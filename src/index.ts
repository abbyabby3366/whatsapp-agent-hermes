import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { waClient } from './whatsapp.js';

const app = express();
const port = parseInt(process.env.PORT || '3001', 10);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Status endpoint
app.get('/api/status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: waClient.getState()
  });
});

// Send message endpoint (for Hermes Agent or manual blast)
app.post('/api/send', async (req: Request, res: Response) => {
  const { to, message } = req.body;
  if (!to || !message) {
    res.status(400).json({
      success: false,
      error: 'Missing "to" (phone number/JID) or "message" text in request body'
    });
    return;
  }

  const result = await waClient.sendMessage(String(to), String(message));
  if (!result.success) {
    res.status(500).json({
      success: false,
      error: result.error
    });
    return;
  }

  res.json({
    success: true,
    messageId: result.messageId,
    timestamp: new Date().toISOString()
  });
});

// Set presence endpoint (e.g. typing indicator)
app.post('/api/presence', async (req: Request, res: Response) => {
  const { recipient, presence } = req.body;
  if (!recipient || !presence) {
    res.status(400).json({ success: false, error: 'Recipient and presence ("composing" | "paused") are required' });
    return;
  }

  const ok = await waClient.setPresence(String(recipient), presence);
  res.json({ success: ok });
});

