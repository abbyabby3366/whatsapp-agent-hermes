import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config, flushSettings, isLoopbackHost } from './config.js';
import { postToHermes } from './hermes.js';
import { PRESENCE_VALUES, waClient, type PresenceValue } from './whatsapp.js';

const app = express();
const startedAt = Date.now();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

app.disable('x-powered-by');

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (!req.path.startsWith('/api')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
  }
  next();
});

const MEDIA_UPLOAD_PATHS = new Set(['/api/send-image', '/api/send-document', '/api/send-sticker']);
const defaultJsonParser = express.json({ limit: '1mb' });
const mediaJsonParser = express.json({ limit: '35mb' });

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'POST' && MEDIA_UPLOAD_PATHS.has(req.path)) {
    mediaJsonParser(req, res, next);
    return;
  }
  defaultJsonParser(req, res, next);
});

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();

const AUTH_WINDOW_MS = 60_000;
const MAX_FAILED_AUTH_ATTEMPTS = 20;
const MAX_TRACKED_AUTH_IPS = 2000;
const failedAuthByIp = new Map<string, { count: number; resetAt: number }>();

export function resetAuthRateLimits(): void {
  failedAuthByIp.clear();
}

/** Optional shared-key protection for the API. The dashboard prompts for the key when it is needed. */
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) {
    next();
    return;
  }

  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const existing = failedAuthByIp.get(clientIp);
  if (existing && existing.resetAt <= now) {
    failedAuthByIp.delete(clientIp);
  }
  const activeEntry = failedAuthByIp.get(clientIp);
  if (activeEntry && activeEntry.count >= MAX_FAILED_AUTH_ATTEMPTS) {
    const retryAfterSec = Math.max(1, Math.ceil((activeEntry.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      success: false,
      error: 'Too many failed authentication attempts. Try again shortly.'
    });
    return;
  }

  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const provided = String(req.headers['x-api-key'] ?? bearer ?? '');
  if (provided && crypto.timingSafeEqual(sha256(provided), sha256(config.apiKey))) {
    failedAuthByIp.delete(clientIp);
    next();
    return;
  }

  const nextCount = activeEntry ? activeEntry.count + 1 : 1;
  const resetAt = activeEntry ? activeEntry.resetAt : now + AUTH_WINDOW_MS;
  failedAuthByIp.delete(clientIp);
  failedAuthByIp.set(clientIp, { count: nextCount, resetAt });
  if (failedAuthByIp.size > MAX_TRACKED_AUTH_IPS) {
    const oldestKey = failedAuthByIp.keys().next().value;
    if (oldestKey) failedAuthByIp.delete(oldestKey);
  }

  res.status(401).json({ success: false, error: 'Missing or invalid API key', authRequired: true });
}

// Liveness probe for monitoring (no auth, no secrets).
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    whatsapp: waClient.getState().status,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
  });
});

app.use('/api', requireApiKey);

app.get('/api/status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: { ...waClient.getState(), authRequired: Boolean(config.apiKey) }
  });
});

// Returns the current WhatsApp pairing QR code as raw PNG bytes (authenticated).
app.get('/api/qr.png', (_req: Request, res: Response) => {
  const state = waClient.getState();
  if (state.status === 'connected') {
    res.status(409).json({
      success: false,
      status: 'connected',
      user: state.user,
      error: 'WhatsApp is already connected'
    });
    return;
  }

  const qrDataUrl = state.qrCodeDataUrl;
  const pngPrefix = 'data:image/png;base64,';
  if (!qrDataUrl || !qrDataUrl.startsWith(pngPrefix)) {
    res.status(404).json({
      success: false,
      status: state.status,
      error: 'Pairing QR code is not ready yet'
    });
    return;
  }

  const pngBuffer = Buffer.from(qrDataUrl.slice(pngPrefix.length), 'base64');
  if (pngBuffer.length === 0) {
    res.status(404).json({
      success: false,
      status: state.status,
      error: 'Pairing QR code is empty'
    });
    return;
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(pngBuffer);
});

// Server-Sent Events stream for real-time dashboard updates without polling.
app.get('/api/events', (req: Request, res: Response) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendState = () => {
    if (res.writableEnded) return;
    const payload = { ...waClient.getState(), authRequired: Boolean(config.apiKey) };
    res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  sendState();
  const unsubscribe = waClient.onStateChange(sendState);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 20_000);
  heartbeat.unref();

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});

