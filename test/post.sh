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
