#!/usr/bin/env bash
# Deterministic, idempotent installer for WhatsApp Agent Hermes (Gateway + Built-In Node Receiver).
# Usage:
#   bash scripts/install.sh --master-phone 60123456789 --master-name "Alex" [options]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RECEIVER_DIR="${HOME}/whatsapp-hermes-receiver"
MASTER_PHONE=""
MASTER_NAME=""
MASTER_LID=""
TIMEZONE_ARG=""
COUNTRY_CODE_ARG=""
SKIP_BUILD=false
SKIP_SYSTEMD=false
SKIP_WHISPER_WARMUP=false

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh --master-phone <digits> --master-name <name> [options]

Options:
  --master-phone <digits>         Master WhatsApp phone number with country code (required on fresh install)
  --master-name <name>            Master real name for first-person ghostwriting (required on fresh install)
  --master-lid <lid>              Optional 15-digit WhatsApp LID for Master 1:1 DM recognition
  --timezone <iana_tz>            IANA timezone (default: Asia/Kuala_Lumpur)
  --default-country-code <digits> Country code for leading-0 numbers (default: 60)
  --receiver-dir <path>           Receiver data directory (default: ~/whatsapp-hermes-receiver)
  --skip-build                    Skip npm ci, typecheck, and build (useful when already built)
  --skip-systemd                  Skip systemd --user unit installation and live checks
  --skip-whisper-warmup           Skip downloading ONNX Whisper model during install
  -h, --help                      Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --master-phone)
      MASTER_PHONE="${2:-}"
      shift 2
      ;;
    --master-name)
      MASTER_NAME="${2:-}"
      shift 2
      ;;
    --master-lid)
      MASTER_LID="${2:-}"
      shift 2
      ;;
    --timezone)
      TIMEZONE_ARG="${2:-}"
      shift 2
      ;;
    --default-country-code)
      COUNTRY_CODE_ARG="${2:-}"
      shift 2
      ;;
    --receiver-dir)
      RECEIVER_DIR="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --skip-systemd)
      SKIP_SYSTEMD=true
      shift
      ;;
    --skip-whisper-warmup)
      SKIP_WHISPER_WARMUP=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Expand leading ~/ in RECEIVER_DIR if supplied manually
if [[ "${RECEIVER_DIR}" == "~/"* ]]; then
  RECEIVER_DIR="${HOME}/${RECEIVER_DIR#~/}"
elif [[ "${RECEIVER_DIR}" == "~" ]]; then
  RECEIVER_DIR="${HOME}"
fi

# 1. Verify Node.js >= 22.5.0 (built-in node:sqlite requirement) and npm
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
if [[ -z "${NODE_BIN}" || -z "${NPM_BIN}" ]]; then
  echo "Error: node and npm must be installed and available on PATH (Node >= 22.5.0 required)." >&2
  exit 1
fi
NODE_BIN="$("${NODE_BIN}" -p 'process.execPath')"
NODE_BIN_DIR="$(dirname "${NODE_BIN}")"

"${NODE_BIN}" --input-type=module - <<'NODE'
const [major, minor] = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`Error: Node.js >= 22.5.0 is required for built-in node:sqlite (found v${process.versions.node}).`);
  process.exit(1);
}
console.log(`[install] Node.js v${process.versions.node} detected`);
NODE

HERMES_BIN_PATH="${HERMES_BIN:-$(command -v hermes || true)}"
if [[ -z "${HERMES_BIN_PATH}" && -x "${HOME}/.hermes/hermes-agent/venv/bin/hermes" ]]; then
  HERMES_BIN_PATH="${HOME}/.hermes/hermes-agent/venv/bin/hermes"
fi
if [[ -z "${HERMES_BIN_PATH}" ]]; then
  echo "[install] Warning: 'hermes' CLI not found on PATH yet; ensure Hermes is installed before live turns run." >&2
  HERMES_BIN_PATH="hermes"
else
  echo "[install] Hermes CLI detected at ${HERMES_BIN_PATH}"
fi

