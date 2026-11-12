# Prompt for Hermes Agent: install the WhatsApp gateway

> Copy the block below into your Hermes agent (or any autonomous server assistant) running on the Linux server where Hermes lives.

---

````markdown
You are an autonomous engineer. Install and connect the "WhatsApp Agent Hermes" gateway and its Hermes webhook receiver on this server so that WhatsApp messages reach this Hermes agent and Hermes can reply safely in the owner's voice.

### Step 0: Immediate User Input (Master Credentials & Optional Gemini Voice Transcription)
**Immediately ask the user for:**
1. **Master Phone Number** (`MASTER_PHONE`): Their personal WhatsApp phone number with country code and digits only (e.g. `60123456789`). Required for escalations (`@@FLAG@@`), 1:1 Master DM command authority, and urgent alerts.
2. **Master Operator Name** (`MASTER_NAME`): Their real name (e.g. `Alex`, `Desmond`) so the agent speaks on their behalf in the first person ("I", "my") without exposing bot intermediaries.
3. **Gemini API Key for Voice-Note Transcription? (Optional)**: Ask whether they want to use a **Gemini API key** for voice-note transcription (higher accuracy on multilingual / Mandarin / Malay / Manglish + vocal vibe detection) **or skip/ignore it** to use **local `faster-whisper` out of the box** (works locally on CPU with zero API keys):
   - **If they want Gemini**: Ask them to paste their Gemini API key directly (if they did not already include it), and store it strictly in the **secret vault** in Step 4 (never echo the raw key back in chat and never write it into plaintext `.env` files).
   - **If they skip, decline, or ignore this question**: Do **not** block — proceed with local `faster-whisper` as the active transcription engine.

Do NOT proceed with `.env` or `receiver.env` configuration using blank or placeholder values for `MASTER_PHONE` or `MASTER_NAME`. Collect those up-front alongside their voice transcription choice.

### Step 1: Prerequisites
Check: `node -v` (v20 or v22+), `npm -v`, `python3 --version` (with `python3 -m venv`), `git --version`, and `systemctl --user --version`.

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

### Step 4: Configure Secrets, Secret Vault & Environment (Automatic — no manual human file editing)
Do NOT ask the human to edit `.env` files manually. Programmatically generate strong secrets, store any optional Gemini API key inside the secret vault, and write both configs:
1. Generate **two** distinct 48-hex-character secrets (`openssl rand -hex 24`):
   - `HERMES_SECRET_TOKEN`: Sent by the gateway as `x-hermes-token` so the receiver rejects unauthorized webhook callers.
   - `GATEWAY_API_KEY`: **Mandatory even on `127.0.0.1`**. Protects `/api/status`, `/api/send*`, `/api/media/*`, and `/api/logout` (`x-api-key` header) so untrusted contacts running with `web` tools cannot read private chats via loopback SSRF.
2. **Store Optional Gemini API Key in the Secret Vault (if provided in Step 0)**:
   - **Never** write the raw `GEMINI_API_KEY` into `~/whatsapp-agent-hermes/.env`, `~/whatsapp-hermes-receiver/receiver.env`, or echo it back in chat/logs.
   - If the user pasted a Gemini API key in Step 0:
     - Create the restricted vault directory `mkdir -p -m 700 ~/.hermes/vault` and write the key with `umask 077` into `~/.hermes/vault/gemini_api_key` (`chmod 600 ~/.hermes/vault/gemini_api_key`).
     - Also store it in Hermes's native encrypted vault if `hermes hvault` (`hermesvault`) is active/initialized on this host (`hermes hvault --help`).
   - If the user skipped or ignored the Gemini API key in Step 0: leave `~/.hermes/vault/gemini_api_key` absent so `receiver.py` automatically uses local `faster-whisper` out of the box.
3. Write `~/whatsapp-agent-hermes/.env`:
   - `PORT=3100`, `HOST=127.0.0.1`, `GATEWAY_API_KEY=<generated_api_key>`
   - `HERMES_WEBHOOK_URL=http://127.0.0.1:5000/api/webhook`, `HERMES_SECRET_TOKEN=<generated_webhook_token>`
   - `TIMEZONE=Asia/Kuala_Lumpur`, `DEFAULT_COUNTRY_CODE=60`, `FORWARD_GROUPS=true`
   - Mirror `MASTER_PHONE` and `MASTER_NAME` for operator reference (consumed at runtime by `receiver.env`).
