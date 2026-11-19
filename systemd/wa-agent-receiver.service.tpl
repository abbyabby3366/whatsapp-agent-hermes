[Unit]
Description=WhatsApp AI Agent Webhook Receiver (Built-In Node)
After=network-online.target whatsapp-ai-agent.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="{{RECEIVER_DIR}}"
Environment="NODE_ENV=production"
Environment="PATH={{NODE_BIN_DIR}}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile="{{RECEIVER_DIR}}/receiver.env"
ExecStart="{{NODE_BIN}}" --no-warnings=ExperimentalWarning "{{REPO_DIR}}/dist/receiver/index.js"
KillMode=control-group
TimeoutStopSec=130
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
