Start Dev Server (http://localhost:3000):
npm run dev

Generate Admin Secret:
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

1. Seed:
curl -X POST http://localhost:3000/api/admin/seed \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "secret": "change-this-long-random-string",
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
  -d '{"secret":"change-this-long-random-string","eventId":"<optional-event-id>"}'
_______________________________________________________________________________________

3. Each Recipients do the draw:
curl -X POST http://localhost:3000/api/draw \
  -H "Content-Type: application/json" \
  -d '{"token":"<paste-one-token>"}'

4. Check your identity + current recipients
curl "http://localhost:3000/api/me?token=<paste-one-token>"


To Do:
1. Resend func ✅
2. Send invites api ✅
3. Confetti ✅
4. Deploy
5. Test
6. Add budget to gifts and ensure each person gives and receives a gift of each budget (e.g. 2 gifts, one budget $50 and one budget $100)

Future Actions
- Godaddy domain wongskringle.online expires on 15 Oct, 2026 (Auto-renew turned off)
- SendGrid free trial expires on December 12th, 2025

To verify domain in SendGrid, got to Sender Authentication -> Domain Authentication -> Authenticate Your Domain -> Add the provided DNS record to your DNS provider