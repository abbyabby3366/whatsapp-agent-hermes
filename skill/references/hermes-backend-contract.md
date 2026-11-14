# Hermes Backend & Receiver Implementation Contract

This reference specifies the exact runtime invariants between the Node/Baileys gateway (`src/index.ts`, port `3100`), the built-in Node webhook receiver (`src/receiver/*`, port `5000`, state in `~/whatsapp-hermes-receiver/`), and the `hermes` CLI subprocess.

---

## 1. Principal Verification (Master vs. Contact Routing)

Elevated owner privileges (`AGENT_TOOLSETS_OWNER=terminal,file,web,vision` and `prompt_template_owner.txt`) MUST only activate when **all three** conditions hold (`isMasterPrincipal()` in `src/receiver/server.ts`):

1. `payload.isGroup` is `false` and `!payload.chatJid.endsWith('@g.us')` (NEVER elevate inside a group chat, even if `sender == MASTER_PHONE`, to prevent leaking internal outputs to group members or executing group-injected quoted text).
2. `chatJid` is a 1:1 user JID (`@s.whatsapp.net` or `@lid`).
3. Either:
   - Canonicalized `sender` (or `chat_map.json` `record.phone`) matches `MASTER_PHONE` (`OWNER_WHATSAPP`), **OR**
   - `senderJid` / `record.lid` matches configured `MASTER_LID` or previously learned `runtimeState.getMasterLid()`. When `MASTER_PHONE` authenticates with a known LID, `runtimeState.setMasterLid(record.lid)` persists it automatically.

`senderUsername` is filled from the message itself, from usernames the gateway learned earlier (contacts sync, group metadata, messages sent from the primary phone), or from a short reverse lookup for an unknown `@lid` sender. It can still be `null` when WhatsApp exposes no handle, so never require it.

Whenever an inbound payload carries `senderUsername` (normalized lowercase WhatsApp `@username` without `@`), `ChatMapStore.upsertInbound()` persists the `@username <-> chatJid` (and `sender` phone digits if known) mapping in `chat_map.json` so outbound instructions to `@username` immediately map to the canonical thread key (`sessions.json`, `flows.json`, `contacts.json`). When `wa-send` or the receiver dispatches to a `@username` not yet in `chat_map.json`, passing `"to": "@username"` (plus optional `"pin": "1234"` or `"@username#1234"`) directly to `/api/send*` (or resolving via `GET /api/resolve?target=@username` with `x-api-key`) returns the deliverable `jid`.

All other turns (including every group turn) MUST run in the restricted contact sandbox (`AGENT_TOOLSETS=web,vision` with `prompt_template.txt`), and outbound local loopback access (`127.0.0.1`, `localhost`, `[::1]`) remains protected by requiring `GATEWAY_API_KEY` on all gateway `/api/*` endpoints.

---

## 2. Untrusted Input Sanitization & XML Prompt Wrapping

Before building the contact prompt, `cleanUntrusted()` (`src/receiver/sanitizer.ts`) strips control tokens and XML boundaries from all untrusted strings (`senderName`, `message`, `quoted.message`, and voice transcripts):

```ts
export function cleanUntrusted(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replaceAll('===MSG===', '[split]')
    .replaceAll('@@FLAG@@', '[flag]')
    .replace(/<\/untrusted_inbound_message\s*>/gi, '[/untrusted_inbound_message]')
    .replace(/<untrusted_inbound_message\b[^>]*>/gi, '[untrusted_inbound_message]');
}
```

Operator context is injected **outside** the XML boundary (including hot-reloaded `## 2. Global Contact Reply Rules & Business Facts` and **only** the matching contact's `### <phone | @username | Name>` block under `## 3. Contact-Specific Rules` from `~/.hermes/skills/whatsapp-agent-rules/SKILL.md` via `loadContactRules()`, never exposing `## 1. Operator & Outbound Workflow Rules` or other contacts' `###` blocks), while inbound WhatsApp content is wrapped **inside** `<untrusted_inbound_message>`:

```text
[Trusted Operator Context]
Contact: Acme Corp Lead (Relation: Client)
Persona: Warm and professional enterprise partner
Known: Interested in enterprise tier; decision maker is Alex.
Missing: Implementation timeline and contract start date.
Approach: Direct, transparent pricing; no promotional discounts.
Open Flow Items: Pending invoice delivery

[Earlier Conversation History (Oldest First — Context Only, Do Not Re-Answer)]
[09-10-26 14:20] IN: Hi, do you have enterprise plans?
[09-10-26 14:21] OUT: Yes, happy to share our enterprise breakdown 🙂 What team size are you planning for?

[New Inbound Turn — Answer ONLY What Is Inside <untrusted_inbound_message>]
<untrusted_inbound_message>
chat_type: direct
sender_name: Alex Tan
timestamp_gmt8: 09-10-26 14:25:10
quoted: null
messages (count=1):
1. Around 40 seats. Can we start next month?
</untrusted_inbound_message>
```

