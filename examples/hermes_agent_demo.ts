/**
 * Hermes Agent Reference Server (Demo)
 * Run this with: npx tsx examples/hermes_agent_demo.ts
 *
 * This server receives webhooks from the WhatsApp Agent Hermes gateway,
 * decides whether to reply, and returns a response or calls the outbound API.
 */

import express, { Request, Response } from 'express';

const app = express();
const PORT = 5000;
const SECRET_TOKEN = process.env.HERMES_SECRET_TOKEN || 'hermes_whatsapp_secret_key_2026';
const WHATSAPP_GATEWAY_URL = 'http://localhost:3100';

app.use(express.json());

// Inbound webhook from WhatsApp Agent Hermes
app.post('/api/webhook', async (req: Request, res: Response) => {
  const token = req.headers['x-hermes-token'];
  if (SECRET_TOKEN && token !== SECRET_TOKEN) {
    console.warn('⚠️ Unauthorized webhook call. Bad x-hermes-token.');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { event, messageId, sender, senderName, message, isGroup } = req.body;
  console.log(`\n📨 [Hermes] Incoming message from ${senderName || sender}: "${message}" (ID: ${messageId})`);

  // Handle ping test from gateway dashboard
  if (event === 'test.ping') {
    res.json({ success: true, message: 'Hermes Agent received ping successfully!' });
    return;
  }

  // --- REASONING LOGIC ---
  // Here, Hermes decides whether to reply or ignore
  const lowerMsg = (message || '').toLowerCase();

  if (lowerMsg.includes('ping')) {
    // Mode A: Immediate synchronous reply
    res.json({
      reply: `Pong! 🏓 (Hermes Agent running at GMT+8)`
    });
    return;
  }

  if (lowerMsg.includes('help') || lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
    // Mode A: Immediate synchronous reply
    res.json({
      reply: `Hello ${senderName || 'there'}! 👋 I am your Hermes Agent connected to WhatsApp. How can I assist you today?`
    });
    return;
  }

  if (lowerMsg.includes('think')) {
    // Mode B: Simulate deep agent reasoning / tool calls
    // First, respond 200 OK immediately with no synchronous reply
    res.json({ reply: null, status: 'processing' });

    console.log(`🤖 [Hermes] Deep thinking started for ${sender}...`);

    // 1. Tell gateway to show "typing..." presence
    await fetch(`${WHATSAPP_GATEWAY_URL}/api/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: sender, presence: 'composing' })
    }).catch(() => null);

    // 2. Simulate 3-second LLM tool execution
    setTimeout(async () => {
      // 3. Stop typing presence
      await fetch(`${WHATSAPP_GATEWAY_URL}/api/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: sender, presence: 'paused' })
      }).catch(() => null);

      // 4. Send asynchronous reply via POST /api/send
      const sendRes = await fetch(`${WHATSAPP_GATEWAY_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: sender,
          message: `🧠 [Hermes AI Reasoning Complete]\nI analyzed your query: "${message}". All systems operational!`
        })
      });
      const data = await sendRes.json();
      console.log(`✅ [Hermes] Asynchronous reply sent to ${sender}:`, data);
    }, 3000);

    return;
  }

  // Decision: Ignore message (no reply needed)
  console.log(`🔇 [Hermes] Decided not to reply to message "${message}"`);
  res.json({ reply: null, ignored: true });
});

app.listen(PORT, () => {
  console.log(`🤖 Demo Hermes Agent server running on http://127.0.0.1:${PORT}`);
  console.log(`📡 Listening for webhooks from WhatsApp Agent at http://127.0.0.1:${PORT}/api/webhook\n`);
});