/** Extracts an optional PIN passed as a string ("1234" / "0412") or integer (1234 / 412 -> "0412") without silently dropping numeric JSON values. */
function extractPin(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    // JSON numbers lose leading zeros; restore them for 0-9999 and leave anything else for validation to reject
    return raw >= 0 && raw <= 9999 ? String(raw).padStart(4, '0') : String(raw);
  }
  return undefined;
}

// Resolve a phone number, @username (with optional 4-digit PIN), or JID into a canonical WhatsApp JID.
const handleResolveRecipient = async (req: Request, res: Response): Promise<void> => {
  const source = req.method === 'GET' ? req.query : (req.body ?? {});
  const rawTarget = source.target ?? source.to ?? source.username;
  const rawPin = source.pin;
  const rawRefresh = source.refresh;

  if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
    res.status(400).json({
      success: false,
      error: '"target" (phone number, @username, or WhatsApp ID) is required'
    });
    return;
  }

  const pin = extractPin(rawPin);
  const forceRefresh = rawRefresh === true || rawRefresh === 'true' || rawRefresh === '1';

  const result = await waClient.resolveRecipient(rawTarget, { pin, forceRefresh });
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }

  res.json({
    success: true,
    jid: result.jid,
    username: result.username ?? null,
    displayRecipient: result.displayRecipient,
    isGroup: result.isGroup,
    source: result.source
  });
};

app.get('/api/resolve', handleResolveRecipient);
app.post('/api/resolve', handleResolveRecipient);

// List known @username <-> JID mappings cached from inbound chats, contacts sync, and USync lookups.
app.get('/api/usernames', (_req: Request, res: Response) => {
  const usernames = waClient.listKnownUsernames();
  res.json({ success: true, count: usernames.length, usernames });
});

// Send a message (used by Hermes for asynchronous replies, and by the dashboard form).
app.post('/api/send', async (req: Request, res: Response) => {
  const { to, message, pin, replyToMessageId } = req.body ?? {};
  if (!to || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({
      success: false,
      error: 'Both "to" (phone number, @username, or WhatsApp ID) and "message" (text) are required'
    });
    return;
  }

  const result = await waClient.sendMessage(String(to), message, {
    pin: extractPin(pin),
    quotedMessageId: typeof replyToMessageId === 'string' ? replyToMessageId : undefined,
    inReplyTo: typeof replyToMessageId === 'string' ? replyToMessageId : undefined,
    source: req.headers['x-source'] === 'dashboard' ? 'api' : 'hermes'
  });
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true, messageId: result.messageId, jid: result.jid, timestamp: new Date().toISOString() });
});

// Send an image (used by Hermes and external APIs).
app.post('/api/send-image', async (req: Request, res: Response) => {
  const { to, url, imageUrl, caption, pin, replyToMessageId } = req.body ?? {};
  const mediaUrl =
    typeof url === 'string' && url.trim()
      ? url.trim()
      : typeof imageUrl === 'string' && imageUrl.trim()
        ? imageUrl.trim()
        : null;

  if (!to || !mediaUrl) {
    res.status(400).json({
      success: false,
      error: 'Both "to" (phone number, @username, or WhatsApp ID) and "url" (or "imageUrl") are required'
    });
    return;
  }

  const result = await waClient.sendImage(
    String(to),
    mediaUrl,
    typeof caption === 'string' ? caption : undefined,
    {
      pin: extractPin(pin),
      quotedMessageId: typeof replyToMessageId === 'string' ? replyToMessageId : undefined,
      inReplyTo: typeof replyToMessageId === 'string' ? replyToMessageId : undefined,
      source: req.headers['x-source'] === 'dashboard' ? 'api' : 'hermes'
    }
  );
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true, messageId: result.messageId, jid: result.jid, timestamp: new Date().toISOString() });
});

// Send a document (used by Hermes, dashboard, and external APIs).
app.post('/api/send-document', async (req: Request, res: Response) => {
  const { to, url, documentUrl, fileName, filename, mimetype, caption, pin, replyToMessageId } = req.body ?? {};
  const mediaUrl =
    typeof url === 'string' && url.trim()
      ? url.trim()
      : typeof documentUrl === 'string' && documentUrl.trim()
        ? documentUrl.trim()
        : null;

  if (!to || !mediaUrl) {
    res.status(400).json({
      success: false,
      error: 'Both "to" (phone number, @username, or WhatsApp ID) and "url" (or "documentUrl") are required'
    });
    return;
  }

  const cleanFileName =
    typeof fileName === 'string' && fileName.trim()
      ? fileName.trim()
      : typeof filename === 'string' && filename.trim()
        ? filename.trim()
        : undefined;

  const result = await waClient.sendDocument(
    String(to),
    mediaUrl,
    {
      pin: extractPin(pin),
      fileName: cleanFileName,
      mimetype: typeof mimetype === 'string' && mimetype.trim() ? mimetype.trim() : undefined,
      caption: typeof caption === 'string' && caption.trim() ? caption.trim() : undefined,
      quotedMessageId: typeof replyToMessageId === 'string' && replyToMessageId.trim() ? replyToMessageId.trim() : undefined,
      inReplyTo: typeof replyToMessageId === 'string' && replyToMessageId.trim() ? replyToMessageId.trim() : undefined,
      source: req.headers['x-source'] === 'dashboard' ? 'api' : 'hermes'
    }
  );
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true, messageId: result.messageId, jid: result.jid, timestamp: new Date().toISOString() });
});

