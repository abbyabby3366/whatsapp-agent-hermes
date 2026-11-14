---
name: whatsapp-agent-hermes-gateway
description: "Use when operating, diagnosing, configuring, or administering the WhatsApp Baileys gateway (`whatsapp-agent-hermes`) and built-in Node Hermes webhook receiver (`hermes-wa-receiver`): pairing QR codes (`wa-qr` / `GET /api/qr.png`), checking service health/logs, managing per-contact briefs (`contacts.json`) and task/fact state (`flows.json` / `wa-flow`), querying SQLite chat history (`wa_history.db` / `wa-history`), toggling global or per-contact pauses, sending outbound WhatsApp text/media/stickers to phone numbers, `@username` handles (with optional 4-digit PIN), or JIDs (`wa-send`), resolving WhatsApp `@username`/LID-to-phone mappings, or troubleshooting Error 463, burst coalescing, and webhook delivery."
version: 2.0.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    requires_toolsets: [terminal]
    tags: [whatsapp, baileys, gateway, webhook, receiver, systemd, ops, messaging, username]
---

# WhatsApp Agent Hermes — External Gateway + Built-In Node Receiver

This architecture decouples WhatsApp connectivity from the core Hermes process. Both the Express + Baileys gateway (`~/whatsapp-agent-hermes/dist/index.js`) and the webhook receiver (`~/whatsapp-agent-hermes/dist/receiver/index.js`) live in the `~/whatsapp-agent-hermes` repo and run as isolated `systemd --user` processes with runtime state under `~/whatsapp-hermes-receiver/`.

**Key Architectural Invariants**:
1. **Session & Process Isolation**: Hermes never holds Baileys/WhatsApp credentials, and gateway restarts never drop in-flight Hermes turns. They communicate strictly over authenticated loopback HTTP (`x-hermes-token` inbound, `x-api-key` outbound).
2. **Role & Context Separation**: Contact-facing turns do **not** load this DevOps `SKILL.md`. Instead, `dist/receiver/index.js` injects the lean ghostwriter prompt (`assets/prompt_template.txt`) for external contacts and `assets/prompt_template_owner.txt` exclusively for verified 1:1 Master DMs.

## When to Use

Load and apply this skill whenever you need to:
- Check gateway/receiver service status, inspect live logs, or export a fresh WhatsApp pairing QR PNG (`~/.local/bin/wa-qr` or `GET /api/qr.png`).
- Manage contact profiles (`contacts.json`), per-contact open items/facts (`wa-flow` / `flows.json`), or search SQLite conversation history (`wa-history` / `wa_history.db`).
- Administer runtime controls (global `on/off`, `pause <number|@username> <duration>`, `resume <number|@username>`).
- Send outbound WhatsApp text, images, documents, or stickers to phone numbers, `@username` handles (`@username` or `@username#1234` with 4-digit PIN), or JIDs via `~/.local/bin/wa-send` or the gateway REST API (`/api/send*`, `/api/resolve`).
- Maintain, rebuild, or debug receiver logic (`src/receiver/*`), prompt templates, `@username` & LID canonicalization, burst superseding, or WhatsApp Error 463 restrictions.

For deep implementation schemas, subprocess contracts, systemd unit files, and Nginx tunnel configs, load the progressive-disclosure files in `SKILL_DIR`:
- `SKILL_DIR/assets/prompt_template.txt` — Contact-facing first-person ghostwriter prompt.
- `SKILL_DIR/assets/prompt_template_owner.txt` — Verified 1:1 Master DM operator prompt.
- `SKILL_DIR/references/hermes-backend-contract.md` — Subprocess flags, XML untrusted-input wrapping, `@@FLAG@@`/`NO_REPLY` parser order, and `sanitizeReply()`.
- `SKILL_DIR/references/deployment-and-env.md` — `scripts/install.sh`, `systemd --user` units, Nginx + SSH tunnel setup, and full `receiver.env` tunables table.
- `SKILL_DIR/scripts/fetch-pairing-qr.sh` — Helper script to trigger `/api/connect` and download `GET /api/qr.png`.

---

## Layout & Architecture

