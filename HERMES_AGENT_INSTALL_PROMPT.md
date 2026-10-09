# Prompt for Hermes Agent: install the WhatsApp gateway

> Copy the block below into your Hermes agent (or any autonomous server assistant) running on the server where Hermes lives.

---

```markdown
You are an autonomous engineer. Install and connect the "WhatsApp Agent Hermes" gateway on this server so that WhatsApp messages reach this Hermes agent and Hermes can reply.

### Step 1: Prerequisites
Check: `node -v` (v20 or v22), `npm -v`, `git --version`.

### Step 2: Get the code
git clone https://github.com/abbyabby3366/whatsapp-agent-hermes.git
cd whatsapp-agent-hermes
(if it already exists: cd whatsapp-agent-hermes && git pull)

### Step 3: Install
npm install
npx tsc --noEmit        # must exit 0

### Step 4: Configure
cp .env.example .env
Edit .env:
- PORT=3100, HOST=127.0.0.1 (Hermes is on this machine; keep it loopback).
- HERMES_WEBHOOK_URL = the HTTP endpoint where THIS Hermes agent will receive webhooks (e.g. http://127.0.0.1:5000/api/webhook).
- HERMES_SECRET_TOKEN = generate a long random string; store the same value in Hermes's config.
- MASTER_PHONE = your WhatsApp phone number with country code (e.g. 60123456789) for escalations and master commands.
- MASTER_NAME = your name (e.g. Alex) so the bot speaks on your behalf in the first person.
- Leave GATEWAY_API_KEY empty unless HOST is changed to 0.0.0.0.

### Step 5: Install and learn the operational skill
Install `wa-agent-SKILL.md` into Hermes's skill directory so this agent permanently retains these operational rules:
```bash
mkdir -p ~/.hermes/skills/whatsapp-agent-hermes-gateway
cp wa-agent-SKILL.md ~/.hermes/skills/whatsapp-agent-hermes-gateway/SKILL.md
```
Study `wa-agent-SKILL.md` carefully: it contains the complete production receiver architecture, voice standards (speaking as `${MASTER_NAME}` in first person), master chat command authority, burst grouping, contact flow store (`flow.py`), and error 463 handling.

### Step 6: Run the gateway
Development:  npm run dev
Production:   npm run build && npm install -g pm2 && pm2 start npm --name whatsapp-agent-hermes -- start && pm2 save
Verify:       curl http://127.0.0.1:3100/api/health   -> {"success":true,"whatsapp":"qr_ready"|"connected",...}

### Step 7: Pair WhatsApp
Tell the human to open http://localhost:3100 (or an SSH tunnel: ssh -L 3100:127.0.0.1:3100 user@server) and scan the QR code with WhatsApp -> Linked devices -> Link a device. The dashboard turns to "Connected".

### Step 8: Implement the webhook receiver in Hermes
Listen for POST requests at HERMES_WEBHOOK_URL. Reject requests whose "x-hermes-token" header differs from HERMES_SECRET_TOKEN (HTTP 401). Refer to `wa-agent-SKILL.md` for the full implementation (SQLite history injection, burst coalescing, and quote-replies).

Incoming body:
{
  "event": "message.received" | "test.ping",
  "messageId": "3EB0ABC12345",
  "sender": "60123456789" | null,        // phone number; null when WhatsApp hides it
  "senderName": "Customer Name" | null,
  "senderJid": "60123456789@s.whatsapp.net",
  "chatJid": "60123456789@s.whatsapp.net", // ALWAYS reply to this
  "isGroup": false,
  "groupJid": null,
  "message": "Hello, I need help",
  "messageType": "text" | "image" | "video" | "voice" | "audio" | "document" | "sticker" | "location" | "contact" | "other",
  "hasMedia": false,
  "mimetype": null,
  "mentionsMe": false,
  "isReplyToMe": false,
  "quoted": null | { "messageId": "...", "message": "..." },
  "timestamp": "08-10-2026 20:15:30",
  "isoTimestamp": "2026-10-08T12:15:30.000Z"
}

For event "test.ping" answer HTTP 200 with any JSON.

For "message.received" decide and answer HTTP 200 with one of:
A) Reply now:        { "reply": "text", "quote": true }
B) Stay silent:      { "reply": null, "ignored": true }
C) Think longer:     { "reply": null, "status": "processing" }  then later:
   POST http://127.0.0.1:3100/api/presence  { "recipient": chatJid, "presence": "composing" }
   ... run tools / LLM ...
   POST http://127.0.0.1:3100/api/send      { "to": chatJid, "message": "result", "replyToMessageId": messageId }

Group chats: If "isGroup": true and neither "mentionsMe" nor "isReplyToMe" is true, choose option B (stay silent) so the bot doesn't spam groups.

Optional helpers (if GATEWAY_API_KEY is configured in .env, add header `x-api-key: <key>` to all requests):
   POST /api/send-image    { "to": chatJid, "url": "https://...", "caption": "..." } -> send image
   POST /api/send-document { "to": chatJid, "url": "https://...", "fileName": "...", "caption": "..." } -> send document (PDF, doc, xls, etc.)
   POST /api/send-sticker  { "to": chatJid, "url": "https://...", "pack": "...", "author": "..." } -> send sticker (auto-formatted to 512x512 WebP)
   POST /api/read   { "messageId": "..." }   -> mark as read
   GET  /api/media/<messageId>               -> download image / voice note / document bytes

Answer the webhook within 15 seconds; if the task takes longer use option C.

### Step 9: Verify
curl -X POST http://127.0.0.1:3100/api/webhook/test      -> "success": true, "status": 200
Ask the human to send a WhatsApp message to the linked number from another phone, then check Hermes's logs and the dashboard's "Recent activity" list.
```
