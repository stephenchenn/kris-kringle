LOCAL:
0. Start Dev Server (http://localhost:3000):
npm run dev

1. Seed:
curl -X POST https://<your-host>/api/admin/seed \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "secret": "<ADMIN_SECRET>",
  "eventName": "Wong's Christmas 2025",
  "participants": [
    {"name":"stephen1","email":"chen.stephen151@gmail.com"},
    {"name":"stephen2","email":"chen.stephen141@gmail.com"},
    {"name":"Alice","email":"alice@example.com"},
    {"name":"Bob","email":"bob@example.com"},
    {"name":"Carol","email":"carol@example.com"},
    {"name":"Dave","email":"dave@example.com"},
    {"name":"Eve","email":"eve@example.com"},
    {"name":"Frank","email":"frank@example.com"},
    {"name":"Grace","email":"grace@example.com"},
    {"name":"Heidi","email":"heidi@example.com"}
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
  -d '{"secret":"<ADMIN_SECRET>","eventId":"<optional-event-id>"}'
______________________________________________________________________________________________________________________________________________________________________________

3. Each Recipients do the draw:
curl -X POST http://localhost:3000/api/draw \
  -H "Content-Type: application/json" \
  -d '{"token":"<recipient-token>"}'

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
  "eventName": "Wong's Kris Kringle 2025",
  "giftsPerPerson": 2,
  "participants": [
    {"name":"Stephen","email":"chen.stephen151@gmail.com"},
    {"name":"Stephen2","email":"chen.stephen141@gmail.com"},
    {"name":"Clarisse","email":"clarisse@example.com"},
    {"name":"Liezel","email":"liezel@example.com"},
    {"name":"Pualine","email":"pualine@example.com"},
    {"name":"Hana","email":"hana@example.com"},
    {"name":"Kelvin","email":"kelvin@example.com"},
    {"name":"Andrew","email":"andrew@example.com"}
  ]
}
JSON

2. Send Invites:
curl -X POST https://kris-kringle.onrender.com/api/admin/send-invites \
  -H "Content-Type: application/json" \
  -d '{"secret":"<ADMIN_SECRET>","eventId":"<EVENT_ID>"}'



RESET:
curl -X POST https://<your-host>/api/admin/reset \
  -H "Content-Type: application/json" \
  -d '{"secret":"<ADMIN_SECRET>"}'

______________________________________________________________________________________________________________________________________________________________________________

To Do:
1. Resend func ✅
2. Send invites api ✅
3. Confetti ✅
4. Deploy ✅
5. Test
6. Add budget to gifts and ensure each person gives and receives a gift of each budget (e.g. 2 gifts, one budget $50 and one budget $100)

Future Actions
- Godaddy domain wongskringle.online expires on 15 Oct, 2026 (Auto-renew turned off)
- SendGrid free trial expires on December 12th, 2025

To verify domain in SendGrid, got to Sender Authentication -> Domain Authentication -> Authenticate Your Domain -> Add the provided DNS record to your DNS provider

Generate Admin Secret:
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='