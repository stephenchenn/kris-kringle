1. Seed:
curl -X POST http://localhost:3000/api/admin/seed \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "secret": "change-this-long-random-string",
  "eventName": "wong's christmas 2025",
  "giftsPerPerson": 2,
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
  ]
}
JSON


1. Do the draw
curl -X POST http://localhost:3000/api/draw \
  -H "Content-Type: application/json" \
  -d '{"token":"<paste-one-token>"}'

2. Check your identity + current recipients
curl "http://localhost:3000/api/me?token=<paste-one-token>"



To Do:
1. Resend func
2. Send invites api
3. Confetti
4. Deploy
5. Test