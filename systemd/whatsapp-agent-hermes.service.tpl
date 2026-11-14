[Unit]
Description=WhatsApp Agent Hermes Gateway (Baileys)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="{{REPO_DIR}}"
Environment="NODE_ENV=production"
Environment="PATH={{NODE_BIN_DIR}}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
EnvironmentFile="{{REPO_DIR}}/.env"
ExecStart="{{NODE_BIN}}" "{{REPO_DIR}}/dist/index.js"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