---

## 3. Hermes Subprocess Invocation & Stdout/Stderr Split (`src/receiver/hermes-runner.ts`)

- Invoke `hermes chat -Q --toolsets <toolsets> [--resume <session_id>] [--image <local_path>] -q <prompt>` with `detached: true` (on POSIX) so superseding bursts cleanly terminate the entire child process group via `process.kill(-child.pid, 'SIGTERM')` (with 3s `SIGKILL` escalation).
- **Brain = the box's own built-in AI proxy, ONLY**: `hermes chat -Q` uses whatever model/provider Hermes is already configured with on this host. Never ask the owner for an LLM / OpenAI / OpenRouter / Anthropic / provider API key, never add an alternate endpoint or model override, and never write LLM keys into any vault or `.env`.
- **Subprocess Secret Hygiene (deny-list, NOT allow-list)**: `buildHermesChildEnv()` copies `process.env` and deletes **only** `GATEWAY_API_KEY` and `HERMES_SECRET_TOKEN`. Never build the child env from scratch or strip `HOME`, `PATH`, `XDG_*`, `*_BASE_URL`, or proxy credentials.
- **AI proxy failure handling**: If `hermes chat -Q` fails with an auth/quota error (`401`/`402`/`403`/`429`, `unauthorized`, `budget`, `quota`), `server.ts` logs the failure and alerts `MASTER_PHONE` at most once per 15 minutes without asking for an API key.
- **Stdout vs. Stderr Invariant**:
  - `stdout`: Raw assistant reply text only.
  - `stderr`: Diagnostics and `session_id: <id>`. Parse `session_id` exclusively from `stderr` and persist in `sessions.json` keyed by canonical `chatKey`. If resuming a stale session fails with non-zero exit and empty stdout, `runHermesWithSessionFallback()` clears the stored session ID and retries once fresh.

---

## 4. Voice Note Pipeline (Local Pure-Node ONNX Whisper, Zero Python, No API Keys)

- Download `.ogg` / `audio` payloads immediately via `GET /api/media/<messageId>` (with header `x-api-key: <GATEWAY_API_KEY>`) into `media/`.
- **Transcription Engine (`src/receiver/transcribe.ts`)**:
  - Decodes arbitrary WhatsApp audio formats (`.ogg` Opus, `.m4a`, `.mp3`, `.wav`) in memory to 16 kHz mono `Float32Array` (`f32le` PCM) via bundled `ffmpeg-static`.
  - Runs `@huggingface/transformers` (`automatic-speech-recognition` pipeline, default `onnx-community/whisper-base`, CPU `dtype: 'q8'`, cached persistently under `WHISPER_CACHE_DIR`, default `~/whatsapp-hermes-receiver/models`). Zero Python, zero `.venv`, zero API keys.
  - Mutex-serialized lazy singleton pipeline prevents OOM under concurrent voice bursts.
  - Injects `[voice note | engine: whisper-onnx | transcript: "..."]` (cleaned via `cleanUntrusted()`), or `[voice note | engine: whisper-onnx | quality: unclear | transcript: "(inaudible/muffled)"]` when speech is empty or noise-only (`[BLANK_AUDIO]`, `[Music]`, etc.).

---

## 5. Output Parsing Order (`@@FLAG@@`, `NO_REPLY`, `===MSG===`, `sanitizeReply`)

Process raw `stdout` in `parseHermesOutput()` (`src/receiver/sanitizer.ts`):

1. **Empty Check**: If trimmed `rawStdout` is empty, treat as **`no-answer`** (process failure/timeout). Leave unledgered in `handled.json` so `replayOrphans()` can retry on restart.
2. **Extract & Strip `@@FLAG@@` First**:
   - Match `/^\s*@@FLAG@@\s*(.*)$/` line-by-line, defaulting empty summaries to `"Manual review requested"`.
   - Dispatch every extracted flag to `MASTER_PHONE` via `/api/send` and record its outbound message ID in `outbox.json` so Master quote-replies resolve back to `targetChatJid`.
