# Current setup (2026)

Use the free Render hostname: https://kris-kringle.onrender.com.
See [the 2026 setup guide](documentations/setup-2026.md) for hosting,
free email setup, backups, and creating this year's event.

Edit your private `.local/event-2026.json`, then create the event and email its
invitations with one command:

```sh
npm run event:create
```

It saves the event ID automatically and reuses an event you already created.
Running it again keeps the same draws and skips invitations it already sent.

```sh
npm run event:links      # Show everyone's personal draw and wishlist links
npm run event:status     # Check who has drawn and who is still waiting
npm run event:assignments # Admin: show all saved recipients, tiers and budgets
npm run event:invite     # Send/resend invitations for the saved event
npm run event:wishlists  # Send wishlist reminder emails
```

In **Add an item**, paste a product link to fill its name, image and price
automatically. You can edit the details or enter them yourself if a shop blocks
the lookup.

Recipient wishlist cards have a notification bell and **Send a nudge**. Email
updates are opt-in for each recipient and include new item details. Nudges are
anonymous and limited to one per recipient every 24 hours, shared by all gifters.

**Guess the gifters** lets each participant guess who is giving to every recipient,
for each tier. Gifts you are giving are already known and cannot be guessed or
scored: seven people and two tiers gives **12 guesses per person**. Before
publication, the public board shows only each person’s guesses about their own
gifters. Their guesses about other recipients stay private. The full ballot and
known outgoing gifts are sent only to their authenticated owner; other users,
including the admin, cannot retrieve them before publication. Hiding whole
private sections avoids revealing assignments through skipped slots. Publishing
results makes all ballots visible for the final leaderboard. On phones, tap a
gifter field for a picker with large name buttons, explanations for unavailable
choices, and **Clear this guess**. Background refreshes preserve active controls
and unsaved choices instead of replacing a dropdown while it is in use.
A participant cannot gift to themselves, each giver gives once per tier, and
gifters for a recipient must differ across tiers when the draw allows it.
Edits lock at midnight
at the start of the event day in Adelaide. Results stay hidden until Stephen
clicks **Publish results** on his wishlist page, regardless of the scheduled time.
Publishing requires confirmation, reveals all answers, and permanently locks
guesses even if published early. Only the authenticated admin can publish,
and only for their own event. Publication survives server restarts. Most correct guesses wins. Ties use the average last-edit time of correct
guesses, with earlier guesses first; exact ties share a rank. Saving an unchanged
guess preserves its time. Date-only events also require manual publication.

Stephen’s invitation (`chen.stephen151@gmail.com`) also grants **edit-only** access
to existing wishlist items in the same event. Other people retain their usual
permissions. This grants no access to add or delete someone else’s items, or to
see reservations on unrelated wishlists. The server matches the stored participant
email; it does not trust a name or a browser flag. `WISHLIST_ADMIN_EMAIL` can
override that address; an empty value disables this access. Keep Stephen’s
personal invitation private, just like any authenticated session.

Amazon product pages also support their main product title, high-resolution image
and buy-box price. Missing offers and blocked retailers (including LEGO in our
live check) still need manual details. Foreign currency prices are shown for
reference and never inserted into the AUD field.

To review these features with temporary sample events and captured emails:

```sh
npm run review
```

Open http://127.0.0.1:3001/review for editable, locked and finished event examples.
The preview inbox is at http://127.0.0.1:3001/review/emails. The review command uses
its own database under the system temporary directory and never delivers email.
Each sample event has seven people; Alex is the preview-only wishlist admin.
Use `REVIEW_PORT=3002 npm run review` if port 3001 is busy.

For a separate manual test with six participants—Stephen, Stephen1, Clarisse,
Clarisse1, Liezel and Liezel1—using your existing three inboxes:

```sh
npm run test:event -- --send-email
```

This uses the Gmail SMTP settings in `.env`, and creates only
`.local/manual-test/db.sqlite` and its state files. Open
http://127.0.0.1:3002/test-event. Everyone starts undrawn; each person has ten
scored guesses with six people and two tiers. The duplicate accounts use Gmail
`+` aliases; Liezel1’s alias goes to the 151 inbox. Only the original Stephen
account has admin access. Invitation and notification links
point to this local server, so keep it running and open them on this computer.
Subsequent starts reuse the test and do not resend invitations automatically.
Omit `-- --send-email` when creating a fresh test to capture emails instead.

When finished, stop and delete only this marked test:

```sh
npm run test:event:clean
```

Cleanup verifies the directory, event and participants before deleting, and stops
only its own server process. This removes the test database, links and captured
emails. It leaves the live family event and `.local/event-2026*` files untouched;
it cannot remove messages already delivered to your inboxes. This local runner,
like `/review`, is not a production route.

For local development and automated tests:

```sh
npm ci
npm test
npm run test:e2e
npm run demo
```

The automated tests use temporary databases and capture emails without sending
them. Desktop and mobile browser tests draw all 12 participants, then check
wishlist editing and reservations from the owner, two givers and an unrelated
participant. API tests check all 144 owner/viewer combinations, competing
reservations, restart persistence and larger events with up to 30 participants.
When tiers exceed the number of other participants, repeat recipients are
unavoidable; tests check that everyone is used before any repeat and that repeats
are balanced.

The demo prints five participant links and captures emails locally. It uses its
own database under `.local/` and leaves last year's database untouched.

## Historical notes (2025)

