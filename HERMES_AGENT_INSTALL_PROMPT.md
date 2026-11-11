# Prompt for Hermes Agent: install the WhatsApp gateway

> Copy the block below into your Hermes agent (or any autonomous server assistant) running on the Linux server where Hermes lives.

---

````markdown
You are an autonomous engineer. Install and connect the "WhatsApp Agent Hermes" gateway and its Hermes webhook receiver on this server so that WhatsApp messages reach this Hermes agent and Hermes can reply safely in the owner's voice.

### Step 0: Immediate User Input (Master Credentials)
**Immediately ask the user for:**
1. **Master Phone Number** (`MASTER_PHONE`): Their personal WhatsApp phone number with country code and digits only (e.g. `60123456789`). Required for escalations (`@@FLAG@@`), 1:1 Master DM command authority, and urgent alerts.
2. **Master Operator Name** (`MASTER_NAME`): Their real name (e.g. `Alex`, `Desmond`) so the agent speaks on their behalf in the first person ("I", "my") without exposing bot intermediaries.

Do NOT proceed with `.env` or `receiver.env` configuration using blank or placeholder credentials. Collect these two values up-front.

### Step 1: Prerequisites
Check: `node -v` (v20 or v22+), `npm -v`, `python3 --version`, `git --version`, and `systemctl --user --version`.

### Step 2: Get the code
```bash
cd ~
if [ -d ~/whatsapp-agent-hermes ]; then
  cd ~/whatsapp-agent-hermes && git pull
else
  git clone https://github.com/abbyabby3366/whatsapp-agent-hermes.git ~/whatsapp-agent-hermes
  cd ~/whatsapp-agent-hermes
fi
```

### Step 3: Install & build the gateway
```bash
npm install
npx tsc --noEmit        # must exit 0
npm run build           # compiles dist/ for production systemd execution
```

### Step 4: Configure Secrets & Environment (Automatic — no manual human file editing)
Do NOT ask the human to edit `.env` files manually. Programmatically generate strong secrets and write both configs:
1. Generate **two** distinct 48-hex-character secrets (`openssl rand -hex 24`):
   - `HERMES_SECRET_TOKEN`: Sent by the gateway as `x-hermes-token` so the receiver rejects unauthorized webhook callers.
   - `GATEWAY_API_KEY`: **Mandatory even on `127.0.0.1`**. Protects `/api/status`, `/api/send*`, `/api/media/*`, and `/api/logout` (`x-api-key` header) so untrusted contacts running with `web` tools cannot read private chats via loopback SSRF.
2. Write `~/whatsapp-agent-hermes/.env`:
   - `PORT=3100`, `HOST=127.0.0.1`, `GATEWAY_API_KEY=<generated_api_key>`
   - `HERMES_WEBHOOK_URL=http://127.0.0.1:5000/api/webhook`, `HERMES_SECRET_TOKEN=<generated_webhook_token>`
   - `TIMEZONE=Asia/Kuala_Lumpur`, `DEFAULT_COUNTRY_CODE=60`, `FORWARD_GROUPS=true`
   - Mirror `MASTER_PHONE` and `MASTER_NAME` for operator reference (consumed at runtime by `receiver.env`).
3. Create `~/whatsapp-hermes-receiver/` and write `~/whatsapp-hermes-receiver/receiver.env` (`chmod 600` on both `.env` files):
   - `RECEIVER_PORT=5000`, `WHATSAPP_GATEWAY_URL=http://127.0.0.1:3100`
   - Same `HERMES_SECRET_TOKEN` and `GATEWAY_API_KEY`
   - `MASTER_PHONE=<from Step 0>`, `MASTER_LID=` (populate automatically once observed on first Master 1:1 DM), `MASTER_NAME=<from Step 0>`, `TIMEZONE=Asia/Kuala_Lumpur`

### Step 5: Install the Hermes Skill & Seed Live Templates
Install `wa-agent-SKILL.md` and its companion `assets/`, `references/`, and `scripts/` directories into Hermes's skill directory, and seed the live hot-reloadable templates into `~/whatsapp-hermes-receiver/`:
```bash
mkdir -p ~/.hermes/skills/whatsapp-agent-hermes-gateway ~/whatsapp-hermes-receiver/media
cp ~/whatsapp-agent-hermes/wa-agent-SKILL.md ~/.hermes/skills/whatsapp-agent-hermes-gateway/SKILL.md
cp -r ~/whatsapp-agent-hermes/skill/* ~/.hermes/skills/whatsapp-agent-hermes-gateway/
chmod +x ~/.hermes/skills/whatsapp-agent-hermes-gateway/scripts/fetch-pairing-qr.sh

# Seed live prompt templates (substitute ${MASTER_NAME} or interpolate dynamically per turn) and QR helper
cp ~/whatsapp-agent-hermes/skill/assets/prompt_template.txt ~/whatsapp-hermes-receiver/prompt_template.txt
cp ~/whatsapp-agent-hermes/skill/assets/prompt_template_owner.txt ~/whatsapp-hermes-receiver/prompt_template_owner.txt
cp ~/whatsapp-agent-hermes/skill/scripts/fetch-pairing-qr.sh ~/whatsapp-hermes-receiver/get-qr.sh
chmod +x ~/whatsapp-hermes-receiver/get-qr.sh
```
Read all installed skill files carefully before writing receiver code:
- `~/.hermes/skills/whatsapp-agent-hermes-gateway/SKILL.md`
- `~/.hermes/skills/whatsapp-agent-hermes-gateway/references/hermes-backend-contract.md`
- `~/.hermes/skills/whatsapp-agent-hermes-gateway/references/deployment-and-env.md`