3. **Evaluate `NO_REPLY` Second**:
   - If the remaining trimmed body equals `NO_REPLY` (or `""` *only when at least one `@@FLAG@@` was extracted*):
     - Ledger outcome as `silent` in `handled.json`.
     - Do **not** call `/api/read` and do **not** send anything to the contact.
4. **Sanitize & Convert Markdown to WhatsApp Formatting (`sanitizeReply`)**:
   - Strip stacked routing headers (`To:`, `Recipient:`, `@@TO@@`, `Bot:`, `AI:`, `Assistant:`, `Reply:`, etc.) using an explicit loop instead of nested quantifiers.
   - Flatten Markdown links `[label](https://...)` -> `label (https://...)` before shielding bare URLs (preventing regex `$1` backreference corruption on URL query strings).
   - Convert `# Heading` -> `*Heading*`, replace em/en dashes (`—`, `–`, ` -- `) with `, `, and normalize via `formatWhatsAppText()` (`**bold**` -> `*bold*` + space boundaries around CJK/alphanumeric text).
5. **Split Multi-Messages (`===MSG===`)**:
   - Split on `===MSG===`, apply `sanitizeReply()` per chunk, drop empty chunks, and cap at `MAX_MESSAGES_PER_TURN` (`5`; merge overflow into chunk 5).
6. **Read Receipt + Immediate Live Human Cadence Dispatch (No Draft Approval Gate)**:
   - Never hold outbound contact replies behind a `[DRAFT APPROVAL]` queue — dispatch live directly to `chatJid`.
   - Call `POST /api/read { "messageId": latestInboundId }` right before sending chunk 1.
   - Send chunk 1 immediately (`POST /api/send`, quoting `latestInboundId` in groups).
   - For chunks `2..N`: call `POST /api/presence { "recipient": chatJid, "presence": "composing" }`, sleep `SPLIT_MESSAGE_DELAY_SECONDS` (`2.0s`), call `POST /api/send`, then call `POST /api/presence { "recipient": chatJid, "presence": "paused" }`.

---

## 6. Canonical Contact Identity (Phone, `@username`, `@lid`)

A contact can reach you as a phone number, a WhatsApp `@username`, or an opaque 15-digit `@lid`, and the same person can expose additional identifiers over time. `ChatMapStore` (`src/receiver/stores.ts`) indexes every thread under one canonical `chatKey`:

1. **Pick the canonical key in priority order**: phone digits (when known) -> `@username` -> raw LID digits. Never store LID digits in a phone field.
2. **Promote, never demote**: when a thread keyed by LID digits later reveals a `@username`, or a `@username` thread reveals a phone number, `migrateAllStores()` moves the old key's SQLite history, sessions, flows, contacts profile, pause timers, and quota counters to the canonical key and updates all indexes (`byLid`, `byUsername`, `byJid`, `byPhone`).
3. **Usernames change**: if a known JID arrives with a different `senderUsername`, the old username alias is replaced automatically.
4. **Outbound lookups**: resolve `@username` / `@username#1234` via `chat_map.json` first, then `GET /api/usernames`, then pass it straight to `/api/send*` (or `GET /api/resolve`) and store the returned `jid`.

### Gateway send results to handle

| HTTP | Meaning | What to do |
| --- | --- | --- |
| `400` | Bad recipient or PIN format (PIN must be exactly 4 digits; JSON numbers like `412` are read as `"0412"`) | Fix the input; do not retry as-is |
| `403` | `@username` needs a 4-digit PIN, the PIN was wrong, or a raw local media path is outside `ALLOWED_MEDIA_DIR` | Ask owner for PIN, or send via `~/.local/bin/wa-send` (auto base64 data URI) / URL |
| `404` | `@username` not found, or phone number not on WhatsApp | Report it; do not retry |
| `413` | Media exceeds `MAX_MEDIA_BYTES` (25 MiB) or request body limit | Compress/resize or stay within limit; do not retry as-is |
| `429` | WhatsApp rate-limited username lookups | Back off before retrying |
| `502` | WhatsApp rejected the message (Error `463` cold-outreach restriction, Error `479` stanza rejected) | Ledger as `failed-502`, alert `MASTER_PHONE`, never auto-retry |
| `503` | Gateway not connected, or WhatsApp timed out | Retry with backoff (up to 6 attempts) |

The gateway waits briefly for WhatsApp's server acknowledgement before answering, so an immediate `463`/`479` rejection comes back as `502` instead of a false success. Late rejections are shown as **Failed** in the dashboard.
