#!/usr/bin/env bash
# Requests a fresh WhatsApp pairing QR from the WhatsApp AI Agent gateway and saves it as a PNG.
# Usage: bash fetch-pairing-qr.sh [output_png_path]

set -euo pipefail

OUT_PATH="${1:-/tmp/wa-qr.png}"
mkdir -p "$(dirname "$OUT_PATH")"

ENV_CANDIDATES=(
  "${HOME}/whatsapp-agent-gateway/.env"
  "${HOME}/whatsapp-agent-receiver/receiver.env"
  ".env"
)

# Load PORT / GATEWAY_API_KEY from env files if not already exported
for env_file in "${ENV_CANDIDATES[@]}"; do
  if [[ -f "$env_file" ]]; then
    if [[ -z "${GATEWAY_API_KEY:-}" ]]; then
      GATEWAY_API_KEY="$(grep -E '^GATEWAY_API_KEY=' "$env_file" | tail -n1 | cut -d'=' -f2- | tr -d '"\r' || true)"
    fi
    if [[ -z "${PORT:-}" ]]; then
      PORT="$(grep -E '^PORT=' "$env_file" | tail -n1 | cut -d'=' -f2- | tr -d '"\r' || true)"
    fi
  fi
done

GATEWAY_URL="${WHATSAPP_GATEWAY_URL:-http://127.0.0.1:${PORT:-3100}}"
AUTH_ARGS=()
if [[ -n "${GATEWAY_API_KEY:-}" ]]; then
  AUTH_ARGS=(-H "x-api-key: ${GATEWAY_API_KEY}")
fi

# Trigger connection if currently disconnected
if ! curl -fsS -X POST "${GATEWAY_URL}/api/connect" "${AUTH_ARGS[@]}" -H "Content-Type: application/json" >/dev/null; then
  echo "Failed to reach ${GATEWAY_URL}/api/connect (check that whatsapp-agent-gateway is running and GATEWAY_API_KEY matches)." >&2
  exit 1
fi

# Poll /api/status up to 15s for qr_ready or connected
python3 - "$GATEWAY_URL" "${GATEWAY_API_KEY:-}" "$OUT_PATH" <<'PY'
import base64
import json
import sys
import time
import urllib.error
import urllib.request

gateway_url, api_key, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
headers = {"x-api-key": api_key} if api_key else {}

for _ in range(15):
    req = urllib.request.Request(f"{gateway_url}/api/status", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        print(f"Gateway returned HTTP {err.code} on /api/status (check GATEWAY_API_KEY).", file=sys.stderr)
        sys.exit(1)

    if not payload.get("success") or not isinstance(payload.get("data"), dict):
        print(f"Unexpected /api/status response: {payload}", file=sys.stderr)
        sys.exit(1)

    data = payload["data"]
    status = data.get("status")
    qr_data_url = data.get("qrCodeDataUrl")

    if status == "connected":
        user = data.get("user")
        account_id = user["id"] if isinstance(user, dict) and "id" in user else "linked account"
        print(f"WhatsApp is already connected as {account_id}.")
        sys.exit(0)

    if isinstance(qr_data_url, str) and "," in qr_data_url:
        b64 = qr_data_url.split(",", 1)[1]
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(b64))
        print(f"Saved fresh pairing QR code to {out_path}")
        sys.exit(0)

    time.sleep(1)

print("Timed out waiting for QR code from gateway.", file=sys.stderr)
sys.exit(1)
PY
