import type { ReceiverConfig } from './config.js';

export interface GatewayCallResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

const SEND_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(cfg: Pick<ReceiverConfig, 'gatewayUrl' | 'gatewayApiKey'>) {
    this.baseUrl = cfg.gatewayUrl.replace(/\/+$/, '');
    this.apiKey = cfg.gatewayApiKey;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  private async requestJson<T = Record<string, unknown>>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, unknown>,
    opts: { retryOn503?: boolean; timeoutMs?: number } = {}
  ): Promise<GatewayCallResult<T>> {
    const maxAttempts = opts.retryOn503 ? SEND_RETRY_DELAYS_MS.length + 1 : 1;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const url = `${this.baseUrl}${endpoint}`;
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: this.authHeaders(serialized ? { 'Content-Type': 'application/json' } : {}),
          body: serialized,
          signal: AbortSignal.timeout(timeoutMs)
        });
        const text = await res.text();
        let json: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          // Ignore non-JSON body on error reporting
        }

        const errorMsg =
          typeof json?.error === 'string'
            ? json.error
            : !res.ok
              ? text.slice(0, 300) || `HTTP ${res.status}`
              : undefined;

        // Only retry transient 503 (disconnect / reconnect window), never 4xx or 502 (Error 463 / 479)
        if (res.status === 503 && opts.retryOn503 && attempt < maxAttempts) {
          await sleep(SEND_RETRY_DELAYS_MS[attempt - 1] ?? 10000);
          continue;
        }

        return {
          ok: res.ok && json?.success !== false,
          status: res.status,
          data: json as T | undefined,
          error: errorMsg
        };
      } catch (err: unknown) {
        if (opts.retryOn503 && attempt < maxAttempts) {
          await sleep(SEND_RETRY_DELAYS_MS[attempt - 1] ?? 10000);
          continue;
        }
        return {
          ok: false,
          status: 503,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }

    return { ok: false, status: 503, error: 'Gateway request exhausted retries' };
  }

  public sendText(params: {
    to: string;
    message: string;
    pin?: string;
    replyToMessageId?: string;
  }): Promise<GatewayCallResult<{ success: boolean; messageId?: string; jid?: string }>> {
    return this.requestJson(
      'POST',
      '/api/send',
      {
        to: params.to,
        message: params.message,
        ...(params.pin ? { pin: params.pin } : {}),
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {})
      },
      { retryOn503: true, timeoutMs: 25_000 }
    );
  }

  public sendImage(params: {
    to: string;
    url: string;
    caption?: string;
    pin?: string;
    replyToMessageId?: string;
  }): Promise<GatewayCallResult<{ success: boolean; messageId?: string; jid?: string }>> {
    return this.requestJson(
      'POST',
      '/api/send-image',
      {
        to: params.to,
        url: params.url,
        ...(params.caption ? { caption: params.caption } : {}),
        ...(params.pin ? { pin: params.pin } : {}),
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {})
      },
      { retryOn503: true, timeoutMs: 45_000 }
    );
  }

  public sendDocument(params: {
    to: string;
    url: string;
    fileName?: string;
    mimetype?: string;
    caption?: string;
    pin?: string;
    replyToMessageId?: string;
  }): Promise<GatewayCallResult<{ success: boolean; messageId?: string; jid?: string }>> {
    return this.requestJson(
      'POST',
      '/api/send-document',
      {
        to: params.to,
        url: params.url,
        ...(params.fileName ? { fileName: params.fileName } : {}),
        ...(params.mimetype ? { mimetype: params.mimetype } : {}),
        ...(params.caption ? { caption: params.caption } : {}),
        ...(params.pin ? { pin: params.pin } : {}),
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {})
      },
      { retryOn503: true, timeoutMs: 45_000 }
    );
  }

  public sendSticker(params: {
    to: string;
    url: string;
    pack?: string;
    author?: string;
    pin?: string;
    replyToMessageId?: string;
  }): Promise<GatewayCallResult<{ success: boolean; messageId?: string; jid?: string }>> {
    return this.requestJson(
      'POST',
      '/api/send-sticker',
      {
        to: params.to,
        url: params.url,
        ...(params.pack ? { pack: params.pack } : {}),
        ...(params.author ? { author: params.author } : {}),
        ...(params.pin ? { pin: params.pin } : {}),
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {})
      },
      { retryOn503: true, timeoutMs: 30_000 }
    );
  }

  public markRead(messageId: string): Promise<GatewayCallResult> {
    return this.requestJson('POST', '/api/read', { messageId }, { timeoutMs: 10_000 });
  }

  public setPresence(recipient: string, presence: 'composing' | 'paused'): Promise<GatewayCallResult> {
    return this.requestJson('POST', '/api/presence', { recipient, presence }, { timeoutMs: 10_000 });
  }

  public resolveRecipient(target: string, pin?: string, refresh = false): Promise<GatewayCallResult> {
    const qs = new URLSearchParams({ target });
    if (pin) qs.set('pin', pin);
    if (refresh) qs.set('refresh', 'true');
    return this.requestJson('GET', `/api/resolve?${qs.toString()}`, undefined, { timeoutMs: 15_000 });
  }

  public listUsernames(): Promise<GatewayCallResult> {
    return this.requestJson('GET', '/api/usernames', undefined, { timeoutMs: 10_000 });
  }

  public getHealth(): Promise<GatewayCallResult<{ success: boolean; whatsapp?: string; uptimeSeconds?: number }>> {
    return this.requestJson('GET', '/api/health', undefined, { timeoutMs: 5_000 });
  }

  public async downloadMedia(
    messageId: string
  ): Promise<{ ok: true; buffer: Buffer; mimetype: string; fileName?: string } | { ok: false; status: number; error: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/media/${encodeURIComponent(messageId)}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` };
      }
      const mimetype = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
      const cd = res.headers.get('content-disposition') || '';
      const fnMatch = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(cd);
      let fileName: string | undefined;
      if (fnMatch?.[1]) {
        try {
          fileName = decodeURIComponent(fnMatch[1]);
        } catch {
          fileName = fnMatch[1];
        }
      } else if (fnMatch?.[2]) {
        fileName = fnMatch[2];
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return { ok: true, buffer, mimetype, fileName };
    } catch (err: unknown) {
      return { ok: false, status: 503, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