| Component | Entrypoint / State | Service (`systemd --user`) | Loopback Port |
|---|---|---|---|
| Gateway + Dashboard | `~/whatsapp-agent-hermes/dist/index.js` | `whatsapp-agent-hermes.service` | `3100` |
| Built-In Node Receiver | `~/whatsapp-agent-hermes/dist/receiver/index.js` (state in `~/whatsapp-hermes-receiver/`) | `hermes-wa-receiver.service` | `5000` |

### Receiver Runtime Files (`~/whatsapp-hermes-receiver/`)
- `receiver.env`: Environment configuration shared cleanly with `systemd --user`.
- `wa_history.db`: SQLite conversation history store (via Node `node:sqlite`, WAL mode; queried via `~/.local/bin/wa-history`).
- `handled.json`: Idempotency ledger of terminal message outcomes (`sent`, `silent`, `dry-run`, `failed-502`).
- `chat_map.json`: Canonical WhatsApp 15-digit LID (`...@lid`) <-> phone number <-> `@username` lookup map (gateway also persists `~/whatsapp-agent-hermes/data/usernames.json` from inbound messages, contacts sync, and USync lookups).
- `sessions.json`: Canonical chat key -> active Hermes `session_id` mapping.
- `state.json`: Persisted runtime toggles (global on/off, per-contact pause timers, reply quotas, learned `masterLid`).
- `contacts.json`: Per-contact briefs, personas, notes, and `auto_reply` toggles (hot-reloaded per turn).
- `prompt_template.txt`: Live contact ghostwriter brief (seeded from `SKILL_DIR/assets/prompt_template.txt`, hot-reloaded per turn).
- `prompt_template_owner.txt`: Live 1:1 Master operator brief (seeded from `SKILL_DIR/assets/prompt_template_owner.txt`, hot-reloaded per turn).
- `outbox.json`: Ledger of outbound `[FLAG]` escalations so Master quote-replies resolve back to the target contact `chatJid`.
- `flows.json`: Per-contact operational state (`open` items, `facts`, timestamped `events`; managed via `~/.local/bin/wa-flow`).
- `media/` & `models/`: Local cache directory for inbound media and cached `@huggingface/transformers` Whisper ONNX weights.
- `~/.hermes/skills/skill-crafter/SKILL.md` + `~/.hermes/skills/whatsapp-agent-rules/SKILL.md`: Companion single-file global meta-skill (`skill-crafter`) and reinstall-safe user-owned rules skill (`whatsapp-agent-rules`). Whenever the owner teaches or updates how to operate or reply with WhatsApp, `skill-crafter` merges it into `whatsapp-agent-rules/SKILL.md` (single `.md` file, zero subfolders, trivial 1-file export). The receiver hot-loads Section 2 + only the matching contact's `###` block from Section 3 on contact turns while keeping Section 1 owner-only.

### Configuration & Loopback Auth
- **Gateway `.env`**: `PORT=3100`, `HOST=127.0.0.1`, `GATEWAY_API_KEY=<48-hex-secret>`, `HERMES_WEBHOOK_URL=http://127.0.0.1:5000/api/webhook`, `HERMES_SECRET_TOKEN=<48-hex-secret>`, `TIMEZONE=Asia/Kuala_Lumpur`.
- **Receiver `receiver.env`**: Shared `HERMES_SECRET_TOKEN` and `GATEWAY_API_KEY`, `WHATSAPP_GATEWAY_URL=http://127.0.0.1:3100`, `MASTER_PHONE=<digits>` (alias: `OWNER_WHATSAPP`), optional `MASTER_LID=<15-digit-lid>`, `MASTER_NAME=<name>`, and `WHISPER_MODEL=base` / `WHISPER_DTYPE=q8` (local pure-Node ONNX Whisper via `@huggingface/transformers` + `ffmpeg-static`; zero Python, zero API keys).
- **AI Brain = Box's Own AI Proxy Only**: Replies come from `hermes chat -Q` using this host's built-in AI proxy / configured Hermes model. Never ask the owner for an LLM or provider API key, never configure alternate endpoints, and spawn `hermes chat -Q` with a full copy of `process.env` minus only `GATEWAY_API_KEY`, `HERMES_SECRET_TOKEN` (an allow-list env breaks proxy auth). If the proxy refuses (unauthorized / budget), verify env passthrough first, then report it — don't solicit a key.
- **Mandatory `GATEWAY_API_KEY` (Even on `127.0.0.1`)**: Never leave `GATEWAY_API_KEY` blank. Because external contacts run with `AGENT_TOOLSETS=web,vision`, requiring `x-api-key` on all non-health `/api/*` endpoints prevents prompt-injected SSRF requests from reading `/api/status` (which contains recent messages across all chats) or calling `/api/send` / `/api/logout`.
- **Single Process Manager (`systemd --user`)**: Always run both services under `systemd --user` with lingering enabled (`loginctl enable-linger`). Never mix `pm2` and `systemd` on the same server.