4. Create `~/whatsapp-hermes-receiver/`, its Python virtualenv (`python3 -m venv ~/whatsapp-hermes-receiver/.venv`), install transcription dependencies so **both** engines are ready out of the box, and write `~/whatsapp-hermes-receiver/receiver.env` (`chmod 600` on both `.env` files):
   - Install audio packages inside `~/whatsapp-hermes-receiver/.venv`:
     ```bash
     ~/whatsapp-hermes-receiver/.venv/bin/pip install --upgrade pip faster-whisper "google-genai>=2.30.1"
     ```
   - If no Gemini API key was provided, pre-download the default `faster-whisper` model (`base`, `int8` CPU) now so the very first voice note transcribes immediately without cold-start download delay:
     ```bash
     ~/whatsapp-hermes-receiver/.venv/bin/python -c 'from faster_whisper import WhisperModel; WhisperModel("base", device="cpu", compute_type="int8")'
     ```
   - Write `~/whatsapp-hermes-receiver/receiver.env`:
     - `RECEIVER_PORT=5000`, `WHATSAPP_GATEWAY_URL=http://127.0.0.1:3100`
     - Same `HERMES_SECRET_TOKEN` and `GATEWAY_API_KEY`
     - `MASTER_PHONE=<from Step 0>`, `MASTER_LID=` (populate automatically once observed on first Master 1:1 DM), `MASTER_NAME=<from Step 0>`, `TIMEZONE=Asia/Kuala_Lumpur`
     - `GEMINI_API_KEY_FILE=/home/<user>/.hermes/vault/gemini_api_key`, `GEMINI_AUDIO_MODEL=gemini-3.8-flash`, `GEMINI_THINKING_LEVEL=low`
     - `WHISPER_MODEL=base`, `WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`

