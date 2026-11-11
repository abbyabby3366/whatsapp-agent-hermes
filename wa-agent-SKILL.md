---
name: whatsapp-agent-hermes-gateway
description: "Use when operating, diagnosing, configuring, or administering the WhatsApp Baileys gateway (`whatsapp-agent-hermes`) and Hermes webhook receiver (`hermes-wa-receiver`): pairing QR codes, checking service health/logs, managing per-contact briefs (`contacts.json`) and task/fact state (`flows.json` / `flow.py`), querying SQLite chat history (`wa_history.db` / `history.py`), toggling draft approval or per-number pauses, sending outbound WhatsApp text/media/stickers, resolving WhatsApp LID-to-phone mappings, or troubleshooting Error 463, burst coalescing, and webhook delivery."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    requires_toolsets: [terminal]
    tags: [whatsapp, baileys, gateway, webhook, receiver, systemd, ops, messaging]
---

# WhatsApp Agent Hermes — External Gateway + Hermes Receiver

This architecture decouples WhatsApp connectivity from the core Hermes process. WhatsApp sessions run inside an external Node/Express + Baileys gateway (`~/whatsapp-agent-hermes`), while Hermes operates as the reasoning backend through a dedicated webhook receiver (`~/whatsapp-hermes-receiver/receiver.py`).

**Key Architectural Invariants**:
1. **Session Isolation**: Hermes never holds Baileys/WhatsApp credentials. The gateway owns session state and talks to Hermes strictly over authenticated loopback HTTP (`x-hermes-token` inbound, `x-api-key` outbound).
2. **Role & Context Separation**: Contact-facing turns do **not** load this DevOps `SKILL.md`. Instead, `receiver.py` injects the lean ghostwriter prompt (`assets/prompt_template.txt`) for external contacts and `assets/prompt_template_owner.txt` exclusively for verified 1:1 Master DMs.

## When to Use

Load and apply this skill whenever you need to:
- Check gateway/receiver service status, inspect live logs, or export a fresh WhatsApp pairing QR code.
- Manage contact profiles (`contacts.json`), per-contact open items/facts (`flow.py` / `flows.json`), or search conversation history (`history.py` / `wa_history.db`).
- Administer runtime controls (`approval on/off`, global `on/off`, `pause <number> <duration>`, `resume <number>`).
- Send outbound WhatsApp text, images, documents, or stickers via the gateway REST API or `wa_send.py`.
- Implement, update, or debug `receiver.py`, prompt templates, LID canonicalization, burst superseding, or WhatsApp Error 463 restrictions.

For deep implementation schemas, subprocess contracts, systemd unit files, and Nginx tunnel configs, load the progressive-disclosure files in `SKILL_DIR`:
- `SKILL_DIR/assets/prompt_template.txt` — Contact-facing first-person ghostwriter prompt.
- `SKILL_DIR/assets/prompt_template_owner.txt` — Verified 1:1 Master DM operator prompt.
- `SKILL_DIR/references/hermes-backend-contract.md` — Subprocess flags, XML untrusted-input wrapping, `@@FLAG@@`/`NO_REPLY` parser order, and `sanitize_reply()`.
- `SKILL_DIR/references/deployment-and-env.md` — `systemd --user` units, Nginx + SSH tunnel setup, and full `receiver.env` tunables table.
- `SKILL_DIR/scripts/fetch-pairing-qr.sh` — Helper script to trigger `/api/connect` and export a fresh QR PNG.

---

## Layout & Architecture

| Component | Path | Service (`systemd --user`) | Loopback Port |
|---|---|---|---|
| Gateway + Dashboard | `~/whatsapp-agent-hermes` | `whatsapp-agent-hermes.service` | `3100` |
| Hermes Receiver | `~/whatsapp-hermes-receiver/` | `hermes-wa-receiver.service` | `5000` |

