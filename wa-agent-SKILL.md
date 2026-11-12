---
name: whatsapp-agent-gateway
description: "Use when operating, diagnosing, configuring, or administering the WhatsApp Baileys gateway (`whatsapp-agent-gateway`) and AI webhook receiver (`whatsapp-agent-receiver`): pairing QR codes, checking service health/logs, managing per-contact briefs (`contacts.json`) and task/fact state (`flows.json` / `flow.py`), querying SQLite chat history (`wa_history.db` / `history.py`), toggling global or per-contact pauses, sending outbound WhatsApp text/media/stickers to phone numbers, `@username` handles (with optional 4-digit PIN), or JIDs, resolving WhatsApp `@username`/LID-to-phone mappings, or troubleshooting Error 463, burst coalescing, AI brain configuration, and webhook delivery."
version: 2.0.0
license: MIT
---

# WhatsApp AI Agent — External Gateway + AI Webhook Receiver

This architecture decouples WhatsApp connectivity from your AI agent runtime. WhatsApp sessions run inside an external Node/Express + Baileys gateway (`~/whatsapp-agent-gateway`), while an asynchronous Python webhook receiver (`~/whatsapp-agent-receiver/receiver.py`) orchestrates message coalescing, contact state, voice transcription, and AI replies using the **same AI provider as the host AI agent** (either via an authenticated host CLI or direct LLM HTTP API).

**Key Architectural Invariants**:
1. **Session Isolation**: Your AI runtime never holds Baileys/WhatsApp credentials. The gateway owns session state and talks to the receiver strictly over authenticated loopback HTTP (`x-agent-token` inbound, `x-api-key` outbound).
2. **Role & Context Separation**: Contact-facing turns do **not** load this DevOps `SKILL.md`. Instead, `receiver.py` injects the lean ghostwriter prompt (`assets/prompt_template.txt`) for external contacts and `assets/prompt_template_owner.txt` exclusively for verified 1:1 Master DMs.

## When to Use

Load and apply this skill whenever you need to:
- Check gateway/receiver service status, inspect live logs, or export a fresh WhatsApp pairing QR code.
- Manage contact profiles (`contacts.json`), per-contact open items/facts (`flow.py` / `flows.json`), or search conversation history (`history.py` / `wa_history.db`).
- Administer runtime controls (global `on/off`, `pause <number|@username> <duration>`, `resume <number|@username>`).
- Send outbound WhatsApp text, images, documents, or stickers to phone numbers, `@username` handles (`@username` or `@username#1234` with 4-digit PIN), or JIDs via the gateway REST API (`/api/send*`, `/api/resolve`) or `wa_send.py`.
- Implement, update, or debug `receiver.py`, AI brain provider settings (`BRAIN_MODE=api|cli`), prompt templates, `@username` & LID canonicalization, burst superseding, or WhatsApp Error 463 restrictions.

For deep implementation schemas, AI brain contracts, systemd unit files, and Nginx tunnel configs, load the companion files in `SKILL_DIR`:
- `SKILL_DIR/assets/prompt_template.txt` — Contact-facing first-person ghostwriter prompt.
- `SKILL_DIR/assets/prompt_template_owner.txt` — Verified 1:1 Master DM operator prompt.
- `SKILL_DIR/references/receiver-backend-contract.md` — AI brain modes (`api` vs `cli`), XML untrusted-input wrapping, voice pipeline, `@@FLAG@@`/`NO_REPLY` parser order, and `sanitize_reply()`.
- `SKILL_DIR/references/deployment-and-env.md` — `systemd --user` units, `~/.whatsapp-agent/vault/` secret vault, Nginx + SSH tunnel setup, and full `receiver.env` tunables table.
- `SKILL_DIR/scripts/fetch-pairing-qr.sh` — Helper script to trigger `/api/connect` and export a fresh QR PNG.

---

## Layout & Architecture

