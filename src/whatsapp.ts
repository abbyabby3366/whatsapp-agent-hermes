import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  type WASocket,
  type ConnectionState,
  type WAMessage
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

export interface RecentMessage {
  id: string;
  sender: string;
  senderName?: string;
  recipient: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  isGroup: boolean;
  webhookStatus?: 'forwarded' | 'replied' | 'ignored' | 'failed' | 'disabled';
  hermesReply?: string;
}

export type WhatsAppConnectionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

export interface WhatsAppClientState {
  status: WhatsAppConnectionStatus;
  qrCodeDataUrl: string | null;
  user: { id: string; name?: string } | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  recentMessages: RecentMessage[];
  stats: {
    receivedCount: number;
    forwardedToHermesCount: number;
    hermesRepliesCount: number;
    sentCount: number;
  };
  webhookConfig: {
    url: string | null;
    hasSecret: boolean;
  };
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private sessionDir: string;
  private status: WhatsAppConnectionStatus = 'disconnected';
  private qrCodeDataUrl: string | null = null;
  private user: { id: string; name?: string } | null = null;
  private lastConnectedAt: string | null = null;
  private lastError: string | null = null;
  private recentMessages: RecentMessage[] = [];
  private processedMessageIds = new Set<string>();

  private stats = {
    receivedCount: 0,
    forwardedToHermesCount: 0,
    hermesRepliesCount: 0,
    sentCount: 0
  };

  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(sessionDir: string = './sessions') {
    this.sessionDir = path.resolve(sessionDir);
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  private formatGmt8DateTime(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date).replace(/\//g, '-');
  }

  public async start(): Promise<void> {
    if (this.sock) {
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.status = 'connecting';
    this.lastError = null;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      let version: [number, number, number] | undefined;

      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
      } catch (err: unknown) {
        console.warn('Could not fetch latest Baileys version; using default Baileys version.', err);
      }

      const logger = pino({ level: 'warn' });

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: Browsers.macOS('Desktop App'),
        logger,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60_000,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
            this.status = 'qr_ready';
          } catch (qrErr: unknown) {
            console.error('Failed to generate QR data URL:', qrErr);
          }
        }

        if (connection === 'open') {
          this.status = 'connected';
          this.qrCodeDataUrl = null;
          this.reconnectAttempts = 0;
          this.lastConnectedAt = this.formatGmt8DateTime();
          this.user = {
            id: this.sock?.user?.id || 'Connected Account',
            name: this.sock?.user?.name || undefined
          };
          console.log(`[WhatsApp] Connected successfully as ${this.user.id}`);
        } else if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(`[WhatsApp] Connection closed (code ${statusCode}). Reconnect: ${shouldReconnect}`);
          this.cleanupSocket();

