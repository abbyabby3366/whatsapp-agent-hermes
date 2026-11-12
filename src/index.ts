import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config, isLoopbackHost } from './config.js';
import { postToWebhook } from './webhook.js';
import { PRESENCE_VALUES, waClient, type PresenceValue } from './whatsapp.js';

const app = express();
const startedAt = Date.now();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();

/** Optional shared-key protection for the API. The dashboard prompts for the key when it is needed. */
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiKey) {
    next();
    return;
  }
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const provided = String(req.headers['x-api-key'] ?? bearer ?? '');
  if (provided && crypto.timingSafeEqual(sha256(provided), sha256(config.apiKey))) {
    next();
    return;
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

/** Extracts an optional PIN passed as a string ("1234" / "0412") or integer (1234) without silently dropping numeric JSON values. */
function extractPin(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw);
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

// Send a message (used by the AI agent for asynchronous replies, and by the dashboard form).
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
    source: req.headers['x-source'] === 'dashboard' ? 'api' : 'agent'
  });
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true, messageId: result.messageId, jid: result.jid, timestamp: new Date().toISOString() });
});

// Send an image (used by the AI agent and external APIs).
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
      source: req.headers['x-source'] === 'dashboard' ? 'api' : 'agent'
    }
  );
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true, messageId: result.messageId, jid: result.jid, timestamp: new Date().toISOString() });
});

// Send a document (used by the AI agent, dashboard, and external APIs).
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
      source: req.headers['x-source'] === 'dashboard' ? 'api' : 'agent'
    }
  );
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true, messageId: result.messageId, jid: result.jid, timestamp: new Date().toISOString() });
});

// Send a sticker (used by the AI agent, dashboard, and external APIs).
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
      source: req.headers['x-source'] === 'dashboard' ? 'api' : 'agent'
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

// Download the media (image, voice note, document...) of a recent incoming message.
app.get('/api/media/:messageId', async (req: Request, res: Response) => {
  const result = await waClient.downloadMedia(String(req.params.messageId));
  if (!result.success) {
    res.status(result.code).json({ success: false, error: result.error });
    return;
  }
  res.setHeader('Content-Type', result.mimetype);
  res.send(result.buffer);
});

// Pause / resume forwarding incoming messages to the AI agent.
app.post('/api/forwarding', (req: Request, res: Response) => {
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ success: false, error: '"enabled" (true | false) is required' });
    return;
  }
  waClient.setForwardingEnabled(req.body.enabled);
  res.json({ success: true, forwardingEnabled: req.body.enabled });
});

// Check that the AI agent webhook receiver is reachable and accepts our token.
app.post('/api/webhook/test', async (_req: Request, res: Response) => {
  if (!config.webhookUrl) {
    res.status(400).json({ success: false, error: 'AGENT_WEBHOOK_URL is not set in .env' });
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
    message: 'Ping from WhatsApp AI Agent gateway',
    messageType: 'text',
    timestamp: new Date().toISOString()
  };

  try {
    const result = await postToWebhook(testPayload, { retries: 0, timeoutMs: 8000 });
    res.json({
      success: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      responseBody: result.bodyText.slice(0, 500),
      error: result.ok
        ? undefined
        : result.status === 401 || result.status === 403
          ? `Webhook receiver rejected the secret token (HTTP ${result.status}). Check AGENT_SECRET_TOKEN.`
          : `Webhook receiver answered HTTP ${result.status}`
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ success: false, error: `Could not reach webhook receiver at ${config.webhookUrl}: ${errMsg}` });
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
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ success: false, error: 'Request body is not valid JSON' });
    return;
  }
  console.error('[Server] Unhandled error:', err);
  res.status(err.status ?? 500).json({ success: false, error: err.status && err.status < 500 ? err.message : 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[WhatsApp AI Agent] Dashboard: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`[WhatsApp AI Agent] Agent webhook: ${config.webhookUrl || 'NOT SET (messages will not be forwarded)'}`);
  if (!isLoopbackHost(config.host) && !config.apiKey) {
    console.warn(
      '[WhatsApp AI Agent] WARNING: listening on a public interface without GATEWAY_API_KEY. ' +
        'Anyone who can reach this port can send WhatsApp messages as you. Set GATEWAY_API_KEY in .env.'
    );
  }
  void waClient.start();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `[WhatsApp AI Agent] Port ${config.port} is already in use. Change PORT in .env or stop the other process.`
      : `[WhatsApp AI Agent] Server error: ${err.message}`
  );
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[WhatsApp AI Agent] ${signal} received, shutting down...`);
    void waClient.shutdown().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