### Receiver Working Files (`~/whatsapp-hermes-receiver/`)
- `receiver.py`: Main webhook server, burst coalescer, and async worker dispatcher.
- `history.py` + `wa_history.db`: SQLite conversation history store.
- `handled.json`: Idempotency ledger of terminal message outcomes (`sent`, `silent`, `dry-run`).
- `chat_map.json`: Canonical WhatsApp 15-digit LID (`...@lid`) <-> phone number lookup map.
- `sessions.json`: Canonical chat key -> active Hermes `session_id` mapping.
- `state.json`: Persisted runtime toggles (approval mode, global on/off, per-contact pause timers).
- `contacts.json`: Per-contact briefs, personas, notes, and `auto_reply` toggles (hot-reloaded per turn).
- `prompt_template.txt`: Live contact ghostwriter brief (seeded from `SKILL_DIR/assets/prompt_template.txt`, hot-reloaded per turn).
- `prompt_template_owner.txt`: Live 1:1 Master operator brief (seeded from `SKILL_DIR/assets/prompt_template_owner.txt`, hot-reloaded per turn).
- `outbox.py` + `outbox.json`: Ledger of outbound escalations/drafts so Master quote-replies resolve back to the target contact `chatJid`.
- `flow.py` + `flows.json`: Per-contact operational state (`open` items, `facts`, timestamped `events`).
- `media/`: Local cache directory for inbound and outbound media.

### Configuration & Loopback Auth
- **Gateway `.env`**: `PORT=3100`, `HOST=127.0.0.1`, `GATEWAY_API_KEY=<48-hex-secret>`, `HERMES_WEBHOOK_URL=http://127.0.0.1:5000/api/webhook`, `HERMES_SECRET_TOKEN=<48-hex-secret>`, `TIMEZONE=Asia/Kuala_Lumpur`.
- **Receiver `receiver.env`**: Shared `HERMES_SECRET_TOKEN` and `GATEWAY_API_KEY`, `WHATSAPP_GATEWAY_URL=http://127.0.0.1:3100`, `MASTER_PHONE=<digits>` (alias: `OWNER_WHATSAPP`), optional `MASTER_LID=<15-digit-lid>`, `MASTER_NAME=<name>`, `GEMINI_API_KEY=<key>`.
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

# Restarts (prompt_template*.txt and contacts.json hot-reload without restart)
systemctl --user restart hermes-wa-receiver             # Required after receiver.py edits
systemctl --user restart whatsapp-agent-hermes          # Required after gateway TypeScript rebuild

# Health & end-to-end webhook checks
curl -s http://127.0.0.1:3100/api/health                # Public liveness: {"success":true,"whatsapp":"connected",...}
curl -s http://127.0.0.1:5000/health                    # Receiver health: {"ok":true,"turns_active":0}
curl -s -X POST http://127.0.0.1:3100/api/webhook/test \
  -H "x-api-key: $GATEWAY_API_KEY"                      # Authenticated gateway -> receiver ping

# Export fresh pairing QR PNG (works via skill script or receiver copy)
bash ~/.hermes/skills/whatsapp-agent-hermes-gateway/scripts/fetch-pairing-qr.sh /tmp/wa-qr.png

# Updating gateway code
cd ~/whatsapp-agent-hermes && git pull && npm install && npm run build && systemctl --user restart whatsapp-agent-hermes
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
    Note over Recv: 1) Strip & send any @@FLAG@@ alert to MASTER_PHONE first
    alt Remaining body is NO_REPLY
        Note over Recv: Ledgered as "silent"; no /api/read, no send
    else Remaining body has 1..5 chunks (split by ===MSG===)
        alt Draft Approval Mode is ON
            Recv->>GW: POST /api/send { to: MASTER_PHONE, message: "[DRAFT APPROVAL]..." }
            Master->>GW: Reply: SEND | SKIP | Quote-edit
            GW->>Recv: Webhook with Master decision (1:1 DM only)
        end
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
- **No Premature Blue Ticks (`/api/read`)**: Never mark a message read at webhook arrival. Only call `POST /api/read` immediately before dispatching an approved outbound reply (so `NO_REPLY` turns and held Draft Approval messages never flash instant 3:00 AM blue ticks).
- **Silent First Draft**: Never send `presence: "composing"` while generating the initial reply. Only show `"composing"` during the ~2s pause between split messages `2..N`.
- **Bursts & Superseding**:
  1. Consecutive messages within `COALESCE_WINDOW_SECONDS` (`2.5s`) bundle into one turn.
  2. If a new message arrives mid-generation for that chat, bump the chat's generation counter, kill the in-flight process group (`os.killpg`), discard its partial draft, and re-run once on the combined burst.
  3. Cap parallel Hermes subprocesses with `MAX_CONCURRENT_RUNS` (`4`).

---

## Media & Voice Note Handling

