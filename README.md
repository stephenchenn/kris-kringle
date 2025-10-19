LOCAL:
0. Start Dev Server (http://localhost:3000):
npm run dev

1. Seed:
curl -X POST http://localhost:3000/api/admin/seed \
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

2. Send invites to participants:
curl -X POST http://localhost:3000/api/admin/send-invites \
  -H "Content-Type: application/json" \
  -d '{"secret":"<ADMIN_SECRET>","eventId":"<optional-event-id>"}'
______________________________________________________________________________________________________________________________________________________________________________

3. Each Recipients do the draw:
curl -X POST http://localhost:3000/api/draw \
  -H "Content-Type: application/json" \
  -d '{"token":"<paste-one-token>"}'

4. Check your identity + current recipients
curl "http://localhost:3000/api/me?token=<paste-one-token>"
______________________________________________________________________________________________________________________________________________________________________________

PROD:

1. Seed
curl -X POST https://kris-kringle.onrender.com/api/admin/seed \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "secret": "Vy_VnmjzDmBtxTOkBh7tIeBOyUt8kS0j4reLF7rWVZ0",
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
  -d '{"secret":"Vy_VnmjzDmBtxTOkBh7tIeBOyUt8kS0j4reLF7rWVZ0","eventId":"dd264c2b-a972-4beb-afb3-ef8b6c8bbff9"}'

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