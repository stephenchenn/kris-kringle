import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import MagicMock, patch


spec = importlib.util.spec_from_file_location('email_delivery', Path(__file__).parents[1] / 'scripts/email-delivery.py')
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class EmailDeliveryTests(unittest.TestCase):
    def mailbox(self):
        client = MagicMock()
        client.list.return_value = ('OK', [b'(\\HasNoChildren) "/" "INBOX"',
                                            b'(\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"'])
        client.select.return_value = ('OK', [b'3'])
        return client

    def test_checks_headers_in_both_folders_without_mutating_mail_or_read_state(self):
        client = self.mailbox()
        header = b'Date: Sun, 01 Nov 2026 15:58:23 +0000\r\nSubject: KK delivery check B\r\nAuthentication-Results: mx.google.com; spf=pass; dkim=pass; dmarc=pass\r\n\r\n'

        def uid(command, *args):
            if command == 'search':
                self.assertEqual(args, (None, 'SUBJECT', '"Kris Kringle"', 'FROM', '"sender@gmail.com"'))
                return 'OK', [b'1 2 3']
            self.assertEqual(command, 'fetch')
            self.assertEqual(args, ('2,3', delivery.HEADERS))
            self.assertIn('BODY.PEEK[HEADER.FIELDS', args[1])
            return 'OK', [(b'3 (UID 3 BODY[HEADER.FIELDS] {250}', header), b')']

        client.uid.side_effect = uid
        result = delivery.inspect_delivery(client, sender='sender@gmail.com', limit=2)
        self.assertEqual([row['folder'] for row in result], ['Inbox', 'Spam'])
        self.assertEqual(result[0]['date_adelaide'], '2026-11-02T02:28+10:30')
        self.assertEqual(result[0]['authentication'], {'spf': ['pass'], 'dkim': ['pass'], 'dmarc': ['pass']})
        for call in client.select.call_args_list:
            self.assertTrue(call.kwargs['readonly'])
        self.assertEqual({call.args[0] for call in client.uid.call_args_list}, {'search', 'fetch'})

    def test_unknown_spam_folder_is_not_reported_as_success(self):
        client = self.mailbox()
        client.list.return_value = 'OK', [b'(\\HasNoChildren) "/" "INBOX"']
        with self.assertRaisesRegex(delivery.DeliveryError, 'No placement conclusion'):
            delivery.inspect_delivery(client)
        client.select.assert_not_called()

    def test_verified_account_is_saved_privately_and_existing_accounts_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'accounts.json'
            delivery.save_accounts({'first@gmail.com': 'aaaabbbbccccdddd'}, path)
            client = self.mailbox()
            with patch.object(delivery.sys.stdin, 'isatty', return_value=True), \
                    patch.object(delivery.getpass, 'getpass', return_value='eeee ffff gggg hhhh'), \
                    patch.object(delivery, 'open_mailbox', return_value=client) as login, \
                    patch('builtins.print'):
                delivery.connect('second@gmail.com', path)
            login.assert_called_once_with('second@gmail.com', 'eeeeffffgggghhhh')
            self.assertEqual(json.loads(path.read_text()), {'first@gmail.com': 'aaaabbbbccccdddd', 'second@gmail.com': 'eeeeffffgggghhhh'})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            client.logout.assert_called_once()
            for call in client.select.call_args_list:
                self.assertTrue(call.kwargs['readonly'])

    def test_failed_sign_in_preserves_saved_access_and_never_saves_candidate_password(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'accounts.json'
            delivery.save_accounts({'first@gmail.com': 'aaaabbbbccccdddd'}, path)
            before = path.read_bytes()
            with patch.object(delivery.sys.stdin, 'isatty', return_value=True), \
                    patch.object(delivery.getpass, 'getpass', return_value='eeee ffff gggg hhhh'), \
                    patch.object(delivery, 'open_mailbox', side_effect=delivery.DeliveryError('Gmail sign-in failed')):
                with self.assertRaisesRegex(delivery.DeliveryError, 'sign-in failed'):
                    delivery.connect('second@gmail.com', path)
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
