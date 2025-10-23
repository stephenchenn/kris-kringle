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