- **Gateway Media Cache**: The gateway caches raw messages in memory for the last `300` messages. Download media immediately on webhook arrival via `GET /api/media/<messageId>` (with `x-api-key`). Never abort a turn if media download fails — note `[media download failed]` in context so the agent can ask the sender to resend.
- **Images**: Saved into `media/` and passed to Hermes via `--image <path>`.
- **Audio / Voice Notes (Gemini Audio — Never Whisper)**:
  - Do **not** use local Whisper / `faster-whisper` (which mangles Malaysian accents and Mandarin/Malay/English code-switching).
  - Analyze downloaded `.ogg` / audio files via **Gemini Audio** with **`LOW` or `MEDIUM` thinking level** to extract both an accurate multilingual/Manglish transcript and vocal vibe (`[voice note | vibe: polite/casual/urgent/unclear | transcript: "..."]`).
  - If the audio is noisy or `unclear` on critical details (prices, dates, names), the agent must ask naturally (*"Sorry, your voice note broke up a bit, mind typing that out?"*) rather than guessing.

---

## Message Terminal States & Invariants

| Outcome | Meaning | Ledgered in `handled.json`? | Action on Restart |
|---|---|---|---|
| `sent` | Reply successfully dispatched via `/api/send` | **Yes** | None |
| `silent` | Agent emitted explicit `NO_REPLY` (after stripping `@@FLAG@@`) | **Yes** | None |
| `dry-run` | `DRY_RUN=true` testing mode | **Yes** | None |
| `no-answer` | Subprocess crashed, timed out, or returned empty stdout | **No** | Retried via `replay_orphans()` |
| `send-failed` | `/api/send` failed after retries (e.g., HTTP 503 disconnect) | **No** | Retried + alert to `MASTER_PHONE` |
| `superseded` | Killed and replaced by newer message in burst | **No** | Consolidated into next turn |

- **Parser Order Invariant (`@@FLAG@@` Before `NO_REPLY`)**: Always extract and strip `@@FLAG@@ <summary>` lines **first** and forward those alerts to `MASTER_PHONE`. Only **after** stripping `@@FLAG@@` lines, check whether the remaining trimmed output equals `NO_REPLY` (or empty when a flag was present). Never send literal `"NO_REPLY"` to a contact.
- **Startup Replay (`replay_orphans`)**: Unledgered inbound messages younger than `REPLAY_MAX_AGE_MIN` (evaluated via numeric `rawTimestamp` epoch seconds) are replayed on receiver startup.

---

## Conversation History, Contacts & Flow State

### 1. SQLite Conversation Store (`history.py` / `wa_history.db`)
- Persists `chat_key`, `message_id` (`out:<inbound_id>` for outbound), `direction` (`in`/`out`), `sender_name`, `sender_number`, `body`, `wa_timestamp` (ISO 8601), and `stored_at`.
- Injects the last `HISTORY_LIMIT` (`30`) turns as read-only prior context formatted in `DD-MM-YY HH:MM` (`GMT+8`).
```bash
python3 ~/whatsapp-hermes-receiver/history.py stats | chats
python3 ~/whatsapp-hermes-receiver/history.py recent <chat_key> 30
python3 ~/whatsapp-hermes-receiver/history.py search "keyword"
```

