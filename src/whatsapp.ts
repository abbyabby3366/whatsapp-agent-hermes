import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  normalizeMessageContent,
  getContentType,
  downloadMediaMessage,
  jidNormalizedUser,
  isJidGroup,
  isLidUser,
  type WASocket,
  type ConnectionState,
  type WAMessage,
  type WAMessageContent,
  type proto
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { config, loadSettings, saveSettings, type RuntimeSettings } from './config.js';
import { postToHermes } from './hermes.js';

export type WebhookStatus =
  | 'forwarded' // delivery to Hermes in progress
  | 'processing' // Hermes acknowledged and will reply later through /api/send
  | 'replied'
  | 'ignored' // Hermes chose not to reply
  | 'failed'
  | 'disabled' // no HERMES_WEBHOOK_URL configured
  | 'paused' // forwarding switched off from the dashboard
  | 'filtered'; // blocked by ALLOWED_NUMBERS / FORWARD_GROUPS

export interface RecentMessage {
  id: string;
  sender: string;
  senderName?: string;
  recipient: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  isGroup: boolean;
  messageType?: string;
  webhookStatus?: WebhookStatus;
  webhookError?: string;
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
    forwardingEnabled: boolean;
    forwardGroups: boolean;
    allowedNumbersCount: number;
  };
  timezone: string;
}

export type SendResult =
  | { success: true; messageId?: string }
  | { success: false; error: string; code: 400 | 404 | 502 | 503 };

export const PRESENCE_VALUES = ['composing', 'paused', 'recording', 'available', 'unavailable'] as const;
export type PresenceValue = (typeof PRESENCE_VALUES)[number];

interface ParsedContent {
  type: string;
  text: string;
  hasMedia: boolean;
  mimetype?: string;
  contextInfo?: proto.IContextInfo | null;
}

/** Message kinds that are protocol noise rather than something a person wrote. */
const IGNORED_CONTENT_TYPES = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'encReactionMessage',
  'messageContextInfo'
]);