          if (shouldReconnect) {
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
              this.reconnectAttempts++;
              const delay = Math.min(this.reconnectAttempts * 3000, 15000);
              console.log(`[WhatsApp] Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
              this.status = 'connecting';
              this.reconnectTimeout = setTimeout(() => {
                this.start();
              }, delay);
            } else {
              this.status = 'disconnected';
              this.lastError = 'Max reconnect attempts reached. Please restart session manually.';
            }
          } else {
            this.status = 'disconnected';
            this.lastError = 'Logged out from WhatsApp. Please scan QR code again.';
            this.user = null;
            await this.clearSavedSession();
          }
        }
      });

      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          await this.handleIncomingMessage(msg);
        }
      });

    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.status = 'disconnected';
      this.lastError = errMsg;
      console.error('[WhatsApp] Initialization error:', errMsg);
    }
  }

  private async handleIncomingMessage(msg: WAMessage): Promise<void> {
    if (!msg.message) return;

    const msgId = msg.key.id;
    if (msgId && this.processedMessageIds.has(msgId)) {
      return;
    }
    if (msgId) {
      this.processedMessageIds.add(msgId);
      if (this.processedMessageIds.size > 2000) {
        const oldest = this.processedMessageIds.values().next().value;
        if (oldest) this.processedMessageIds.delete(oldest);
      }
    }

    const fromMe = Boolean(msg.key.fromMe);
    const remoteJid = msg.key.remoteJid || 'unknown';

    // Ignore WhatsApp status broadcasts and self messages
    if (remoteJid.includes('@broadcast') || fromMe) {
      return;
    }

    const isGroup = remoteJid.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || remoteJid) : remoteJid;
    const cleanSenderNumber = sender.replace(/[^0-9]/g, '');

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      (msg.message.documentMessage ? '[Document]' : '[Media Message]');

    const record: RecentMessage = {
      id: msgId || `msg-${Date.now()}`,
      sender: cleanSenderNumber,
      senderName: msg.pushName || undefined,
      recipient: 'Hermes Agent',
      content: text,
      timestamp: this.formatGmt8DateTime(),
      fromMe: false,
      isGroup,
      webhookStatus: 'disabled'
    };

    this.stats.receivedCount++;

    const webhookUrl = process.env.HERMES_WEBHOOK_URL;
    if (!webhookUrl) {
      this.addRecentMessage(record);
      return;
    }

    // Forward webhook to Hermes Agent
    record.webhookStatus = 'forwarded';
    this.stats.forwardedToHermesCount++;
    this.addRecentMessage(record);

    try {
      const timeoutMs = parseInt(process.env.HERMES_WEBHOOK_TIMEOUT_MS || '15000', 10);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const payload = {
        event: 'message.received',
        messageId: record.id,
        sender: cleanSenderNumber,
        senderName: record.senderName,
        senderJid: sender,
        remoteJid,
        isGroup,
        message: text,
        timestamp: record.timestamp,
        rawTimestamp: msg.messageTimestamp
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hermes-token': process.env.HERMES_SECRET_TOKEN || ''
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        record.webhookStatus = 'failed';
        console.warn(`[Webhook] Hermes returned HTTP ${response.status}: ${response.statusText}`);
        return;
      }

      interface HermesWebhookResponse {
        reply?: string | null;
        [key: string]: unknown;
      }
      const resData = (await response.json().catch(() => null)) as HermesWebhookResponse | null;

      // Check if Hermes decided to reply synchronously
      if (resData && typeof resData === 'object' && resData.reply && typeof resData.reply === 'string') {
        const replyText = resData.reply.trim();
        if (replyText.length > 0) {
          console.log(`[Webhook] Hermes triggered synchronous reply to ${cleanSenderNumber}`);
          record.webhookStatus = 'replied';
          record.hermesReply = replyText;
          this.stats.hermesRepliesCount++;
          await this.sendMessage(remoteJid, replyText);
        }
      } else {
        record.webhookStatus = 'ignored';
      }

    } catch (err: unknown) {
      record.webhookStatus = 'failed';
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Webhook] Error sending message to Hermes (${webhookUrl}):`, errMsg);
    }
  }

  private addRecentMessage(message: RecentMessage): void {
    this.recentMessages.unshift(message);
    if (this.recentMessages.length > 50) {
      this.recentMessages.pop();
    }
  }

  public async setPresence(recipient: string, presence: 'composing' | 'paused' | 'available' | 'unavailable'): Promise<boolean> {
    if (!this.sock || this.status !== 'connected') {
      return false;
    }
    const jid = this.resolveJid(recipient);
    try {
      await this.sock.sendPresenceUpdate(presence, jid);
      return true;
    } catch (err: unknown) {
      console.warn(`[Presence] Failed to set presence ${presence} for ${recipient}:`, err);
      return false;
    }
  }

  public resolveJid(recipient: string): string {
    if (recipient.endsWith('@s.whatsapp.net') || recipient.endsWith('@g.us')) {
      return recipient;
    }
    let clean = recipient.replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) {
      clean = '60' + clean.substring(1);
    }
    return `${clean}@s.whatsapp.net`;
  }

  public async sendMessage(recipient: string, messageText: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.sock || this.status !== 'connected') {
      return { success: false, error: 'WhatsApp client is not currently connected' };
    }

    if (!recipient || !messageText.trim()) {
      return { success: false, error: 'Recipient phone number and message text are required' };
    }

    const jid = this.resolveJid(recipient);
    const displayRecipient = jid.replace('@s.whatsapp.net', '').replace('@g.us', ' (Group)');

    try {
      const result = await this.sock.sendMessage(jid, { text: messageText });
      const messageId = result?.key?.id;

      this.stats.sentCount++;
      this.addRecentMessage({
        id: messageId || `sent-${Date.now()}`,
        sender: 'Hermes Agent',
        recipient: displayRecipient,
        content: messageText,
        timestamp: this.formatGmt8DateTime(),
        fromMe: true,
        isGroup: jid.endsWith('@g.us')
      });

      return { success: true, messageId };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errMsg };
    }
  }

  public async logout(): Promise<{ success: boolean; message: string }> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      if (this.sock) {
        try {
          await this.sock.logout();
        } catch (_) { }
        this.cleanupSocket();
      }
      await this.clearSavedSession();
      this.status = 'disconnected';
      this.user = null;
      this.qrCodeDataUrl = null;
      return { success: true, message: 'Logged out and session cleared successfully' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to logout: ${errMsg}` };
    }
  }

  private cleanupSocket(): void {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.ws.removeAllListeners();
        this.sock.end(undefined);
      } catch (_) { }
      this.sock = null;
    }
  }

  private async clearSavedSession(): Promise<void> {
    try {
      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
        fs.mkdirSync(this.sessionDir, { recursive: true });
      }
    } catch (err: unknown) {
      console.error('Error clearing session dir:', err);
    }
  }

  public getState(): WhatsAppClientState {
    return {
      status: this.status,
      qrCodeDataUrl: this.qrCodeDataUrl,
      user: this.user,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      recentMessages: [...this.recentMessages],
      stats: { ...this.stats },
      webhookConfig: {
        url: process.env.HERMES_WEBHOOK_URL || null,
        hasSecret: Boolean(process.env.HERMES_SECRET_TOKEN)
      }
    };
  }
}

export const waClient = new WhatsAppClient(process.env.SESSIONS_DIR || './sessions');