// Send a sticker (used by Hermes, dashboard, and external APIs).
app.post('/api/send-sticker', async (req: Request, res: Response) => {
  const { to, url, stickerUrl, sticker, pack, author, categories, isAnimated, pin, replyToMessageId } = req.body ?? {};
  const stickerData =
    typeof url === 'string' && url.trim()
      ? url.trim()
      : typeof stickerUrl === 'string' && stickerUrl.trim()
        ? stickerUrl.trim()
        : typeof sticker === 'string' && sticker.trim()
          ? sticker.trim()
          : null;

  if (!to || !stickerData) {
    res.status(400).json({
      success: false,
      error: 'Both "to" (phone number, @username, or WhatsApp ID) and "url" (or "sticker" / "stickerUrl") are required'
    });
    return;
  }

  const cleanPack = typeof pack === 'string' && pack.trim() ? pack.trim() : undefined;
  const cleanAuthor = typeof author === 'string' && author.trim() ? author.trim() : undefined;
  const cleanCategories = Array.isArray(categories)
    ? categories.filter((c): c is string => typeof c === 'string')
    : undefined;

  const result = await waClient.sendSticker(
    String(to),
    stickerData,
    {
      pin: extractPin(pin),
      pack: cleanPack,
      author: cleanAuthor,
      categories: cleanCategories,
      isAnimated: typeof isAnimated === 'boolean' ? isAnimated : undefined,
      quotedMessageId: typeof replyToMessageId === 'string' && replyToMessageId.trim() ? replyToMessageId.trim() : undefined,
      inReplyTo: typeof replyToMessageId === 'string' && replyToMessageId.trim() ? replyToMessageId.trim() : undefined,
      source: req.headers['x-source'] === 'dashboard' ? 'api' : 'hermes'
    }
  );
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true, messageId: result.messageId, jid: result.jid, timestamp: new Date().toISOString() });
});

// Typing indicator etc.
app.post('/api/presence', async (req: Request, res: Response) => {
  const { recipient, presence, pin } = req.body ?? {};
  if (!recipient || !PRESENCE_VALUES.includes(presence)) {
    res.status(400).json({
      success: false,
      error: `"recipient" and "presence" (${PRESENCE_VALUES.join(' | ')}) are required`
    });
    return;
  }

  const result = await waClient.setPresence(String(recipient), presence as PresenceValue, extractPin(pin));
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }
  res.json({ success: true });
});

// Mark a received message as read (blue ticks).
app.post('/api/read', async (req: Request, res: Response) => {
  const messageId = req.body?.messageId;
  if (typeof messageId !== 'string' || !messageId) {
    res.status(400).json({ success: false, error: '"messageId" is required' });
    return;
  }
  const ok = await waClient.markRead(messageId);
  res.status(ok ? 200 : 404).json({ success: ok, ...(ok ? {} : { error: 'Message not found or WhatsApp not connected' }) });
});

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json'
};

