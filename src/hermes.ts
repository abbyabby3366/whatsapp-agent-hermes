import { config } from './config.js';

export interface HermesResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  attempts: number;
  bodyText: string;
  /** Parsed JSON body, or null when Hermes answered with something that is not a JSON object. */
  json: Record<string, unknown> | null;
}

const MAX_HERMES_RESPONSE_BYTES = 64 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function extractMessageId(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const id = (payload as Record<string, unknown>).messageId;
    if (typeof id === 'string' && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), 15_000);
    }
  }
  return null;
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        total += remaining;
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * POSTs a payload to the Hermes webhook. Network errors, timeouts, HTTP 429 and 5xx are retried
 * with a short back-off; other 4xx responses are returned immediately. Throws if every attempt
 * failed at the network level.
 */
export async function postToHermes(
  payload: unknown,
  opts: { retries?: number; timeoutMs?: number } = {}
): Promise<HermesResult> {
  if (!config.webhookUrl) {
    throw new Error('HERMES_WEBHOOK_URL is not configured');
  }

  const retries = opts.retries ?? config.webhookRetries;
  const timeoutMs = opts.timeoutMs ?? config.webhookTimeoutMs;
  const messageId = extractMessageId(payload);
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.webhookToken) baseHeaders['x-hermes-token'] = config.webhookToken;
  if (messageId) baseHeaders['Idempotency-Key'] = messageId;
  const body = JSON.stringify(payload);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryDelayMs = 1000 * attempt + Math.floor(Math.random() * 250);
    try {
      const headers = { ...baseHeaders, 'X-Hermes-Attempt': String(attempt) };
      const res = await fetch(config.webhookUrl, { method: 'POST', headers, body, signal: controller.signal });
      const bodyText = await readBoundedText(res, MAX_HERMES_RESPONSE_BYTES);
      const result: HermesResult = {
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - started,
        attempts: attempt,
        bodyText,
        json: parseJsonObject(bodyText)
      };
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries + 1) return result;
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
        if (retryAfterMs !== null) {
          retryDelayMs = retryAfterMs;
        }
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err: unknown) {
      lastError =
        err instanceof Error && err.name === 'AbortError'
          ? new Error(`timed out after ${timeoutMs}ms`)
          : err;
      if (attempt === retries + 1) break;
    } finally {
      clearTimeout(timer);
    }
    await sleep(retryDelayMs);
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  const cause = (lastError as { cause?: { code?: string } } | null)?.cause?.code;
  throw new Error(cause ? `${reason} (${cause})` : reason);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
