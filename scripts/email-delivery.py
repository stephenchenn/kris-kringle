#!/usr/bin/env python3
"""Inspect Gmail delivery without fetching bodies, marking read or moving mail."""

import argparse
import email
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
import getpass
import imaplib
import json
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
from zoneinfo import ZoneInfo


CONFIG = Path(__file__).resolve().parent.parent / '.local/email-test-accounts.json'
HEADERS = '(BODY.PEEK[HEADER.FIELDS (DATE FROM TO SUBJECT MESSAGE-ID CONTENT-TYPE AUTHENTICATION-RESULTS)])'


class DeliveryError(Exception):
    pass


def read_accounts(path=CONFIG):
    if path.is_symlink():
        raise DeliveryError('The local accounts file must not be a symbolic link.')
    if not path.exists():
        return {}
    path.chmod(0o600)
    try:
        accounts = json.loads(path.read_text())
        if not isinstance(accounts, dict) or any(not isinstance(value, str) for value in accounts.values()):
            raise ValueError()
        return accounts
    except (ValueError, OSError):
        raise DeliveryError('Could not read the local accounts file; existing credentials were kept.') from None


def save_accounts(accounts, path=CONFIG):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            os.chmod(temporary, 0o600)
            json.dump(accounts, file)
            file.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def open_mailbox(account, password):
    client = imaplib.IMAP4_SSL('imap.gmail.com', 993, timeout=20)
    try:
        client.login(account, password)
    except Exception:
        try:
            client.logout()
        except Exception:
            pass
        raise DeliveryError('Gmail sign-in failed. Use an app password created in this exact account.') from None
    return client


def close_mailbox(client):
    try:
        client.logout()
    except Exception:
        pass


def quote(value):
    if any(ord(char) < 32 for char in value):
        raise DeliveryError('Search values cannot contain control characters.')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def delivery_folders(client):
    status, entries = client.list()
    if status != 'OK':
        raise DeliveryError('Could not list Gmail folders.')
    folders = [('Inbox', '"INBOX"')]
    for entry in entries or []:
        if not isinstance(entry, bytes):
            continue
        match = re.match(rb'\(([^)]*)\)\s+(?:"(?:[^"\\]|\\.)*"|NIL)\s+(.+)$', entry)
        if match and b'\\junk' in match[1].lower().split():
            # Keep Gmail's original quoting and modified UTF-7 folder name.
            folders.append(('Spam', match[2].decode('ascii')))
            break
    if len(folders) != 2:
        raise DeliveryError('Gmail did not expose its Spam folder. No placement conclusion was made.')
    return folders


def decode(value):
    try:
        return str(make_header(decode_header(value or '')))
    except (LookupError, UnicodeError):
        return value or ''


def inspect_delivery(client, subject='Kris Kringle', sender=None, limit=10):
    messages = []
    criteria = ['SUBJECT', quote(subject)]
    if sender:
        criteria += ['FROM', quote(sender)]
    for label, folder in delivery_folders(client):
        # imaplib sends EXAMINE, rather than SELECT, when readonly=True.
        status, _ = client.select(folder, readonly=True)
        if status != 'OK':
            raise DeliveryError(f'Could not examine {label}; placement check is incomplete.')
        status, result = client.uid('search', None, *criteria)
        if status != 'OK':
            raise DeliveryError(f'Could not search {label}.')
        identifiers = result[0].split()[-limit:] if result and result[0] else []
        if not identifiers:
            continue
        status, parts = client.uid('fetch', b','.join(identifiers).decode('ascii'), HEADERS)
        if status != 'OK':
            raise DeliveryError(f'Could not read the message headers in {label}.')
        for part in parts:
            if not isinstance(part, tuple):
                continue
            message = email.message_from_bytes(part[1])
            authentication = ' '.join(message.get_all('Authentication-Results', []))
            date = message.get('Date', '')
            try:
                date = parsedate_to_datetime(date).astimezone(ZoneInfo('Australia/Adelaide')).isoformat(timespec='minutes')
            except (ValueError, TypeError, OverflowError):
                pass
            messages.append({
                'folder': label, 'date_adelaide': date,
                'subject': decode(message.get('Subject')), 'from': decode(message.get('From')),
                'to': decode(message.get('To')), 'message_id': message.get('Message-ID'),
                'content_type': message.get_content_type(),
                'authentication': {name: re.findall(r'\b' + name + r'=([a-z]+)', authentication, re.I)
                                   for name in ['spf', 'dkim', 'dmarc']},
            })
    return messages


def connect(account, path=CONFIG):
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', account):
        raise DeliveryError('Provide the full Gmail or Google Workspace email address.')
    accounts = read_accounts(path)
    if not sys.stdin.isatty():
        raise DeliveryError('Run email:connect in your own interactive terminal so the password can stay hidden.')
    password = getpass.getpass(f'Google app password for {account} (hidden): ').replace(' ', '')
    if not re.fullmatch(r'[A-Za-z]{16}', password):
        raise DeliveryError('Use the 16-letter Google app password, not your normal Google password.')
    client = open_mailbox(account, password)
    try:
        # Confirm that read-only Spam and Inbox checks work before saving access.
        for label, folder in delivery_folders(client):
            if client.select(folder, readonly=True)[0] != 'OK':
                raise DeliveryError(f'Could not examine {label}; credentials were not saved.')
    finally:
        close_mailbox(client)
    accounts[account] = password
    save_accounts(accounts, path)
    print(f'Connected {account}. App password saved privately in {path}.')
    print('Check Inbox/Spam placement with: npm run email:check')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    setup = commands.add_parser('connect', help='Verify and save a Gmail app password privately')
    setup.add_argument('account')
    check = commands.add_parser('check', help='Read delivery placement in configured test accounts')
    check.add_argument('--account', help='Check one configured account')
    check.add_argument('--subject', default='Kris Kringle')
    check.add_argument('--sender')
    check.add_argument('--limit', type=int, default=10, help='Latest matching messages per folder (1-50)')
    args = parser.parse_args()
    if args.command == 'connect':
        connect(args.account.strip().lower())
        return
    if not 1 <= args.limit <= 50:
        raise DeliveryError('--limit must be between 1 and 50.')
    accounts = read_accounts()
    if args.account:
        accounts = {address: password for address, password in accounts.items() if address == args.account.lower()}
    if not accounts:
        raise DeliveryError('Connect a test account first: npm run email:connect -- your-address@gmail.com')
    report = []
    for account, password in accounts.items():
        client = open_mailbox(account, password)
        try:
            report.append({'account': account, 'messages': inspect_delivery(client, args.subject, args.sender, args.limit)})
        finally:
            close_mailbox(client)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit('\nCancelled; no messages were changed.') from None
    except DeliveryError as error:
        raise SystemExit(str(error)) from None
    except (OSError, imaplib.IMAP4.error, socket.timeout):
        raise SystemExit('Could not complete the Gmail check. No messages were changed; retry when connected.') from None
