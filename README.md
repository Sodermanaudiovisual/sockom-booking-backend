# Studio Booking Backend (Render)
Endpoints:
- GET /health
- GET /availability?date=YYYY-MM-DD
- POST /book (supports multi-slot)
- GET /approve/:token
- GET /reject/:token

Run locally:
npm i && mkdir -p data && node server.js

Render:
- Environment: Node
- Build: (blank)
- Start: node server.js
- Add env vars from .env.example