function buildContentDisposition(fileName: string | undefined, messageId: string, mimetype: string): string {
  const ext = MEDIA_EXTENSIONS[mimetype.split(';')[0].trim().toLowerCase()] ?? 'bin';
  const safeId = messageId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'file';
  const rawName = fileName ? path.basename(fileName) : `media-${safeId}.${ext}`;
  const asciiFallback = rawName.replace(/[\r\n"\\/]/g, '_').replace(/[^\x20-\x7e]/g, '_') || `media.${ext}`;
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(rawName)}`;
}

// Download the media (image, voice note, document...) of a recent incoming message.
app.get('/api/media/:messageId', async (req: Request, res: Response) => {
  const messageId = String(req.params.messageId);
  const result = await waClient.downloadMedia(messageId);
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }
  res.setHeader('Content-Type', result.mimetype);
  res.setHeader('Content-Disposition', buildContentDisposition(result.fileName, messageId, result.mimetype));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(result.buffer);
});

// Pause / resume forwarding incoming messages to Hermes.
app.post('/api/forwarding', (req: Request, res: Response) => {
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ success: false, error: '"enabled" (true | false) is required' });
    return;
  }
  waClient.setForwardingEnabled(req.body.enabled);
  res.json({ success: true, forwardingEnabled: req.body.enabled });
});

// Check that Hermes is reachable and accepts our token.
app.post('/api/webhook/test', async (_req: Request, res: Response) => {
  if (!config.webhookUrl) {
    res.status(400).json({ success: false, error: 'HERMES_WEBHOOK_URL is not set in .env' });
    return;
  }

  const testPayload = {
    event: 'test.ping',
    messageId: `test-${Date.now()}`,
    sender: '60120000000',
    senderName: 'Test Contact',
    senderJid: '60120000000@s.whatsapp.net',
    chatJid: '60120000000@s.whatsapp.net',
    remoteJid: '60120000000@s.whatsapp.net',
    isGroup: false,
    message: 'Ping from WhatsApp Agent Hermes gateway',
    messageType: 'text',
    timestamp: new Date().toISOString()
  };

  try {
    const result = await postToHermes(testPayload, { retries: 0, timeoutMs: 8000 });
    res.json({
      success: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      responseBody: result.bodyText.slice(0, 500),
      error: result.ok
        ? undefined
        : result.status === 401 || result.status === 403
          ? `Hermes rejected the secret token (HTTP ${result.status}). Check HERMES_SECRET_TOKEN.`
          : `Hermes answered HTTP ${result.status}`
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ success: false, error: `Could not reach Hermes at ${config.webhookUrl}: ${errMsg}` });
  }
});

app.post('/api/connect', async (_req: Request, res: Response) => {
  const { status } = waClient.getState();
  if (status === 'connected') {
    res.json({ success: true, message: 'Already connected' });
    return;
  }
  await waClient.start();
  res.json({ success: true, message: 'WhatsApp connection initiated' });
});

app.post('/api/logout', async (_req: Request, res: Response) => {
  const result = await waClient.logout();
  if (!result.success) {
    res.status(500).json({ success: false, error: result.message });
    return;
  }
  res.json({ success: true, message: result.message });
});

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Unknown API endpoint' });
});

// Dashboard (static files in /public)
app.use(express.static(publicDir));

// Final error handler: always answer API clients with JSON instead of an HTML stack trace.
app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.too.large') {
    res.status(413).json({ success: false, error: 'Request body exceeds the maximum allowed size' });
    return;
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ success: false, error: 'Request body is not valid JSON' });
    return;
  }
  console.error('[Server] Unhandled error:', err);
  res.status(err.status ?? 500).json({ success: false, error: err.status && err.status < 500 ? err.message : 'Internal server error' });
});

export { app };

if (process.env.NODE_ENV !== 'test') {
  process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled promise rejection:', reason);
  });

  if (!isLoopbackHost(config.host) && (!config.apiKey || config.hasPlaceholderApiKey)) {
    console.error(
      '[WhatsApp Agent Hermes] FATAL: Refusing to listen on non-loopback host without a strong non-placeholder GATEWAY_API_KEY.'
    );
    process.exit(1);
  }

  if (config.hasPlaceholderApiKey) {
    console.warn(
      '[WhatsApp Agent Hermes] WARNING: GATEWAY_API_KEY appears to use a placeholder secret ("change-me*"). Generate a strong key in .env.'
    );
  }
  if (config.hasPlaceholderWebhookToken) {
    console.warn(
      '[WhatsApp Agent Hermes] WARNING: HERMES_SECRET_TOKEN appears to use a placeholder secret ("change-me*"). Generate a strong token in .env.'
    );
  }

  const server = app.listen(config.port, config.host, () => {
    console.log(`[WhatsApp Agent Hermes] Dashboard: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`[WhatsApp Agent Hermes] Hermes webhook: ${config.webhookUrl || 'NOT SET (messages will not be forwarded)'}`);
    void waClient.start();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `[WhatsApp Agent Hermes] Port ${config.port} is already in use. Change PORT in .env or stop the other process.`
        : `[WhatsApp Agent Hermes] Server error: ${err.message}`
    );
    process.exit(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[WhatsApp Agent Hermes] ${signal} received, shutting down...`);
      void Promise.all([waClient.shutdown(), flushSettings()]).finally(() => server.close(() => process.exit(0)));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}