### 2. Per-Contact Flow Store (`flow.py` / `flows.json`)
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
python3 ~/whatsapp-hermes-receiver/flow.py contacts | show <key>
python3 ~/whatsapp-hermes-receiver/flow.py open <key> "item" | close <key> "item"
python3 ~/whatsapp-hermes-receiver/flow.py fact <key> "fact" | event <key> "event"
```

### 3. Contact Profiles & Notes (`contacts.json`)
Hot-reloaded per turn to customize persona, relationship context, or disable auto-reply (`"auto_reply": false`) per person without restarting services:
```json
{
  "60123456789": {
    "name": "Acme Corp Lead",
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
   - `sanitize_reply()` deterministically converts stray `**bold**` -> `*bold*`, strips `#` headers, flattens Markdown links, and replaces em dashes.
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

## Security Boundaries, Draft Approval & Master Authority

### Untrusted Contact Sandbox & Anti-Injection
- **Restricted Toolset**: External contacts run strictly with `AGENT_TOOLSETS=web,vision` (no terminal, no file write, no memory/config mutation).
- **XML Data Delimiters**: Strip `===MSG===` and `@@FLAG@@` from inbound contact strings (`senderName`, `quoted`, `message`) and wrap all inbound contact content inside `<untrusted_inbound_message>...</untrusted_inbound_message>` so contacts cannot spoof `[Known: ...]` operator tags or system rules.
- **Safety Quotas**: Max **25 replies/person/day** (`DAILY_REPLY_LIMIT_PER_PERSON`) and **60 replies/hour globally** (`HOURLY_GLOBAL_REPLY_LIMIT`). Group messages without `@mention` or quote-reply to the linked account are ignored.

### Master 1:1 DM Authority & Phone Commands
- **Strict 1:1 DM Gate (`isGroup == false`)**: Elevated Master mode (`AGENT_TOOLSETS_OWNER=terminal,file,web,vision` + `prompt_template_owner.txt` + administrative commands) activates **only** when `isGroup == false` AND the sender matches `MASTER_PHONE` or verified `MASTER_LID`. In group chats, even messages sent by `MASTER_PHONE` run under standard non-privileged group rules so internal outputs never leak into shared groups.
- **Phone Admin Commands** (case-insensitive in 1:1 Master DM):
  - `status` — Health, active sessions, approval mode, paused contacts, quota counters.
  - `on` / `off` — Enable or disable automated contact replies globally.
  - `pause <number> <duration>` / `resume <number>` — Pause (e.g., `4h`, `30m`, `1d`) or resume auto-replies for a contact.
  - `approval on` / `approval off` — Toggle Draft Approval testing mode.
  - `SEND` / `SKIP` / **Quote-Reply with custom text** — Approve, drop, or replace a held `[DRAFT APPROVAL]` message.

---

## Outbound Media Dispatch (`wa_send.py`)

```bash
wa_send.py text    <recipient_jid> "Message content"
wa_send.py image   <recipient_jid> "http://127.0.0.1:8099/photo.jpg" "Caption"
wa_send.py doc     <recipient_jid> /path/to/document.pdf "Caption"
wa_send.py sticker <recipient_jid> "http://127.0.0.1:8099/sticker.webp" "Pack" "Author"
```
Serve local HTTP media over HTTP/1.1 with valid `Content-Length` headers (`media_server.py`) and include `x-api-key: $GATEWAY_API_KEY` when calling `/api/send*`. Never use Python's `http.server` (HTTP/1.0 framing issues).

---

## Operational Pitfalls

1. **WhatsApp Error 463 (Cold Outreach Restriction)**: Baileys cannot initiate cold 1:1 chats without a privacy `tctoken`. Never auto-retry Error 463 sends in a loop (worsens account restrictions); initiate first contact manually from the primary phone or `wa.me/<number>`.
2. **Stdout vs. Stderr Split**: `hermes chat -Q` writes reply text to `stdout` and `session_id: <id>` to `stderr`. Never parse `stdout` for session IDs.
3. **LID vs. Phone Thread Splitting**: WhatsApp Web / privacy users often appear as `15-digit@lid` with `sender: null`. Always canonicalize through `chat_map.json` before looking up `sessions.json`, `flows.json`, or `contacts.json`, and reply to `chatJid`.
4. **Disconnection 503s**: Sending during a brief Baileys reconnect returns HTTP 503. Retry with backoff (up to 6 attempts); if still down, leave unledgered for `replay_orphans()` and alert `MASTER_PHONE` once reconnected.
5. **QR Code Rotation**: Pairing QR codes expire every ~60s. Always run `scripts/fetch-pairing-qr.sh` (which triggers `/api/connect` first) rather than reading stale cached screenshots.

---

## Verification Checklist

1. `curl -s http://127.0.0.1:3100/api/health` -> `"success": true`, `"whatsapp": "connected"`.
2. `curl -s http://127.0.0.1:5000/health` -> `"ok": true`, `"turns_active": 0`.
3. `curl -s -X POST http://127.0.0.1:3100/api/webhook/test -H "x-api-key: $GATEWAY_API_KEY"` -> `"success": true`, `"status": 200`.
4. **Unauthenticated API Block Check**: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/api/status` -> returns `401` (verifying `GATEWAY_API_KEY` blocks local SSRF).
5. **Burst & Supersede Check**: Send 3 rapid messages within 2s from a test contact -> verify `journalctl --user -u hermes-wa-receiver` coalesces/supersedes into a single turn with `*bold*` WhatsApp-native formatting and zero premature blue ticks.