# 2. Configure .env and receiver.env idempotently (fail fast before slow installs if MASTER_* is missing)
mkdir -p "${RECEIVER_DIR}" "${RECEIVER_DIR}/media" "${RECEIVER_DIR}/models"

"${NODE_BIN}" --input-type=module - \
  "${REPO_DIR}" \
  "${RECEIVER_DIR}" \
  "${MASTER_PHONE}" \
  "${MASTER_NAME}" \
  "${MASTER_LID}" \
  "${TIMEZONE_ARG}" \
  "${COUNTRY_CODE_ARG}" \
  "${HERMES_BIN_PATH}" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [
  repoDir,
  receiverDir,
  argMasterPhone,
  argMasterName,
  argMasterLid,
  argTimezone,
  argCountryCode,
  hermesBinPath
] = process.argv.slice(2);

const isPlaceholder = (val) => /^change-me(-|$)/i.test((val || '').trim());

const parseEnvFile = (filePath) => {
  const entries = new Map();
  if (!fs.existsSync(filePath)) return entries;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) entries.set(key, val);
  }
  return entries;
};

const gwEnvPath = path.join(repoDir, '.env');
const rxEnvPath = path.join(receiverDir, 'receiver.env');
const oldGw = parseEnvFile(gwEnvPath);
const oldRx = parseEnvFile(rxEnvPath);

const pickNonEmpty = (...vals) => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
};

const pickSecret = (...vals) => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '' && !isPlaceholder(v)) {
      return v.trim();
    }
  }
  return crypto.randomBytes(24).toString('hex');
};

const countryCode = pickNonEmpty(
  argCountryCode,
  oldRx.get('DEFAULT_COUNTRY_CODE'),
  oldGw.get('DEFAULT_COUNTRY_CODE'),
  '60'
).replace(/[^0-9]/g, '');

const normalizePhone = (raw) => {
  let digits = (raw || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('0') && countryCode) {
    digits = countryCode + digits.slice(1);
  }
  return digits;
};

const masterPhone = normalizePhone(
  pickNonEmpty(argMasterPhone, oldRx.get('MASTER_PHONE'), oldRx.get('OWNER_WHATSAPP'), oldGw.get('MASTER_PHONE'))
);
const masterName = pickNonEmpty(argMasterName, oldRx.get('MASTER_NAME'), oldGw.get('MASTER_NAME'));
const masterLid = pickNonEmpty(
  argMasterLid,
  oldRx.get('MASTER_LID'),
  oldGw.get('MASTER_LID')
)
  .replace(/@lid$/i, '')
  .replace(/[^0-9]/g, '');

if (!masterPhone || masterPhone.length < 8) {
  console.error(
    'Error: --master-phone is required on fresh install (digits with country code, e.g. 60123456789).'
  );
  process.exit(1);
}
if (!masterName) {
  console.error('Error: --master-name is required on fresh install (e.g. "Alex").');
  process.exit(1);
}

const timezone = pickNonEmpty(argTimezone, oldRx.get('TIMEZONE'), oldGw.get('TIMEZONE'), 'Asia/Kuala_Lumpur');
try {
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
} catch {
  console.error(`Error: Invalid IANA timezone "${timezone}".`);
  process.exit(1);
}

const gatewayApiKey = pickSecret(oldGw.get('GATEWAY_API_KEY'), oldRx.get('GATEWAY_API_KEY'));
const hermesSecretToken = pickSecret(oldGw.get('HERMES_SECRET_TOKEN'), oldRx.get('HERMES_SECRET_TOKEN'));

const gatewayPort = pickNonEmpty(oldGw.get('PORT'), '3100');
const receiverPort = pickNonEmpty(oldRx.get('RECEIVER_PORT'), '5000');