| Component | Path | Service (`systemd --user`) | Loopback Port |
|---|---|---|---|
| Gateway + Dashboard | `~/whatsapp-agent-gateway` | `whatsapp-agent-gateway.service` | `3100` |
| AI Webhook Receiver | `~/whatsapp-agent-receiver/` | `whatsapp-agent-receiver.service` | `5000` |
| Skills & Secret Vault | `~/.whatsapp-agent/` | *(symlinked into active host agent skills dir)* | — |

### Receiver Working Files (`~/whatsapp-agent-receiver/`)
- `receiver.py`: Main webhook server, burst coalescer, voice-note pipeline, and async AI worker dispatcher.
- `history.py` + `wa_history.db`: SQLite conversation history store.
- `handled.json`: Idempotency ledger of terminal message outcomes (`sent`, `silent`, `dry-run`).
- `chat_map.json`: Canonical WhatsApp 15-digit LID (`...@lid`) <-> phone number <-> `@username` lookup map (gateway also persists `~/whatsapp-agent-gateway/data/usernames.json` from inbound messages, contacts sync, and USync lookups).
- `sessions.json`: Canonical chat key -> active conversation/session state mapping.
- `state.json`: Persisted runtime toggles (global on/off, per-contact pause timers).
- `contacts.json`: Per-contact briefs, personas, notes, and `auto_reply` toggles (hot-reloaded per turn).
- `prompt_template.txt`: Live contact ghostwriter brief (seeded from `SKILL_DIR/assets/prompt_template.txt`, hot-reloaded per turn).
- `prompt_template_owner.txt`: Live 1:1 Master operator brief (seeded from `SKILL_DIR/assets/prompt_template_owner.txt`, hot-reloaded per turn).
- `outbox.py` + `outbox.json`: Ledger of outbound `[FLAG]` escalations so Master quote-replies resolve back to the target contact `chatJid`.
- `flow.py` + `flows.json`: Per-contact operational state (`open` items, `facts`, timestamped `events`).
- `media/`: Local cache directory for inbound and outbound media.
- `~/.whatsapp-agent/skills/skill-crafter/SKILL.md` + `~/.whatsapp-agent/skills/whatsapp-agent-rules/SKILL.md`: Companion single-file global meta-skill (`skill-crafter`) and reinstall-safe user-owned rules skill (`whatsapp-agent-rules`), symlinked into whichever skill directory the host AI agent reads (`~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`, etc.). Whenever the owner teaches or updates how to operate or reply with WhatsApp, `skill-crafter` merges it into `whatsapp-agent-rules/SKILL.md` (single `.md` file, zero subfolders, trivial 1-file export). `receiver.py` hot-loads Section 2 + only the matching contact's `###` block from Section 3 on contact turns while keeping Section 1 owner-only.

### Configuration, AI Brain & Loopback Auth
- **Gateway `.env`**: `PORT=3100`, `HOST=127.0.0.1`, `GATEWAY_API_KEY=<48-hex-secret>`, `AGENT_WEBHOOK_URL=http://127.0.0.1:5000/api/webhook`, `AGENT_SECRET_TOKEN=<48-hex-secret>`, `TIMEZONE=Asia/Kuala_Lumpur`.
- **Receiver `receiver.env` & Secret Vault (`~/.whatsapp-agent/vault/`)**:
  - Shared `AGENT_SECRET_TOKEN` and `GATEWAY_API_KEY`, `WHATSAPP_GATEWAY_URL=http://127.0.0.1:3100`, `MASTER_PHONE=<digits>` (alias: `OWNER_WHATSAPP`), optional `MASTER_LID=<15-digit-lid>`, `MASTER_NAME=<name>`.
  - **AI Brain (`BRAIN_MODE=api` or `BRAIN_MODE=cli`)**: Uses the **same AI provider as the host AI agent** (verified by a live test call before starting the service — never left unconfigured):
    - `BRAIN_MODE=api`: `LLM_PROVIDER=openai|anthropic|gemini`, `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY_FILE=~/.whatsapp-agent/vault/llm_api_key` (`0600`).
    - `BRAIN_MODE=cli`: `AGENT_CLI_TYPE=claude|codex|gemini|custom` and `AGENT_CLI_BIN=/abs/path/to/cli`.
  - **Voice Transcription**: `GEMINI_API_KEY_FILE=~/.whatsapp-agent/vault/gemini_api_key` (optional `0600` vault file — never raw in `.env`) and `WHISPER_MODEL=base` (local `faster-whisper` default when no Gemini key is stored in the vault).
