# WhatsApp AI Agent

A Baileys WhatsApp gateway **and** built-in Node webhook receiver that connects a WhatsApp account to your **AI Agent** on the same server (Node.js `>= 22.5.0`, zero Python dependencies):

1. A WhatsApp message arrives → the gateway (`:3100`) `POST`s it to your AI Agent or the built-in receiver (`:5000`, `AGENT_WEBHOOK_URL`).
2. The built-in receiver coalesces bursts (`2.5s`), transcribes voice notes locally in pure Node (`@huggingface/transformers` + `ffmpeg-static`, `onnx-community/whisper-base`), runs your configured AI Agent runner (`AGENT_BIN`) cleanly in a sandboxed or verified 1:1 Master turn, and replies with human typing cadence.
3. The dashboard at `http://localhost:3100` shows the QR code, connection state, and every message with what the AI Agent did with it.

Built on Express + the Baileys fork [`github:JonathanChuahE-Jay/Baileys`](https://github.com/JonathanChuahE-Jay/Baileys).

## One-Command Server Install (Production)

Requires **Node.js `>= 22.5.0`** and `npm`:

```bash
git clone https://github.com/abbyabby3366/whatsapp-agent-hermes.git ~/whatsapp-ai-agent
cd ~/whatsapp-ai-agent
bash scripts/install.sh --master-phone 60123456789 --master-name "Alex"
```

This idempotently generates `chmod 600` `.env` & `~/whatsapp-ai-agent-receiver/receiver.env`, builds `dist/`, installs global skills (`~/.whatsapp-ai-agent/skills/`), creates `~/.local/bin/{wa-send,wa-history,wa-flow,wa-qr}`, pre-warms ONNX Whisper, configures & starts both `systemd --user` services (`whatsapp-ai-agent` + `wa-agent-receiver`), and verifies health, `401` auth lock, and webhook ping.

Pair WhatsApp via PNG export or the dashboard:

```bash
~/.local/bin/wa-qr /tmp/wa-qr.png
```

## Quick Local Dev Start

```bash
npm install
cp .env.example .env            # then edit GATEWAY_API_KEY / AGENT_SECRET_TOKEN
npm run dev                     # hot-reloading gateway (:3100)
# optional in a second terminal:
npm run dev:receiver            # hot-reloading built-in receiver (:5000)
# or run the minimal demo webhook instead:
npm run demo:agent
```

Production build & run without `systemd`:

```bash
npm run build
npm start                       # gateway (:3100)
npm run start:receiver          # built-in receiver (:5000)
```

## Built-In CLI Tools (`~/.local/bin/`)

```bash
wa-qr /tmp/wa-qr.png
wa-send text    <phone|@username|@username#PIN|chatJid> "Message"
wa-send image   <recipient> /path/to/photo.jpg "Caption"
wa-send doc     <recipient> /path/to/file.pdf "Caption" --name report.pdf
wa-send sticker <recipient> /path/to/sticker.png "Pack" "Author"
wa-history stats | chats [limit] | recent <chat_key> [limit] | search "<keyword>"
wa-flow contacts | show <key> | open <key> "<item>" | close <key> "<item>" | fact <key> "<fact>" | event <key> "<event>"
```

(`wa-send` automatically encodes local files outside `ALLOWED_MEDIA_DIR` as `data:<mime>;base64,...` URIs up to `MAX_MEDIA_BYTES`, eliminating any separate local media server.)

## Configuration (`.env` & `receiver.env`)

See [`.env.example`](.env.example) for gateway settings, [`receiver.env.example`](receiver.env.example) for built-in receiver settings, and [`skill/references/deployment-and-env.md`](skill/references/deployment-and-env.md) for the full tunables table:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3100` / `127.0.0.1` | Gateway bind port and host |
| `GATEWAY_API_KEY` | *(recommended)* | Shared key required on every `/api/*` call (`x-api-key` or Bearer, except `/api/health`) |
| `AGENT_WEBHOOK_URL` | `http://127.0.0.1:5000/api/webhook` | Webhook target for inbound messages |
| `AGENT_SECRET_TOKEN` | *(recommended)* | Sent as `x-agent-token` so the receiver rejects unauthorized callers |
| `AGENT_WEBHOOK_TIMEOUT_MS` / `AGENT_WEBHOOK_RETRIES` | `15000` / `2` | Webhook HTTP timeout and retry count on 5xx/network errors |
| `WEBHOOK_CONCURRENCY` | `8` | Max concurrent outbound webhooks to AI Agent |
| `ALLOWED_MEDIA_DIR` / `MAX_MEDIA_BYTES` | `./data/media` / `26214400` | Allowed directory for raw path sends and 25 MiB media ceiling |
| `DEFAULT_COUNTRY_CODE` | `60` | Prefix for numbers starting with `0` |
| `ALLOWED_NUMBERS` | *(empty)* | Comma-separated phone numbers and/or `@usernames` allowed to reach AI Agent |
| `FORWARD_GROUPS` | `true` | Forward group chats to AI Agent |
| `TIMEZONE` | `Asia/Kuala_Lumpur` | IANA timezone (`GMT+8`) of timestamps (`DD-MM-YY`) |
| `SESSIONS_DIR` / `DATA_DIR` | `./sessions` / `./data` | WhatsApp credentials / persisted settings, username directory, and activity log |

## Webhook: gateway → AI Agent

`POST AGENT_WEBHOOK_URL` with header `x-agent-token: <AGENT_SECRET_TOKEN>` and body:

```json
{
  "event": "message.received",
  "messageId": "3EB0ABC123456789",
  "sender": "60123456789",
  "senderName": "John Doe",
  "senderUsername": "johndoe",
  "senderJid": "60123456789@s.whatsapp.net",
  "chatJid": "60123456789@s.whatsapp.net",
  "isGroup": false,
  "groupJid": null,
  "message": "Hello, can you help?",
  "messageType": "text",
  "hasMedia": false,
  "mimetype": null,
  "fileName": null,
  "mentionsMe": false,
  "isReplyToMe": false,
  "quoted": null,
  "timestamp": "08-10-26 20:15:30",
  "timezone": "Asia/Kuala_Lumpur",
  "isoTimestamp": "2026-10-08T12:15:30.000Z",
  "rawTimestamp": 1791461730
}
```

- `sender` can be `null` when WhatsApp only exposes an anonymous ID (common in groups). **Always reply to `chatJid`.**
- `messageType` is one of `text | image | video | voice | audio | document | sticker | location | contact | other`. For media, `message` holds the caption or a placeholder like `[Voice message]`; download the file with `GET /api/media/:messageId`.
- `event: "test.ping"` is sent by the dashboard's **Test connection** button; answer with any HTTP 200.

## REST API (AI Agent → gateway)

All endpoints are on `http://127.0.0.1:3100`. Add `x-api-key: <GATEWAY_API_KEY>` when set (required for every route except `/api/health`).

| Endpoint | Body / Query | Purpose |
| --- | --- | --- |
| `POST /api/send` | `{ "to": "<phone, @username, or chatJid>", "message": "...", "pin"?: "1234", "replyToMessageId"?: "..." }` | Send a text message (supports `@username` or `@username#1234` PIN) |
| `POST /api/send-image` | `{ "to": "<phone, @username, or chatJid>", "url": "...", "caption"?: "...", "pin"?: "1234", "replyToMessageId"?: "..." }` | Send an image (URL, local file, or data URI) |
| `POST /api/send-document` | `{ "to": "<phone, @username, or chatJid>", "url": "...", "fileName"?: "...", "caption"?: "...", "pin"?: "1234", "replyToMessageId"?: "..." }` | Send a document (URL, local file, or data URI) |
| `POST /api/send-sticker` | `{ "to": "<phone, @username, or chatJid>", "url": "...", "pack"?: "...", "author"?: "...", "pin"?: "1234", "replyToMessageId"?: "..." }` | Send a sticker (URL, local file, or data URI; auto-converts to 512x512 WebP with optional EXIF) |
| `GET /api/resolve` | `?target=@username&pin=1234` (or `POST` body) | Resolve a `@username` or phone number to a canonical WhatsApp JID (`@lid` / `@s.whatsapp.net`) |
| `GET /api/usernames` | – | List cached `@username <-> JID` mappings learned from chats, contacts, and USync |
| `POST /api/presence` | `{ "recipient": "<chatJid or @username>", "presence": "composing" \| "paused" \| "recording" \| "available" \| "unavailable" }` | Typing indicator |
| `POST /api/read` | `{ "messageId": "..." }` | Mark a received message as read (blue ticks) |
| `GET /api/media/:messageId` | – | Download the media of a recent message (raw bytes, correct `Content-Type`) |
| `GET /api/qr.png` | – | Download current pairing QR code as raw `image/png` (`404` if not ready, `409` if connected) |
| `POST /api/forwarding` | `{ "enabled": true \| false }` | Pause / resume forwarding to AI Agent |
| `POST /api/webhook/test` | – | Ping AI Agent |
| `GET /api/status` | – | Connection state, QR code, stats, recent messages |
| `GET /api/events` | – | Server-Sent Events (`event: status`) live gateway state stream |
| `GET /api/health` | – | Liveness probe (no auth) |
| `POST /api/connect` / `POST /api/logout` | – | Start the connection / unlink the device |

Errors always come back as JSON `{ "success": false, "error": "..." }` with a matching HTTP status (400 bad input, 404 not on WhatsApp, 503 not connected).

See [AI_AGENT_INSTALL_PROMPT.md](AI_AGENT_INSTALL_PROMPT.md) for the streamlined installation prompt, [wa-agent-SKILL.md](wa-agent-SKILL.md) (plus companion templates/references in [`skill/`](skill/)) for the operational AI Agent skill, [skill-crafter-SKILL.md](skill-crafter-SKILL.md) for the single-file global skill-persistence meta-skill, and [examples/ai_agent_demo.ts](examples/ai_agent_demo.ts) for a working Node.js demo receiver.