const formatEnvValue = (val) => (/[\s#"'`]/.test(val) ? `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : val);

const writeEnvAtomic = (targetPath, pairs, preservedFromOld) => {
  const writtenKeys = new Set();
  const lines = [];
  for (const [k, v] of pairs) {
    writtenKeys.add(k);
    lines.push(`${k}=${formatEnvValue(v)}`);
  }
  for (const [k, v] of preservedFromOld.entries()) {
    if (!writtenKeys.has(k)) {
      lines.push(`${k}=${formatEnvValue(v)}`);
    }
  }
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, targetPath);
};

writeEnvAtomic(
  gwEnvPath,
  [
    ['PORT', gatewayPort],
    ['HOST', pickNonEmpty(oldGw.get('HOST'), '127.0.0.1')],
    ['GATEWAY_API_KEY', gatewayApiKey],
    ['SESSIONS_DIR', pickNonEmpty(oldGw.get('SESSIONS_DIR'), './sessions')],
    ['DATA_DIR', pickNonEmpty(oldGw.get('DATA_DIR'), './data')],
    ['ALLOWED_MEDIA_DIR', pickNonEmpty(oldGw.get('ALLOWED_MEDIA_DIR'), './data/media')],
    ['MAX_MEDIA_BYTES', pickNonEmpty(oldGw.get('MAX_MEDIA_BYTES'), '26214400')],
    ['TIMEZONE', timezone],
    ['HERMES_WEBHOOK_URL', pickNonEmpty(oldGw.get('HERMES_WEBHOOK_URL'), `http://127.0.0.1:${receiverPort}/api/webhook`)],
    ['HERMES_SECRET_TOKEN', hermesSecretToken],
    ['HERMES_WEBHOOK_TIMEOUT_MS', pickNonEmpty(oldGw.get('HERMES_WEBHOOK_TIMEOUT_MS'), '15000')],
    ['HERMES_WEBHOOK_RETRIES', pickNonEmpty(oldGw.get('HERMES_WEBHOOK_RETRIES'), '2')],
    ['WEBHOOK_CONCURRENCY', pickNonEmpty(oldGw.get('WEBHOOK_CONCURRENCY'), '8')],
    ['DEFAULT_COUNTRY_CODE', countryCode],
    ['ALLOWED_NUMBERS', oldGw.get('ALLOWED_NUMBERS') ?? ''],
    ['FORWARD_GROUPS', pickNonEmpty(oldGw.get('FORWARD_GROUPS'), 'true')],
    ['MASTER_PHONE', masterPhone],
    ['MASTER_LID', masterLid],
    ['MASTER_NAME', masterName]
  ],
  oldGw
);

writeEnvAtomic(
  rxEnvPath,
  [
    ['RECEIVER_HOST', pickNonEmpty(oldRx.get('RECEIVER_HOST'), '127.0.0.1')],
    ['RECEIVER_PORT', receiverPort],
    ['RECEIVER_DATA_DIR', receiverDir],
    ['WHATSAPP_GATEWAY_URL', pickNonEmpty(oldRx.get('WHATSAPP_GATEWAY_URL'), `http://127.0.0.1:${gatewayPort}`)],
    ['GATEWAY_API_KEY', gatewayApiKey],
    ['HERMES_SECRET_TOKEN', hermesSecretToken],
    ['MASTER_PHONE', masterPhone],
    ['MASTER_LID', masterLid],
    ['MASTER_NAME', masterName],
    ['DEFAULT_COUNTRY_CODE', countryCode],
    ['TIMEZONE', timezone],
    ['WHISPER_MODEL', pickNonEmpty(oldRx.get('WHISPER_MODEL'), 'base')],
    ['WHISPER_DTYPE', pickNonEmpty(oldRx.get('WHISPER_DTYPE'), 'q8')],
    ['WHISPER_CACHE_DIR', pickNonEmpty(oldRx.get('WHISPER_CACHE_DIR'), path.join(receiverDir, 'models'))],
    ['HERMES_BIN', pickNonEmpty(oldRx.get('HERMES_BIN'), hermesBinPath)],
    ['HERMES_RULES_PATH', pickNonEmpty(oldRx.get('HERMES_RULES_PATH'), path.join(process.env.HOME || '', '.hermes', 'skills', 'whatsapp-agent-rules', 'SKILL.md'))],
    ['AGENT_TOOLSETS', pickNonEmpty(oldRx.get('AGENT_TOOLSETS'), 'web,vision')],
    ['AGENT_TOOLSETS_OWNER', pickNonEmpty(oldRx.get('AGENT_TOOLSETS_OWNER'), 'terminal,file,web,vision')],
    ['AGENT_TIMEOUT_SECONDS', pickNonEmpty(oldRx.get('AGENT_TIMEOUT_SECONDS'), '300')],
    ['COALESCE_WINDOW_SECONDS', pickNonEmpty(oldRx.get('COALESCE_WINDOW_SECONDS'), '2.5')],
    ['MAX_CONCURRENT_RUNS', pickNonEmpty(oldRx.get('MAX_CONCURRENT_RUNS'), '4')],
    ['DRAIN_SECONDS', pickNonEmpty(oldRx.get('DRAIN_SECONDS'), '120')],
    ['STARTUP_REPLAY', pickNonEmpty(oldRx.get('STARTUP_REPLAY'), 'true')],
    ['REPLAY_MAX_AGE_MIN', pickNonEmpty(oldRx.get('REPLAY_MAX_AGE_MIN'), '60')],
    ['HISTORY_LIMIT', pickNonEmpty(oldRx.get('HISTORY_LIMIT'), '30')],
    ['DAILY_REPLY_LIMIT_PER_PERSON', pickNonEmpty(oldRx.get('DAILY_REPLY_LIMIT_PER_PERSON'), '25')],
    ['HOURLY_GLOBAL_REPLY_LIMIT', pickNonEmpty(oldRx.get('HOURLY_GLOBAL_REPLY_LIMIT'), '60')],
    ['SPLIT_MESSAGE_DELAY_SECONDS', pickNonEmpty(oldRx.get('SPLIT_MESSAGE_DELAY_SECONDS'), '2.0')],
    ['MAX_MESSAGES_PER_TURN', pickNonEmpty(oldRx.get('MAX_MESSAGES_PER_TURN'), '5')],
    ['MAX_MEDIA_BYTES', pickNonEmpty(oldRx.get('MAX_MEDIA_BYTES'), '26214400')],
    ['DRY_RUN', pickNonEmpty(oldRx.get('DRY_RUN'), 'false')]
  ],
  oldRx
);

console.log(`[install] Wrote chmod 600 configs: ${gwEnvPath} and ${rxEnvPath}`);
NODE

# 3. Install Node dependencies, typecheck, and build dist/
if [[ "${SKIP_BUILD}" != "true" ]]; then
  echo "[install] Running npm ci, typecheck, and build in ${REPO_DIR}..."
  cd "${REPO_DIR}"
  "${NPM_BIN}" ci
  "${NPM_BIN}" run typecheck
  "${NPM_BIN}" run build
else
  echo "[install] --skip-build set; skipping npm ci, typecheck, and build."
fi

# 4. Install Hermes global skills, prompt templates, QR helper, and CLI shims
SKILLS_DIR="${HOME}/.hermes/skills"
mkdir -p \
  "${SKILLS_DIR}/whatsapp-agent-hermes-gateway" \
  "${SKILLS_DIR}/skill-crafter" \
  "${SKILLS_DIR}/whatsapp-agent-rules" \
  "${HOME}/.local/bin"

cp "${REPO_DIR}/wa-agent-SKILL.md" "${SKILLS_DIR}/whatsapp-agent-hermes-gateway/SKILL.md"
cp -r "${REPO_DIR}/skill/." "${SKILLS_DIR}/whatsapp-agent-hermes-gateway/"
chmod +x "${SKILLS_DIR}/whatsapp-agent-hermes-gateway/scripts/fetch-pairing-qr.sh"
cp "${REPO_DIR}/skill-crafter-SKILL.md" "${SKILLS_DIR}/skill-crafter/SKILL.md"

RULES_SKILL_FILE="${SKILLS_DIR}/whatsapp-agent-rules/SKILL.md"
if [[ ! -f "${RULES_SKILL_FILE}" ]]; then
  cat > "${RULES_SKILL_FILE}" <<'EOF'
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
  echo "[install] Seeded ${RULES_SKILL_FILE}"
else
  echo "[install] Preserved existing ${RULES_SKILL_FILE}"
fi

if [[ ! -f "${RECEIVER_DIR}/prompt_template.txt" ]]; then
  cp "${REPO_DIR}/skill/assets/prompt_template.txt" "${RECEIVER_DIR}/prompt_template.txt"
fi
if [[ ! -f "${RECEIVER_DIR}/prompt_template_owner.txt" ]]; then
  cp "${REPO_DIR}/skill/assets/prompt_template_owner.txt" "${RECEIVER_DIR}/prompt_template_owner.txt"
fi

cp "${REPO_DIR}/scripts/fetch-pairing-qr.sh" "${RECEIVER_DIR}/get-qr.sh"
chmod +x "${REPO_DIR}/scripts/fetch-pairing-qr.sh" "${RECEIVER_DIR}/get-qr.sh"

for tool in wa-send wa-history wa-flow; do
  cat > "${HOME}/.local/bin/${tool}" <<EOF
#!/usr/bin/env bash
export RECEIVER_ENV_FILE="\${RECEIVER_ENV_FILE:-${RECEIVER_DIR}/receiver.env}"
exec "${NODE_BIN}" --no-warnings=ExperimentalWarning "${REPO_DIR}/dist/cli/${tool}.js" "\$@"
EOF
  chmod +x "${HOME}/.local/bin/${tool}"
done

cat > "${HOME}/.local/bin/wa-qr" <<EOF
#!/usr/bin/env bash
export RECEIVER_ENV_FILE="\${RECEIVER_ENV_FILE:-${RECEIVER_DIR}/receiver.env}"
exec bash "${REPO_DIR}/scripts/fetch-pairing-qr.sh" "\$@"
EOF
chmod +x "${HOME}/.local/bin/wa-qr"
echo "[install] Installed CLI shims in ${HOME}/.local/bin: wa-send, wa-history, wa-flow, wa-qr"

# 5. Pre-download pure-Node ONNX Whisper model unless skipped
if [[ "${SKIP_WHISPER_WARMUP}" != "true" ]]; then
  echo "[install] Pre-loading local ONNX Whisper model into ${RECEIVER_DIR}/models..."
  if ! RECEIVER_ENV_FILE="${RECEIVER_DIR}/receiver.env" "${NODE_BIN}" --no-warnings=ExperimentalWarning "${REPO_DIR}/dist/cli/wa-whisper-warmup.js"; then
    echo "[install] Warning: Whisper model warmup failed; receiver will retry lazy-download on first voice note." >&2
  fi
fi

# 6. Install systemd --user services and run live health & auth self-checks
if [[ "${SKIP_SYSTEMD}" == "true" ]]; then
  echo "[install] --skip-systemd set; skipping systemd service setup and live verification."
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[install] Error: systemctl not found. Re-run with --skip-systemd on non-systemd hosts." >&2
  exit 1
fi

CURRENT_USER="${USER:-$(id -un)}"
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "${CURRENT_USER}" 2>/dev/null \
    || sudo -n loginctl enable-linger "${CURRENT_USER}" 2>/dev/null \
    || echo "[install] Note: run 'sudo loginctl enable-linger ${CURRENT_USER}' if user services should survive reboot."
fi

if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
mkdir -p "${SYSTEMD_USER_DIR}"

"${NODE_BIN}" --input-type=module - \
  "${REPO_DIR}" \
  "${RECEIVER_DIR}" \
  "${NODE_BIN}" \
  "${NODE_BIN_DIR}" \
  "${SYSTEMD_USER_DIR}" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [repoDir, receiverDir, nodeBin, nodeBinDir, systemdUserDir] = process.argv.slice(2);
const templates = [
  ['whatsapp-agent-hermes.service.tpl', 'whatsapp-agent-hermes.service'],
  ['hermes-wa-receiver.service.tpl', 'hermes-wa-receiver.service']
];

for (const [tplName, outName] of templates) {
  const tpl = fs.readFileSync(path.join(repoDir, 'systemd', tplName), 'utf8');
  const rendered = tpl
    .replaceAll('{{REPO_DIR}}', repoDir)
    .replaceAll('{{RECEIVER_DIR}}', receiverDir)
    .replaceAll('{{NODE_BIN}}', nodeBin)
    .replaceAll('{{NODE_BIN_DIR}}', nodeBinDir);
  fs.writeFileSync(path.join(systemdUserDir, outName), rendered, 'utf8');
}
NODE

systemctl --user daemon-reload
systemctl --user enable whatsapp-agent-hermes.service hermes-wa-receiver.service
systemctl --user restart whatsapp-agent-hermes.service hermes-wa-receiver.service

GATEWAY_PORT="$(grep -E '^PORT=' "${REPO_DIR}/.env" | tail -n1 | cut -d'=' -f2- | tr -d "\"'\r")"
GATEWAY_API_KEY_VAL="$(grep -E '^GATEWAY_API_KEY=' "${REPO_DIR}/.env" | tail -n1 | cut -d'=' -f2- | tr -d "\"'\r")"
RECEIVER_PORT_VAL="$(grep -E '^RECEIVER_PORT=' "${RECEIVER_DIR}/receiver.env" | tail -n1 | cut -d'=' -f2- | tr -d "\"'\r")"
GW_BASE="http://127.0.0.1:${GATEWAY_PORT:-3100}"
RX_BASE="http://127.0.0.1:${RECEIVER_PORT_VAL:-5000}"

