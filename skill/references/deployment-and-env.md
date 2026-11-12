# Deployment, Systemd Units, Secret Vault & Tunables Reference

## 1. Systemd User Services (`systemd --user`)

Always run both the gateway and the AI webhook receiver under `systemd --user` with user lingering enabled so services survive SSH disconnects and reboots cleanly (never mix `pm2` and `systemd` on the same host):

```bash
sudo loginctl enable-linger "$USER"
mkdir -p ~/.config/systemd/user
```

### `~/.config/systemd/user/whatsapp-agent-gateway.service`
*(Verify `command -v node` first; if Node is installed via `nvm`/`fnm`/`mise`, include its bin directory in `PATH` and set `ExecStart` to that `node` binary directly so `SIGTERM` reaches Node cleanly without an `npm` wrapper.)*
```ini
[Unit]
Description=WhatsApp AI Agent Gateway (Baileys)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/whatsapp-agent-gateway
Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=%h/whatsapp-agent-gateway/.env
ExecStart=/usr/bin/env node %h/whatsapp-agent-gateway/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### `~/.config/systemd/user/whatsapp-agent-receiver.service`
*(Run `receiver.py` using its dedicated `%h/whatsapp-agent-receiver/.venv/bin/python` virtualenv where `faster-whisper`, `google-genai`, and `httpx` are installed, while keeping `%h/.local/bin` and any host agent CLI directory in `PATH` so `receiver.py` finds host agent CLIs when `BRAIN_MODE=cli`.)*
```ini
[Unit]
Description=WhatsApp AI Agent Webhook Receiver
After=network-online.target whatsapp-agent-gateway.service

[Service]
Type=simple
WorkingDirectory=%h/whatsapp-agent-receiver
Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=%h/whatsapp-agent-receiver/receiver.env
ExecStart=%h/whatsapp-agent-receiver/.venv/bin/python %h/whatsapp-agent-receiver/receiver.py
KillMode=control-group
TimeoutStopSec=130
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

Enable and start both:
```bash
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-agent-gateway whatsapp-agent-receiver
```

---

## 2. Secret Vault (`~/.whatsapp-agent/vault/`)

Never store raw third-party LLM or Gemini API keys inside `~/whatsapp-agent-gateway/.env`, `~/whatsapp-agent-receiver/receiver.env`, or git-tracked files. Keep all provider API keys inside the restricted secret vault directory `~/.whatsapp-agent/vault/` (`0700` directory, `0600` files written under `umask 077`):

```bash
mkdir -p -m 700 ~/.whatsapp-agent/vault

# Optional: Gemini API key for Gemini Audio voice-note transcription
# (When absent or empty, receiver.py automatically uses local faster-whisper out of the box)
(umask 077 && printf '%s' "$RAW_GEMINI_API_KEY" > ~/.whatsapp-agent/vault/gemini_api_key)
chmod 600 ~/.whatsapp-agent/vault/gemini_api_key

# When BRAIN_MODE=api: LLM API key for the receiver's AI brain
(umask 077 && printf '%s' "$RAW_LLM_API_KEY" > ~/.whatsapp-agent/vault/llm_api_key)
chmod 600 ~/.whatsapp-agent/vault/llm_api_key
```

*(Optional hardening on hosts with `systemd-creds`: encrypt credentials into `~/.whatsapp-agent/vault/*.cred` and pass `LoadCredentialEncrypted=...` in `whatsapp-agent-receiver.service`; `receiver.py` checks `$CREDENTIALS_DIRECTORY/<name>` first, then the `*_FILE` path in `~/.whatsapp-agent/vault/`.)*

---

## 3. Public Dashboard Exposure (Nginx Reverse Proxy + SSH Tunnel)

Keep `HOST=127.0.0.1` on the gateway and expose the dashboard externally only behind TLS + `GATEWAY_API_KEY`:

```text
https://gateway.example.com -> Nginx (TLS) -> SSH Remote Tunnel (127.0.0.1:3101) -> Gateway (127.0.0.1:3100)
```

1. Ensure `GATEWAY_API_KEY` is set to a strong 48-hex-character secret in both `~/whatsapp-agent-gateway/.env` and `~/whatsapp-agent-receiver/receiver.env`.
2. Nginx virtual host:
   ```nginx
   server {
       listen 443 ssl http2;
       server_name gateway.example.com;

       location / {
           proxy_pass http://127.0.0.1:3101;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_buffering off;
       }
   }
   ```
3. Persistent tunnel command (`systemd --user` unit):
   `ssh -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -N -R 3101:127.0.0.1:3100 user@remote-server`

---

## 4. Complete `receiver.env` Tunables

