# Family Kris Kringle setup

## Hosting and free address

Use **https://kris-kringle.onrender.com**. Render supplies this hostname and
HTTPS; there is no domain purchase, renewal, or DNS setup. There is no need to
renew `wongskringle.online`.

Keep the existing Starter service and 1 GB persistent disk at `/data`. The
hostname is free; compute and disk storage still have charges. Render's Free
service cannot attach a disk and loses SQLite data on restart, deploy, or idle
shutdown. Entirely free hosting would require migrating database storage and
changing email delivery.

| Setting | Value |
| --- | --- |
| Dashboard | https://dashboard.render.com/web/srv-d3r0kut6ubrc738ahp20 |
| Repository / branch | `stephenchenn/kris-kringle` / `main` |
| Runtime | Node 24, declared in `.node-version` |
| Build / start | `npm ci` / `npm start` |
| Health check | `/healthz` |
| Database | `/data/db.sqlite` on the retained persistent disk |

Choose **Resume service** in Render if suspended, then deploy current code after
updating the environment. Verify with:

```sh
curl --fail https://kris-kringle.onrender.com/healthz
```

It should return `ok`. The home page without a personal token shows “Invalid or
missing invite link”; participants need their individual invitation links.

The service was restored on 31 October 2026 after its payment method was added
again. Last year's data was backed up on Render and locally before deploying
the fixes. If a future resume leaves it suspended, check workspace Billing.

## Free email without SendGrid or a paid domain

Use a personal Gmail account directly over SMTP. The existing application
already supports it. Google sends
from the Gmail address itself; you do not need to buy a sender domain or
authenticate the expired domain with another email provider.