- **Mandatory `GATEWAY_API_KEY` (Even on `127.0.0.1`)**: Never leave `GATEWAY_API_KEY` blank. Requiring `x-api-key` on all non-health `/api/*` endpoints prevents prompt-injected SSRF requests from reading `/api/status` (which contains recent messages across all chats) or calling `/api/send` / `/api/logout`.
- **Single Process Manager (`systemd --user`)**: Always run both services under `systemd --user` with lingering enabled (`loginctl enable-linger`). Never mix `pm2` and `systemd` on the same server.

---

## Ops Cheatsheet

```bash
# Load GATEWAY_API_KEY for authenticated gateway calls
export GATEWAY_API_KEY="$(grep -E '^GATEWAY_API_KEY=' ~/whatsapp-agent-gateway/.env | cut -d= -f2-)"

# Service status and live logs
systemctl --user status whatsapp-agent-gateway whatsapp-agent-receiver
journalctl --user -u whatsapp-agent-receiver -f         # Live receiver & AI decision log
journalctl --user -u whatsapp-agent-gateway -f          # Live Baileys gateway log

# Restarts (prompt_template*.txt, contacts.json, and vault keys hot-reload without restart)
systemctl --user restart whatsapp-agent-receiver        # Required after receiver.py edits
systemctl --user restart whatsapp-agent-gateway         # Required after gateway TypeScript rebuild

# Health & end-to-end webhook checks
curl -s http://127.0.0.1:3100/api/health                # Public liveness: {"success":true,"whatsapp":"connected",...}
curl -s http://127.0.0.1:5000/health                    # Receiver health: {"ok":true,"brain_ready":true,"turns_active":0,...}
curl -s -X POST http://127.0.0.1:3100/api/webhook/test \
  -H "x-api-key: $GATEWAY_API_KEY"                      # Authenticated gateway -> receiver ping

# Export fresh pairing QR PNG (works via skill script or receiver copy)
bash ~/.whatsapp-agent/skills/whatsapp-agent-gateway/scripts/fetch-pairing-qr.sh /tmp/wa-qr.png

# Updating gateway code
cd ~/whatsapp-agent-gateway && git pull && npm install && npm run build && systemctl --user restart whatsapp-agent-gateway
```

---

## Message Lifecycle & Human Cadence