---

## Ops Cheatsheet

```bash
# Load GATEWAY_API_KEY for authenticated gateway calls
export GATEWAY_API_KEY="$(grep -E '^GATEWAY_API_KEY=' ~/whatsapp-agent-hermes/.env | cut -d= -f2-)"

# Service status and live logs
systemctl --user status whatsapp-agent-hermes hermes-wa-receiver
journalctl --user -u hermes-wa-receiver -f              # Live receiver decision log
journalctl --user -u whatsapp-agent-hermes -f           # Live Baileys gateway log

# Restarts (prompt_template*.txt, contacts.json, flows.json, and rules SKILL.md hot-reload without restart)
systemctl --user restart hermes-wa-receiver             # Required after src/receiver/* TypeScript rebuild
systemctl --user restart whatsapp-agent-hermes          # Required after gateway TypeScript rebuild

# Health & end-to-end webhook checks
curl -s http://127.0.0.1:3100/api/health                # Public liveness: {"success":true,"whatsapp":"connected",...}
curl -s http://127.0.0.1:5000/health                    # Receiver health: {"ok":true,"turns_active":0}
curl -s -X POST http://127.0.0.1:3100/api/webhook/test \
  -H "x-api-key: $GATEWAY_API_KEY"                      # Authenticated gateway -> receiver ping

# Export fresh pairing QR PNG (calls POST /api/connect + GET /api/qr.png)
~/.local/bin/wa-qr /tmp/wa-qr.png

# Upgrading code & re-running idempotent installer
cd ~/whatsapp-agent-hermes && git pull && bash scripts/install.sh --skip-whisper-warmup
```

---

## Message Lifecycle & Human Cadence

```mermaid
sequenceDiagram
    autonumber
    actor User as WhatsApp Contact
    participant GW as Gateway (:3100)
    participant Recv as Receiver (:5000)
    participant Agent as Hermes Core
    actor Master as Master Operator

    User->>GW: Inbound WhatsApp message
    GW->>Recv: POST /api/webhook (x-hermes-token)
    Recv-->>GW: HTTP 200 {"reply": null, "status": "processing"}
    Note over Recv: Coalesce burst (2.5s) & supersede any in-flight run
    Note over Recv,Agent: Draft silently (NO /api/read yet, NO typing indicator)
    Recv->>Agent: Run Hermes with XML-wrapped untrusted input + SQLite history
    Agent-->>Recv: Raw output (optional @@FLAG@@ + reply chunks or NO_REPLY)
    opt Output contains @@FLAG@@
        Recv->>GW: POST /api/send { to: MASTER_PHONE, message: "[FLAG] ..." }
        GW->>Master: Escalation alert (contact reply is NOT held)
    end
    alt Remaining body is NO_REPLY
        Note over Recv: Ledgered as "silent"; no /api/read, no send
    else Remaining body has 1..5 chunks (split by ===MSG===)
        Recv->>GW: POST /api/read { messageId } (blue ticks right before reply)
        Recv->>GW: POST /api/send { to: chatJid, message: part1 }
        loop For subsequent split parts (2..N)
            Recv->>GW: POST /api/presence { recipient: chatJid, presence: "composing" }
            Note over Recv: ~2.0s pause between split messages
            Recv->>GW: POST /api/send { to: chatJid, message: partK }
            Recv->>GW: POST /api/presence { recipient: chatJid, presence: "paused" }
        end
    end
```