| Variable | Default | Purpose |
|---|---|---|
| `RECEIVER_PORT` | `5000` | Receiver listen port on `127.0.0.1` |
| `AGENT_SECRET_TOKEN` | *(required)* | Shared webhook auth header (`x-agent-token`) |
| `WHATSAPP_GATEWAY_URL` | `http://127.0.0.1:3100` | Gateway REST base URL |
| `GATEWAY_API_KEY` | *(required)* | Shared API key sent as `x-api-key` to gateway `/api/*` |
| `MASTER_PHONE` | *(required)* | Master operator phone digits (alias: `OWNER_WHATSAPP`) |
| `MASTER_LID` | `""` | Optional 15-digit WhatsApp LID for Master 1:1 DM recognition |
| `MASTER_NAME` | *(required)* | Principal's real name for first-person voice |
| `TIMEZONE` | `Asia/Kuala_Lumpur` | Timezone (`GMT+8`) for `DD-MM-YY` formatted timestamps |
| `BRAIN_MODE` | `api` or `cli` | `cli` to invoke the authenticated host AI agent CLI; `api` to call the same AI provider's HTTP API directly |
| `AGENT_CLI_TYPE` | `""` | When `BRAIN_MODE=cli`: `claude`, `codex`, `gemini`, or `custom` |
| `AGENT_CLI_BIN` | `""` | Absolute path to the verified host AI agent CLI binary (so `systemd --user` never misses `PATH`) |
| `LLM_PROVIDER` | `openai` | When `BRAIN_MODE=api`: `openai` (any OpenAI-compatible endpoint, OpenRouter, etc.), `anthropic`, or `gemini` |
| `LLM_BASE_URL` | `""` | Base URL for `openai` / `anthropic` compatible APIs (e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`) |
| `LLM_MODEL` | *(verified model)* | Model identifier verified by a live test call during installation |
| `LLM_API_KEY_FILE` | `~/.whatsapp-agent/vault/llm_api_key` | Restricted `0600` vault file holding the LLM API key when `BRAIN_MODE=api` |
| `GEMINI_API_KEY_FILE` | `~/.whatsapp-agent/vault/gemini_api_key` | Optional `0600` secret-vault file for voice transcription; if present & non-empty, uses Gemini Audio, else uses local `faster-whisper` out of the box |
| `GEMINI_AUDIO_MODEL` | `gemini-3.8-flash` | Gemini model used for voice-note transcription + vocal vibe analysis when a Gemini key is stored in the secret vault |
| `GEMINI_THINKING_LEVEL` | `low` | Thinking level (`low` or `medium`) passed to Gemini Audio |
| `WHISPER_MODEL` | `base` | Local `faster-whisper` model (`tiny`, `base`, `small`, `medium`, `large-v3-turbo`) used automatically when no Gemini key is configured |
| `WHISPER_DEVICE` | `cpu` | Execution device for local `faster-whisper` (`cpu` or `cuda`) |
| `WHISPER_COMPUTE_TYPE` | `int8` | Quantization type for local `faster-whisper` (`int8` on CPU, `float16` on CUDA) |
| `SKILLS_DIR` | `~/.whatsapp-agent/skills` | Canonical skills root containing `whatsapp-agent-rules/SKILL.md` and `skill-crafter/SKILL.md` |
| `AGENT_TIMEOUT_SECONDS` | `300` | Max execution time per AI turn |
| `COALESCE_WINDOW_SECONDS` | `2.5` | Burst bundling window for consecutive messages |
| `MAX_CONCURRENT_RUNS` | `4` | Max parallel AI turns |
| `DRAIN_SECONDS` | `120` | Graceful shutdown wait window |
| `STARTUP_REPLAY` | `true` | Replay unanswered `processing` messages on receiver boot |
| `REPLAY_MAX_AGE_MIN` | `60` | Maximum age (minutes, via `rawTimestamp`) for startup replay |
| `HISTORY_LIMIT` | `30` | Prior SQLite turns injected as read-only conversation context |
| `DAILY_REPLY_LIMIT_PER_PERSON` | `25` | Max automated replies per contact per 24h |
| `HOURLY_GLOBAL_REPLY_LIMIT` | `60` | Max automated replies globally per rolling hour |
| `DRAFT_APPROVAL_DEFAULT` | `false` | Initial draft approval state when `state.json` is initialized |
| `SPLIT_MESSAGE_DELAY_SECONDS` | `2.0` | Typing delay between `===MSG===` chunks `2..N` |
| `MAX_MESSAGES_PER_TURN` | `5` | Hard ceiling on outbound messages per turn |
| `DRY_RUN` | `false` | Logs full reply plan without calling `/api/send` |