```mermaid
sequenceDiagram
    autonumber
    actor User as WhatsApp Contact
    participant GW as Gateway (:3100)
    participant Recv as Receiver (:5000)
    participant Brain as AI Provider (API / CLI)
    actor Master as Master Operator

    User->>GW: Inbound WhatsApp message
    GW->>Recv: POST /api/webhook (x-agent-token)
    Recv-->>GW: HTTP 200 {"reply": null, "status": "processing"}
    Note over Recv: Coalesce burst (2.5s) & supersede any in-flight run
    Note over Recv,Brain: Draft silently (NO /api/read yet, NO typing indicator)
    Recv->>Brain: Invoke AI with XML-wrapped untrusted input + SQLite history
    Brain-->>Recv: Raw output (optional @@FLAG@@ + reply chunks or NO_REPLY)
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
  2. If a new message arrives mid-generation for that chat, bump the chat's generation counter, cancel/kill the in-flight run (`os.killpg` in CLI mode or cancel the in-flight HTTP request in API mode), discard its partial draft, and re-run once on the combined burst.
  3. Cap parallel AI runs with `MAX_CONCURRENT_RUNS` (`4`).

---

## Media & Voice Note Handling

- **Gateway Media Cache**: The gateway caches raw messages in memory for the last `300` messages. Download media immediately on webhook arrival via `GET /api/media/<messageId>` (with `x-api-key`). Never abort a turn if media download fails — note `[media download failed]` in context so the agent can ask the sender to resend.
- **Images**: Saved into `media/` and passed to the AI provider as a vision attachment (base64 image block in `api` mode, or image path flag in `cli` mode).
- **Audio / Voice Notes (Gemini Audio via Secret Vault -> Local `faster-whisper` Out of the Box)**:
  - **Engine Selection (Hot-Reloaded per Voice Note)**:
    1. **Gemini Audio (when a Gemini API key is present in `~/.whatsapp-agent/vault/gemini_api_key` or `$CREDENTIALS_DIRECTORY/gemini_api_key`)**: Pass the `.ogg` / audio file to **Gemini Audio** (`gemini-3.8-flash` with `low` or `medium` `thinking_level`, `store=False`) to extract both an accurate multilingual/Manglish transcript and vocal vibe (`[voice note | vibe: polite/casual/urgent/unclear | transcript: "..."]`). Never pass secret vault keys into external-contact subprocess environments, and if a configured Gemini key fails authentication or quota, log the error clearly and alert `MASTER_PHONE` rather than silently masking the broken key.
    2. **Local `faster-whisper` (default when no Gemini API key is configured)**: Transcribe locally out of the box using `faster-whisper` (`WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)` — default `base`, `int8` CPU, `vad_filter=True`, lazy singleton, zero external API keys needed) and inject `[voice note | engine: faster-whisper | lang: <code> | transcript: "..."]` (or mark `unclear` when speech is absent/muffled).
  - If the audio is noisy or `unclear` on critical details (prices, dates, names), the agent must ask naturally (*"Sorry, your voice note broke up a bit, mind typing that out?"*) rather than guessing.

---

## Message Terminal States & Invariants

| Outcome | Meaning | Ledgered in `handled.json`? | Action on Restart |
|---|---|---|---|
| `sent` | Reply successfully dispatched via `/api/send` | **Yes** | None |
| `silent` | Agent emitted explicit `NO_REPLY` (after stripping `@@FLAG@@`) | **Yes** | None |
| `dry-run` | `DRY_RUN=true` testing mode | **Yes** | None |
| `no-answer` | AI call failed, returned HTTP 401/402/429/5xx, timed out, or returned empty output | **No** | Retried via `replay_orphans()` |
| `send-failed` | `/api/send` failed after retries (e.g., HTTP 503 disconnect) | **No** | Retried + alert to `MASTER_PHONE` |
| `superseded` | Cancelled and replaced by newer message in burst | **No** | Consolidated into next turn |

- **Parser Order Invariant (`@@FLAG@@` Before `NO_REPLY`)**: Always extract and strip `@@FLAG@@ <summary>` lines **first** and forward those alerts to `MASTER_PHONE`. Only **after** stripping `@@FLAG@@` lines, check whether the remaining trimmed output equals `NO_REPLY` (or empty when a flag was present). Never send literal `"NO_REPLY"` to a contact.
- **Startup Replay (`replay_orphans`)**: Unledgered inbound messages younger than `REPLAY_MAX_AGE_MIN` (evaluated via numeric `rawTimestamp` epoch seconds) are replayed on receiver startup.

---

## Conversation History, Contacts & Flow State

### 1. SQLite Conversation Store (`history.py` / `wa_history.db`)
- Persists `chat_key`, `message_id` (`out:<inbound_id>` for outbound), `direction` (`in`/`out`), `sender_name`, `sender_number`, `body`, `wa_timestamp` (ISO 8601), and `stored_at`.
- Injects the last `HISTORY_LIMIT` (`30`) turns as read-only prior context formatted in `DD-MM-YY HH:MM` (`GMT+8`).
```bash
~/whatsapp-agent-receiver/.venv/bin/python ~/whatsapp-agent-receiver/history.py stats | chats
~/whatsapp-agent-receiver/.venv/bin/python ~/whatsapp-agent-receiver/history.py recent <chat_key> 30
~/whatsapp-agent-receiver/.venv/bin/python ~/whatsapp-agent-receiver/history.py search "keyword"
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
~/whatsapp-agent-receiver/.venv/bin/python ~/whatsapp-agent-receiver/flow.py contacts | show <key>
~/whatsapp-agent-receiver/.venv/bin/python ~/whatsapp-agent-receiver/flow.py open <key> "item" | close <key> "item"
~/whatsapp-agent-receiver/.venv/bin/python ~/whatsapp-agent-receiver/flow.py fact <key> "fact" | event <key> "event"
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

