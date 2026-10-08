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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.webhookToken) headers['x-hermes-token'] = config.webhookToken;
  const body = JSON.stringify(payload);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(config.webhookUrl, { method: 'POST', headers, body, signal: controller.signal });
      const bodyText = await res.text();
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
    await sleep(1000 * attempt);
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