echo "[install] Waiting for gateway (${GW_BASE}) and receiver (${RX_BASE}) health checks..."
gw_ok=false
rx_ok=false
for _ in $(seq 1 20); do
  if [[ "${gw_ok}" != "true" ]] && curl -fsS "${GW_BASE}/api/health" >/dev/null 2>&1; then
    gw_ok=true
  fi
  if [[ "${rx_ok}" != "true" ]] && curl -fsS "${RX_BASE}/health" >/dev/null 2>&1; then
    rx_ok=true
  fi
  if [[ "${gw_ok}" == "true" && "${rx_ok}" == "true" ]]; then
    break
  fi
  sleep 1
done

if [[ "${gw_ok}" != "true" || "${rx_ok}" != "true" ]]; then
  echo "[install] Error: services did not become healthy in time (gateway=${gw_ok}, receiver=${rx_ok})." >&2
  systemctl --user status whatsapp-agent-hermes.service hermes-wa-receiver.service --no-pager >&2 || true
  exit 1
fi

unauth_code="$(curl -s -o /dev/null -w "%{http_code}" "${GW_BASE}/api/status")"
if [[ "${unauth_code}" != "401" ]]; then
  echo "[install] Error: expected HTTP 401 on unauthenticated /api/status, got ${unauth_code}." >&2
  exit 1
fi

auth_code="$(curl -s -o /dev/null -w "%{http_code}" -H "x-api-key: ${GATEWAY_API_KEY_VAL}" "${GW_BASE}/api/status")"
if [[ "${auth_code}" != "200" ]]; then
  echo "[install] Error: expected HTTP 200 on authenticated /api/status, got ${auth_code}." >&2
  exit 1
fi

webhook_res="$(curl -fsS -X POST -H "x-api-key: ${GATEWAY_API_KEY_VAL}" "${GW_BASE}/api/webhook/test")"
echo "[install] Gateway health: $(curl -fsS "${GW_BASE}/api/health")"
echo "[install] Receiver health: $(curl -fsS "${RX_BASE}/health")"
echo "[install] Webhook test: ${webhook_res}"
echo "[install] Done! Next step: pair WhatsApp via 'wa-qr /tmp/wa-qr.png' or dashboard on ${GW_BASE}."
