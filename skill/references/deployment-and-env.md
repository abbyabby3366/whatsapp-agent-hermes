# Deployment, Systemd Units & Tunables Reference

## 1. Systemd User Services (`systemd --user`)

Always run both the gateway and the receiver under `systemd --user` with user lingering enabled so services survive SSH disconnects and reboots cleanly (never mix `pm2` and `systemd` on the same host):

```bash
sudo loginctl enable-linger "$USER"
mkdir -p ~/.config/systemd/user
```

### `~/.config/systemd/user/whatsapp-agent-hermes.service`
*(Verify `command -v node` first; if Node is installed via `nvm`/`fnm`/`mise`, include its bin directory in `PATH` and set `ExecStart` to that `node` binary directly so `SIGTERM` reaches Node cleanly without an `npm` wrapper.)*
```ini
[Unit]
Description=WhatsApp Agent Hermes Gateway (Baileys)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/whatsapp-agent-hermes
Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=%h/whatsapp-agent-hermes/.env
ExecStart=/usr/bin/env node %h/whatsapp-agent-hermes/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### `~/.config/systemd/user/hermes-wa-receiver.service`
*(Run `receiver.py` using its dedicated `%h/whatsapp-hermes-receiver/.venv/bin/python` virtualenv where `faster-whisper` and `google-genai` are installed, while keeping `%h/.local/bin` and `%h/.hermes/hermes-agent/venv/bin` in `PATH` so `receiver.py` always finds the `hermes` CLI under `systemd --user`.)*
```ini
[Unit]
Description=Hermes WhatsApp Webhook Receiver
After=network-online.target whatsapp-agent-hermes.service

[Service]
Type=simple
WorkingDirectory=%h/whatsapp-hermes-receiver
Environment="PATH=%h/.local/bin:%h/.hermes/hermes-agent/venv/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile=%h/whatsapp-hermes-receiver/receiver.env
ExecStart=%h/whatsapp-hermes-receiver/.venv/bin/python %h/whatsapp-hermes-receiver/receiver.py
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
systemctl --user enable --now whatsapp-agent-hermes hermes-wa-receiver
```

### Secret Vault for Optional Gemini API Key (`~/.hermes/vault/` & `hermes hvault`)
Voice-note transcription works **out of the box** via local `faster-whisper` (`WHISPER_MODEL=base`) with zero external API keys. When the user opts in and pastes a Gemini API key (at install time or later via 1:1 Master DM / CLI), never store the raw key in `.env` or `receiver.env` — save it in the secret vault:

```bash
# 1. Restricted local secret vault file (0700 dir, 0600 file; hot-reloaded per voice note)
mkdir -p -m 700 ~/.hermes/vault
(umask 077 && printf '%s' "$RAW_GEMINI_API_KEY" > ~/.hermes/vault/gemini_api_key)
chmod 600 ~/.hermes/vault/gemini_api_key

# 2. Also store in Hermes's native encrypted vault if hermesvault (hvault) is initialized
if hermes hvault list >/dev/null 2>&1; then
  hermes hvault set GEMINI_API_KEY "$RAW_GEMINI_API_KEY"
fi
```
*(Optional hardening on hosts with `systemd-creds`: encrypt into `~/.hermes/vault/gemini_api_key.cred` and add `LoadCredentialEncrypted=gemini_api_key:%h/.hermes/vault/gemini_api_key.cred` to `hermes-wa-receiver.service`; `receiver.py` checks `$CREDENTIALS_DIRECTORY/gemini_api_key` first, then `GEMINI_API_KEY_FILE`.)*

---

## 2. Public Dashboard Exposure (Nginx Reverse Proxy + SSH Tunnel)

Keep `HOST=127.0.0.1` on the gateway and expose the dashboard externally only behind TLS + `GATEWAY_API_KEY`:

```text
https://gateway.example.com -> Nginx (TLS) -> SSH Remote Tunnel (127.0.0.1:3101) -> Gateway (127.0.0.1:3100)
```

1. Ensure `GATEWAY_API_KEY` is set to a strong 48-hex-character secret in both `~/whatsapp-agent-hermes/.env` and `~/whatsapp-hermes-receiver/receiver.env`.
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

## 3. Complete `receiver.env` Tunables

| Variable | Default | Purpose |
|---|---|---|
| `RECEIVER_PORT` | `5000` | Receiver listen port on `127.0.0.1` |
| `HERMES_SECRET_TOKEN` | *(required)* | Shared webhook auth header (`x-hermes-token`) |
| `WHATSAPP_GATEWAY_URL` | `http://127.0.0.1:3100` | Gateway REST base URL |
| `GATEWAY_API_KEY` | *(required)* | Shared API key sent as `x-api-key` to gateway `/api/*` |
| `MASTER_PHONE` | *(required)* | Master operator phone digits (alias: `OWNER_WHATSAPP`) |
| `MASTER_LID` | `""` | Optional 15-digit WhatsApp LID for Master 1:1 DM recognition |
| `MASTER_NAME` | *(required)* | Principal's real name for first-person voice |
| `TIMEZONE` | `Asia/Kuala_Lumpur` | Timezone (`GMT+8`) for `DD-MM-YY` formatted timestamps |
| `GEMINI_API_KEY_FILE` | `~/.hermes/vault/gemini_api_key` | Optional `0600` secret-vault file holding the Gemini API key; if present & non-empty, uses Gemini Audio, else uses local `faster-whisper` out of the box |
| `GEMINI_AUDIO_MODEL` | `gemini-3.8-flash` | Gemini model used for voice-note transcription + vocal vibe analysis when a Gemini key is stored in the secret vault |
| `GEMINI_THINKING_LEVEL` | `low` | Thinking level (`low` or `medium`) passed to Gemini Audio |
| `WHISPER_MODEL` | `base` | Local `faster-whisper` model (`tiny`, `base`, `small`, `medium`, `large-v3-turbo`) used automatically when no Gemini key is configured |
| `WHISPER_DEVICE` | `cpu` | Execution device for local `faster-whisper` (`cpu` or `cuda`) |
| `WHISPER_COMPUTE_TYPE` | `int8` | Quantization type for local `faster-whisper` (`int8` on CPU, `float16` on CUDA) |
| `AGENT_TOOLSETS` | `web,vision` | Restricted read-only toolsets for external contacts |
| `AGENT_TOOLSETS_OWNER` | `terminal,file,web,vision` | Elevated toolsets exclusively for 1:1 Master DM |
| `AGENT_TIMEOUT_SECONDS` | `300` | Max execution time per Hermes turn |
| `COALESCE_WINDOW_SECONDS` | `2.5` | Burst bundling window for consecutive messages |
| `MAX_CONCURRENT_RUNS` | `4` | Max parallel Hermes subprocesses |
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
