# WhatsApp AI Receiver & Brain Implementation Contract

This reference specifies the exact runtime invariants between the Node/Baileys gateway (`~/whatsapp-agent-gateway`, port `3100`), the Python webhook receiver (`~/whatsapp-agent-receiver/receiver.py`, port `5000`), and the AI brain (matching the host AI agent's provider via either CLI or direct HTTP API).

---

## 1. Principal Verification (Master vs. Contact Routing)

Elevated owner privileges (`prompt_template_owner.txt` + shell/file operator tools + phone admin commands) MUST only activate when **all three** conditions hold:

1. `payload["isGroup"] is False` (NEVER elevate inside a group chat, even if `sender == MASTER_PHONE`, to prevent leaking internal outputs to group members or executing group-injected quoted text).
2. `chat_jid` is a 1:1 user JID (`@s.whatsapp.net` or `@lid`).
3. Either:
   - Canonicalized `sender` digits match `MASTER_PHONE` (`OWNER_WHATSAPP`), **OR**
   - `senderJid` (stripped of `@lid`) matches `MASTER_LID` (or resolves to `MASTER_PHONE` in `chat_map.json`).

Whenever an inbound payload carries `senderUsername` (normalized lowercase WhatsApp `@username` without `@`), persist the `@username <-> chatJid` (and `sender` phone digits if known) mapping in `chat_map.json` so outbound instructions to `@username` immediately map to the canonical thread key (`sessions.json`, `flows.json`, `contacts.json`). When `wa_send.py` or `receiver.py` dispatches to a `@username` not yet in `chat_map.json`, pass `"to": "@username"` (plus optional `"pin": "1234"` or `"@username#1234"`) directly to `/api/send*` (or pre-resolve via `GET /api/resolve?target=@username` with `x-api-key`) and store the returned `jid` in `chat_map.json`.

All other turns (including every group turn) MUST run in the restricted external-contact sandbox (`prompt_template.txt`, zero shell/file-write tools), and outbound local loopback access (`127.0.0.1`, `localhost`, `[::1]`) remains protected by requiring `GATEWAY_API_KEY` on all gateway `/api/*` endpoints.

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

Inject operator context **outside** the XML boundary (including hot-reloaded `## 2. Global Contact Reply Rules & Business Facts` and **only** the current contact's matching `### <phone | @username | Name>` block under `## 3. Contact-Specific Rules` from `~/.whatsapp-agent/skills/whatsapp-agent-rules/SKILL.md` — never inject `## 1. Operator & Outbound Workflow Rules` or other contacts' `###` blocks into external contact turns) and wrap inbound WhatsApp content **inside** `<untrusted_inbound_message>`:

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

## 3. AI Brain Adapter (Reuse Host AI Provider — Never Deploy `brain: none`)

The receiver supports two brain modes configured in `receiver.env` so it always uses the **same AI provider as the host AI agent** without depending on any single framework CLI:

### Mode A: `BRAIN_MODE=api` (Direct HTTP / SDK Provider — Works Everywhere)
Calls the active LLM provider directly from Python (`httpx` / `google-genai`) using the key stored in `~/.whatsapp-agent/vault/llm_api_key` (`LLM_API_KEY_FILE`):
- **`LLM_PROVIDER=openai`**: Any OpenAI-compatible Chat Completions endpoint (`{LLM_BASE_URL}/chat/completions`, default `https://api.openai.com/v1` or `https://openrouter.ai/api/v1`) with `Authorization: Bearer <key>`. Attach inbound images as `image_url` (`data:image/jpeg;base64,...`).
- **`LLM_PROVIDER=anthropic`**: Anthropic Messages API (`https://api.anthropic.com/v1/messages` or `{LLM_BASE_URL}/v1/messages`) with `x-api-key: <key>` and `anthropic-version: 2023-06-01`. Attach inbound images as base64 `image` blocks.
- **`LLM_PROVIDER=gemini`**: Official `google-genai >= 2.30.1` (`genai.Client(api_key=key)` -> `client.interactions.create(model=LLM_MODEL, system_instruction=..., input=..., store=False)`).
- **Tool Gating in `api` Mode**:
  - **External Contact Turns (`is_owner=False`)**: Pass `tools=[]` (pure text/vision generation — zero shell or filesystem access).
  - **Verified 1:1 Master DM Turns (`is_owner=True`)**: Expose restricted operator function tools (`run_shell`, `read_file`, `write_file`, `wa_send`) executed inside `~/whatsapp-agent-receiver/` (up to 8 tool-call iterations) so the owner can manage `contacts.json`, `flows.json`, `whatsapp-agent-rules/SKILL.md`, and outbound messages directly from WhatsApp.
- **Burst Cancellation**: Track an `asyncio.Task` / `threading.Event` per chat key so superseding messages cancel any in-flight HTTP stream/request before dispatching the combined burst.

### Mode B: `BRAIN_MODE=cli` (Authenticated Host Agent CLI)
Invokes the verified host AI agent CLI (`AGENT_CLI_BIN`, e.g. `claude`, `codex`, `gemini`) in its own POSIX process group (`start_new_session=True`) so superseding bursts can terminate in-flight runs via `os.killpg(proc.pid, signal.SIGTERM)`:
- **Subprocess Secret Hygiene**: Strip `GATEWAY_API_KEY`, `AGENT_SECRET_TOKEN`, and raw vault secrets from the child `env` on external contact turns (`is_owner=False`).
- **Sandbox Separation**:
  - **`claude` (`AGENT_CLI_TYPE=claude`)**:
    - Contact turn: `[AGENT_CLI_BIN, "-p", prompt, "--system-prompt", system_prompt, "--tools", "WebSearch,WebFetch"]` in an isolated temp directory (`/tmp/wa-contact-sandbox`).
    - Owner 1:1 DM turn: `[AGENT_CLI_BIN, "-p", prompt, "--system-prompt", system_prompt, "--dangerously-skip-permissions"]` in `~/whatsapp-agent-receiver`.
  - **`codex` (`AGENT_CLI_TYPE=codex`)**:
    - Contact turn: `[AGENT_CLI_BIN, "exec", "--skip-git-repo-check", "--sandbox", "read-only", full_prompt]` in `/tmp/wa-contact-sandbox` (with `-i <image_path>` when an image is attached).
    - Owner 1:1 DM turn: `[AGENT_CLI_BIN, "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", full_prompt]` in `~/whatsapp-agent-receiver`.
  - **`gemini` (`AGENT_CLI_TYPE=gemini`)**:
    - Contact turn: `[AGENT_CLI_BIN, "-p", full_prompt]` in `/tmp/wa-contact-sandbox`.
    - Owner 1:1 DM turn: `[AGENT_CLI_BIN, "-p", full_prompt, "--yolo"]` in `~/whatsapp-agent-receiver`.

### Mandatory Health & Live Readiness Check (`GET /health`)
`GET http://127.0.0.1:5000/health` MUST return:
```json
{
  "ok": true,
  "brain_mode": "api",
  "brain_provider": "openai:gpt-4.1",
  "brain_ready": true,
  "voice_engine": "gemini-audio" | "faster-whisper",
  "turns_active": 0
}
```
Never ignore HTTP `401`/`402`/`403` provider errors silently — log them clearly, alert `MASTER_PHONE`, and leave the inbound turn unledgered (`no-answer`) so `replay_orphans()` retries once credentials/quota are restored.

---

## 4. Voice Note Pipeline (Gemini Audio via Secret Vault, or Local `faster-whisper` Out of the Box)

- Download `.ogg` / `audio` payloads immediately via `GET /api/media/<messageId>` (with header `x-api-key: <GATEWAY_API_KEY>`) into `media/`.
- **Dynamic Engine Selection via Secret Vault** (`load_vault_secret("gemini_api_key", "GEMINI_API_KEY_FILE")`):
  1. Check `$CREDENTIALS_DIRECTORY/gemini_api_key` (`systemd-creds`), then `GEMINI_API_KEY_FILE` (default `~/.whatsapp-agent/vault/gemini_api_key`, `0600`).
  2. **If a non-empty Gemini API key is present -> Use Gemini Audio (`google-genai >= 2.30.1`)**:
     - Call `gemini-3.8-flash` (`GEMINI_AUDIO_MODEL`) via `client.interactions.create(..., generation_config={"thinking_level": GEMINI_THINKING_LEVEL}, store=False)` (`low` or `medium` thinking) requesting JSON `{"vibe": "casual|polite|funny|serious|urgent|unclear", "transcript": "..."}` preserving verbatim English, Chinese, Malay, and Manglish code-switching.
     - Inject into `<untrusted_inbound_message>` (after `clean_untrusted()`) as:
       `[voice note | vibe: polite | transcript: "..."]`
     - **Explicit Error Visibility (No Silent Masking)**: If a configured Gemini API key fails authentication or quota (HTTP 400/401/403/429), log the error clearly in `whatsapp-agent-receiver` and alert `MASTER_PHONE` so the owner knows their configured Gemini key needs attention rather than silently hiding a broken key.
  3. **Else (no Gemini API key configured — user skipped/ignored it) -> Use Local `faster-whisper` Out of the Box**:
     - Lazily initialize a process-wide thread-safe `faster_whisper.WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)` singleton (default `WHISPER_MODEL="base"`, `device="cpu"`, `compute_type="int8"`, decoded natively via bundled PyAV with zero external API keys required).
     - Run `model.transcribe(str(audio_path), beam_size=5, vad_filter=True)`.
     - If speech segments are present, inject (after `clean_untrusted()`):
       `[voice note | engine: faster-whisper | lang: {info.language} | transcript: "..."]`
     - If no speech is detected or average log-probability indicates garbled audio (`avg_logprob < -1.0`), mark `unclear`:
       `[voice note | engine: faster-whisper | quality: unclear | transcript: "(inaudible/muffled)"]`

```python
import base64
import json
import os
import threading
from pathlib import Path

_whisper_lock = threading.Lock()
_whisper_model = None


def load_vault_secret(cred_name: str, env_file_var: str, default_path: str) -> str | None:
    cred_dir = os.environ.get("CREDENTIALS_DIRECTORY")
    candidates: list[Path] = []
    if cred_dir:
        candidates.append(Path(cred_dir) / cred_name)
    vault_file = os.environ.get(env_file_var, default_path)
    candidates.append(Path(vault_file).expanduser())

    for path in candidates:
        if path.is_file():
            key = path.read_text(encoding="utf-8").strip()
            if key:
                return key
    return None


def load_gemini_api_key() -> str | None:
    return load_vault_secret(
        "gemini_api_key",
        "GEMINI_API_KEY_FILE",
        "~/.whatsapp-agent/vault/gemini_api_key",
    )


def transcribe_with_gemini(audio_path: Path, mime_type: str, api_key: str) -> str:
    from google import genai

    model = os.environ.get("GEMINI_AUDIO_MODEL", "gemini-3.8-flash")
    thinking_level = os.environ.get("GEMINI_THINKING_LEVEL", "low").lower()
    audio_b64 = base64.b64encode(audio_path.read_bytes()).decode("utf-8")

    client = genai.Client(api_key=api_key)
    interaction = client.interactions.create(
        model=model,
        input=[
            {
                "type": "text",
                "text": (
                    'Transcribe this WhatsApp voice note verbatim (preserving English, Chinese, Malay, and Manglish) '
                    'and classify speaker vibe as one of: casual, polite, funny, serious, urgent, unclear. '
                    'Respond strictly as JSON: {"vibe": "...", "transcript": "..."}. '
                    'If muffled or inaudible, set vibe to "unclear" and transcript to "(inaudible/muffled)".'
                ),
            },
            {
                "type": "audio",
                "data": audio_b64,
                "mime_type": mime_type.split(";")[0].strip() or "audio/ogg",
            },
        ],
        generation_config={"thinking_level": thinking_level},
        store=False,
    )
    raw = (interaction.output_text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`").removeprefix("json").strip()
    parsed = json.loads(raw)
    vibe = clean_untrusted(str(parsed.get("vibe") or "unclear")).lower()
    transcript = clean_untrusted(str(parsed.get("transcript") or "(inaudible/muffled)"))
    return f'[voice note | vibe: {vibe} | transcript: "{transcript}"]'


def transcribe_with_faster_whisper(audio_path: Path) -> str:
    global _whisper_model
    from faster_whisper import WhisperModel

    with _whisper_lock:
        if _whisper_model is None:
            _whisper_model = WhisperModel(
                os.environ.get("WHISPER_MODEL", "base"),
                device=os.environ.get("WHISPER_DEVICE", "cpu"),
                compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
            )
        segments_iter, info = _whisper_model.transcribe(str(audio_path), beam_size=5, vad_filter=True)
        segments = list(segments_iter)

    text = " ".join(seg.text.strip() for seg in segments if seg.text.strip()).strip()
    if not text:
        return '[voice note | engine: faster-whisper | quality: unclear | transcript: "(inaudible/muffled)"]'

    avg_logprob = sum(seg.avg_logprob for seg in segments) / len(segments)
    clean_text = clean_untrusted(text)
    if avg_logprob < -1.0:
        return f'[voice note | engine: faster-whisper | lang: {info.language} | quality: unclear | transcript: "{clean_text}"]'
    return f'[voice note | engine: faster-whisper | lang: {info.language} | transcript: "{clean_text}"]'
```

---

## 5. Output Parsing Order (`@@FLAG@@`, `NO_REPLY`, `===MSG===`, `sanitize_reply`)

Process raw AI reply text in this exact deterministic order:

1. **Empty Check**: If `raw_output.strip() == ""`, treat as **`no-answer`** (process/API failure or timeout). Do **not** ledger in `handled.json` so `replay_orphans()` can retry.
2. **Extract & Strip `@@FLAG@@` First**:
   ```python
   import re

   flags: list[str] = []
   kept_lines: list[str] = []
   for line in raw_output.splitlines():
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
       # Ensure boundary spaces around *bold* when touching alphanumeric or CJK characters
       text = re.sub(r"([^\s*(\[\"'\u201c])\*([^\s*](?:[^*\n]*?[^\s*])?)\*", r"\1 *\2*", text)
       text = re.sub(r"\*([^\s*](?:[^*\n]*?[^\s*])?)\*([^\s*.,!?:;)\]\"'\u201d])", r"*\1* \2", text)
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