### Step 6: Run Gateway via `systemd --user` (Do NOT mix with `pm2`)
Use `systemd --user` with user lingering enabled (`sudo loginctl enable-linger "$USER"`) as specified in `references/deployment-and-env.md` so all operational commands (`systemctl --user`, `journalctl --user`) work consistently:
- Create and start `~/.config/systemd/user/whatsapp-agent-hermes.service`.
- Verify public liveness: `curl -s http://127.0.0.1:3100/api/health` -> `{"success":true,"whatsapp":"qr_ready"|"connected",...}`
- Verify auth lock: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/api/status` -> `401` (and `200` when passing `-H "x-api-key: $GATEWAY_API_KEY"`).

### Step 7: Pair WhatsApp
Either:
- Run `~/whatsapp-hermes-receiver/get-qr.sh /tmp/wa-qr.png` and send `/tmp/wa-qr.png` to the human, OR
- Have the human open `http://localhost:3100` via SSH tunnel (`ssh -L 3100:127.0.0.1:3100 user@server`), enter `GATEWAY_API_KEY` when prompted by the dashboard, and scan the QR code (**WhatsApp -> Linked devices -> Link a device**).

### Step 8: Implement & Start the Webhook Receiver (`~/whatsapp-hermes-receiver/`)
Implement the receiver modules in `~/whatsapp-hermes-receiver/` (`receiver.py`, `history.py`, `flow.py`, `outbox.py`, `wa_send.py`) following `SKILL.md` and `references/hermes-backend-contract.md`, then enable `hermes-wa-receiver.service` under `systemd --user`:

1. **Auth**: Listen on `127.0.0.1:5000/api/webhook`. Reject missing/mismatched `x-hermes-token` with HTTP 401. Include `-H "x-api-key: $GATEWAY_API_KEY"` on every REST call back to `:3100/api/*`.
2. **Inbound Webhook Payload (`POST /api/webhook`)**:
   ```json
   {
     "event": "message.received" | "test.ping",
     "messageId": "3EB0ABC12345",
     "sender": "60123456789" | null,
     "senderName": "Customer Name" | null,
     "senderJid": "60123456789@s.whatsapp.net",
     "chatJid": "60123456789@s.whatsapp.net",
     "remoteJid": "60123456789@s.whatsapp.net",
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
     "timezone": "Asia/Kuala_Lumpur",
     "isoTimestamp": "2026-10-08T12:15:30.000Z",
     "rawTimestamp": 1791461730
   }
   ```
3. **Webhook Response Modes (must answer within 15 seconds)**:
   - For `"event": "test.ping"` -> HTTP 200 `{"ok": true}`.
   - Group filtering -> If `isGroup: true` and neither `mentionsMe` nor `isReplyToMe` is true, immediately return HTTP 200 `{"reply": null, "ignored": true}`.
   - Synchronous quick replies (optional) -> `{"reply": "text", "quote": true}` or sticker `{"sticker": "https://...", "pack": "...", "author": "..."}`.
   - Production async path (standard) -> Immediately return HTTP 200 `{"reply": null, "status": "processing"}` and process in the background worker:
     - Coalesce rapid bursts (`2.5s` window) and supersede in-flight drafts on new arrivals.
     - **Do NOT** call `/api/read` or `presence: "composing"` while drafting the first reply.
     - Enforce strict principal gating: `AGENT_TOOLSETS_OWNER` + `prompt_template_owner.txt` ONLY when `isGroup == false` AND sender matches `MASTER_PHONE` / `MASTER_LID`. Wrap untrusted contact messages in `<untrusted_inbound_message>` tags.
     - Transcribe voice notes using **Gemini Audio** (`LOW` or `MEDIUM` thinking — never Whisper).
     - Strip and forward `@@FLAG@@` lines first, then evaluate `NO_REPLY`, then run `sanitize_reply()` (ensuring WhatsApp `*bold*`, never Markdown `**bold**`).
     - Right before dispatching an approved reply: call `POST /api/read {"messageId": messageId}`, send chunk 1 via `POST /api/send`, and for split chunks `2..N` (`===MSG===`) show `presence: "composing"` for `~2.0s` between chunks before pausing presence.
4. **Gateway REST Helpers** (all require header `x-api-key: <GATEWAY_API_KEY>`):
   - `POST /api/send`          `{ "to": chatJid, "message": "...", "replyToMessageId"?: messageId }`
   - `POST /api/send-image`    `{ "to": chatJid, "url": "...", "caption"?: "...", "replyToMessageId"?: messageId }`
   - `POST /api/send-document` `{ "to": chatJid, "url": "...", "fileName"?: "...", "caption"?: "..." }`
   - `POST /api/send-sticker`  `{ "to": chatJid, "url": "...", "pack"?: "...", "author"?: "..." }`
   - `POST /api/presence`      `{ "recipient": chatJid, "presence": "composing" | "paused" }`
   - `POST /api/read`          `{ "messageId": "..." }`
   - `GET  /api/media/<messageId>` -> raw media bytes

### Step 9: End-to-End Verification
1. `curl -s http://127.0.0.1:3100/api/health` -> `"whatsapp": "connected"`
2. `curl -s http://127.0.0.1:5000/health` -> `"ok": true`
3. `curl -s -X POST http://127.0.0.1:3100/api/webhook/test -H "x-api-key: $GATEWAY_API_KEY"` -> `"success": true, "status": 200`
4. Ask the human to send a test WhatsApp message (first from their `MASTER_PHONE` DM to verify `status` and capture `MASTER_LID` if applicable, then from a second phone to verify first-person `${MASTER_NAME}` reply style).
````