### Step 5: Install the Hermes Skills & Seed Live Templates
Install `wa-agent-SKILL.md` (with its companion `assets/`, `references/`, and `scripts/` directories) and the single-file `skill-crafter-SKILL.md` into Hermes's global skill directory, initialize the user-owned `whatsapp-agent-rules/SKILL.md` if not yet present (never overwrite existing learned rules), and seed the live hot-reloadable templates into `~/whatsapp-hermes-receiver/`:
```bash
mkdir -p ~/.hermes/skills/whatsapp-agent-hermes-gateway ~/.hermes/skills/skill-crafter ~/.hermes/skills/whatsapp-agent-rules ~/whatsapp-hermes-receiver/media
cp ~/whatsapp-agent-hermes/wa-agent-SKILL.md ~/.hermes/skills/whatsapp-agent-hermes-gateway/SKILL.md
cp -r ~/whatsapp-agent-hermes/skill/* ~/.hermes/skills/whatsapp-agent-hermes-gateway/
chmod +x ~/.hermes/skills/whatsapp-agent-hermes-gateway/scripts/fetch-pairing-qr.sh

# Install the single-file Skill Crafter meta-skill
cp ~/whatsapp-agent-hermes/skill-crafter-SKILL.md ~/.hermes/skills/skill-crafter/SKILL.md

# Seed the user-owned global WhatsApp rules skill ONLY if it does not exist yet (reinstall-safe)
if [ ! -f ~/.hermes/skills/whatsapp-agent-rules/SKILL.md ]; then
  cat > ~/.hermes/skills/whatsapp-agent-rules/SKILL.md <<'EOF'
---
name: whatsapp-agent-rules
description: "Owner-defined global rules, workflows, reply preferences, business facts, and per-contact instructions for operating and replying with the WhatsApp agent. Load whenever using WhatsApp tools, managing contacts/escalations, or drafting WhatsApp messages."
version: 1.0.0
---

# WhatsApp Agent — Learned Global Rules

## 1. Operator & Outbound Workflow Rules (Owner-Only)

## 2. Global Contact Reply Rules & Business Facts

## 3. Contact-Specific Rules
EOF
fi

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
- `~/.hermes/skills/skill-crafter/SKILL.md`

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
     "senderUsername": "alex_tan" | null,
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
     - Enforce strict principal gating: `AGENT_TOOLSETS_OWNER` + `prompt_template_owner.txt` ONLY when `isGroup == false` AND sender matches `MASTER_PHONE` / `MASTER_LID`. Wrap untrusted contact messages in `<untrusted_inbound_message>` tags, and hot-load Section 2 (plus only the matching contact's `###` block from Section 3) of `~/.hermes/skills/whatsapp-agent-rules/SKILL.md` into `[Trusted Operator Context]` so owner-taught rules take effect live without exposing Section 1 or other contacts' notes.
     - Transcribe voice notes dynamically based on the secret vault (`$CREDENTIALS_DIRECTORY/gemini_api_key` -> `GEMINI_API_KEY_FILE` `~/.hermes/vault/gemini_api_key` -> `hermes hvault` if active):
       - **If a Gemini API key is present**: Use **Gemini Audio** (`gemini-3.8-flash`, `thinking_level: "low"` or `"medium"`, `store=False`) to extract accurate multilingual/Manglish transcript + vocal vibe (`[voice note | vibe: polite | transcript: "..."]`). Never pass the key into `hermes chat -Q` subprocess environments, and if a configured Gemini key fails authentication/quota, log the error visibly and alert `MASTER_PHONE`.
       - **Else (no Gemini API key configured)**: Use local **`faster-whisper`** (`WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)`, `vad_filter=True`, lazy singleton) so voice transcription works out of the box with zero API keys (`[voice note | engine: faster-whisper | lang: ... | transcript: "..."]`).
     - Strip and forward `@@FLAG@@` lines first, then evaluate `NO_REPLY`, then run `sanitize_reply()` (ensuring WhatsApp `*bold*`, never Markdown `**bold**`).
     - Right before dispatching an approved reply: call `POST /api/read {"messageId": messageId}`, send chunk 1 via `POST /api/send`, and for split chunks `2..N` (`===MSG===`) show `presence: "composing"` for `~2.0s` between chunks before pausing presence.
4. **Gateway REST Helpers** (all require header `x-api-key: <GATEWAY_API_KEY>`; `to` accepts phone digits, `chatJid`, `@username`, or `@username#1234` with 4-digit PIN):
   - `POST /api/send`          `{ "to": chatJid | "@username", "message": "...", "pin"?: "1234", "replyToMessageId"?: messageId }`
   - `POST /api/send-image`    `{ "to": chatJid | "@username", "url": "...", "caption"?: "...", "pin"?: "1234", "replyToMessageId"?: messageId }`
   - `POST /api/send-document` `{ "to": chatJid | "@username", "url": "...", "fileName"?: "...", "caption"?: "...", "pin"?: "1234" }`
   - `POST /api/send-sticker`  `{ "to": chatJid | "@username", "url": "...", "pack"?: "...", "author"?: "...", "pin"?: "1234" }`
   - `GET  /api/resolve`       `?target=@username&pin=1234` -> `{ "success": true, "jid": "...@lid", "username": "...", "source": "cache" | "usync" }`
   - `GET  /api/usernames`     -> known `@username <-> jid` mappings cached from inbound chats, contacts sync, and USync
   - `POST /api/presence`      `{ "recipient": chatJid | "@username", "presence": "composing" | "paused" }`
   - `POST /api/read`          `{ "messageId": "..." }`
   - `GET  /api/media/<messageId>` -> raw media bytes

### Step 9: End-to-End Verification
1. `curl -s http://127.0.0.1:3100/api/health` -> `"whatsapp": "connected"`
2. `curl -s http://127.0.0.1:5000/health` -> `"ok": true`
3. `curl -s -X POST http://127.0.0.1:3100/api/webhook/test -H "x-api-key: $GATEWAY_API_KEY"` -> `"success": true, "status": 200`
4. Ask the human to send a test WhatsApp message (first from their `MASTER_PHONE` DM to verify `status` and capture `MASTER_LID` if applicable, then from a second phone to verify first-person `${MASTER_NAME}` reply style).
````