LOCAL:
0. Start Dev Server (http://localhost:3000):
npm run dev

1. Seed:
curl -X POST http://localhost:3000/api/admin/seed \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "secret": "admin-secret",
  "eventName": "Wong's Christmas 2025",
  "eventDate": "2025-12-25T18:00:00+10:30",
  "location": "50 Tasman Avenue, Gilles Plains",
  "participants": [
    {"name":"Stephen","email":"chen.stephen151@gmail.com"},
    {"name":"Liezel","email":"liezel@example.com"},
    {"name":"Clarisse","email":"clarisse@example.com"},
    {"name":"Hana","email":"hana@example.com"}
  ],
  "tiers": [
    { "name": "Gift 1", "budgetCents": 10000 },
    { "name": "Gift 2", "budgetCents":  5000 }
  ]
}
JSON

2. Send invites to participants:
curl -X POST http://localhost:3000/api/admin/send-invites \
  -H "Content-Type: application/json" \
  -d '{"secret":"admin-secret","eventId":"7e0669d4-386d-473f-be58-c3261df58388"}'
  
3. Send wishlists to participants:
curl -X POST http://localhost:3000/api/admin/send-wishlists \
  -H "Content-Type: application/json" \
  -d '{"secret":"admin-secret","eventId":"3b92880f-1457-4243-a008-60fe58f833aa"}'

curl -X POST http://localhost:3000/api/admin/event/update \
  -H "Content-Type: application/json" \
  -d '{"secret":"admin-secret", "eventDate": "2025-12-25T18:00:00+10:30", "location": "50 Tasman Avenue, Gilles Plains", "eventId":"1cfbd7a4-7cd7-47ce-b3cc-7c3d595bb2c8"}'

______________________________________________________________________________________________________________________________________________________________________________

3. Each Recipients do the draw:
curl -X POST http://localhost:3000/api/draw \
  -H "Content-Type: application/json" \
  -d '{"token":"f0a3d313-f678-4071-9b4c-53ba38989769"}'

4. Check your identity + current recipients
curl "http://localhost:3000/api/me?token=<recipient-token>"
______________________________________________________________________________________________________________________________________________________________________________

PROD:

1. Seed
curl -X POST https://kris-kringle.onrender.com/api/admin/seed \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "secret": "<ADMIN_SECRET>",
  "eventName": "Wong's Christmas 2027",
  "participants": [
    {"name":"stephen1","email":"chen.stephen151@gmail.com"},
    {"name":"stephen2","email":"chen.stephen141@gmail.com"},
    {"name":"Alice","email":"alice@example.com"}
  ],
  "tiers": [
    { "name": "Gift 1", "budgetCents": 10000 },
    { "name": "Gift 2", "budgetCents":  5000 }
  ]
}
JSON

2. Send Invites:
curl -X POST https://kris-kringle.onrender.com/api/admin/send-invites \
  -H "Content-Type: application/json" \
  -d '{"secret":"<ADMIN_SECRET>","eventId":"a1679b20-48b6-466b-a50a-2f4fa317b736"}'


RESET:
curl -X POST https://kris-kringle.onrender.com/api/admin/reset \
  -H "Content-Type: application/json" \
  -d '{"secret":"<ADMIN_SECRET>"}'

______________________________________________________________________________________________________________________________________________________________________________

To Do:
1. Resend func ✅
2. Send invites api ✅
3. Confetti ✅
4. Deploy ✅
5. Test ✅
6. Add budget to gifts and ensure each person gives and receives a gift of each budget (e.g. 2 gifts, one budget $50 and one budget $100) ✅
7. Wishlist ✅
8. Notification system - Notify participant when their recipient add a new wishlist item
9. Add panel for gifts they've reserved
10. Frontend: Back to top and Collapse All

Future Actions
- Godaddy domain wongskringle.online expires on 15 Oct, 2026 (Auto-renew turned off)
- SendGrid free trial expires on December 12th, 2025 (Just use another email for free trial)

To verify domain in SendGrid, got to Sender Authentication -> Domain Authentication -> Authenticate Your Domain -> Use config:
  DNS host: GODaddy
  From Domain: mail.wongskringle.online (subdomain)
-> Add the provided DNS record to your DNS provider -> Update env with new Sendgrid API key

Generate Admin Secret:
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

Testing:
node testSeed.js

Note: it checks for:
  1) For each tier, every participant gives exactly one gift and receives exactly one gift.
  2) No self-assignments.
  3) Cross-tier uniqueness: a giver never gifts to the same recipient more than once.
  4) Max tier count is (number of participants - 1)

SSH
# Set up
https://render.com/docs/ssh

# Enter SSH
render ssh

# merge recent changes to main db
sqlite3 /data/db.sqlite "PRAGMA wal_checkpoint(FULL);"

# backup first (if you haven’t already)
sqlite3 /data/db.sqlite ".backup '/tmp/kk-backup.sqlite'"

# Check backup
ls -lh /tmp/kk-backup.sqlite

# open the snapshot
sqlite3 /tmp/kk-backup.sqlite




.ENV
PORT=3000
ADMIN_SECRET=<ADMIN-SECRET>
BASE_URL= https://kris-kringle.onrender.com
DB_PATH=/data/db.sqlite
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=<SENDGRID-API-KEY>
FROM_EMAIL="Wong's Kris Kringle <noreply@mail.wongskringle.online>"


DEPLOY
Name: kris-kringle
Source Code: stephenchenn/kris-kringle
Build Command: npm ci
Start Command: node server.js
Branch: main
Region: Singapore
Instance: Starter
Disk Mount Path: /data
Disk Size: 1GB
Health Check Path: /healthz
Auto-Deploy: On Commit
