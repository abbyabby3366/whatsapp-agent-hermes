#!/usr/bin/env bash
# Requests a fresh WhatsApp pairing QR from whatsapp-agent-hermes and saves it as a PNG.
# Usage: bash fetch-pairing-qr.sh [output_png_path]

set -euo pipefail

OUT_PATH="${1:-/tmp/wa-qr.png}"
mkdir -p "$(dirname "$OUT_PATH")"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_CANDIDATES=(
  "${RECEIVER_ENV_FILE:-}"
  "${SCRIPT_DIR}/../.env"
  "${HOME}/whatsapp-agent-hermes/.env"
  "${HOME}/whatsapp-hermes-receiver/receiver.env"
  ".env"
)

# Load PORT / WHATSAPP_GATEWAY_URL / GATEWAY_API_KEY from env files if not already exported
for env_file in "${ENV_CANDIDATES[@]}"; do
  if [[ -n "$env_file" && -f "$env_file" ]]; then
    if [[ -z "${GATEWAY_API_KEY:-}" ]]; then
      GATEWAY_API_KEY="$(grep -E '^GATEWAY_API_KEY=' "$env_file" | tail -n1 | cut -d'=' -f2- | tr -d "\"'\r" || true)"
    fi
    if [[ -z "${WHATSAPP_GATEWAY_URL:-}" ]]; then
      WHATSAPP_GATEWAY_URL="$(grep -E '^WHATSAPP_GATEWAY_URL=' "$env_file" | tail -n1 | cut -d'=' -f2- | tr -d "\"'\r" || true)"
    fi
    if [[ -z "${PORT:-}" ]]; then
      PORT="$(grep -E '^PORT=' "$env_file" | tail -n1 | cut -d'=' -f2- | tr -d "\"'\r" || true)"
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
  echo "Failed to reach ${GATEWAY_URL}/api/connect (check that whatsapp-agent-hermes is running and GATEWAY_API_KEY matches)." >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "node binary not found in PATH." >&2
  exit 1
fi

# Poll /api/qr.png up to 15s for raw QR PNG or 409 already-connected
"${NODE_BIN}" --input-type=module - "${GATEWAY_URL}" "${GATEWAY_API_KEY:-}" "${OUT_PATH}" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [gatewayUrl, apiKey, outPath] = process.argv.slice(2);
const headers = apiKey ? { 'x-api-key': apiKey } : {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let attempt = 0; attempt < 15; attempt++) {
  let res;
  try {
    res = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/api/qr.png`, {
      headers,
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.error(`Gateway request failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (res.status === 200) {
    const pngBuffer = Buffer.from(await res.arrayBuffer());
    const tmpPath = `${outPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(tmpPath, pngBuffer);
    fs.renameSync(tmpPath, outPath);
    console.log(`Saved fresh pairing QR code to ${outPath}`);
    process.exit(0);
  }

  if (res.status === 409) {
    let accountId = 'linked account';
    try {
      const payload = await res.json();
      if (payload?.user?.id) {
        accountId = payload.user.id;
      }
    } catch {
      // Ignore JSON parse failure on 409
    }
    console.log(`WhatsApp is already connected as ${accountId}.`);
    process.exit(0);
  }

  if (res.status === 401 || res.status === 403) {
    console.error(`Gateway returned HTTP ${res.status} on /api/qr.png (check GATEWAY_API_KEY).`);
    process.exit(1);
  }

  if (res.status !== 404) {
    console.error(`Unexpected HTTP ${res.status} from /api/qr.png.`);
    process.exit(1);
  }

  await sleep(1000);
}

console.error('Timed out waiting for QR code from gateway.');
process.exit(1);
NODE