// Test webhook connection to Hermes
app.post('/api/webhook/test', async (_req: Request, res: Response) => {
  const webhookUrl = process.env.HERMES_WEBHOOK_URL;
  if (!webhookUrl) {
    res.status(400).json({ success: false, error: 'HERMES_WEBHOOK_URL is not configured in .env' });
    return;
  }

  const testPayload = {
    event: 'test.ping',
    messageId: `test-${Date.now()}`,
    sender: '60120000000',
    senderName: 'Test Contact',
    senderJid: '60120000000@s.whatsapp.net',
    isGroup: false,
    message: 'Ping from WhatsApp Agent Hermes gateway',
    timestamp: new Date().toISOString()
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const start = Date.now();
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hermes-token': process.env.HERMES_SECRET_TOKEN || ''
      },
      body: JSON.stringify(testPayload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - start;
    const body = await response.text();

    res.json({
      success: response.ok,
      status: response.status,
      latencyMs,
      responseBody: body.slice(0, 500)
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(502).json({
      success: false,
      error: `Could not reach Hermes at ${webhookUrl}: ${errMsg}`
    });
  }
});

// Trigger connection
app.post('/api/connect', async (_req: Request, res: Response) => {
  await waClient.start();
  res.json({ success: true, message: 'WhatsApp connection initiated' });
});

// Logout endpoint
app.post('/api/logout', async (_req: Request, res: Response) => {
  const result = await waClient.logout();
  if (!result.success) {
    res.status(500).json({ success: false, error: result.message });
    return;
  }
  res.json({ success: true, message: result.message });
});

// Interactive Dashboard
app.get('/', (_req: Request, res: Response) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Agent Hermes</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(23, 30, 47, 0.8);
      --card-border: rgba(255, 255, 255, 0.08);
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --accent: #25D366;
      --accent-hover: #1eb956;
      --hermes: #8b5cf6;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --warning: #f59e0b;
      --info: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(circle at 10% 20%, rgba(37, 211, 102, 0.07) 0%, transparent 40%),
                  radial-gradient(circle at 90% 80%, rgba(139, 92, 246, 0.07) 0%, transparent 40%),
                  var(--bg);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
    }
    .container { width: 100%; max-width: 960px; display: flex; flex-direction: column; gap: 1.25rem; }
    header {
      display: flex; justify-content: space-between; align-items: center;
      background: var(--card-bg); border: 1px solid var(--card-border);
      backdrop-filter: blur(12px); padding: 1.25rem 1.5rem; border-radius: 1rem;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .logo-area { display: flex; align-items: center; gap: 0.75rem; }
    .logo-badge {
      width: 44px; height: 44px; background: rgba(37, 211, 102, 0.15);
      color: var(--accent); border: 1px solid rgba(37, 211, 102, 0.3);
      border-radius: 12px; display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 1.25rem;
    }
    .title h1 { font-size: 1.25rem; font-weight: 700; }
    .title p { font-size: 0.8rem; color: var(--text-muted); }
    .badge {
      padding: 0.4rem 0.85rem; border-radius: 9999px; font-size: 0.75rem;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
      display: inline-flex; align-items: center; gap: 0.4rem;
    }
    .badge-connected { background: rgba(37, 211, 102, 0.15); color: #4ade80; border: 1px solid rgba(74, 222, 128, 0.3); }
    .badge-connecting { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
    .badge-qr_ready { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(96, 165, 250, 0.3); }
    .badge-disconnected { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background-color: currentColor; box-shadow: 0 0 8px currentColor; }

    .stats-row {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem;
    }
    @media (max-width: 640px) { .stats-row { grid-template-columns: repeat(2, 1fr); } }
    .stat-card {
      background: var(--card-bg); border: 1px solid var(--card-border);
      padding: 1rem; border-radius: 0.75rem; text-align: center;
    }
    .stat-num { font-size: 1.4rem; font-weight: 700; color: var(--accent); }
    .stat-label { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem; }

    .grid-panels { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
    @media (max-width: 768px) { .grid-panels { grid-template-columns: 1fr; } }
    .panel {
      background: var(--card-bg); border: 1px solid var(--card-border);
      backdrop-filter: blur(12px); padding: 1.25rem; border-radius: 1rem;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2); display: flex; flex-direction: column; gap: 0.85rem;
    }
    .panel h2 { font-size: 1.05rem; font-weight: 600; color: #e2e8f0; }

    .qr-container {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-height: 230px; background: rgba(15, 23, 42, 0.6); border-radius: 0.75rem;
      border: 1px dashed rgba(255, 255, 255, 0.1); padding: 1rem; text-align: center;
    }
    .qr-image { max-width: 200px; border-radius: 0.5rem; background: white; padding: 6px; }

    .webhook-box {
      background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 0.5rem; padding: 0.75rem; font-size: 0.8rem; word-break: break-all;
    }

    .form-group { display: flex; flex-direction: column; gap: 0.35rem; }
    label { font-size: 0.75rem; font-weight: 500; color: var(--text-muted); }
    input, textarea {
      background: rgba(15, 23, 42, 0.8); border: 1px solid var(--card-border);
      color: var(--text-main); padding: 0.7rem; border-radius: 0.5rem;
      font-family: inherit; font-size: 0.85rem; outline: none;
    }
    input:focus, textarea:focus { border-color: var(--accent); }

    .btn {
      cursor: pointer; font-family: inherit; font-weight: 600; font-size: 0.85rem;
      padding: 0.65rem 1.1rem; border-radius: 0.5rem; border: none;
      transition: all 0.2s ease; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
    }
    .btn-primary { background: var(--accent); color: #0b0f19; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-hermes { background: rgba(139, 92, 246, 0.2); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.4); }
    .btn-hermes:hover { background: var(--hermes); color: white; }
    .btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: var(--danger); color: white; }
    .btn-secondary { background: rgba(255, 255, 255, 0.08); color: var(--text-main); }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.15); }

    .alert { padding: 0.75rem 1rem; border-radius: 0.5rem; font-size: 0.85rem; display: none; }
    .alert-error { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
    .alert-success { background: rgba(37, 211, 102, 0.15); color: #86efac; border: 1px solid rgba(37, 211, 102, 0.3); }

    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th, td { padding: 0.7rem 0.9rem; text-align: left; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
    th { color: var(--text-muted); font-weight: 600; font-size: 0.7rem; text-transform: uppercase; }
    .time-cell { display: flex; flex-direction: column; }
    .primary-time { font-weight: 500; color: var(--text-main); }
    .secondary-time { font-size: 0.75rem; color: var(--text-muted); }

    .status-tag { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
    .tag-replied { background: rgba(37, 211, 102, 0.2); color: #4ade80; }
    .tag-forwarded { background: rgba(139, 92, 246, 0.2); color: #c4b5fd; }
    .tag-outbound { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
    .tag-ignored { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
    .tag-failed { background: rgba(239, 68, 68, 0.2); color: #f87171; }

    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px); display: none; align-items: center; justify-content: center; z-index: 100; padding: 1rem;
    }
    .modal-content {
      background: #171e2f; border: 1px solid var(--card-border);
      border-radius: 1rem; max-width: 440px; width: 100%; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem;
    }
    .modal-actions { display: flex; justify-content: flex-end; gap: 0.75rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-area">
        <div class="logo-badge">W</div>
        <div class="title">
          <h1>WhatsApp Agent (Hermes)</h1>
          <p>Autonomous WhatsApp Bridge &bull; Powered by Baileys</p>
        </div>
      </div>
      <div id="statusBadge" class="badge badge-disconnected">
        <span class="pulse"></span>
        <span id="statusText">Checking...</span>
      </div>
    </header>

    <div id="globalAlert" class="alert"></div>

    <!-- Stats Row -->
    <div class="stats-row">
      <div class="stat-card">
        <div id="statReceived" class="stat-num">0</div>
        <div class="stat-label">Inbound Received</div>
      </div>
      <div class="stat-card">
        <div id="statForwarded" class="stat-num" style="color: var(--hermes);">0</div>
        <div class="stat-label">Forwarded to Hermes</div>
      </div>
      <div class="stat-card">
        <div id="statReplies" class="stat-num" style="color: #60a5fa;">0</div>
        <div class="stat-label">Hermes Auto-Replies</div>
      </div>
      <div class="stat-card">
        <div id="statSent" class="stat-num" style="color: #4ade80;">0</div>
        <div class="stat-label">Outbound Sent</div>
      </div>
    </div>

    <div class="grid-panels">
      <!-- Session Card -->
      <div class="panel">
        <h2>WhatsApp Session</h2>
        <div id="qrArea" class="qr-container">
          <p style="color: var(--text-muted);">Waiting for session status...</p>
        </div>
        <div id="sessionDetails" style="display: none; font-size: 0.85rem; line-height: 1.6;">
          <p><strong>Connected Account:</strong> <span id="accountUser" style="color: var(--accent);"></span></p>
          <div style="display: flex; flex-direction: column; margin-top: 0.4rem;">
            <span style="color: var(--text-muted); font-size: 0.75rem;">Connected Since:</span>
            <span id="connectedDate" class="primary-time"></span>
            <span id="connectedTime" class="secondary-time"></span>
          </div>
        </div>

        <!-- Webhook Info Box -->
        <div class="webhook-box">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem;">
            <strong>Hermes Webhook URL:</strong>
            <button class="btn btn-hermes" style="padding: 0.25rem 0.6rem; font-size: 0.7rem;" onclick="testWebhook()">Test Ping</button>
          </div>
          <span id="webhookUrlText" style="color: var(--text-muted); font-family: monospace;">Loading...</span>
        </div>

        <div style="display: flex; gap: 0.5rem; margin-top: auto;">
          <button id="connectBtn" class="btn btn-primary" style="flex: 1; display: none;" onclick="triggerConnect()">
            Start Connection
          </button>
          <button id="logoutBtn" class="btn btn-danger" style="flex: 1; display: none;" onclick="promptLogout()">
            Disconnect Session
          </button>
        </div>
      </div>

      <!-- Quick Message Test Form -->
      <div class="panel">
        <h2>Send WhatsApp Message</h2>
        <form id="sendForm" onsubmit="handleSend(event)" style="display: flex; flex-direction: column; gap: 0.8rem;">
          <div class="form-group">
            <label for="recipientInput">Recipient Phone Number (e.g. 60123456789)</label>
            <input type="text" id="recipientInput" placeholder="60123456789" required />
          </div>
          <div class="form-group">
            <label for="messageInput">Message Content</label>
            <textarea id="messageInput" rows="4" placeholder="Type your WhatsApp message..." required></textarea>
          </div>
          <button type="submit" id="sendBtn" class="btn btn-primary">
            Send Message
          </button>
        </form>
        <div id="sendFeedback" class="alert"></div>
      </div>
    </div>

    <!-- Recent Activity Table -->
    <div class="panel">
      <h2>Recent Messages & Webhook Activity</h2>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Contact / Sender</th>
              <th>Message</th>
              <th>Hermes Action</th>
              <th>Timestamp (GMT+8)</th>
            </tr>
          </thead>
          <tbody id="messagesTableBody">
            <tr>
              <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">
                No messages recorded yet
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Logout Confirmation Modal -->
  <div id="logoutModal" class="modal-overlay">
    <div class="modal-content">
      <h3 style="color: #f87171;">Confirm Disconnect</h3>
      <p style="color: var(--text-muted); font-size: 0.85rem;">
        Are you sure you want to disconnect this WhatsApp session? This will terminate the active session and remove stored credentials.
      </p>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeLogoutModal()">Cancel</button>
        <button class="btn btn-danger" onclick="executeLogout()">Confirm Disconnect</button>
      </div>
    </div>
  </div>

  <script>
    function showAlert(msg, isError = false) {
      const alert = document.getElementById('globalAlert');
      alert.textContent = msg;
      alert.className = 'alert ' + (isError ? 'alert-error' : 'alert-success');
      alert.style.display = 'block';
      setTimeout(() => { alert.style.display = 'none'; }, 6000);
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const json = await res.json();
        if (json.success && json.data) {
          renderState(json.data);
        }
      } catch (err) {
        console.error('Failed to poll status', err);
      }
    }

    function renderState(state) {
      const statusBadge = document.getElementById('statusBadge');
      const statusText = document.getElementById('statusText');
      const qrArea = document.getElementById('qrArea');
      const sessionDetails = document.getElementById('sessionDetails');
      const connectBtn = document.getElementById('connectBtn');
      const logoutBtn = document.getElementById('logoutBtn');

      statusBadge.className = 'badge badge-' + state.status;
      statusText.textContent = state.status.replace('_', ' ').toUpperCase();

      document.getElementById('statReceived').textContent = state.stats?.receivedCount || 0;
      document.getElementById('statForwarded').textContent = state.stats?.forwardedToHermesCount || 0;
      document.getElementById('statReplies').textContent = state.stats?.hermesRepliesCount || 0;
      document.getElementById('statSent').textContent = state.stats?.sentCount || 0;

      const webhookUrl = state.webhookConfig?.url || 'Not configured in .env';
      document.getElementById('webhookUrlText').textContent = webhookUrl;

      if (state.status === 'connected') {
        qrArea.style.display = 'none';
        sessionDetails.style.display = 'block';
        document.getElementById('accountUser').textContent = state.user?.id || 'Connected';
        
        if (state.lastConnectedAt) {
          const parts = state.lastConnectedAt.split(' ');
          document.getElementById('connectedDate').textContent = parts[0] || state.lastConnectedAt;
          document.getElementById('connectedTime').textContent = parts[1] || '';
        }
        connectBtn.style.display = 'none';
        logoutBtn.style.display = 'inline-flex';
      } else if (state.status === 'qr_ready' && state.qrCodeDataUrl) {
        sessionDetails.style.display = 'none';
        qrArea.style.display = 'flex';
        qrArea.innerHTML = '<img class="qr-image" src="' + state.qrCodeDataUrl + '" alt="WhatsApp QR Code" /><p style="margin-top:0.6rem; font-size:0.8rem; color:#94a3b8;">Scan this QR with WhatsApp Linked Devices</p>';
        connectBtn.style.display = 'none';
        logoutBtn.style.display = 'none';
      } else if (state.status === 'connecting') {
        sessionDetails.style.display = 'none';
        qrArea.style.display = 'flex';
        qrArea.innerHTML = '<p style="color: #fbbf24;">Connecting to WhatsApp...</p>';
        connectBtn.style.display = 'none';
        logoutBtn.style.display = 'none';
      } else {
        sessionDetails.style.display = 'none';
        qrArea.style.display = 'flex';
        qrArea.innerHTML = '<p style="color: #f87171;">Disconnected' + (state.lastError ? ': ' + state.lastError : '') + '</p>';
        connectBtn.style.display = 'inline-flex';
        logoutBtn.style.display = 'none';
      }

      // Render messages
      const tbody = document.getElementById('messagesTableBody');
      if (state.recentMessages && state.recentMessages.length > 0) {
        tbody.innerHTML = state.recentMessages.map(m => {
          const timeParts = m.timestamp.split(' ');
          const datePart = timeParts[0] || m.timestamp;
          const clockPart = timeParts[1] || '';

          let tagClass = 'tag-forwarded';
          let tagText = m.webhookStatus || 'inbound';
          if (m.fromMe) {
            tagClass = 'tag-outbound';
            tagText = 'Outbound';
          } else if (m.webhookStatus === 'replied') {
            tagClass = 'tag-replied';
            tagText = 'Replied';
          } else if (m.webhookStatus === 'ignored') {
            tagClass = 'tag-ignored';
            tagText = 'Ignored';
          } else if (m.webhookStatus === 'failed') {
            tagClass = 'tag-failed';
            tagText = 'Failed';
          }

          const actionDetails = m.hermesReply 
            ? '<span style="color: #4ade80;">Replied: "' + m.hermesReply.substring(0, 40) + '..."</span>'
            : (m.fromMe ? '<span style="color: var(--text-muted);">-</span>' : '<span style="color: var(--text-muted);">' + (m.webhookStatus || 'None') + '</span>');

          return '<tr>' +
            '<td><span class="status-tag ' + tagClass + '">' + tagText + '</span></td>' +
            '<td><strong>' + (m.senderName ? m.senderName + ' (' + m.sender + ')' : m.sender) + '</strong></td>' +
            '<td style="max-width:240px; word-break:break-word;">' + m.content + '</td>' +
            '<td style="max-width:200px; font-size:0.75rem;">' + actionDetails + '</td>' +
            '<td>' +
              '<div class="time-cell">' +
                '<span class="primary-time">' + datePart + '</span>' +
                '<span class="secondary-time">' + clockPart + '</span>' +
              '</div>' +
            '</td>' +
          '</tr>';
        }).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No messages recorded yet</td></tr>';
      }
    }

    async function testWebhook() {
      showAlert('Pinging Hermes webhook...');
      try {
        const res = await fetch('/api/webhook/test', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showAlert('Hermes Webhook OK! HTTP ' + json.status + ' (' + json.latencyMs + 'ms)');
        } else {
          showAlert('Webhook Error: ' + (json.error || 'HTTP ' + json.status), true);
        }
      } catch (err) {
        showAlert('Webhook test request failed: ' + err.message, true);
      }
    }

    async function handleSend(e) {
      e.preventDefault();
      const sendFeedback = document.getElementById('sendFeedback');
      const sendBtn = document.getElementById('sendBtn');
      const recipient = document.getElementById('recipientInput').value.trim();
      const message = document.getElementById('messageInput').value.trim();

      sendFeedback.style.display = 'none';
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';

      try {
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: recipient, message })
        });
        const data = await res.json();
        if (data.success) {
          sendFeedback.textContent = 'Message sent successfully! (ID: ' + data.messageId + ')';
          sendFeedback.className = 'alert alert-success';
          sendFeedback.style.display = 'block';
          document.getElementById('messageInput').value = '';
          fetchStatus();
        } else {
          sendFeedback.textContent = data.error || 'Failed to send message';
          sendFeedback.className = 'alert alert-error';
          sendFeedback.style.display = 'block';
        }
      } catch (err) {
        sendFeedback.textContent = 'Network error: ' + (err.message || 'Could not send message');
        sendFeedback.className = 'alert alert-error';
        sendFeedback.style.display = 'block';
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Message';
      }
    }

    async function triggerConnect() {
      try {
        await fetch('/api/connect', { method: 'POST' });
        fetchStatus();
      } catch (err) {
        showAlert('Failed to start connection: ' + err.message, true);
      }
    }

    function promptLogout() { document.getElementById('logoutModal').style.display = 'flex'; }
    function closeLogoutModal() { document.getElementById('logoutModal').style.display = 'none'; }

    async function executeLogout() {
      closeLogoutModal();
      try {
        const res = await fetch('/api/logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showAlert('Logged out successfully.');
          fetchStatus();
        } else {
          showAlert(data.error || 'Failed to logout', true);
        }
      } catch (err) {
        showAlert('Error logging out: ' + err.message, true);
      }
    }

    // Auto-poll status every 3 seconds (reactive status polling without manual refresh button)
    fetchStatus();
    setInterval(fetchStatus, 3000);
  </script>
</body>
</html>`);
});

app.listen(port, () => {
  console.log(`[WhatsApp Agent Hermes] Server listening on http://localhost:${port}`);
  console.log(`[WhatsApp Agent Hermes] Hermes Webhook URL: ${process.env.HERMES_WEBHOOK_URL || 'Not set'}`);
  waClient.start();
});