1. Enable [2-Step Verification](https://myaccount.google.com/security) on the
   Google account you want to send from.
2. Open [App passwords](https://myaccount.google.com/apppasswords) and create
   one named `Family Kris Kringle`. Use this app password, not your normal
   Google password. Some managed accounts, Advanced Protection accounts, and
   accounts configured only with security keys do not offer app passwords.
3. Open [Render's Environment tab](https://dashboard.render.com/web/srv-d3r0kut6ubrc738ahp20/env)
   and replace the old SendGrid SMTP settings with:

```dotenv
BASE_URL=https://kris-kringle.onrender.com
DB_PATH=/data/db.sqlite
EMAIL_MODE=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-account@gmail.com
SMTP_PASS=<Google app password>
FROM_EMAIL="Your name - Family Kris Kringle <your-account@gmail.com>"
```

Use exactly the same Gmail address in `SMTP_USER` and `FROM_EMAIL`. Keep the
existing `BASE_URL`, `DB_PATH`, and admin secret. Enter the app password directly
in Render; do not paste it into chat or tracked files. Save and deploy the
environment changes. SMTP authentication can then be verified without sending
any messages. A separate test invitation is still needed to check inbox delivery.

Replace `your-account@gmail.com` with your actual Gmail address in both fields.
In Render's individual value boxes, enter `FROM_EMAIL` without the outer double
quotes shown in dotenv syntax, for example `Stephen - Family Kris Kringle <your Gmail address>`.
Paste the 16-character Google app password without its grouping spaces. Edited
values do not take effect until you save the environment changes and deploy.

Gmail's documented consumer sending limit is 500 messages per day; other account
and recipient limits also apply. Seven invitations, seven draw confirmations,
and occasional reminders are well below that limit for this family event.
Google documents [SMTP settings](https://support.google.com/mail/answer/7104828),
[app passwords](https://support.google.com/accounts/answer/185833), and
[sending limits](https://support.google.com/mail/answer/22839).

### If invitations go to Spam

All three email types include plain-text and HTML versions. SMTP requires TLS,
and the From display name should identify the organiser so family members
recognise the sender. These improve message quality; they do not guarantee
inbox placement.

For Gmail and Google Workspace recipients:

1. In the recipient's Spam folder, select the invitation and choose **Not spam**.
2. Add the exact Gmail sender address (the address in `SMTP_USER`) to Contacts.
3. If needed, create a filter in that inbox: **Show search options → From**,
   enter the exact sender address, then **Create filter → Never send it to Spam
   → Create filter**. Apply it to existing matching conversations if offered.
   A Workspace administrator's policy can still take precedence.

Google documents [marking legitimate mail as not spam and adding contacts](https://support.google.com/mail/answer/1366858)
and [creating filters](https://support.google.com/mail/answer/6579).

To diagnose an affected message, open **More (⋮) → Show original** in the
recipient's inbox and check **SPF**, **DKIM** and **DMARC**, plus the spam warning
shown above the message. When all three pass, authentication is working; the
headers alone do not explain the spam classification. Do not change the
recipient domain's DNS to authenticate mail sent from Gmail. Google manages
authentication for the Gmail sender domain.

On 2 November 2026, a supplied invitation header from the affected Gmail inbox
showed SPF, DKIM and DMARC passing, with TLS 1.3. This confirms the existing Gmail
SMTP setup authenticates correctly for that message, but does not prove inbox
placement for future messages or other recipients. Follow Google's
[sender guidelines](https://support.google.com/mail/answer/81126) and avoid
repeated mass resends while testing.

### Other free options

| Option | Allowance / setup | Tradeoff |
| --- | --- | --- |
| Gmail SMTP | Existing personal account plus an app password | Recommended for this small annual event; sends from your Gmail address. |
| Brevo Free | 300 emails per day; create an account and configure its SMTP credentials | Additional setup. Without your own authenticated domain, Brevo temporarily rewrites the sender address. |
| Share invitation links manually | No email provider needed | Send each person only their own private link; automatic confirmations and email resends remain unavailable until SMTP works. |

Brevo documents its [free allowance](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)
and [sender rewriting](https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders).
It describes rewriting as a temporary measure, so Gmail is the simpler option
when you do not want a paid sender domain.

Manual sharing works with the personal links returned by `/api/admin/seed`.
Draws are saved before the app attempts a confirmation email, and wishlist
access does not depend on email success. Keep links private: each grants access
to that participant's account. SendGrid remains unusable with its current
zero-credit account, but recovering it is not required for any of these options.

The email options above are free; the retained Render compute and SQLite disk
still have charges. Render Free blocks SMTP ports 465 and 587; the existing paid
service supports them.

## Local demo and end-to-end tests

Use Node 22 or later; Node 24 matches deployment:

```sh
npm ci
npm test
npm run test:e2e
npm run demo
```

Browser tests use installed Google Chrome on this Linux workstation. If Chrome
is unavailable, run `npx playwright install chromium` first. Set
`PLAYWRIGHT_CHANNEL` to choose another supported installed browser.

The demo creates five fictional participants and $100 / $50 gift tiers. It
prints personal draw links and saves them to `.local/demo.json`. Each run gets
a fresh database under `.local/`. Emails are captured as `.html` previews and
`.json` messages in that run's directory, even if `.env` contains SMTP
credentials. No real email is sent. Open the HTML files to inspect invitations
and follow their links while the demo is running.

1. Open each person's link and draw. Each person gives and receives each budget
   and gives to two different people. Refreshing keeps the same recipients.
2. Test “Resend my email” and inspect the captured confirmation.
3. Open wishlists, add an item, expand the list, and edit it.
4. Reserve an item as one of the owner's assigned givers. Their other giver sees
   “Reserved”; the recipient and unrelated participants cannot see the status.
5. The second giver cannot reserve the same item or cancel the reservation.
   After the first giver unreserves it, the second giver can reserve it.
6. Delete the item as its owner and check that it disappears for everyone.

Stop with Ctrl+C. If port 3000 is occupied, use `DEMO_PORT=3001 npm run demo`.
The demo never resets `db.sqlite` or the Render database.

For ordinary local development, copy `.env.example` to `.env` only if you do
not already have one, replace `ADMIN_SECRET`, keep `EMAIL_MODE=preview`, and run
`npm run dev`. This preserves the configured database across restarts. Preview
mode is refused when `NODE_ENV=production`.

## Back up before creating the real event

Use SQLite's backup API; copying just `db.sqlite` can omit committed data in its
WAL file. Open Render Shell or `render ssh kris-kringle`, then run:

```sh
mkdir -p /data/backups
node - <<'JS'
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || '/data/db.sqlite', { readonly: true });
const destination = `/data/backups/kringle-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
db.backup(destination).then(() => {
  db.close();
  console.log(destination);
}).catch(error => { db.close(); console.error(error); process.exitCode = 1; });
JS
```

Keep an off-host copy before deleting or replacing the disk. Create a new event
for this year instead of resetting last year's data.

## Create this year's event when details are confirmed

Assignments are generated together at event creation. Each draw reveals that
person's saved assignments, marks them as drawn, and sends their confirmation.
This prevents the last participants from getting stuck. Repeated draws keep the
same assignments; use the existing link or resend instead of recreating events.

Each tier is one gift with a budget in **cents**. Every participant gives and
receives one gift per tier, without self-assignment. Givers exhaust the other
`participants − 1` people before repeating recipients; extra tiers use balanced
repeats.

Create an ignored `.local/event-2026.json` with the admin secret and confirmed
names, emails, tiers, date, and venue. These are examples, not confirmed details:

```json
{
  "secret": "<ADMIN_SECRET>",
  "eventName": "Family Christmas 2026",
  "eventDate": "2026-12-25T18:00:00+10:30",
  "location": "<confirmed venue>",
  "participants": [
    { "name": "Alex", "email": "<real-email>" },
    { "name": "Blair", "email": "<real-email>" },
    { "name": "Casey", "email": "<real-email>" }
  ],
  "tiers": [
    { "name": "Gift 1", "budgetCents": 10000 },
    { "name": "Gift 2", "budgetCents": 5000 }
  ]
}
```

From the repository directory, run:

```sh
npm run event:create
```

This reads `.local/event-2026.json`, validates the participants and budgets,
creates the event, and sends its invitation emails. It prints how many emails
were sent or failed. It uses the live server at
`https://kris-kringle.onrender.com`; recipients are the addresses in your JSON.
No pasted JavaScript, curl commands, or manually copied event IDs are needed.
The helper runs on your computer, so these commands need no Render deployment.

It saves the server response to `.local/event-2026-result.json` and the creation
and email status to `.local/event-2026-state.json`. It also fills
`.local/send-2026.json` automatically for compatibility with the old curl commands.
These files have owner-only permissions and are ignored by Git. Keep them:
they identify the event and contain personal account links.

If a result from an earlier successful curl command already exists, the helper
reuses that event. It checks that the saved event matches your configuration and
still exists on the selected server. If invitations were already sent manually,
use `npm run event:create -- --no-email` on the first run to adopt it without
sending them again.

After a successful scripted creation, repeating `npm run event:create` keeps
the same assignments and skips its previously sent invitations. If a request
is interrupted or only some invitations succeed, it preserves the event ID and
reports the problem rather than silently creating another event or sending
duplicate emails. After fixing email delivery, deliberately resend with:

```sh
npm run event:invite
```

This command sends invitations to everyone each time it is run, including people
who received an earlier invitation. It keeps their existing links and draws.

To view the personal links at any time:

```sh
npm run event:links
```

Participants open their invitation, draw, then use the wishlist button. Test
wishlist add/edit/delete and private reservations using the checklist in the
local demo section above. To email everyone their wishlist links:

```sh
npm run event:wishlists
```

Wishlist reminders are sent each time that command is run. A successful email
result means the SMTP server accepted the messages; check the inbox to confirm
delivery.

Optional commands:

```sh
npm run event:create -- --no-email              # Create/reuse without emailing
npm run event:create -- --new                   # Create a separate event and email it
npm run event:create -- --file .local/event-2027.json
npm run event:create -- --url http://localhost:3000
npm run event:create -- --help
```

Use the same `--file` and `--url` options on subsequent invite, links, and
wishlist commands. A local server needs the admin secret matching that server.
With `--new`, previous local result, status, and send files are archived under
`.local/event-2026-history/`. Existing events on the server remain intact.
Changing participants or budgets after creation requires a new event; the
helper rejects configuration changes that would otherwise target an older event.

If you explicitly reset the server, all old personal links stop working. Start
again with `npm run event:create -- --new`. The existing `/api/admin/reset`
endpoint deletes every event; the event helper does not call it.

## Test coverage and later work

`npm test` covers allocation rules, invitations, stable draws, resends, wishlist
CRUD, reservation privacy, ownership, event isolation, and a complete server
restart. It also runs the event commands against isolated servers, checking saved
event reuse, manual-curl event adoption, reminders, partial email failures, and
interrupted requests. `npm run test:e2e` checks the flow in desktop and mobile Chrome with
separate participant sessions. Both use temporary databases and captured email.

## Add wishlist items from product links

Open **Add an item** and paste a product URL. The form automatically looks up
the name, product image and price. **Get details** lets you retry. Review or edit
the filled fields, add size/colour notes, then select **Add to my wishlist**.
Pasting a link only previews details; it does not save an item until you add it.

The lookup reads public product data (JSON-LD, Open Graph or microdata) without
requiring a paid service or an API key. Some stores block automated requests or
only provide details through JavaScript. If a lookup fails or a field is missing,
enter it manually. Your edits are kept when a lookup finishes or you change the
link. Prices are entered in AUD; a page listing another currency shows its price
for reference and leaves the AUD field for you to fill in.

This works for both desktop and mobile. Automated tests cover metadata parsing,
private-address and redirect blocking, request limits, editable autofill, image
preview, manual fallback, slow responses and saving the resulting item.

References: [Render web services](https://render.com/docs/web-services),
[persistent disks](https://render.com/docs/disks), and
[Free service limits](https://render.com/docs/free).