- **Fast Webhook Release**: Answer the gateway within 15s using `{"reply": null, "status": "processing"}` and dispatch async work in the background.
- **Immediate Live Replies (No Draft Approval Gate)**: Never hold outbound replies in a `[DRAFT APPROVAL]` queue. Once paired, automated replies dispatch live directly to contacts (unless `NO_REPLY`, global `off`, or the contact is paused / `"auto_reply": false`).
- **No Premature Blue Ticks (`/api/read`)**: Never mark a message read at webhook arrival. Only call `POST /api/read` immediately before dispatching an outbound reply (so `NO_REPLY` turns never flash instant 3:00 AM blue ticks).
- **Silent First Draft**: Never send `presence: "composing"` while generating the initial reply. Only show `"composing"` during the ~2s pause between split messages `2..N`.
- **Bursts & Superseding**:
  1. Consecutive messages within `COALESCE_WINDOW_SECONDS` (`2.5s`) bundle into one turn.
  2. If a new message arrives mid-generation for that chat, bump the chat's generation counter, terminate the in-flight process group (`process.kill(-pid, 'SIGTERM')`), discard its partial draft, and re-run once on the combined burst.
  3. Cap parallel Hermes subprocesses with `MAX_CONCURRENT_RUNS` (`4`).

---

## Media & Voice Note Handling

- **Gateway Media Cache**: The gateway caches raw messages in memory for the last `300` messages. Download media immediately on webhook arrival via `GET /api/media/<messageId>` (with `x-api-key`). Never abort a turn if media download fails — note `[media download failed]` in context so the agent can ask the sender to resend.
- **Images**: Saved into `media/` and passed to Hermes via `--image <path>`.
- **Audio / Voice Notes (Local Pure-Node ONNX Whisper Only)**:
  - Decoded in memory to 16 kHz mono PCM via `ffmpeg-static` and transcribed locally with `@huggingface/transformers` (`onnx-community/whisper-${WHISPER_MODEL}`, default `base`, CPU `q8` quantized, cached in `~/whatsapp-hermes-receiver/models`, zero Python, zero API keys) and injected as `[voice note | engine: whisper-onnx | lang: <code> | transcript: "..."]` (or marked `unclear` when speech is absent/muffled). Never use Gemini or any external transcription API.
  - If the audio is noisy or `unclear` on critical details (prices, dates, names), the agent must ask naturally (*"Sorry, your voice note broke up a bit, mind typing that out?"*) rather than guessing.

---

## Message Terminal States & Invariants

| Outcome | Meaning | Ledgered in `handled.json`? | Action on Restart |
|---|---|---|---|
| `sent` | Reply successfully dispatched via `/api/send` | **Yes** | None |
| `silent` | Agent emitted explicit `NO_REPLY` (after stripping `@@FLAG@@`) | **Yes** | None |
| `dry-run` | `DRY_RUN=true` testing mode | **Yes** | None |
| `failed-502` | Permanent WhatsApp stanza / cold outreach rejection (Error 463 / 479) | **Yes** | None (alert sent to `MASTER_PHONE`) |
| `no-answer` | Subprocess crashed, timed out, or returned empty stdout | **No** | Retried via `replayOrphans()` |
| `send-failed` | `/api/send` failed after retries (e.g., HTTP 503 disconnect) | **No** | Retried + alert to `MASTER_PHONE` |
| `superseded` | Killed and replaced by newer message in burst | **No** | Consolidated into next turn |

- **Parser Order Invariant (`@@FLAG@@` Before `NO_REPLY`)**: Always extract and strip `@@FLAG@@ <summary>` lines **first** and forward those alerts to `MASTER_PHONE`. Only **after** stripping `@@FLAG@@` lines, check whether the remaining trimmed output equals `NO_REPLY` (or empty when a flag was present). Never send literal `"NO_REPLY"` to a contact.
- **Startup Replay (`replayOrphans`)**: Unledgered inbound messages younger than `REPLAY_MAX_AGE_MIN` (evaluated via numeric `rawTimestamp` epoch seconds) are replayed on receiver startup.

---

## Conversation History, Contacts & Flow State

### 1. SQLite Conversation Store (`~/.local/bin/wa-history` / `wa_history.db`)
- Persists `chat_key`, `message_id` (`out:<inbound_id>:<chunk>` for outbound), `direction` (`in`/`out`), `sender_name`, `sender_number`, `body`, `wa_timestamp` (ISO 8601), and `stored_at`.
- Injects the last `HISTORY_LIMIT` (`30`) turns as read-only prior context formatted in `DD-MM-YY HH:MM` (`GMT+8`).
```bash
wa-history stats | chats [limit]
wa-history recent <chat_key> [limit]
wa-history search "<keyword>" [limit]
```