const MAX_CACHED_MESSAGES = 300;

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private starting = false;
  private sessionDir: string;
  private status: WhatsAppConnectionStatus = 'disconnected';
  private qrCodeDataUrl: string | null = null;
  private user: { id: string; name?: string } | null = null;
  private lastConnectedAt: string | null = null;
  private lastError: string | null = null;
  private recentMessages: RecentMessage[] = [];
  private processedMessageIds = new Set<string>();
  /** Raw messages kept so replies can quote them and media can be downloaded on request. */
  private rawMessages = new Map<string, WAMessage>();
  private settings: RuntimeSettings = loadSettings();

  private stats = {
    receivedCount: 0,
    forwardedToHermesCount: 0,
    hermesRepliesCount: 0,
    sentCount: 0
  };

  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private registered = false;
  private shuttingDown = false;
  private logger = pino({ level: 'warn' });

  constructor(sessionDir: string = './sessions') {
    this.sessionDir = path.resolve(sessionDir);
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  private formatDateTime(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
      .format(date)
      .replace(/\//g, '-')
      .replace(',', '');
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  public async start(): Promise<void> {
    if (this.sock || this.starting || this.shuttingDown) {
      return;
    }
    this.starting = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.status = 'connecting';
    this.lastError = null;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      this.registered = Boolean(state.creds.registered);
      let version: [number, number, number] | undefined;

      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
      } catch (err: unknown) {
        console.warn('Could not fetch latest Baileys version; using default Baileys version.', err);
      }

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger)
        },
        browser: Browsers.macOS('Desktop App'),
        logger: this.logger,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60_000
      });
      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
        // Ignore late events from a socket we have already replaced or torn down.
        if (this.sock !== sock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
            this.status = 'qr_ready';
          } catch (qrErr: unknown) {
            console.error('Failed to generate QR data URL:', qrErr);
          }
        }

        if (connection === 'open') {
          this.status = 'connected';
          this.qrCodeDataUrl = null;
          this.reconnectAttempts = 0;
          this.registered = true;
          this.lastError = null;
          this.lastConnectedAt = this.formatDateTime();
          this.user = {
            id: sock.user?.id || 'Connected Account',
            name: sock.user?.name || undefined
          };
          console.log(`[WhatsApp] Connected successfully as ${this.user.id}`);
        } else if (connection === 'close') {
          await this.handleClose(lastDisconnect?.error);
        }
      });

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;

        // Do not await: a slow Hermes webhook must never hold up the WhatsApp event loop.
        for (const msg of messages) {
          this.handleIncomingMessage(msg).catch((err: unknown) => {
            console.error('[WhatsApp] Failed to process incoming message:', err);
          });
        }
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.status = 'disconnected';
      this.lastError = errMsg;
      console.error('[WhatsApp] Initialization error:', errMsg);
    } finally {
      this.starting = false;
    }
  }

  private async handleClose(error: unknown): Promise<void> {
    const statusCode = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    const replaced = statusCode === DisconnectReason.connectionReplaced;
    const needsRestart = statusCode === DisconnectReason.restartRequired;

    console.log(`[WhatsApp] Connection closed (code ${statusCode}).`);
    this.cleanupSocket();
    this.qrCodeDataUrl = null;

    if (this.shuttingDown) return;

    if (loggedOut) {
      this.status = 'disconnected';
      this.lastError = 'Logged out from WhatsApp. Please scan the QR code again.';
      this.user = null;
      this.registered = false;
      await this.clearSavedSession();
      return;
    }

    if (replaced) {
      this.status = 'disconnected';
      this.lastError = 'This WhatsApp session was opened somewhere else. Press "Reconnect" to take it back.';
      return;
    }

    // WhatsApp asks for an immediate restart right after a QR scan; that is not a failure.
    if (needsRestart) {
      this.status = 'connecting';
      this.scheduleReconnect(500);
      return;
    }

    // A linked account keeps retrying (with a capped back-off) so an unattended server heals itself.
    // An account that was never paired gives up after a few QR cycles instead of looping forever.
    if (this.registered || this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(this.reconnectAttempts * 3000, 60_000);
      console.log(`[WhatsApp] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
      this.status = 'connecting';
      this.scheduleReconnect(delay);
    } else {
      this.status = 'disconnected';
      this.lastError = 'The QR code expired before it was scanned. Press "Reconnect" to get a new one.';
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.start();
    }, delayMs);
  }

  /** Drops the socket without unlinking the device, so the session survives a restart. */
  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanupSocket();
  }

  public async logout(): Promise<{ success: boolean; message: string }> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      const sock = this.sock;
      if (sock) {
        // Detach first so the "logged out" close event is ignored (no error banner, no reconnect),
        // but keep the socket open long enough to tell WhatsApp to unlink this device.
        this.sock = null;
        try {
          await sock.logout();
        } catch {
          // The server may already have dropped the link; we still wipe local credentials below.
        }
        this.disposeSocket(sock);
      }
      await this.clearSavedSession();
      this.status = 'disconnected';
      this.user = null;
      this.registered = false;
      this.qrCodeDataUrl = null;
      this.lastError = null;
      this.reconnectAttempts = 0;
      return { success: true, message: 'Logged out and session cleared successfully' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to logout: ${errMsg}` };
    }
  }

  private cleanupSocket(): void {
    const sock = this.sock;
    this.sock = null;
    if (sock) this.disposeSocket(sock);
  }

  private disposeSocket(sock: WASocket): void {
    try {
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ws.removeAllListeners();
      sock.end(undefined);
    } catch {
      // Socket was already closed.
    }
  }

  private async clearSavedSession(): Promise<void> {
    try {
      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
      }
      fs.mkdirSync(this.sessionDir, { recursive: true });
    } catch (err: unknown) {
      console.error('Error clearing session dir:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Incoming messages -> Hermes
  // ---------------------------------------------------------------------------

  private parseContent(message: WAMessageContent | null | undefined): ParsedContent | null {
    const content = normalizeMessageContent(message);
    if (!content) return null;
    const kind = getContentType(content);
    if (!kind || IGNORED_CONTENT_TYPES.has(kind)) return null;

    const part = content[kind] as
      | {
          caption?: string | null;
          text?: string | null;
          mimetype?: string | null;
          ptt?: boolean | null;
          contextInfo?: proto.IContextInfo | null;
          name?: string | null;
          displayName?: string | null;
          degreesLatitude?: number | null;
          degreesLongitude?: number | null;
          selectedDisplayText?: string | null;
          title?: string | null;
          singleSelectReply?: { selectedRowId?: string | null } | null;
        }
      | string
      | null
      | undefined;
    const p = typeof part === 'object' && part ? part : {};
    const contextInfo = p.contextInfo ?? null;

    switch (kind) {
      case 'conversation':
        return { type: 'text', text: String(part ?? ''), hasMedia: false };
      case 'extendedTextMessage':
        return { type: 'text', text: p.text ?? '', hasMedia: false, contextInfo };
      case 'imageMessage':
        return { type: 'image', text: p.caption || '[Image]', hasMedia: true, mimetype: p.mimetype ?? undefined, contextInfo };
      case 'videoMessage':
        return { type: 'video', text: p.caption || '[Video]', hasMedia: true, mimetype: p.mimetype ?? undefined, contextInfo };
      case 'audioMessage':
        return {
          type: p.ptt ? 'voice' : 'audio',
          text: p.ptt ? '[Voice message]' : '[Audio]',
          hasMedia: true,
          mimetype: p.mimetype ?? undefined,
          contextInfo
        };
      case 'documentMessage':
      case 'documentWithCaptionMessage':
        return { type: 'document', text: p.caption || `[Document${p.title ? `: ${p.title}` : ''}]`, hasMedia: true, mimetype: p.mimetype ?? undefined, contextInfo };
      case 'stickerMessage':
        return { type: 'sticker', text: '[Sticker]', hasMedia: true, mimetype: p.mimetype ?? undefined, contextInfo };
      case 'locationMessage':
      case 'liveLocationMessage':
        return {
          type: 'location',
          text: `[Location] ${p.degreesLatitude ?? '?'}, ${p.degreesLongitude ?? '?'}${p.name ? ` (${p.name})` : ''}`,
          hasMedia: false,
          contextInfo
        };
      case 'contactMessage':
        return { type: 'contact', text: `[Contact] ${p.displayName ?? ''}`.trim(), hasMedia: false, contextInfo };
      case 'contactsArrayMessage':
        return { type: 'contact', text: '[Contacts]', hasMedia: false, contextInfo };
      case 'buttonsResponseMessage':
      case 'templateButtonReplyMessage':
      case 'listResponseMessage':
        return {
          type: 'text',
          text: p.selectedDisplayText || p.title || p.singleSelectReply?.selectedRowId || '[Selection]',
          hasMedia: false,
          contextInfo
        };
      default:
        return { type: 'other', text: `[${kind.replace(/Message$/, '')}]`, hasMedia: false, contextInfo };
    }
  }

  private cacheRawMessage(id: string, msg: WAMessage): void {
    this.rawMessages.set(id, msg);
    if (this.rawMessages.size > MAX_CACHED_MESSAGES) {
      const oldest = this.rawMessages.keys().next().value;
      if (oldest) this.rawMessages.delete(oldest);
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
    const chatJid = msg.key.remoteJid || '';

    // Ignore status broadcasts, newsletters/channels and our own messages.
    if (!chatJid || chatJid.includes('@broadcast') || chatJid.endsWith('@newsletter') || fromMe) {
      return;
    }

    const parsed = this.parseContent(msg.message);
    if (!parsed) return;

    const isGroup = Boolean(isJidGroup(chatJid));
    const senderJid = (isGroup ? msg.key.participant : chatJid) || chatJid;
    const senderAlt = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt;

    // WhatsApp now addresses many people by an opaque "LID" instead of their phone number.
    // Only report a phone number when we actually know it; replies always go to chatJid.
    const phoneJid = isLidUser(senderJid) ? senderAlt : senderJid;
    const phone = phoneJid ? phoneJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || null : null;
    const senderId = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    const me = new Set(
      [this.sock?.user?.id, this.sock?.user?.lid].filter((v): v is string => Boolean(v)).map(jidNormalizedUser)
    );
    const ctx = parsed.contextInfo;
    const mentionsMe = (ctx?.mentionedJid ?? []).some((j) => me.has(jidNormalizedUser(j)));
    const isReplyToMe = Boolean(ctx?.participant && me.has(jidNormalizedUser(ctx.participant)));
    const quotedContent = this.parseContent(ctx?.quotedMessage);

    const tsSeconds = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
    const eventDate = new Date(tsSeconds * 1000);
    const id = msgId || `msg-${Date.now()}`;

    const record: RecentMessage = {
      id,
      sender: phone || senderId,
      senderName: msg.pushName || undefined,
      recipient: 'Hermes Agent',
      content: parsed.text,
      timestamp: this.formatDateTime(eventDate),
      fromMe: false,
      isGroup,
      messageType: parsed.type,
      webhookStatus: 'disabled'
    };

    this.stats.receivedCount++;
    this.cacheRawMessage(id, msg);
    this.addRecentMessage(record);

    if (!config.webhookUrl) return;
    if (!this.settings.forwardingEnabled) {
      record.webhookStatus = 'paused';
      return;
    }
    if (
      (isGroup && !config.forwardGroups) ||
      (config.allowedNumbers.length > 0 &&
        !config.allowedNumbers.some((n) => n === phone || n === senderId))
    ) {
      record.webhookStatus = 'filtered';
      return;
    }

    record.webhookStatus = 'forwarded';

    const payload = {
      event: 'message.received',
      messageId: id,
      /** Phone number in digits, or null when WhatsApp only exposed an anonymous ID (LID). */
      sender: phone,
      senderName: record.senderName ?? null,
      senderJid,
      /** Where to send replies. Always use this (or the sender's phone) as "to" in POST /api/send. */
      chatJid,
      remoteJid: chatJid,
      isGroup,
      groupJid: isGroup ? chatJid : null,
      message: parsed.text,
      messageType: parsed.type,
      hasMedia: parsed.hasMedia,
      mimetype: parsed.mimetype ?? null,
      mentionsMe,
      isReplyToMe,
      quoted: ctx?.stanzaId ? { messageId: ctx.stanzaId, message: quotedContent?.text ?? null } : null,
      timestamp: record.timestamp,
      timezone: config.timezone,
      isoTimestamp: eventDate.toISOString(),
      rawTimestamp: tsSeconds
    };

    try {
      const result = await postToHermes(payload);

      if (!result.ok) {
        record.webhookStatus = 'failed';
        record.webhookError = `Hermes answered HTTP ${result.status}`;
        console.warn(`[Webhook] Hermes returned HTTP ${result.status} for message ${id}`);
        return;
      }

      this.stats.forwardedToHermesCount++;
      const reply = typeof result.json?.reply === 'string' ? result.json.reply.trim() : '';

      if (reply) {
        record.webhookStatus = 'replied';
        record.hermesReply = reply;
        const quote = typeof result.json?.quote === 'boolean' ? result.json.quote : isGroup;
        const sent = await this.sendMessage(chatJid, reply, { quotedMessageId: quote ? id : undefined, source: 'hermes' });
        if (sent.success) {
          this.stats.hermesRepliesCount++;
        } else {
          record.webhookStatus = 'failed';
          record.webhookError = `Reply could not be sent: ${sent.error}`;
        }
      } else {
        record.webhookStatus = result.json?.status === 'processing' ? 'processing' : 'ignored';
      }
    } catch (err: unknown) {
      record.webhookStatus = 'failed';
      record.webhookError = err instanceof Error ? err.message : String(err);
      console.error(`[Webhook] Could not reach Hermes at ${config.webhookUrl}: ${record.webhookError}`);
    }
  }

  private addRecentMessage(message: RecentMessage): void {
    this.recentMessages.unshift(message);
    if (this.recentMessages.length > 50) {
      this.recentMessages.pop();
    }
  }

  // ---------------------------------------------------------------------------
  // Outgoing actions (used by the dashboard and by Hermes)
  // ---------------------------------------------------------------------------

  /** Turns a phone number or JID into a JID. Returns null when it cannot be a valid recipient. */
  public resolveJid(recipient: string): string | null {
    const trimmed = recipient.trim();
    if (trimmed.includes('@')) {
      return /^[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/i.test(trimmed) ? trimmed.toLowerCase() : null;
    }
    let digits = trimmed.replace(/[^0-9]/g, '');
    if (digits.startsWith('0') && config.defaultCountryCode) {
      digits = config.defaultCountryCode + digits.substring(1);
    }
    return digits.length >= 8 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : null;
  }

  public async setPresence(recipient: string, presence: PresenceValue): Promise<boolean> {
    if (!this.sock || this.status !== 'connected') {
      return false;
    }
    const jid = this.resolveJid(recipient);
    if (!jid) return false;
    try {
      await this.sock.sendPresenceUpdate(presence, jid);
      return true;
    } catch (err: unknown) {
      console.warn(`[Presence] Failed to set presence ${presence} for ${recipient}:`, err);
      return false;
    }
  }

  public async markRead(messageId: string): Promise<boolean> {
    const msg = this.rawMessages.get(messageId);
    if (!this.sock || this.status !== 'connected' || !msg) return false;
    try {
      await this.sock.readMessages([msg.key]);
      return true;
    } catch (err: unknown) {
      console.warn(`[Read] Failed to mark ${messageId} as read:`, err);
      return false;
    }
  }

  public async sendMessage(
    recipient: string,
    messageText: string,
    opts: { quotedMessageId?: string; source?: 'hermes' | 'api' } = {}
  ): Promise<SendResult> {
    if (!this.sock || this.status !== 'connected') {
      return { success: false, code: 503, error: 'WhatsApp is not connected yet. Scan the QR code or press Reconnect first.' };
    }

    if (!recipient?.trim() || !messageText?.trim()) {
      return { success: false, code: 400, error: 'Recipient and message text are required' };
    }

    let jid = this.resolveJid(recipient);
    if (!jid) {
      return {
        success: false,
        code: 400,
        error: 'Invalid recipient. Use a phone number with country code (e.g. 60123456789) or a WhatsApp ID.'
      };
    }

    // For plain phone numbers, confirm the number is on WhatsApp so we can give a clear error.
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const [match] = (await this.sock.onWhatsApp(jid)) ?? [];
        if (match && !match.exists) {
          return { success: false, code: 404, error: `${jid.split('@')[0]} is not registered on WhatsApp` };
        }
        if (match?.exists && match.jid) jid = match.jid;
      } catch {
        // Lookup is best effort; try sending anyway.
      }
    }

    const isGroup = jid.endsWith('@g.us');
    const displayRecipient = isGroup ? `${jid.split('@')[0]} (Group)` : jid.split('@')[0];
    const quoted = opts.quotedMessageId ? this.rawMessages.get(opts.quotedMessageId) : undefined;

    try {
      const result = await this.sock.sendMessage(jid, { text: messageText }, quoted ? { quoted } : undefined);
      const messageId = result?.key?.id ?? undefined;

      this.stats.sentCount++;
      this.addRecentMessage({
        id: messageId || `sent-${Date.now()}`,
        sender: opts.source === 'hermes' ? 'Hermes Agent' : 'Dashboard / API',
        recipient: displayRecipient,
        content: messageText,
        timestamp: this.formatDateTime(),
        fromMe: true,
        isGroup
      });

      return { success: true, messageId };
    } catch (err: unknown) {
      return { success: false, code: 502, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Downloads the media of a recently received message (the last few hundred are kept in memory). */
  public async downloadMedia(
    messageId: string
  ): Promise<{ success: true; buffer: Buffer; mimetype: string } | { success: false; error: string; code: number }> {
    const msg = this.rawMessages.get(messageId);
    if (!msg) {
      return { success: false, code: 404, error: 'Message not found. Only the most recent messages are kept.' };
    }
    if (!this.sock || this.status !== 'connected') {
      return { success: false, code: 503, error: 'WhatsApp is not connected' };
    }
    const parsed = this.parseContent(msg.message);
    if (!parsed?.hasMedia) {
      return { success: false, code: 400, error: 'This message has no downloadable media' };
    }
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: this.logger, reuploadRequest: this.sock.updateMediaMessage }
      );
      return { success: true, buffer, mimetype: parsed.mimetype || 'application/octet-stream' };
    } catch (err: unknown) {
      return { success: false, code: 502, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  public setForwardingEnabled(enabled: boolean): void {
    this.settings = { ...this.settings, forwardingEnabled: enabled };
    saveSettings(this.settings);
  }

  public getState(): WhatsAppClientState {
    return {
      status: this.status,
      qrCodeDataUrl: this.qrCodeDataUrl,
      user: this.user,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      recentMessages: this.recentMessages.map((m) => ({ ...m })),
      stats: { ...this.stats },
      webhookConfig: {
        url: config.webhookUrl || null,
        hasSecret: Boolean(config.webhookToken),
        forwardingEnabled: this.settings.forwardingEnabled,
        forwardGroups: config.forwardGroups,
        allowedNumbersCount: config.allowedNumbers.length
      },
      timezone: config.timezone
    };
  }
}

export const waClient = new WhatsAppClient(config.sessionsDir);
