# WhatsApp Agent for Hermes

A small gateway that links a WhatsApp account to your **Hermes agent**. It runs next to Hermes on the same server:

1. A WhatsApp message arrives → the gateway `POST`s it to Hermes (`HERMES_WEBHOOK_URL`).
2. Hermes decides: reply right away, stay silent, or think longer and answer later through the REST API.
3. The dashboard at `http://localhost:3100` shows the QR code, connection state, and every message with what Hermes did with it.

Built on Express + the Baileys fork [`github:JonathanChuahE-Jay/Baileys`](https://github.com/JonathanChuahE-Jay/Baileys).

## Quick start

```bash
npm install
cp .env.example .env     # then edit HERMES_WEBHOOK_URL / HERMES_SECRET_TOKEN
npm run dev              # hot-reloading dev server
```

Open [http://localhost:3100](http://localhost:3100), scan the QR code (WhatsApp → **Linked devices** → **Link a device**), and press **Test connection to Hermes**.

To try the whole loop without a real Hermes, run the bundled demo agent in a second terminal:

```bash
npm run demo:hermes
```

Production:

```bash
npm run build && npm start
# or keep it alive with pm2:
pm2 start npm --name whatsapp-agent-hermes -- start
```

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3100` | Gateway port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to open the dashboard to other machines (then set `GATEWAY_API_KEY`). |
| `GATEWAY_API_KEY` | *(empty)* | Optional key required on every `/api/*` call (`x-api-key` header). The dashboard asks for it. |
| `HERMES_WEBHOOK_URL` | *(empty)* | Where incoming messages are posted. Empty = messages are only shown in the dashboard. |
| `HERMES_SECRET_TOKEN` | *(empty)* | Sent to Hermes as `x-hermes-token` so Hermes can reject other callers. |
| `HERMES_WEBHOOK_TIMEOUT_MS` | `15000` | Wait time per webhook call |
| `HERMES_WEBHOOK_RETRIES` | `2` | Retries on network errors / HTTP 5xx |
| `DEFAULT_COUNTRY_CODE` | `60` | Prefix for numbers starting with `0` |
| `ALLOWED_NUMBERS` | *(empty)* | Comma-separated senders allowed to reach Hermes |
| `FORWARD_GROUPS` | `true` | Forward group chats to Hermes |
| `TIMEZONE` | `Asia/Kuala_Lumpur` | Timezone of timestamps |
| `SESSIONS_DIR` / `DATA_DIR` | `./sessions` / `./data` | WhatsApp credentials / dashboard settings |

## Webhook: gateway → Hermes

`POST HERMES_WEBHOOK_URL` with header `x-hermes-token: <HERMES_SECRET_TOKEN>` and body:

```json
{
  "event": "message.received",
  "messageId": "3EB0ABC123456789",
  "sender": "60123456789",
  "senderName": "John Doe",
  "senderJid": "60123456789@s.whatsapp.net",
  "chatJid": "60123456789@s.whatsapp.net",
  "isGroup": false,
  "groupJid": null,
  "message": "Hello, can you help?",
  "messageType": "text",
  "hasMedia": false,
  "mimetype": null,
  "mentionsMe": false,
  "isReplyToMe": false,
  "quoted": null,
  "timestamp": "08-10-2026 20:15:30",
  "timezone": "Asia/Kuala_Lumpur",
  "isoTimestamp": "2026-10-08T12:15:30.000Z",
  "rawTimestamp": 1791461730
}
```

- `sender` can be `null` when WhatsApp only exposes an anonymous ID (common in groups). **Always reply to `chatJid`.**
- `messageType` is one of `text | image | video | voice | audio | document | sticker | location | contact | other`. For media, `message` holds the caption or a placeholder like `[Voice message]`; download the file with `GET /api/media/:messageId`.
- `event: "test.ping"` is sent by the dashboard's **Test connection** button; answer with any HTTP 200.

### What Hermes answers

| Hermes wants to… | HTTP 200 body |
| --- | --- |
| Reply immediately | `{ "reply": "Hi John!" }` (add `"quote": true` to quote the incoming message) |
| Stay silent | `{ "reply": null, "ignored": true }` |
| Think longer, answer later | `{ "reply": null, "status": "processing" }` then call `POST /api/send` |

## REST API (Hermes → gateway)

All endpoints are on `http://127.0.0.1:3100`. Add `x-api-key: <GATEWAY_API_KEY>` when that is set.

| Endpoint | Body | Purpose |
| --- | --- | --- |
| `POST /api/send` | `{ "to": "<phone or chatJid>", "message": "...", "replyToMessageId"?: "..." }` | Send a text message (optionally quoting one) |
| `POST /api/presence` | `{ "recipient": "<chatJid>", "presence": "composing" \| "paused" \| "recording" \| "available" \| "unavailable" }` | Typing indicator |
| `POST /api/read` | `{ "messageId": "..." }` | Mark a received message as read (blue ticks) |
| `GET /api/media/:messageId` | – | Download the media of a recent message (raw bytes, correct `Content-Type`) |
| `POST /api/forwarding` | `{ "enabled": true \| false }` | Pause / resume forwarding to Hermes |
| `POST /api/webhook/test` | – | Ping Hermes |
| `GET /api/status` | – | Connection state, QR code, stats, recent messages |
| `GET /api/health` | – | Liveness probe (no auth) |
| `POST /api/connect` / `POST /api/logout` | – | Start the connection / unlink the device |

Errors always come back as JSON `{ "success": false, "error": "..." }` with a matching HTTP status (400 bad input, 404 not on WhatsApp, 503 not connected).

Example:

```bash
curl -X POST http://127.0.0.1:3100/api/send \
  -H "Content-Type: application/json" \
  -d '{"to": "60123456789", "message": "Hello from Hermes!"}'
```

See [HERMES_INTEGRATION_GUIDE.md](HERMES_INTEGRATION_GUIDE.md) for the full flow and a Python example, and [examples/hermes_agent_demo.ts](examples/hermes_agent_demo.ts) for a working Node.js agent.
