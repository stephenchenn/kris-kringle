curl --request POST \
--url https://api.sendgrid.com/v3/mail/send \
--header 'Authorization: Bearer <API_KEY>' \
--header 'Content-Type: application/json' \
--data '{
    "personalizations": [
        {
            "to": [
                {
                    "email": "chen.stephen141@gmail.com",
                    "name": "Stephen 141"
                }
            ],
            "subject": "Hello, World!"
        }
    ],
    "content": [
        {
            "type": "text/plain",
            "value": "Heya!"
        }
    ],
    "from": {
        "email": "chen.stephen151@gmail.com",
        "name": "Stephen Chen"
    },
    "reply_to": {
        "email": "chen.stephen151@gmail.com",
        "name": "Stephen Chen"
    }
}'