When editing `~/whatsapp-agent-receiver/prompt_template.txt`, preserve these core behavioral rules:

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

## Security Boundaries & Master Authority

### Untrusted Contact Sandbox & Anti-Injection
- **Restricted Sandbox**: External contacts run strictly with zero shell/terminal or file-write capabilities.
- **XML Data Delimiters**: Strip `===MSG===` and `@@FLAG@@` from inbound contact strings (`senderName`, `quoted`, `message`) and wrap all inbound contact content inside `<untrusted_inbound_message>...</untrusted_inbound_message>` so contacts cannot spoof `[Known: ...]` operator tags or system rules.
- **Safety Quotas**: Max **25 replies/person/day** (`DAILY_REPLY_LIMIT_PER_PERSON`) and **60 replies/hour globally** (`HOURLY_GLOBAL_REPLY_LIMIT`). Group messages without `@mention` or quote-reply to the linked account are ignored.

### Master 1:1 DM Authority & Phone Commands
- **Strict 1:1 DM Gate (`isGroup == false`)**: Elevated Master mode (`prompt_template_owner.txt` + operator tools + administrative commands) activates **only** when `isGroup == false` AND the sender matches `MASTER_PHONE` or verified `MASTER_LID`. In group chats, even messages sent by `MASTER_PHONE` run under standard non-privileged group rules so internal outputs never leak into shared groups.
- **Phone Admin Commands** (case-insensitive in 1:1 Master DM):
   - `status` — Health, active brain provider, global on/off state, paused contacts, quota counters.
   - `on` / `off` — Enable or disable automated contact replies globally.
   - `pause <number|@username> <duration>` / `resume <number|@username>` — Pause (e.g., `4h`, `30m`, `1d`) or resume auto-replies for a contact.
   - **Quote-Reply to `[FLAG]` Escalation** — Resolve target contact from `outbox.json` and carry out the instruction toward that contact in `${MASTER_NAME}`'s first-person voice.

---

## Outbound Dispatch & Contacting `@username` Handles

Never reject an instruction to message `@username` by demanding a phone number. The gateway natively resolves WhatsApp `@username` handles (via its cached `data/usernames.json` directory and live Baileys `USyncContactProtocol` queries) into deliverable `@lid` / `@s.whatsapp.net` JIDs.

