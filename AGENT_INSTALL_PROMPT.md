# Prompt for AI Agent: Install the WhatsApp AI Agent

> Copy the block below into your AI coding/server agent (Claude Code, Codex, OpenClaw, Cursor, Antigravity, or any autonomous Linux assistant) on the server where your WhatsApp agent will run.

---

````markdown
You are an autonomous engineer. Install and connect the "WhatsApp AI Agent" gateway and its Python AI webhook receiver on this server so that WhatsApp messages reach your AI brain and reply safely in the owner's first-person voice.

### Step 0: Probe Current AI Provider & Collect Immediate User Input
**First — Probe Your Own AI Provider (Before Asking Questions)**:
The WhatsApp webhook receiver (`receiver.py`) must use the **same AI provider as you (the current AI agent)** so it works seamlessly without assuming any specific third-party agent framework:
1. Check how you are currently authenticated on this machine:
   - **Authenticated Host Agent CLI (`BRAIN_MODE=cli`)**: Check if your own local CLI (`claude`, `codex`, `gemini`, etc.) is installed (`command -v ...`) and run a **real 1-line non-interactive test** (e.g. prompt `"Reply with exact word OK"`).
   - **Direct LLM Provider Credentials (`BRAIN_MODE=api`)**: Otherwise, check the LLM provider credentials/config already present on this machine (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` + `OPENAI_BASE_URL`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, or your local agent config file) and run a **real 1-request HTTP completion smoke test** (`Reply OK`, `max_tokens=8`).
2. **CRITICAL — Never Trust Unverified Sandbox Proxies**: Hosted sandboxes often expose internal proxy URLs that return HTTP `401` / `402` (`budget exhausted`) / `403` when called by background Python services. Only mark a provider as verified if your live `"OK"` test returns HTTP `200` with non-empty text! Never finish setup with `brain: none`.

**Second — Ask the User Up-Front (Single Concise Message)**:
1. **Master Phone Number** (`MASTER_PHONE`): Their personal WhatsApp phone number with country code and digits only (e.g. `60123456789`). Required for escalations (`@@FLAG@@`), 1:1 Master DM command authority, and urgent alerts.
2. **Master Operator Name** (`MASTER_NAME`): Their real name (e.g. `Alex`, `Desmond`) so the agent speaks on their behalf in the first person ("I", "my") without exposing bot intermediaries.
3. **LLM Provider + API Key (ONLY ask if your Step 0 live provider smoke test failed!)**:
   - If reusing your current AI agent's CLI or API provider **passed** the live `"OK"` smoke test, tell the user which provider/model you detected and reuse it automatically without asking for another key.
   - If your live smoke test **failed** (e.g. no local agent CLI and sandbox endpoint returned `401`/`402`/`403` or no credentials exist in the VM), ask the user right now for an **LLM Provider** (`openai`, `openrouter`, `anthropic`, `gemini`, or custom OpenAI-compatible `base_url` + `model`) and **API Key**, verify it with a live `"OK"` test, and save the key into `~/.whatsapp-agent/vault/llm_api_key` (`chmod 600`).

*(Do NOT ask for a Gemini API key during initial setup — configure local `faster-whisper` out of the box automatically so setup stays minimal. If the user ever pastes a Gemini API key on their own or later in 1:1 Master DM, save it into `~/.whatsapp-agent/vault/gemini_api_key` with `chmod 600`.)*

Do NOT proceed with `.env` or `receiver.env` configuration using blank/placeholder `MASTER_PHONE`, `MASTER_NAME`, or an unverified AI brain.

### Step 1: Prerequisites
Check: `node -v` (v20 or v22+), `npm -v`, `python3 --version` (with `python3 -m venv`), `git --version`, and `systemctl --user --version`.

### Step 2: Get the code
```bash
cd ~
if [ -d ~/whatsapp-agent-gateway ]; then
  cd ~/whatsapp-agent-gateway && git pull
else
  git clone https://github.com/abbyabby3366/whatsapp-agent-hermes.git ~/whatsapp-agent-gateway
  cd ~/whatsapp-agent-gateway
fi
```

### Step 3: Install & build the gateway
```bash
npm install
npx tsc --noEmit        # must exit 0
npm run build           # compiles dist/ for production systemd execution
```

### Step 4: Configure Secrets, Secret Vault & Environment (Automatic — no manual human file editing)
Do NOT ask the human to edit `.env` files manually. Programmatically generate strong secrets, populate the restricted secret vault, and write both configs:
1. Generate **two** distinct 48-hex-character secrets (`openssl rand -hex 24`):
   - `AGENT_SECRET_TOKEN`: Sent by the gateway as `x-agent-token` so the receiver rejects unauthorized webhook callers.
   - `GATEWAY_API_KEY`: **Mandatory even on `127.0.0.1`**. Protects `/api/status`, `/api/send*`, `/api/media/*`, and `/api/logout` (`x-api-key` header) so untrusted external contacts cannot read private chats via loopback SSRF.
2. **Populate the Secret Vault (`~/.whatsapp-agent/vault/`)**:
   - Create `mkdir -p -m 700 ~/.whatsapp-agent/vault`. Never write raw LLM or Gemini API keys into `.env` or `receiver.env`, and never echo them in logs/chat.
   - If `BRAIN_MODE=api`: write the verified LLM API key with `umask 077` into `~/.whatsapp-agent/vault/llm_api_key` (`chmod 600`).
   - Leave `~/.whatsapp-agent/vault/gemini_api_key` absent by default so `receiver.py` uses local `faster-whisper` out of the box (unless the user explicitly pasted a Gemini API key, in which case save it with `umask 077` and `chmod 600`).
3. Write `~/whatsapp-agent-gateway/.env` (`chmod 600`):
   - `PORT=3100`, `HOST=127.0.0.1`, `GATEWAY_API_KEY=<generated_api_key>`
   - `AGENT_WEBHOOK_URL=http://127.0.0.1:5000/api/webhook`, `AGENT_SECRET_TOKEN=<generated_webhook_token>`
   - `TIMEZONE=Asia/Kuala_Lumpur`, `DEFAULT_COUNTRY_CODE=60`, `FORWARD_GROUPS=true`
   - Mirror `MASTER_PHONE` and `MASTER_NAME` for operator reference.
4. Create `~/whatsapp-agent-receiver/`, its Python virtualenv (`python3 -m venv ~/whatsapp-agent-receiver/.venv`), install runtime + transcription dependencies, and write `~/whatsapp-agent-receiver/receiver.env` (`chmod 600`):
   - Install dependencies inside `~/whatsapp-agent-receiver/.venv`:
     ```bash
     ~/whatsapp-agent-receiver/.venv/bin/pip install --upgrade pip httpx faster-whisper "google-genai>=2.30.1"
     ```
   - Pre-download the default `faster-whisper` model (`base`, `int8` CPU) now so the very first voice note transcribes immediately out of the box without cold-start download delay:
     ```bash
     ~/whatsapp-agent-receiver/.venv/bin/python -c 'from faster_whisper import WhisperModel; WhisperModel("base", device="cpu", compute_type="int8")'
     ```
   - Write `~/whatsapp-agent-receiver/receiver.env`:
     - `RECEIVER_PORT=5000`, `WHATSAPP_GATEWAY_URL=http://127.0.0.1:3100`
     - Same `AGENT_SECRET_TOKEN` and `GATEWAY_API_KEY`
     - `MASTER_PHONE=<from Step 0>`, `MASTER_LID=` (populate automatically once observed on first Master 1:1 DM), `MASTER_NAME=<from Step 0>`, `TIMEZONE=Asia/Kuala_Lumpur`
     - Verified brain settings (`BRAIN_MODE=api` with `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY_FILE=/home/<user>/.whatsapp-agent/vault/llm_api_key`; OR `BRAIN_MODE=cli` with `AGENT_CLI_TYPE` and `AGENT_CLI_BIN=/abs/path/to/cli`)
     - `GEMINI_API_KEY_FILE=/home/<user>/.whatsapp-agent/vault/gemini_api_key`, `GEMINI_AUDIO_MODEL=gemini-3.8-flash`, `GEMINI_THINKING_LEVEL=low`
     - `WHISPER_MODEL=base`, `WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`
     - `SKILLS_DIR=/home/<user>/.whatsapp-agent/skills`

### Step 5: Install Global Skills, Auto-Link to Host Agent & Seed Live Templates
Install `wa-agent-SKILL.md` (with `assets/`, `references/`, `scripts/`) and the single-file `skill-crafter-SKILL.md` into `~/.whatsapp-agent/skills/`, initialize reinstall-safe `whatsapp-agent-rules/SKILL.md` if not yet present, symlink all three skills into whichever skill root(s) the current AI agent uses (`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, etc.), and seed live templates into `~/whatsapp-agent-receiver/`:
```bash
mkdir -p ~/.whatsapp-agent/skills/whatsapp-agent-gateway ~/.whatsapp-agent/skills/skill-crafter ~/.whatsapp-agent/skills/whatsapp-agent-rules ~/whatsapp-agent-receiver/media
cp ~/whatsapp-agent-gateway/wa-agent-SKILL.md ~/.whatsapp-agent/skills/whatsapp-agent-gateway/SKILL.md
cp -r ~/whatsapp-agent-gateway/skill/* ~/.whatsapp-agent/skills/whatsapp-agent-gateway/
chmod +x ~/.whatsapp-agent/skills/whatsapp-agent-gateway/scripts/fetch-pairing-qr.sh

# Install the single-file Skill Crafter meta-skill
cp ~/whatsapp-agent-gateway/skill-crafter-SKILL.md ~/.whatsapp-agent/skills/skill-crafter/SKILL.md

# Seed the user-owned global WhatsApp rules skill ONLY if it does not exist yet (reinstall-safe)
if [ ! -f ~/.whatsapp-agent/skills/whatsapp-agent-rules/SKILL.md ]; then
  cat > ~/.whatsapp-agent/skills/whatsapp-agent-rules/SKILL.md <<'EOF'
---
name: whatsapp-agent-rules
description: "Owner-defined global rules, workflows, reply preferences, business facts, and per-contact instructions for operating and replying with the WhatsApp AI Agent. Load whenever using WhatsApp tools, managing contacts/escalations, or drafting WhatsApp messages."
version: 1.0.0
---

# WhatsApp AI Agent — Learned Global Rules

## 1. Operator & Outbound Workflow Rules (Owner-Only)

## 2. Global Contact Reply Rules & Business Facts

## 3. Contact-Specific Rules
EOF
fi

# Symlink skills into active host AI agent skill directories (always include ~/.agents/skills + any existing agent roots)
mkdir -p ~/.agents/skills
for agent_root in ~/.agents ~/.claude ~/.codex ~/.cursor ~/.openclaw; do
  if [ -d "$agent_root" ]; then
    mkdir -p "$agent_root/skills"
    for slug in whatsapp-agent-gateway skill-crafter whatsapp-agent-rules; do
      ln -sfn "$HOME/.whatsapp-agent/skills/$slug" "$agent_root/skills/$slug"
    done
  fi
done

# Seed live prompt templates (substitute ${MASTER_NAME} or interpolate dynamically per turn) and QR helper
cp ~/whatsapp-agent-gateway/skill/assets/prompt_template.txt ~/whatsapp-agent-receiver/prompt_template.txt
cp ~/whatsapp-agent-gateway/skill/assets/prompt_template_owner.txt ~/whatsapp-agent-receiver/prompt_template_owner.txt
cp ~/whatsapp-agent-gateway/skill/scripts/fetch-pairing-qr.sh ~/whatsapp-agent-receiver/get-qr.sh
chmod +x ~/whatsapp-agent-receiver/get-qr.sh
```
Read all installed skill files carefully before writing receiver code:
- `~/.whatsapp-agent/skills/whatsapp-agent-gateway/SKILL.md`
- `~/.whatsapp-agent/skills/whatsapp-agent-gateway/references/receiver-backend-contract.md`
- `~/.whatsapp-agent/skills/whatsapp-agent-gateway/references/deployment-and-env.md`
- `~/.whatsapp-agent/skills/skill-crafter/SKILL.md`

### Step 6: Run Gateway via `systemd --user` (Do NOT mix with `pm2`)
Use `systemd --user` with user lingering enabled (`sudo loginctl enable-linger "$USER"`) as specified in `references/deployment-and-env.md` so all operational commands (`systemctl --user`, `journalctl --user`) work consistently:
- Create and start `~/.config/systemd/user/whatsapp-agent-gateway.service`.
- Verify public liveness: `curl -s http://127.0.0.1:3100/api/health` -> `{"success":true,"whatsapp":"qr_ready"|"connected",...}`
- Verify auth lock: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/api/status` -> `401` (and `200` when passing `-H "x-api-key: $GATEWAY_API_KEY"`).

### Step 7: Pair WhatsApp
Either:
- Run `~/whatsapp-agent-receiver/get-qr.sh /tmp/wa-qr.png` and send `/tmp/wa-qr.png` to the human, OR
- Have the human open `http://localhost:3100` via SSH tunnel (`ssh -L 3100:127.0.0.1:3100 user@server`), enter `GATEWAY_API_KEY` when prompted by the dashboard, and scan the QR code (**WhatsApp -> Linked devices -> Link a device**).

### Step 8: Implement & Start the AI Webhook Receiver (`~/whatsapp-agent-receiver/`)
Implement the receiver modules in `~/whatsapp-agent-receiver/` (`receiver.py`, `history.py`, `flow.py`, `outbox.py`, `wa_send.py`) following `SKILL.md` and `references/receiver-backend-contract.md`, then enable `whatsapp-agent-receiver.service` under `systemd --user`:

1. **Auth**: Listen on `127.0.0.1:5000/api/webhook`. Reject missing/mismatched `x-agent-token` with HTTP 401. Include `-H "x-api-key: $GATEWAY_API_KEY"` on every REST call back to `:3100/api/*`.
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
     - Enforce strict principal gating: `prompt_template_owner.txt` + operator tools ONLY when `isGroup == false` AND sender matches `MASTER_PHONE` / `MASTER_LID`. External contact turns get zero shell/file-write tools, wrap inbound content in `<untrusted_inbound_message>` tags, and hot-load Section 2 (plus only the matching contact's `###` block from Section 3) of `~/.whatsapp-agent/skills/whatsapp-agent-rules/SKILL.md` into `[Trusted Operator Context]` so owner-taught rules take effect live without exposing Section 1 or other contacts' notes.
     - Transcribe voice notes dynamically based on `~/.whatsapp-agent/vault/gemini_api_key`:
       - **If a Gemini API key is present**: Use **Gemini Audio** (`gemini-3.8-flash`, `thinking_level: "low"` or `"medium"`, `store=False`) to extract accurate multilingual/Manglish transcript + vocal vibe (`[voice note | vibe: polite | transcript: "..."]`). If a configured Gemini key fails authentication/quota, log the error visibly and alert `MASTER_PHONE`.
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
2. `curl -s http://127.0.0.1:5000/health` -> `"ok": true` AND `"brain_ready": true`
3. `curl -s -X POST http://127.0.0.1:3100/api/webhook/test -H "x-api-key: $GATEWAY_API_KEY"` -> `"success": true, "status": 200`
4. Ask the human to send a test WhatsApp message (first from their `MASTER_PHONE` DM to verify `status` and capture `MASTER_LID` if applicable, then from a second phone to verify first-person `${MASTER_NAME}` reply style).
````
