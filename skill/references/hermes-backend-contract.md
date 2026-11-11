# Hermes Backend & Receiver Implementation Contract

This reference specifies the exact runtime invariants between the Node/Baileys gateway (`whatsapp-agent-hermes`, port `3100`), the Python webhook receiver (`~/whatsapp-hermes-receiver/receiver.py`, port `5000`), and the `hermes` CLI subprocess.

---

## 1. Principal Verification (Master vs. Contact Routing)

Elevated owner privileges (`AGENT_TOOLSETS_OWNER=terminal,file,web,vision` and `prompt_template_owner.txt`) MUST only activate when **all three** conditions hold:

1. `payload["isGroup"] is False` (NEVER elevate inside a group chat, even if `sender == MASTER_PHONE`, to prevent leaking internal outputs to group members or executing group-injected quoted text).
2. `chat_jid` is a 1:1 user JID (`@s.whatsapp.net` or `@lid`).
3. Either:
   - Canonicalized `sender` digits match `MASTER_PHONE` (`OWNER_WHATSAPP`), **OR**
   - `senderJid` (stripped of `@lid`) matches `MASTER_LID` (or resolves to `MASTER_PHONE` in `chat_map.json`).

All other turns (including every group turn) MUST run in the restricted contact sandbox (`AGENT_TOOLSETS=web,vision` with `prompt_template.txt`), and outbound local loopback access (`127.0.0.1`, `localhost`, `[::1]`) remains protected by requiring `GATEWAY_API_KEY` on all gateway `/api/*` endpoints.

---

## 2. Untrusted Input Sanitization & XML Prompt Wrapping

Before building the contact prompt, strip control tokens from all untrusted strings (`senderName`, `message`, `quoted.message`, and voice transcripts) so contacts cannot spoof multi-message splits or escalations:

```python
def clean_untrusted(value: str | None) -> str:
    if value is None:
        return ""
    text = value.replace("===MSG===", "[split]").replace("@@FLAG@@", "[flag]")
    # Prevent breaking out of XML data boundary tags
    return text.replace("</untrusted_inbound_message>", "[/untrusted_inbound_message]")
```