### `@username` Resolution Priority Order
1. **Check Local Known Contacts & History First (Zero Rate-Limit Risk)**:
   - Look up `@username` (case-insensitive, without `@`) in `contacts.json` (`"username"` field or alias), `chat_map.json`, `GET /api/usernames`, or `history.py search`.
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
   - **HTTP `403` / `404` (Username PIN Required)**: Do not guess PINs. Ask `${MASTER_NAME}` for the recipient's 4-digit WhatsApp username PIN and retry once with `"pin": "1234"` (or `"@username#1234"`).
   - **HTTP `429` (USync Rate Limit)**: Stop repeated lookups and wait before retrying.
   - **HTTP `502` with Error `463` (Cold 1:1 Outreach Blocked)**: Even after `@username` resolves to `...@lid`, WhatsApp blocks linked devices from initiating brand-new 1:1 chats when no `tctoken` exists. Never retry Error 463 in a loop — ask `${MASTER_NAME}` to send the very first message to `@username` manually from the primary WhatsApp phone app, after which automated replies and follow-ups work normally.

### Outbound CLI Helper (`wa_send.py`)
`<recipient>` accepts phone digits (`60123456789`), full JID (`...@lid` / `...@s.whatsapp.net` / `...@g.us`), `@username`, or `@username#1234`:
```bash
wa_send.py text    <recipient> "Message content"
wa_send.py text    @alex_tan "Hi Alex, following up on the proposal"
wa_send.py text    "@alex_tan#1234" "Hi Alex!"
wa_send.py image   <recipient> "http://127.0.0.1:8099/photo.jpg" "Caption"
wa_send.py doc     <recipient> /path/to/document.pdf "Caption"
wa_send.py sticker <recipient> "http://127.0.0.1:8099/sticker.webp" "Pack" "Author"
```
Serve local HTTP media over HTTP/1.1 with valid `Content-Length` headers (`media_server.py`) and include `x-api-key: $GATEWAY_API_KEY` when calling `/api/send*`. Never use Python's `http.server` (HTTP/1.0 framing issues).

---

## Operational Pitfalls

1. **WhatsApp Error 463 (Cold Outreach Restriction)**: Baileys cannot initiate cold 1:1 chats (whether by phone number or `@username` -> `@lid`) without a privacy `tctoken`. Never auto-retry Error 463 sends in a loop (worsens account restrictions); initiate first contact manually from the primary phone or `wa.me/<number>`.
2. **Hosted Sandbox Proxy Trap (HTTP 401/402/403)**: Never point `receiver.py` at an unverified sandbox LLM proxy URL without a live completion smoke test first. Always verify `"brain_ready": true` on `/health`.
3. **LID & `@username` vs. Phone Thread Splitting**: WhatsApp Web / privacy users often appear as `15-digit@lid` with `sender: null` (and optional `senderUsername`). Always canonicalize through `chat_map.json` (indexing LID, phone digits, and lowercase `senderUsername`) before looking up `sessions.json`, `flows.json`, or `contacts.json`, and reply to `chatJid`.
4. **Disconnection 503s**: Sending during a brief Baileys reconnect returns HTTP 503. Retry with backoff (up to 6 attempts); if still down, leave unledgered for `replay_orphans()` and alert `MASTER_PHONE` once reconnected.
5. **QR Code Rotation**: Pairing QR codes expire every ~60s. Always run `scripts/fetch-pairing-qr.sh` (which triggers `/api/connect` first) rather than reading stale cached screenshots.

---

## Verification Checklist

1. `curl -s http://127.0.0.1:3100/api/health` -> `"success": true`, `"whatsapp": "connected"`.
2. `curl -s http://127.0.0.1:5000/health` -> `"ok": true`, `"brain_ready": true`, `"turns_active": 0`.
3. `curl -s -X POST http://127.0.0.1:3100/api/webhook/test -H "x-api-key: $GATEWAY_API_KEY"` -> `"success": true`, `"status": 200`.
4. **Unauthenticated API Block Check**: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/api/status` -> returns `401` (verifying `GATEWAY_API_KEY` blocks local SSRF).
5. **Burst & Supersede Check**: Send 3 rapid messages within 2s from a test contact -> verify `journalctl --user -u whatsapp-agent-receiver` coalesces/supersedes into a single turn with `*bold*` WhatsApp-native formatting and zero premature blue ticks.