### 2. Per-Contact Flow Store (`~/.local/bin/wa-flow` / `flows.json`)
Tracks durable pending tasks, verified facts, and full ISO-timestamped milestones across session resets (rendered in `DD-MM-YY HH:MM` `GMT+8` when injected):
```json
{
  "60123456789": {
    "name": "Contact Name",
    "open": ["Pending invoice delivery", "Awaiting spec sheet"],
    "facts": ["Prefers email confirmation", "Timezone: GMT+8"],
    "events": [{"t": "2026-10-09T10:00:00+08:00", "display": "09-10-26 10:00", "text": "Product details sent"}]
  }
}
```
```bash
wa-flow contacts | show <key>
wa-flow open <key> "<item>" | close <key> "<item>"
wa-flow fact <key> "<fact>" | event <key> "<event>"
```

### 3. Contact Profiles & Notes (`contacts.json`)
Hot-reloaded per turn to customize persona, relationship context, `@username` handle, or disable auto-reply (`"auto_reply": false`) per person without restarting services (keyed by phone digits or 15-digit LID when phone is hidden):
```json
{
  "60123456789": {
    "name": "Acme Corp Lead",
    "username": "alex_tan",
    "relation": "Client",
    "auto_reply": true,
    "persona": "Warm and professional enterprise partner",
    "notes": {
      "what_we_know": "Interested in enterprise tier, decision maker is Alex, budget approved.",
      "what_is_missing": "Implementation timeline and contract start date.",
      "how_to_approach": "Direct, transparent pricing; no standard promotional discounts."
    }
  }
}
```

---

## Contact Ghostwriter Rules Summary (`assets/prompt_template.txt`)

When editing `~/whatsapp-hermes-receiver/prompt_template.txt`, preserve these core behavioral rules:

1. **First-Person Principal**: Speak strictly as `${MASTER_NAME}` ("I", "me", "my"). Never say *"I will check with `${MASTER_NAME}`"*. Use first-person holding lines (*"Give me a moment to verify that and get back to you."*) + `@@FLAG@@`.
2. **WhatsApp-Native Formatting Only**:
   - Bold: single asterisks `*bold*` (**never** Markdown `**bold**`).
   - Italic: `_italic_`; Strikethrough: `~text~`; Bullets: `-` or `•`.
   - **Never** output `#` headings, `[label](url)` Markdown links (use bare URLs), em/en dashes (`—`, `–`, `--`), or routing prefixes (`To:`, `@@TO@@`, `Bot:`).
   - `sanitizeReply()` (`src/receiver/sanitizer.ts`) deterministically converts stray `**bold**` -> `*bold*` (preserving spacing around CJK/alphanumeric characters via shared `formatWhatsAppText()`), strips `#` headers, flattens Markdown links, and replaces em dashes.
3. **Concise Multi-Message Cadence (`===MSG===`)**:
   - **1–3 sentences** per message (1–2 ideal), up to **5 messages** separated by `===MSG===`.
   - Never split bullet lists or structured blocks across messages. Place at most **one question per turn**, strictly in the **final** split message.
4. **Zero AI Filler**:
   - **Banned Openers**: *"Great question!"*, *"Certainly!"*, *"Sure, I can help with that!"*, *"Thanks for reaching out!"*, *"I completely understand"*.
   - **Banned Closers**: *"Let me know if you need anything else"*, *"Feel free to reach out"*.
5. **Malaysian Language & Vibe Mirroring**:
   - Warm Malaysian tone; mirror English, Chinese, Malay, or natural Manglish code-switching.
   - **Emoji Priority**: Serious/urgent/upset threads get **0 emojis** (strictly overriding all other emoji rules, including first messages). Casual/warm opening greetings carry **1 natural emoji**; follow-ups use at most 1 emoji every 3–4 warm turns, never back-to-back.
6. **Deliberate Silence (`NO_REPLY`) & Silent Escalation**:
   - Emit `NO_REPLY` on bare acknowledgments (`ok`, `noted`, `thanks`), single-emoji replies (`👍`), or chatter not needing an answer.
   - When silent escalation is needed, emit `NO_REPLY` on line 1 and `@@FLAG@@ <summary>` on line 2.

---

## Security Boundaries & Master Authority