Inject operator context **outside** the XML boundary and wrap inbound WhatsApp content **inside** `<untrusted_inbound_message>`:

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
sender_name: Alex Tan
timestamp_gmt8: 09-10-26 14:25:10
quoted: null
messages (count=1):
1. Around 40 seats. Can we start next month?
</untrusted_inbound_message>
```

---

## 3. Hermes Subprocess Invocation & Stdout/Stderr Split

- Invoke `hermes chat -Q` in its own POSIX process group (`start_new_session=True`) so superseding bursts can cleanly terminate in-flight runs via `os.killpg(proc.pid, signal.SIGTERM)`.
- **Stdout vs. Stderr Invariant**:
  - `stdout`: Raw assistant reply text only.
  - `stderr`: Diagnostics and `session_id: <id>`. Parse `session_id` exclusively from `stderr` and persist in `sessions.json` keyed by canonical phone/chat key.
- Pass `--resume <session_id>` when an active session exists for that canonical chat key, and `--image <local_path>` when an inbound image was downloaded from `GET /api/media/<messageId>`.

---

## 4. Voice Note Pipeline (Gemini Audio — Never Whisper)

- Download `.ogg` / `audio` payloads immediately via `GET /api/media/<messageId>` (with header `x-api-key: <GATEWAY_API_KEY>`) into `media/`.
- **Do NOT use local Whisper / `faster-whisper`**, which mangles Malaysian accents and Mandarin/Malay/English (Manglish) code-switching.
- Pass the audio file to **Gemini Audio** (`gemini-2.5-flash` / `gemini-3-flash-preview` with `LOW` or `MEDIUM` thinking level) requesting:
  1. Verbatim multilingual transcript preserving English, Chinese, Malay, and Manglish terms.
  2. Detected speaker vibe (`casual`, `polite`, `funny`, `serious`, `urgent`, or `unclear`).
- Inject into `<untrusted_inbound_message>` as:
  `[voice note | vibe: polite | transcript: "..."]`
- If audio quality is garbled or `unclear`, note `[voice note | vibe: unclear | transcript: "(inaudible/muffled)"]` so the agent asks the sender to type it out rather than guessing.

---

## 5. Output Parsing Order (`@@FLAG@@`, `NO_REPLY`, `===MSG===`, `sanitize_reply`)

Process raw `stdout` in this exact deterministic order:

1. **Empty Check**: If `raw_stdout.strip() == ""`, treat as **`no-answer`** (process failure/timeout). Do **not** ledger in `handled.json` so `replay_orphans()` can retry.
2. **Extract & Strip `@@FLAG@@` First**:
   ```python
   import re

   flags: list[str] = []
   kept_lines: list[str] = []
   for line in raw_stdout.splitlines():
       m = re.match(r"^\s*@@FLAG@@\s*(.*)$", line)
       if m:
           flags.append(m.group(1).strip() or "Manual review requested")
       else:
           kept_lines.append(line)
   body = "\n".join(kept_lines).strip()
   ```
   Dispatch every extracted flag to `MASTER_PHONE` via `/api/send` and record its outbound message ID in `outbox.json` so quote-replies resolve back to `chatJid`.
3. **Evaluate `NO_REPLY` Second**:
   If `body == "NO_REPLY"` (or `body == ""` *only when at least one `@@FLAG@@` was extracted*):
   - Ledger outcome as `silent` in `handled.json`.
   - Do **not** call `/api/read` and do **not** send anything to the contact.
4. **Sanitize & Convert Markdown to WhatsApp Formatting (`sanitize_reply`)**:
   ```python
   def sanitize_reply(text: str) -> str:
       # Strip accidental routing header lines or bot labels (including stacked prefixes)
       text = re.sub(
           r"^(?:\s*(?:@@TO@@[^\n]*\n*|(?:To|Recipient):\s*\+?[0-9][^\n]*\n+|(?:Bot|AI|Assistant|Contact reply|Message):\s*))+",
           "",
           text,
           flags=re.I,
       )
       # Convert Markdown links [label](https://...) -> label (https://...) before protecting URLs
       text = re.sub(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", r"\1 (\2)", text)
       # Temporarily shield bare URLs so dashes/asterisks inside URLs are never altered
       urls: list[str] = []
       def _stash_url(match: re.Match[str]) -> str:
           urls.append(match.group(0))
           return f"\x00URL{len(urls) - 1}\x00"
       text = re.sub(r"https?://[^\s)>]+", _stash_url, text)
       # Convert Markdown **bold** -> WhatsApp *bold*
       text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text, flags=re.S)
       # Convert Markdown headings (# Heading -> *Heading*)
       text = re.sub(r"(?m)^#{1,6}\s+(.+?)\s*$", r"*\1*", text)
       # Replace em/en dashes and space-flanked double hyphens with comma + space
       text = re.sub(r"\s*(?:—|–)\s*|\s+--\s+", ", ", text)
       # Restore shielded URLs
       for idx, url in enumerate(urls):
           text = text.replace(f"\x00URL{idx}\x00", url)
       return text.strip()
   ```
5. **Split Multi-Messages (`===MSG===`)**:
   - Split on `===MSG===`, apply `sanitize_reply()` to each chunk, drop empty chunks, and cap at `MAX_MESSAGES_PER_TURN` (`5`; merge overflow into chunk 5).
6. **Draft Approval Gate**:
   - If `approval_mode` is enabled (and recipient is not `MASTER_PHONE`), forward the preview to `MASTER_PHONE` and pause **without** calling `/api/read` on the contact's message yet.
7. **Read Receipt + Human Cadence Dispatch**:
   - Call `POST /api/read { "messageId": inbound_id }` right before sending chunk 1.
   - Send chunk 1 immediately (`POST /api/send`, no prior typing indicator).
   - For chunks `2..N`: call `POST /api/presence { "recipient": chatJid, "presence": "composing" }`, sleep `SPLIT_MESSAGE_DELAY_SECONDS` (`2.0s`), call `POST /api/send`, then call `POST /api/presence { "recipient": chatJid, "presence": "paused" }`.
