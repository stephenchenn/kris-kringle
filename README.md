Start Dev Server (http://localhost:3000):
npm run dev

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

2. 
curl -X POST http://localhost:3000/api/admin/send-invites \
  -H "Content-Type: application/json" \
  -d '{"secret":"change-this-long-random-string","eventId":"<optional-event-id>"}'

3. Each Recipients do the draw
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