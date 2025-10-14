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
    {"name":"Andrew","email":"andrew@example.com"},
    {"name":"Evan","email":"evan@example.com"}
  ]
}
JSON
