# Prompt for Hermes Agent: install the WhatsApp gateway

> Copy the block below into your Hermes agent (or any autonomous server assistant) running on the Linux server where Hermes lives.

---

````markdown
You are an autonomous engineer. Install and connect the "WhatsApp Agent Hermes" gateway and its built-in Node webhook receiver on this server so WhatsApp messages reach Hermes and Hermes replies safely in the owner's voice.

### Step 0: Ask for Master Identity Only (No LLM or Transcription API Keys)
**Immediately ask the user for:**
1. **Master Phone Number** (`MASTER_PHONE`): Personal WhatsApp number with country code, digits only (e.g. `60123456789`). Used for `@@FLAG@@` escalations, 1:1 Master DM command authority, and urgent alerts.
2. **Master Operator Name** (`MASTER_NAME`): Their real name (e.g. `Alex`, `Desmond`) so replies speak in the first person ("I", "my") without exposing bots.

- **Zero external API keys**: Voice notes transcribe locally via built-in Node ONNX Whisper (`onnx-community/whisper-base`, CPU `q8` — zero Python, zero `.venv`, zero API keys). Replies run via this host's built-in `hermes chat -Q` AI proxy ONLY. Never ask for Gemini, OpenAI, OpenRouter, Anthropic, or other provider keys.
- Wait for `MASTER_PHONE` and `MASTER_NAME` before running the installer.

### Step 1: Clone/Update & Run the One-Command Installer
```bash
cd ~
if [ -d ~/whatsapp-agent-hermes ]; then
  cd ~/whatsapp-agent-hermes && git pull
else
  git clone https://github.com/abbyabby3366/whatsapp-agent-hermes.git ~/whatsapp-agent-hermes
  cd ~/whatsapp-agent-hermes
fi

bash scripts/install.sh --master-phone "<MASTER_PHONE>" --master-name "<MASTER_NAME>"
```
`scripts/install.sh` automatically verifies `node >= 22.5.0` & `npm`, generates chmod-600 `.env` and `~/whatsapp-hermes-receiver/receiver.env` (preserving any existing non-placeholder secrets & learned rules), runs `npm ci && npm run typecheck && npm run build`, installs `~/.hermes/skills/` and `~/.local/bin/{wa-send,wa-history,wa-flow,wa-qr}`, pre-warms ONNX Whisper, enables `systemd --user` lingering, starts `whatsapp-agent-hermes.service` (`:3100`) and `hermes-wa-receiver.service` (`:5000`), verifies `401` auth lock on `:3100/api/status`, and tests `POST /api/webhook/test`.

Read `~/.hermes/skills/whatsapp-agent-hermes-gateway/SKILL.md` and `~/.hermes/skills/skill-crafter/SKILL.md` to confirm operational commands and rule persistence.

### Step 2: Pair WhatsApp
Run either:
- `~/.local/bin/wa-qr /tmp/wa-qr.png` (or `bash ~/whatsapp-agent-hermes/scripts/fetch-pairing-qr.sh /tmp/wa-qr.png`) and send `/tmp/wa-qr.png` to the user to scan, **OR**
- Instruct the user to open `http://localhost:3100` over SSH (`ssh -L 3100:127.0.0.1:3100 user@server`), paste `GATEWAY_API_KEY` from `~/whatsapp-agent-hermes/.env`, and scan the QR code (**WhatsApp -> Linked devices -> Link a device**).

### Step 3: Verify Connected & Notify `MASTER_PHONE` Live
1. Confirm `"whatsapp":"connected"`: `curl -s http://127.0.0.1:3100/api/health`
2. Leave automated replies **ON and live** immediately (never enable a `[DRAFT APPROVAL]` queue).
3. Send live setup confirmation to `MASTER_PHONE`:
   ```bash
   ~/.local/bin/wa-send text "<MASTER_PHONE>" "WhatsApp Hermes Agent setup complete. Live auto-reply is active."
   ```
   *(If WhatsApp returns HTTP 502 / Error 463 because no prior thread exists with `MASTER_PHONE`, do NOT retry in a loop — just confirm completion to the user here.)*
````