### Untrusted Contact Sandbox & Anti-Injection
- **Restricted Toolset**: External contacts run strictly with `AGENT_TOOLSETS=web,vision` (no terminal, no file write, no memory/config mutation).
- **XML Data Delimiters**: Strip `===MSG===` and `@@FLAG@@` from inbound contact strings (`senderName`, `quoted`, `message`) and wrap all inbound contact content inside `<untrusted_inbound_message>...</untrusted_inbound_message>` so contacts cannot spoof `[Known: ...]` operator tags or system rules.
- **Safety Quotas**: Max **25 replies/person/day** (`DAILY_REPLY_LIMIT_PER_PERSON`) and **60 replies/hour globally** (`HOURLY_GLOBAL_REPLY_LIMIT`). Group messages without `@mention` or quote-reply to the linked account are ignored.

### Master 1:1 DM Authority & Phone Commands
- **Strict 1:1 DM Gate (`isGroup == false`)**: Elevated Master mode (`AGENT_TOOLSETS_OWNER=terminal,file,web,vision` + `prompt_template_owner.txt` + administrative commands) activates **only** when `isGroup == false` AND the sender matches `MASTER_PHONE` or verified `MASTER_LID`. In group chats, even messages sent by `MASTER_PHONE` run under standard non-privileged group rules so internal outputs never leak into shared groups.
- **Phone Admin Commands** (case-insensitive in 1:1 Master DM):
  - `status` — Health, active sessions, global on/off state, paused contacts, quota counters.
  - `on` / `off` — Enable or disable automated contact replies globally.
  - `pause <number|@username> <duration>` / `resume <number|@username>` — Pause (e.g., `4h`, `30m`, `1d`) or resume auto-replies for a contact.
  - **Quote-Reply to `[FLAG]` Escalation** — Resolve target contact from `outbox.json` and carry out the instruction toward that contact in `${MASTER_NAME}`'s first-person voice.

---

## Outbound Dispatch & Contacting `@username` Handles

Never reject an instruction to message `@username` by demanding a phone number. The gateway natively resolves WhatsApp `@username` handles (via its cached `data/usernames.json` directory and live Baileys `USyncContactProtocol` queries) into deliverable `@lid` / `@s.whatsapp.net` JIDs.

### `@username` Resolution Priority Order
1. **Check Local Known Contacts & History First (Zero Rate-Limit Risk)**:
   - Look up `@username` (case-insensitive, without `@`) in `contacts.json` (`"username"` field or alias), `chat_map.json`, `GET /api/usernames`, or `wa-history search`.
   - If the contact already has a known `chatJid` (`...@lid` or `...@s.whatsapp.net`), send directly to that `chatJid`.
2. **Send or Resolve via Gateway (`@username` or `@username#PIN`)**:
   - Pass `"to": "@username"` directly to `POST /api/send`, `/api/send-image`, `/api/send-document`, or `/api/send-sticker` (with optional `"pin": "1234"` or inline `"@username#1234"` when the recipient uses a 4-digit WhatsApp username PIN).
   - To inspect or resolve a handle before sending:
     ```bash
     curl -s "http://127.0.0.1:3100/api/resolve?target=@alex_tan" -H "x-api-key: $GATEWAY_API_KEY"
     curl -s "http://127.0.0.1:3100/api/resolve?target=@alex_tan&pin=1234" -H "x-api-key: $GATEWAY_API_KEY"
     curl -s "http://127.0.0.1:3100/api/usernames" -H "x-api-key: $GATEWAY_API_KEY"
     ```
3. **Handle PIN Challenges & Cold-Outreach Restrictions Cleanly**:
   - **HTTP `400` (Bad Recipient / PIN Format)**: The handle or PIN is malformed (PINs are exactly 4 digits; send them as a string like `"0412"` — a JSON number `412` is also read as `"0412"`). Fix the input instead of retrying.
   - **HTTP `403` / `404` (Username PIN Required)**: Do not guess PINs. Ask `${MASTER_NAME}` for the recipient's 4-digit WhatsApp username PIN and retry once with `"pin": "1234"` (or `"@username#1234"`).
   - **HTTP `429` (USync Rate Limit)**: Stop repeated lookups and wait before retrying.
   - **HTTP `503` (Gateway Disconnected or WhatsApp Timed Out)**: Retry later with backoff.
   - **HTTP `502` with Error `479` (Stanza Rejected)**: WhatsApp refused the message (usually a stale device session). Do not retry in a loop; alert `${MASTER_NAME}`.
   - **HTTP `502` with Error `463` (Cold 1:1 Outreach Blocked)**: Even after `@username` resolves to `...@lid`, WhatsApp blocks linked devices from initiating brand-new 1:1 chats when no `tctoken` exists. Never retry Error 463 in a loop — ask `${MASTER_NAME}` to send the very first message to `@username` manually from the primary WhatsApp phone app, after which automated replies and follow-ups work normally.

