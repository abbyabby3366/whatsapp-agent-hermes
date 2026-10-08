# WhatsApp Agent (Hermes)

Express application integrating WhatsApp Web via Baileys fork [`github:JonathanChuahE-Jay/Baileys`](https://github.com/JonathanChuahE-Jay/Baileys).

## Features

- **Baileys Integration**: Uses `github:JonathanChuahE-Jay/Baileys` with multi-file auth persistence (`./sessions`).
- **Interactive Web UI**: Real-time status, live QR code display for WhatsApp pairing, messaging form, and recent logs.
- **RESTful Endpoints**:
  - `GET /api/status`: Current WhatsApp connection status and active user info.
  - `POST /api/send`: Send text messages to any WhatsApp contact or phone number.
  - `POST /api/connect`: Trigger connection initiation.
  - `POST /api/logout`: Log out the session and clear credentials with safety confirmation.
- **Hot-Reloading**: Configured with `tsx watch` for instant backend development.

## Setup & Running

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Run in Development (Hot-Reloading)**:
   ```bash
   npm run dev
   ```

3. **Access Dashboard**:
   Open [http://localhost:3000](http://localhost:3000) in your browser.
   - Scan the QR code using WhatsApp on your phone (**Linked Devices** -> **Link a Device**).
   - Once connected, test sending WhatsApp messages directly from the dashboard or API.

## API Examples

### Send a Message
```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{"to": "60123456789", "message": "Hello from WhatsApp Agent Hermes!"}'
```

### Check Status
```bash
curl http://localhost:3000/api/status
```
