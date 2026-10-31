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

If Render accepts resume but the service stays suspended, check workspace
Billing. This account's payment method was removed in February 2026; that
separate suspension must be resolved before the service can run or accept SSH.

## Keep the existing SendGrid integration

Render already has the SendGrid host, port, username, API key, and sender
configured. Keep that integration; a Gmail SMTP migration is unnecessary.
The existing API key was accepted by SendGrid's read-only account APIs when
checked on 31 October 2026. The SMTP check on SendGrid's alternative port 2525
then returned `451 Authentication failed: Maximum credits exceeded`. No email
was sent. The account needs sending capacity restored before SMTP can work;
API access alone does not establish that sending is enabled.

Retain these Render environment settings:

```dotenv
BASE_URL=https://kris-kringle.onrender.com
DB_PATH=/data/db.sqlite
EMAIL_MODE=smtp
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=<SendGrid API key with Mail Send permission>
FROM_EMAIL="Family Kris Kringle <your-verified-sender@example.com>"
```

`SMTP_USER` is literally `apikey`, not an email address. The application still
defaults to SMTP when `EMAIL_MODE` is absent, so the current production settings
remain compatible. See [SendGrid's SMTP settings](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/integrating-with-the-smtp-api).

The current sender is `noreply@mail.wongskringle.online`. SendGrid still lists
that domain as authenticated, but its saved status does not establish that DNS
authentication survives domain expiry. The free Render hostname is the website
address; it does not provide a mailbox or DNS control for email authentication.

To avoid buying a domain, open SendGrid → Settings → Sender Authentication →
Single Sender Verification, add an address whose inbox you control, and follow
the verification email. Then update only `FROM_EMAIL` to that verified address.
SendGrid cautions that addresses from large mailbox providers can have DMARC
delivery problems, so check delivery before sending the family invitations.
See [Single Sender Verification](https://www.twilio.com/docs/sendgrid/ui/sending-email/sender-verification).

The account API currently reports a `free` account with zero total and remaining
sending credits. Check SendGrid → Settings → Account Details → Your Products
to restore an active sending plan. The old README recorded a trial ending in
December 2025, and SendGrid's permanent free plan was retired; keeping the
integration does not provide free sending. No paid plan has been purchased as
part of this work. See [SendGrid's plan changes](https://www.twilio.com/en-us/changelog/sendgrid-free-plan).

Keep secrets directly in Render and the ignored `.env` file. Before going live,
replace credentials that have been shared in screenshots. Render Free services
block SMTP ports 465 and 587; the retained paid service supports this setup.

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

```sh
curl --fail-with-body https://kris-kringle.onrender.com/api/admin/seed \
  -H 'Content-Type: application/json' \
  --data-binary @.local/event-2026.json -o .local/event-2026-result.json
```

This returns `event.id` and individual invitation links without sending emails
or erasing old events. Keep the result private: links grant account access.

Save an ignored `.local/send-2026.json` containing
`{"secret":"<ADMIN_SECRET>","eventId":"<event.id from the response>"}`.
When ready to send real invitations:

```sh
curl --fail-with-body https://kris-kringle.onrender.com/api/admin/send-invites \
  -H 'Content-Type: application/json' --data-binary @.local/send-2026.json
```

Check `sent` and `failed`; HTTP 200 can include individual delivery failures.
People can open wishlists immediately after drawing. To send wishlist reminders,
use the same JSON with `/api/admin/send-wishlists`. Always specify `eventId`.
Avoid `/api/admin/reset`: it deletes every event.

## Test coverage and later work

`npm test` covers allocation rules, invitations, stable draws, resends, wishlist
CRUD, reservation privacy, ownership, event isolation, and a complete server
restart. `npm run test:e2e` checks the flow in desktop and mobile Chrome with
separate participant sessions. Both use temporary databases and captured email.

Automatic recommended images from product URLs remain deferred. Manual product
links and image URLs work as before.

References: [Render web services](https://render.com/docs/web-services),
[persistent disks](https://render.com/docs/disks), and
[Free service limits](https://render.com/docs/free).