### Outbound CLI Helper (`~/.local/bin/wa-send`)
`<recipient>` accepts phone digits (`60123456789`), full JID (`...@lid` / `...@s.whatsapp.net` / `...@g.us`), `@username`, or `@username#1234`:
```bash
wa-send text    <recipient> "Message content"
wa-send text    @alex_tan "Hi Alex, following up on the proposal"
wa-send text    "@alex_tan#1234" "Hi Alex!"
wa-send image   <recipient> /path/to/photo.jpg "Caption"
wa-send doc     <recipient> /path/to/document.pdf "Caption" --name report.pdf
wa-send sticker <recipient> /path/to/sticker.png "Pack" "Author"
```
When given a local file path outside `ALLOWED_MEDIA_DIR`, `wa-send` reads the file directly and encodes it as a `data:<mime>;base64,...` URI (up to `MAX_MEDIA_BYTES`, 25 MiB) before calling `/api/send-image`, `/api/send-document`, or `/api/send-sticker` with `x-api-key: $GATEWAY_API_KEY` — no local media HTTP server (`media_server.py`) is needed.

---

## Operational Pitfalls

1. **WhatsApp Error 463 (Cold Outreach Restriction)**: Baileys cannot initiate cold 1:1 chats (whether by phone number or `@username` -> `@lid`) without a privacy `tctoken`. Never auto-retry Error 463 sends in a loop (worsens account restrictions); initiate first contact manually from the primary phone or `wa.me/<number>`.
2. **Stdout vs. Stderr Split**: `hermes chat -Q` writes reply text to `stdout` and `session_id: <id>` to `stderr`. Never parse `stdout` for session IDs.
3. **LID & `@username` vs. Phone Thread Splitting**: WhatsApp Web / privacy users often appear as `15-digit@lid` with `sender: null` (and optional `senderUsername`). Always canonicalize through `chat_map.json` (indexing LID, phone digits, and lowercase `senderUsername`) before looking up `sessions.json`, `flows.json`, or `contacts.json`, and reply to `chatJid`. When a LID-only thread later reveals its `@username` or phone number, migrate the thread to the better key (phone → `@username` → LID) instead of starting a new one (see `references/hermes-backend-contract.md` §6).
4. **False "Sent" on Rejected Messages**: The gateway waits ~4s for WhatsApp's server acknowledgement, so immediate Error `463`/`479` rejections return HTTP `502`. Rejections that arrive later flip the dashboard entry to **Failed**. Treat only HTTP `200` as delivered.
5. **Disconnection 503s**: Sending during a brief Baileys reconnect returns HTTP 503. Retry with backoff (up to 6 attempts); if still down, leave unledgered for `replayOrphans()` and alert `MASTER_PHONE` once reconnected.
6. **QR Code Rotation**: Pairing QR codes expire every ~60s. Always run `~/.local/bin/wa-qr` or `scripts/fetch-pairing-qr.sh` (which triggers `POST /api/connect` + fetches raw `GET /api/qr.png`) rather than reading stale cached screenshots.

---

## Verification Checklist

1. `curl -s http://127.0.0.1:3100/api/health` -> `"success": true`, `"whatsapp": "connected"`.
2. `curl -s http://127.0.0.1:5000/health` -> `"ok": true`, `"turns_active": 0`.
3. `curl -s -X POST http://127.0.0.1:3100/api/webhook/test -H "x-api-key: $GATEWAY_API_KEY"` -> `"success": true`, `"status": 200`.
4. **Unauthenticated API Block Check**: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/api/status` -> returns `401` (verifying `GATEWAY_API_KEY` blocks local SSRF).
5. **Burst & Supersede Check**: Send 3 rapid messages within 2s from a test contact -> verify `journalctl --user -u hermes-wa-receiver` coalesces/supersedes into a single turn with `*bold*` WhatsApp-native formatting and zero premature blue ticks.
