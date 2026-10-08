/**
 * Hermes Agent Reference Server (Demo)
 * Run with: npm run demo:hermes
 *
 * This server receives webhooks from the WhatsApp Agent Hermes gateway, decides whether to
 * reply, and answers either synchronously (in the HTTP response) or asynchronously through
 * the gateway's REST API. Replace the "REASONING LOGIC" section with your real Hermes agent.
 */

import express, { Request, Response } from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);
const SECRET_TOKEN = process.env.HERMES_SECRET_TOKEN || 'change-me-to-a-long-random-string';
const GATEWAY_URL = process.env.WHATSAPP_GATEWAY_URL || 'http://127.0.0.1:3100';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || '';

app.use(express.json());

/** Calls the gateway REST API (adds the optional access key). */
async function gateway(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(GATEWAY_API_KEY ? { 'x-api-key': GATEWAY_API_KEY } : {}) },
    body: JSON.stringify(body)
  });
  return res.json();
}

interface WebhookPayload {
  event: 'message.received' | 'test.ping';
  messageId: string;
  sender: string | null; // phone number, or null when WhatsApp only exposed an anonymous ID
  senderName: string | null;
  senderJid: string;
  chatJid: string; // always use this as "to" when replying
  isGroup: boolean;
  groupJid: string | null;
  message: string;
  messageType: string; // text | image | video | voice | audio | document | sticker | location | contact | other
  hasMedia: boolean;
  mimetype: string | null;
  mentionsMe: boolean;
  isReplyToMe: boolean;
  quoted: { messageId: string; message: string | null } | null;
  timestamp: string;
  isoTimestamp: string;
}

// Inbound webhook from WhatsApp Agent Hermes
app.post('/api/webhook', async (req: Request, res: Response) => {
  const token = req.headers['x-hermes-token'];
  if (SECRET_TOKEN && token !== SECRET_TOKEN) {
    console.warn('⚠️  Unauthorized webhook call. Bad x-hermes-token.');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const p = req.body as WebhookPayload;

  // Health check triggered by the dashboard's "Test connection to Hermes" button.
  if (p.event === 'test.ping') {
    res.json({ success: true, message: 'Hermes Agent received ping successfully!' });
    return;
  }

  console.log(`\n📨 [Hermes] ${p.senderName || p.sender || p.senderJid}: "${p.message}" (${p.messageType}, id ${p.messageId})`);

  // --- REASONING LOGIC ---
  const text = (p.message || '').toLowerCase();

  // In groups, only answer when the bot is mentioned or someone replies to it.
  if (p.isGroup && !p.mentionsMe && !p.isReplyToMe) {
    res.json({ reply: null, ignored: true });
    return;
  }

  if (text.includes('ping')) {
    // Mode A: immediate synchronous reply, quoting the incoming message.
    res.json({ reply: 'Pong! 🏓', quote: true });
    return;
  }

  if (/\b(hi|hello|help)\b/.test(text)) {
    res.json({ reply: `Hello ${p.senderName || 'there'}! 👋 I am your Hermes agent. How can I help?` });
    return;
  }

  if (p.hasMedia) {
    // Media can be fetched from the gateway while the message is still cached (last ~300 messages).
    const media = await fetch(`${GATEWAY_URL}/api/media/${p.messageId}`, {
      headers: GATEWAY_API_KEY ? { 'x-api-key': GATEWAY_API_KEY } : {}
    });
    const bytes = media.ok ? (await media.arrayBuffer()).byteLength : 0;
    res.json({ reply: `Got your ${p.messageType} (${p.mimetype || 'unknown type'}, ${bytes} bytes).` });
    return;
  }

  if (text.includes('think')) {
    // Mode C: long-running reasoning. Acknowledge now, answer later through the API.
    res.json({ reply: null, status: 'processing' });

    await gateway('/api/read', { messageId: p.messageId }); // blue ticks
    await gateway('/api/presence', { recipient: p.chatJid, presence: 'composing' });

    setTimeout(async () => {
      await gateway('/api/presence', { recipient: p.chatJid, presence: 'paused' });
      const result = await gateway('/api/send', {
        to: p.chatJid,
        message: `🧠 Done thinking about: "${p.message}"`,
        replyToMessageId: p.messageId
      });
      console.log('✅ [Hermes] Asynchronous reply sent:', result);
    }, 3000);
    return;
  }

  // Mode B: decide not to reply.
  console.log('🔇 [Hermes] Not replying.');
  res.json({ reply: null, ignored: true });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`🤖 Demo Hermes Agent listening on http://127.0.0.1:${PORT}/api/webhook`);
  console.log(`📡 Gateway: ${GATEWAY_URL}\n`);
});
