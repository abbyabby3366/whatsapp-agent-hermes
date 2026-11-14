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
  isPnUser,
  S_WHATSAPP_NET,
  USyncQuery,
  USyncUser,
  USyncUsernameProtocol,
  WAMessageStatus,
  generateMessageIDV2,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  type BinaryNode,
  type Contact,
  type GroupMetadata,
  type GroupParticipant,
  type WAMessageUpdate,
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
import { config, formatDateTimeParts, loadSettings, saveSettings, type RuntimeSettings } from './config.js';
import { formatWhatsAppText } from './formatting.js';
import { postToHermes } from './hermes.js';
import { MediaResolutionError, resolveMediaInput } from './media.js';
import { inferDocumentMimetype } from './mime.js';
import { DebouncedJsonWriter } from './persistence.js';
import { prepareSticker } from './sticker.js';

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
  senderUsername?: string;
  recipient: string;
  content: string;
  timestamp: string;
  isoTimestamp: string;
  fromMe: boolean;
  isGroup: boolean;
  /** JID of the chat an inbound message came from (where a reply must go). */
  chatJid?: string;
  messageType?: string;
  hasMedia?: boolean;
  webhookStatus?: WebhookStatus;
  webhookError?: string;
  hermesReply?: string;
  /** Set on outbound messages that WhatsApp rejected after sending (e.g. Error 463 / 479). */
  deliveryError?: string;
}

export interface UsernameDirectoryEntry {
  /** Normalized lowercase WhatsApp username without leading "@". */
  username: string;
  /** Canonical WhatsApp JID resolved for this username (typically "...@lid" or "...@s.whatsapp.net"). */
  jid: string;
  /** Digits-only phone number if WhatsApp exposed it alongside the username. */
  phoneNumber?: string;
  /** Last observed contact/push name. */
  name?: string;
  /** ISO 8601 timestamp of when this mapping was recorded/refreshed. */
  updatedAt: string;
}

export type RecipientErrorCode = 400 | 403 | 404 | 413 | 429 | 502 | 503;

export type ResolveRecipientResult =
  | {
      success: true;
      jid: string;
      username?: string;
      displayRecipient: string;
      isGroup: boolean;
      source: 'jid' | 'phone' | 'cache' | 'usync';
    }
  | {
      success: false;
      code: RecipientErrorCode;
      error: string;
    };

export type WhatsAppConnectionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

export interface WhatsAppClientState {
  status: WhatsAppConnectionStatus;
  qrCodeDataUrl: string | null;
  user: { id: string; name?: string } | null;
  lastConnectedAt: string | null;
  lastConnectedIso: string | null;
  lastError: string | null;
  stateVersion: number;
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
  | { success: true; messageId?: string; jid?: string }
  | { success: false; error: string; code: RecipientErrorCode };

export const PRESENCE_VALUES = ['composing', 'paused', 'recording', 'available', 'unavailable'] as const;
export type PresenceValue = (typeof PRESENCE_VALUES)[number];

interface ParsedContent {
  type: string;
  text: string;
  hasMedia: boolean;
  mimetype?: string;
  fileName?: string;
  fileLength?: number;
  contextInfo?: proto.IContextInfo | null;
}

export { inferDocumentMimetype, formatWhatsAppText };

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
const MAX_RECENT_MESSAGES = 50;
const MAX_PROCESSED_MESSAGE_IDS = 2000;

/** How long to wait for WhatsApp's server <ack class="message"> before optimistically reporting success. */
const OUTBOUND_ACK_TIMEOUT_MS = 4000;
/** Upper bound for the reverse LID -> @username lookup done while processing an inbound 1:1 message. */
const LID_USERNAME_LOOKUP_TIMEOUT_MS = 2500;
/** Avoid re-querying WhatsApp for LIDs that recently returned no @username. */
const EMPTY_LID_USERNAME_TTL_MS = 6 * 3600_000;
/** TTL and capacity for cached onWhatsApp() verification results. */
const VERIFIED_PHONE_TTL_MS = 6 * 3600_000;
const MAX_VERIFIED_PHONE_CACHE = 2000;

interface PersistedActivity {
  stats: WhatsAppClientState['stats'];
  recentMessages: RecentMessage[];
  processedMessageIds: string[];
}

function readFileLength(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (raw && typeof raw === 'object' && 'toNumber' in raw && typeof (raw as { toNumber: unknown }).toNumber === 'function') {
    const val = (raw as { toNumber: () => number }).toNumber();
    return Number.isFinite(val) && val >= 0 ? val : undefined;
  }
  return undefined;
}

const digitsOfJid = (jid: string | null | undefined): string =>
  jid ? jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';

/** Decodes a <username> node body, which WhatsApp sends either as a string or as raw bytes. */
function readBinaryNodeText(node: BinaryNode | undefined): string | undefined {
  if (!node) return undefined;
  if (typeof node.content === 'string') return node.content;
  if (node.content instanceof Uint8Array) return Buffer.from(node.content).toString('utf8');
  const val = node.attrs?.val;
  return typeof val === 'string' ? val : undefined;
}

/** Maps a WhatsApp outbound-ack error code to a clear, actionable message. */
function describeOutboundAckError(code: string, targetLabel: string): string {
  if (code === '463') {
    return `WhatsApp Error 463 (cold outreach restriction) sending to ${targetLabel}: linked devices cannot start brand-new 1:1 chats without a privacy token (tctoken). Do NOT auto-retry; send the first message manually from the primary phone.`;
  }
  if (code === '479') {
    return `WhatsApp Error 479 (stanza rejected) sending to ${targetLabel}: the server refused the message, usually because of a stale device session or addressing. Do NOT auto-retry blindly.`;
  }
  return `WhatsApp rejected the message to ${targetLabel} (error ${code}).`;
}

type ParsedRecipientInput =
  | { kind: 'jid'; jid: string }
  | { kind: 'phone'; jid: string }
  | { kind: 'username'; username: string; pin?: string }
  | { kind: 'invalid'; error: string };

/**
 * Validates a normalized lowercase WhatsApp username (without leading "@").
 * WhatsApp usernames are 3-35 chars of lowercase letters, digits, periods, and underscores,
 * must contain at least one letter, and cannot start/end with "." or contain consecutive "..".
 */
export function isValidWhatsAppUsername(username: string): boolean {
  if (!/^[a-z0-9._]{3,35}$/.test(username)) return false;
  if (!/[a-z]/.test(username)) return false;
  if (username.startsWith('.') || username.endsWith('.') || username.includes('..')) return false;
  return true;
}

export function parseRecipientInput(recipient: string, explicitPin?: string): ParsedRecipientInput {
  const trimmed = recipient.trim();
  if (!trimmed) {
    return { kind: 'invalid', error: 'Recipient is required.' };
  }

  // 1. Explicit WhatsApp JID (... @s.whatsapp.net | @g.us | @lid)
  if (/^[^@\s]+@(s\.whatsapp\.net|g\.us|lid)$/i.test(trimmed)) {
    return { kind: 'jid', jid: trimmed.toLowerCase() };
  }

  // Reject invalid mid-string "@" domains (e.g. email addresses)
  if (trimmed.includes('@') && !trimmed.startsWith('@')) {
    return {
      kind: 'invalid',
      error: 'Invalid recipient. Use a phone number with country code (e.g. 60123456789), a @username (e.g. @alex_tan), or a WhatsApp ID.'
    };
  }

  // 2. @username (or bare handle containing letters), with optional "#1234" 4-digit PIN suffix
  if (trimmed.startsWith('@') || /[a-zA-Z]/.test(trimmed)) {
    const withoutAt = trimmed.replace(/^@+/, '');
    const hashIdx = withoutAt.indexOf('#');
    const handlePart = hashIdx === -1 ? withoutAt : withoutAt.slice(0, hashIdx);
    const inlinePin = hashIdx === -1 ? undefined : withoutAt.slice(hashIdx + 1).trim();
    const cleanExplicitPin = explicitPin?.trim() ? explicitPin.trim() : undefined;
    const pin = cleanExplicitPin ?? (inlinePin ? inlinePin : undefined);

    if (trimmed.startsWith('@') && /^\d+$/.test(handlePart)) {
      return {
        kind: 'invalid',
        error: 'WhatsApp @usernames must contain at least one letter. For phone numbers, omit "@" (e.g. 60123456789).'
      };
    }

    if (pin !== undefined && !/^\d{4}$/.test(pin)) {
      return {
        kind: 'invalid',
        error: 'WhatsApp username PIN must be exactly 4 digits (e.g. "1234" or "@username#1234").'
      };
    }

    const username = handlePart.toLowerCase();
    if (!isValidWhatsAppUsername(username)) {
      return {
        kind: 'invalid',
        error: 'Invalid WhatsApp @username. Usernames are 3-35 characters (letters, numbers, periods, underscores) and must include at least one letter.'
      };
    }

    return { kind: 'username', username, pin };
  }

  // 3. Phone number (digits, optional country prefix or leading 0)
  let digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.startsWith('0') && config.defaultCountryCode) {
    digits = config.defaultCountryCode + digits.substring(1);
  }
  if (digits.length >= 8 && digits.length <= 15) {
    return { kind: 'phone', jid: `${digits}@s.whatsapp.net` };
  }

  return {
    kind: 'invalid',
    error: 'Invalid recipient. Use a phone number with country code (e.g. 60123456789), a @username (e.g. @alex_tan), or a WhatsApp ID.'
  };
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private starting = false;
  private connectionEpoch = 0;
  private sessionDir: string;
  private dataDir: string;
  private usernamesFile: string;
  private activityFile: string;
  private usernamesWriter: DebouncedJsonWriter<Record<string, UsernameDirectoryEntry>>;
  private activityWriter: DebouncedJsonWriter<PersistedActivity>;
  private usernameDirectory = new Map<string, UsernameDirectoryEntry>();
  private jidToUsername = new Map<string, string>();
  private phoneToUsername = new Map<string, string>();
  /** Cached verified phone JIDs (`...@s.whatsapp.net`) -> expiry epoch ms. */
  private verifiedPhoneJids = new Map<string, { jid: string; expiresAt: number }>();
  /** LID JIDs whose reverse @username lookup returned nothing recently (jid -> epoch ms). */
  private emptyLidUsernameCache = new Map<string, number>();
  /** In-flight reverse lookups, so a burst of messages from one LID triggers a single query. */
  private pendingLidUsernameLookups = new Map<string, Promise<string | undefined>>();
  /** In-flight media downloads deduplicated by messageId. */
  private pendingMediaDownloads = new Map<
    string,
    Promise<{ success: true; buffer: Buffer; mimetype: string; fileName?: string } | { success: false; error: string; code: number }>
  >();
  /** Per-chat processing queues to keep inbound message delivery strictly ordered per chat. */
  private chatQueues = new Map<string, Promise<void>>();
  private activeWebhooks = 0;
  private webhookWaiters: Array<() => void> = [];
  /** Outbound Hermes reply id -> inbound message id it answered (to undo "replied" on a late rejection). */
  private hermesReplyLinks = new Map<string, string>();
  private status: WhatsAppConnectionStatus = 'disconnected';
  private qrCodeDataUrl: string | null = null;
  private user: { id: string; name?: string } | null = null;
  private lastConnectedAt: string | null = null;
  private lastConnectedIso: string | null = null;
  private lastError: string | null = null;
  private stateVersion = 0;
  private stateListeners = new Set<() => void>();
  private notifyQueued = false;
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

  private waVersion: [number, number, number] | undefined;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private registered = false;
  private shuttingDown = false;
  private logger = pino({ level: 'warn' });

  constructor(sessionDir: string = './sessions', dataDir: string = config.dataDir) {
    this.sessionDir = path.resolve(sessionDir);
    this.dataDir = path.resolve(dataDir);
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
    this.usernamesFile = path.resolve(this.dataDir, 'usernames.json');
    this.activityFile = path.resolve(this.dataDir, 'activity.json');
    this.usernamesWriter = new DebouncedJsonWriter(this.usernamesFile, 400, (err) => {
      console.error('[WhatsApp] Could not persist usernames directory:', err instanceof Error ? err.message : err);
    });
    this.activityWriter = new DebouncedJsonWriter(this.activityFile, 500, (err) => {
      console.error('[WhatsApp] Could not persist activity state:', err instanceof Error ? err.message : err);
    });
    this.loadUsernameDirectory();
    this.loadActivityState();
  }

  public onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private notifyStateChange(): void {
    this.stateVersion++;
    if (this.notifyQueued || this.stateListeners.size === 0) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of this.stateListeners) {
        try {
          listener();
        } catch {
          // Ignore subscriber errors.
        }
      }
    });
  }

  private loadActivityState(): void {
    if (!fs.existsSync(this.activityFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.activityFile, 'utf8')) as Partial<PersistedActivity>;
      if (raw.stats && typeof raw.stats === 'object') {
        if (typeof raw.stats.receivedCount === 'number') this.stats.receivedCount = raw.stats.receivedCount;
        if (typeof raw.stats.forwardedToHermesCount === 'number') {
          this.stats.forwardedToHermesCount = raw.stats.forwardedToHermesCount;
        }
        if (typeof raw.stats.hermesRepliesCount === 'number') {
          this.stats.hermesRepliesCount = raw.stats.hermesRepliesCount;
        }
        if (typeof raw.stats.sentCount === 'number') this.stats.sentCount = raw.stats.sentCount;
      }
      if (Array.isArray(raw.recentMessages)) {
        this.recentMessages = raw.recentMessages
          .filter(
            (m): m is RecentMessage =>
              Boolean(m && typeof m.id === 'string' && typeof m.timestamp === 'string' && typeof m.isoTimestamp === 'string')
          )
          .slice(0, MAX_RECENT_MESSAGES)
          .map((m) =>
            m.webhookStatus === 'forwarded'
              ? { ...m, webhookStatus: 'failed', webhookError: 'Gateway restarted before Hermes responded' }
              : m
          );
      }
      if (Array.isArray(raw.processedMessageIds)) {
        for (const id of raw.processedMessageIds.slice(-MAX_PROCESSED_MESSAGE_IDS)) {
          if (typeof id === 'string' && id) {
            this.processedMessageIds.add(id);
          }
        }
      }
    } catch (err: unknown) {
      console.warn('[WhatsApp] Could not read persisted activity state:', err instanceof Error ? err.message : err);
    }
  }

  private scheduleActivitySave(): void {
    this.notifyStateChange();
    this.activityWriter.schedule(() => ({
      stats: { ...this.stats },
      recentMessages: this.recentMessages.map((m) => ({ ...m })),
      processedMessageIds: Array.from(this.processedMessageIds)
    }));
  }

  private async withWebhookSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeWebhooks >= config.webhookConcurrency) {
      await new Promise<void>((resolve) => {
        this.webhookWaiters.push(resolve);
      });
    }
    this.activeWebhooks++;
    try {
      return await fn();
    } finally {
      this.activeWebhooks--;
      const next = this.webhookWaiters.shift();
      if (next) next();
    }
  }

  private indexUsernameEntry(entry: UsernameDirectoryEntry): void {
    this.jidToUsername.set(entry.jid, entry.username);
    if (entry.phoneNumber) {
      this.phoneToUsername.set(entry.phoneNumber, entry.username);
    } else if (isPnUser(entry.jid)) {
      const digits = digitsOfJid(entry.jid);
      if (digits) this.phoneToUsername.set(digits, entry.username);
    }
  }

  private unindexUsernameEntry(username: string, entry: UsernameDirectoryEntry): void {
    if (this.jidToUsername.get(entry.jid) === username) {
      this.jidToUsername.delete(entry.jid);
    }
    const phone = entry.phoneNumber || (isPnUser(entry.jid) ? digitsOfJid(entry.jid) : '');
    if (phone && this.phoneToUsername.get(phone) === username) {
      this.phoneToUsername.delete(phone);
    }
  }

  private recordVerifiedPhoneJid(rawJid: string | null | undefined): void {
    if (!rawJid) return;
    const normalized = jidNormalizedUser(rawJid);
    if (!normalized || !isPnUser(normalized)) return;
    this.verifiedPhoneJids.delete(normalized);
    this.verifiedPhoneJids.set(normalized, {
      jid: normalized,
      expiresAt: Date.now() + VERIFIED_PHONE_TTL_MS
    });
    if (this.verifiedPhoneJids.size > MAX_VERIFIED_PHONE_CACHE) {
      const oldest = this.verifiedPhoneJids.keys().next().value;
      if (oldest) this.verifiedPhoneJids.delete(oldest);
    }
  }

  private loadUsernameDirectory(): void {
    if (!fs.existsSync(this.usernamesFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.usernamesFile, 'utf8')) as Record<string, UsernameDirectoryEntry>;
      for (const [key, entry] of Object.entries(raw)) {
        const clean = (entry?.username || key).trim().replace(/^@+/, '').toLowerCase();
        if (clean && entry?.jid && isValidWhatsAppUsername(clean)) {
          const normalizedEntry: UsernameDirectoryEntry = {
            username: clean,
            jid: jidNormalizedUser(entry.jid),
            ...(entry.phoneNumber ? { phoneNumber: entry.phoneNumber } : {}),
            ...(entry.name ? { name: entry.name } : {}),
            updatedAt: entry.updatedAt || new Date().toISOString()
          };
          this.usernameDirectory.set(clean, normalizedEntry);
          this.indexUsernameEntry(normalizedEntry);
        }
      }
    } catch (err: unknown) {
      console.warn('[WhatsApp] Could not read usernames directory:', err instanceof Error ? err.message : err);
    }
  }

  private saveUsernameDirectory(): void {
    this.usernamesWriter.schedule(() => {
      const serialized: Record<string, UsernameDirectoryEntry> = {};
      for (const [key, value] of this.usernameDirectory.entries()) {
        serialized[key] = value;
      }
      return serialized;
    });
  }

  private upsertUsernameMapping(
    rawUsername: string,
    rawJid: string,
    phoneNumber?: string,
    name?: string,
    persist = true
  ): boolean {
    const cleanUsername = rawUsername.trim().replace(/^@+/, '').toLowerCase();
    if (!isValidWhatsAppUsername(cleanUsername)) return false;

    const normalizedJid = jidNormalizedUser(rawJid);
    if (!normalizedJid || (!isLidUser(normalizedJid) && !isPnUser(normalizedJid))) {
      return false;
    }

    const existing = this.usernameDirectory.get(cleanUsername);
    const cleanPhone = phoneNumber?.replace(/[^0-9]/g, '') || existing?.phoneNumber;
    const cleanName = name?.trim() || existing?.name;

    // Evict any older handle previously mapped to the same JID (the contact changed their @username)
    let staleRemoved = false;
    const prevUsernameForJid = this.jidToUsername.get(normalizedJid);
    if (prevUsernameForJid && prevUsernameForJid !== cleanUsername) {
      const prevEntry = this.usernameDirectory.get(prevUsernameForJid);
      if (prevEntry) {
        this.usernameDirectory.delete(prevUsernameForJid);
        this.unindexUsernameEntry(prevUsernameForJid, prevEntry);
        staleRemoved = true;
      }
    }

    const unchanged =
      !staleRemoved &&
      existing &&
      existing.jid === normalizedJid &&
      existing.phoneNumber === cleanPhone &&
      existing.name === cleanName;

    if (unchanged) return false;

    if (existing) {
      this.unindexUsernameEntry(cleanUsername, existing);
    }

    const updatedEntry: UsernameDirectoryEntry = {
      username: cleanUsername,
      jid: normalizedJid,
      ...(cleanPhone ? { phoneNumber: cleanPhone } : {}),
      ...(cleanName ? { name: cleanName } : {}),
      updatedAt: new Date().toISOString()
    };
    this.usernameDirectory.set(cleanUsername, updatedEntry);
    this.indexUsernameEntry(updatedEntry);
    this.emptyLidUsernameCache.delete(normalizedJid);

    if (persist) {
      this.saveUsernameDirectory();
    }
    return true;
  }

  /** Finds a cached @username for a sender by JID, alternate JID (LID <-> PN), or phone digits. */
  private findUsernameForSender(senderJid: string, senderAlt?: string | null, phone?: string | null): string | undefined {
    const normSender = senderJid ? jidNormalizedUser(senderJid) : '';
    if (normSender) {
      const hit = this.jidToUsername.get(normSender);
      if (hit) return hit;
    }
    const normAlt = senderAlt ? jidNormalizedUser(senderAlt) : '';
    if (normAlt) {
      const hit = this.jidToUsername.get(normAlt);
      if (hit) return hit;
    }
    const cleanPhone = phone?.replace(/[^0-9]/g, '') || '';
    if (cleanPhone) {
      return this.phoneToUsername.get(cleanPhone);
    }
    return undefined;
  }

  /**
   * Learns @username <-> JID mappings from message keys. Runs for every message (including our own
   * fromMe messages sent from the primary phone, where WhatsApp includes the peer's recipient_username).
   * Historical messages (history sync / append) only fill gaps: they never replace a handle we already
   * know for that JID, so an old username in history cannot overwrite the contact's current one.
   */
  private ingestMessageUsernames(messages: WAMessage[], opts: { historical?: boolean } = {}): void {
    let changed = false;
    const learn = (username: string, jid: string, pn: string | undefined, name: string | undefined): void => {
      if (opts.historical) {
        const normalized = jidNormalizedUser(jid);
        const cleanUsername = username.trim().replace(/^@+/, '').toLowerCase();
        const existingUsername = this.jidToUsername.get(normalized);
        if (existingUsername && existingUsername !== cleanUsername) return;
      }
      if (this.upsertUsernameMapping(username, jid, pn, name, false)) changed = true;
    };
    for (const msg of messages) {
      const key = msg?.key;
      if (!key?.remoteJid) continue;
      const chatJid = key.remoteJid;
      // pushName on fromMe messages is our own name, never the peer's
      const peerName = key.fromMe ? undefined : msg.pushName ?? undefined;
      if (isJidGroup(chatJid)) {
        if (key.participant && isPnUser(key.participant)) this.recordVerifiedPhoneJid(key.participant);
        if (key.participantAlt && isPnUser(key.participantAlt)) this.recordVerifiedPhoneJid(key.participantAlt);
        if (key.participantUsername && key.participant) {
          const pn = key.participantAlt && isPnUser(key.participantAlt) ? key.participantAlt : isPnUser(key.participant) ? key.participant : undefined;
          learn(key.participantUsername, key.participant, digitsOfJid(pn) || undefined, peerName);
        }
      } else {
        if (isPnUser(chatJid)) this.recordVerifiedPhoneJid(chatJid);
        if (key.remoteJidAlt && isPnUser(key.remoteJidAlt)) this.recordVerifiedPhoneJid(key.remoteJidAlt);
        if (key.remoteJidUsername) {
          const pn = key.remoteJidAlt && isPnUser(key.remoteJidAlt) ? key.remoteJidAlt : isPnUser(chatJid) ? chatJid : undefined;
          learn(key.remoteJidUsername, chatJid, digitsOfJid(pn) || undefined, peerName);
        }
      }
    }
    if (changed) this.saveUsernameDirectory();
  }

  /** Learns @username mappings from group metadata (owner, subject/description owners, participants). */
  private ingestGroupParticipants(participants: Array<Partial<GroupParticipant>>): boolean {
    let changed = false;
    for (const p of participants) {
      if (!p) continue;
      if (p.id && isPnUser(p.id)) this.recordVerifiedPhoneJid(p.id);
      if (p.phoneNumber && isPnUser(p.phoneNumber)) this.recordVerifiedPhoneJid(p.phoneNumber);
      if (!p.username) continue;
      const targetJid = p.lid || p.id || p.phoneNumber;
      if (!targetJid) continue;
      const pnSource = p.phoneNumber || (p.id && isPnUser(p.id) ? p.id : undefined);
      if (this.upsertUsernameMapping(p.username, targetJid, digitsOfJid(pnSource) || undefined, p.name || p.notify || undefined, false)) {
        changed = true;
      }
    }
    return changed;
  }

  private ingestGroupMetadata(groups: Array<Partial<GroupMetadata>>): void {
    let changed = false;
    for (const g of groups) {
      if (!g) continue;
      const owners: Array<[string | undefined, string | undefined, string | undefined]> = [
        [g.ownerUsername, g.owner, g.ownerPn],
        [g.subjectOwnerUsername, g.subjectOwner, g.subjectOwnerPn],
        [g.descOwnerUsername, g.descOwner, g.descOwnerPn],
        [g.authorUsername, g.author, g.authorPn]
      ];
      for (const [username, jid, pn] of owners) {
        if (jid && isPnUser(jid)) this.recordVerifiedPhoneJid(jid);
        if (pn && isPnUser(pn)) this.recordVerifiedPhoneJid(pn);
        if (username && jid && this.upsertUsernameMapping(username, jid, digitsOfJid(pn) || undefined, undefined, false)) {
          changed = true;
        }
      }
      if (Array.isArray(g.participants) && this.ingestGroupParticipants(g.participants)) {
        changed = true;
      }
    }
    if (changed) this.saveUsernameDirectory();
  }

  /**
   * Reads username attributes straight from raw <message> stanzas. Baileys only decodes
   * recipient/participant usernames into the message key, so this also catches sender-side attributes.
   */
  private ingestRawMessageStanza(node: BinaryNode): void {
    const attrs = node?.attrs;
    if (!attrs) return;
    // Only the attributes Baileys itself decodes into message keys (see decode-wa-message.js)
    const pairs: Array<[string | undefined, string | undefined]> = [
      [attrs.participant_username, attrs.participant],
      [attrs.peer_recipient_username || attrs.recipient_username, attrs.recipient]
    ];
    let changed = false;
    for (const [username, jid] of pairs) {
      if (!username || !jid || isJidGroup(jid)) continue;
      if (this.upsertUsernameMapping(username, jid, undefined, undefined, false)) changed = true;
    }
    if (changed) this.saveUsernameDirectory();
  }

  /**
   * Reverse lookup (LID -> @username) through WhatsApp USync for inbound 1:1 messages from an uncached LID.
   * Bounded by LID_USERNAME_LOOKUP_TIMEOUT_MS so it never stalls message handling.
   */
  private async lookupUsernameForLid(lidJid: string): Promise<string | undefined> {
    const sock = this.sock;
    if (!sock || this.status !== 'connected' || !isLidUser(lidJid)) return undefined;
    const normalized = jidNormalizedUser(lidJid);
    const emptyAt = this.emptyLidUsernameCache.get(normalized);
    if (emptyAt && Date.now() - emptyAt < EMPTY_LID_USERNAME_TTL_MS) return undefined;

    const pending = this.pendingLidUsernameLookups.get(normalized);
    if (pending) return pending;

    const lookup = (async (): Promise<string | undefined> => {
      try {
        const protocol = new USyncUsernameProtocol();
        const iq: BinaryNode = {
          tag: 'iq',
          attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
          content: [
            {
              tag: 'usync',
              attrs: { context: 'interactive', mode: 'query', sid: sock.generateMessageTag(), last: 'true', index: '0' },
              content: [
                { tag: 'query', attrs: {}, content: [protocol.getQueryElement()] },
                { tag: 'list', attrs: {}, content: [{ tag: 'user', attrs: { jid: normalized } }] }
              ]
            }
          ]
        };
        const resp = await sock.query(iq, LID_USERNAME_LOOKUP_TIMEOUT_MS);
        if (!resp) return undefined; // timed out: do not cache as empty, try again next message
        const listNode = getBinaryNodeChild(getBinaryNodeChild(resp, 'usync'), 'list');
        for (const userNode of getBinaryNodeChildren(listNode, 'user')) {
          const usernameNode = getBinaryNodeChild(userNode, 'username');
          if (getBinaryNodeChild(usernameNode, 'error')) continue;
          const raw = readBinaryNodeText(usernameNode)?.trim().replace(/^@+/, '').toLowerCase();
          if (raw && isValidWhatsAppUsername(raw)) {
            this.upsertUsernameMapping(raw, normalized);
            return raw;
          }
        }
        this.emptyLidUsernameCache.set(normalized, Date.now());
        return undefined;
      } catch (err: unknown) {
        console.warn(`[WhatsApp] Reverse @username lookup failed for ${normalized}:`, err instanceof Error ? err.message : err);
        return undefined;
      } finally {
        this.pendingLidUsernameLookups.delete(normalized);
      }
    })();
    this.pendingLidUsernameLookups.set(normalized, lookup);
    return lookup;
  }

  private ingestContacts(contacts: Array<Partial<Contact>>): void {
    let changed = false;
    for (const contact of contacts) {
      if (!contact) continue;
      if (contact.id && isPnUser(contact.id)) this.recordVerifiedPhoneJid(contact.id);
      if (contact.phoneNumber && isPnUser(contact.phoneNumber)) this.recordVerifiedPhoneJid(contact.phoneNumber);
      if (!contact.username) continue;
      const targetJid = contact.lid || contact.id || contact.phoneNumber;
      if (!targetJid) continue;
      const pnSource = contact.phoneNumber || (contact.id && isPnUser(contact.id) ? contact.id : undefined);
      const digits = pnSource ? pnSource.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : undefined;
      const displayName = contact.name || contact.notify || undefined;
      if (this.upsertUsernameMapping(contact.username, targetJid, digits, displayName, false)) {
        changed = true;
      }
    }
    if (changed) {
      this.saveUsernameDirectory();
    }
  }

  public listKnownUsernames(): UsernameDirectoryEntry[] {
    return Array.from(this.usernameDirectory.values()).sort((a, b) => a.username.localeCompare(b.username));
  }

  private formatDateTime(date: Date = new Date()): string {
    return formatDateTimeParts(date).full;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  public async start(): Promise<void> {
    if (this.sock || this.starting || this.shuttingDown) {
      return;
    }
    this.starting = true;
    const epoch = ++this.connectionEpoch;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.status = 'connecting';
    this.lastError = null;
    this.notifyStateChange();

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      if (this.shuttingDown || epoch !== this.connectionEpoch) return;

      this.registered = Boolean(state.creds.registered);
      // Looked up once per process; reconnects should not depend on GitHub being reachable.
      if (!this.waVersion) {
        try {
          this.waVersion = (await fetchLatestBaileysVersion()).version;
        } catch (err: unknown) {
          console.warn(
            '[WhatsApp] Could not fetch the latest WhatsApp Web version; using the bundled default.',
            err instanceof Error ? err.message : err
          );
        }
      }
      if (this.shuttingDown || epoch !== this.connectionEpoch) return;

      const sock = makeWASocket({
        version: this.waVersion,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger)
        },
        browser: Browsers.macOS('Desktop App'),
        logger: this.logger,
        markOnlineOnConnect: false,
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
            this.notifyStateChange();
          } catch (qrErr: unknown) {
            console.error('Failed to generate QR data URL:', qrErr);
          }
        }

        if (connection === 'open') {
          const connectedNow = new Date();
          this.status = 'connected';
          this.qrCodeDataUrl = null;
          this.reconnectAttempts = 0;
          this.registered = true;
          this.lastError = null;
          this.lastConnectedIso = connectedNow.toISOString();
          this.lastConnectedAt = this.formatDateTime(connectedNow);
          this.user = {
            id: sock.user?.id || 'Connected Account',
            name: sock.user?.name || undefined
          };
          this.notifyStateChange();
          console.log(`[WhatsApp] Connected successfully as ${this.user.id}`);
        } else if (connection === 'close') {
          await this.handleClose(lastDisconnect?.error);
        }
      });

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        // Learn @username mappings from every message first (including our own fromMe and history appends)
        this.ingestMessageUsernames(messages, { historical: type !== 'notify' });
        if (type !== 'notify') return;

        // Serialize per chatJid so messages in the same thread keep arrival order without blocking other chats.
        for (const msg of messages) {
          const queueKey = msg?.key?.remoteJid || msg?.key?.id || 'default';
          const prev = this.chatQueues.get(queueKey) ?? Promise.resolve();
          const next = prev
            .catch(() => {})
            .then(() => this.handleIncomingMessage(msg))
            .catch((err: unknown) => {
              console.error('[WhatsApp] Failed to process incoming message:', err);
            })
            .finally(() => {
              if (this.chatQueues.get(queueKey) === next) {
                this.chatQueues.delete(queueKey);
              }
            });
          this.chatQueues.set(queueKey, next);
        }
      });

      // WhatsApp reports late server rejections (e.g. Error 463 / 479) as a status=ERROR update.
      sock.ev.on('messages.update', (updates) => {
        this.handleMessageUpdates(updates);
      });

      sock.ev.on('messaging-history.set', ({ contacts, messages }) => {
        this.ingestContacts(contacts);
        this.ingestMessageUsernames(messages, { historical: true });
      });

      sock.ev.on('contacts.upsert', (contacts) => {
        this.ingestContacts(contacts);
      });

      sock.ev.on('contacts.update', (updates) => {
        this.ingestContacts(updates);
      });

      sock.ev.on('groups.upsert', (groups) => {
        this.ingestGroupMetadata(groups);
      });

      sock.ev.on('groups.update', (updates) => {
        this.ingestGroupMetadata(updates);
      });

      sock.ev.on('group-participants.update', (update) => {
        this.ingestGroupMetadata([
          { id: update.id, author: update.author, authorPn: update.authorPn, authorUsername: update.authorUsername, participants: update.participants }
        ]);
      });

      sock.ws.on('CB:message', (node: BinaryNode) => {
        try {
          this.ingestRawMessageStanza(node);
        } catch (err: unknown) {
          console.warn('[WhatsApp] Could not read username attributes from stanza:', err instanceof Error ? err.message : err);
        }
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.status = 'disconnected';
      this.lastError = errMsg;
      this.notifyStateChange();
      console.error('[WhatsApp] Initialization error:', errMsg);
    } finally {
      this.starting = false;
    }
  }

  private async handleClose(error: unknown): Promise<void> {
    const statusCode = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

    console.log(`[WhatsApp] Connection closed (code ${statusCode}).`);
    this.connectionEpoch++;
    this.cleanupSocket();
    this.qrCodeDataUrl = null;

    if (this.shuttingDown) {
      this.notifyStateChange();
      return;
    }

    // Cases where the saved session is no longer usable: wipe it and ask for a new QR scan.
    const sessionDead: Partial<Record<number, string>> = {
      [DisconnectReason.loggedOut]: 'Logged out from WhatsApp. Please scan the QR code again.',
      [DisconnectReason.badSession]: 'The saved WhatsApp session is corrupted. Please scan the QR code again.',
      [DisconnectReason.multideviceMismatch]: 'WhatsApp rejected the saved session. Please scan the QR code again.'
    };
    const deadMessage = statusCode !== undefined ? sessionDead[statusCode] : undefined;
    if (deadMessage) {
      this.status = 'disconnected';
      this.lastError = deadMessage;
      this.user = null;
      this.registered = false;
      await this.clearSavedSession();
      this.notifyStateChange();
      return;
    }

    if (statusCode === DisconnectReason.connectionReplaced) {
      this.status = 'disconnected';
      this.lastError = 'This WhatsApp session was opened somewhere else. Press "Reconnect" to take it back.';
      this.notifyStateChange();
      return;
    }

    if (statusCode === DisconnectReason.forbidden) {
      this.status = 'disconnected';
      this.lastError = 'WhatsApp refused the connection (403). The account may be blocked from using linked devices.';
      this.notifyStateChange();
      return;
    }

    // WhatsApp asks for an immediate restart right after a QR scan; that is not a failure.
    if (statusCode === DisconnectReason.restartRequired) {
      this.status = 'connecting';
      this.notifyStateChange();
      this.scheduleReconnect(500);
      return;
    }

    // A linked account keeps retrying (with exponential back-off + jitter) so an unattended server heals itself.
    // An account that was never paired gives up after a few QR cycles instead of looping forever.
    if (this.registered || this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const baseDelay = Math.min(2000 * 2 ** Math.min(this.reconnectAttempts - 1, 6), 60_000);
      const delay = baseDelay + Math.floor(Math.random() * 1000);
      console.log(`[WhatsApp] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);
      this.status = 'connecting';
      this.notifyStateChange();
      this.scheduleReconnect(delay);
    } else {
      this.status = 'disconnected';
      this.lastError = 'The QR code expired before it was scanned. Press "Reconnect" to get a new one.';
      this.notifyStateChange();
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
    this.connectionEpoch++;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanupSocket();
    await Promise.all([this.usernamesWriter.flush(), this.activityWriter.flush()]);
  }

  public async logout(): Promise<{ success: boolean; message: string }> {
    this.connectionEpoch++;
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
      this.lastConnectedAt = null;
      this.lastConnectedIso = null;
      this.lastError = null;
      this.reconnectAttempts = 0;
      await Promise.all([this.usernamesWriter.flush(), this.activityWriter.flush()]);
      this.notifyStateChange();
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
      sock.ev.removeAllListeners('messages.update');
      sock.ev.removeAllListeners('messaging-history.set');
      sock.ev.removeAllListeners('contacts.upsert');
      sock.ev.removeAllListeners('contacts.update');
      sock.ev.removeAllListeners('groups.upsert');
      sock.ev.removeAllListeners('groups.update');
      sock.ev.removeAllListeners('group-participants.update');
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
          fileName?: string | null;
          fileLength?: unknown;
          contextInfo?: proto.IContextInfo | null;
          name?: string | null;
          displayName?: string | null;
          degreesLatitude?: number | null;
          degreesLongitude?: number | null;
          selectedDisplayText?: string | null;
          title?: string | null;
          singleSelectReply?: { selectedRowId?: string | null } | null;
          options?: Array<{ optionName?: string | null }> | null;
          message?: {
            documentMessage?: {
              caption?: string | null;
              mimetype?: string | null;
              fileName?: string | null;
              title?: string | null;
              fileLength?: unknown;
              contextInfo?: proto.IContextInfo | null;
            } | null;
          } | null;
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
        return {
          type: 'image',
          text: p.caption || '[Image]',
          hasMedia: true,
          mimetype: p.mimetype ?? undefined,
          fileLength: readFileLength(p.fileLength),
          contextInfo
        };
      case 'videoMessage':
        return {
          type: 'video',
          text: p.caption || '[Video]',
          hasMedia: true,
          mimetype: p.mimetype ?? undefined,
          fileLength: readFileLength(p.fileLength),
          contextInfo
        };
      case 'audioMessage':
        return {
          type: p.ptt ? 'voice' : 'audio',
          text: p.ptt ? '[Voice message]' : '[Audio]',
          hasMedia: true,
          mimetype: p.mimetype ?? undefined,
          fileLength: readFileLength(p.fileLength),
          contextInfo
        };
      case 'documentMessage':
      case 'documentWithCaptionMessage': {
        const doc = p.message?.documentMessage ?? p;
        const docName = doc.fileName || doc.title || p.fileName || p.title || undefined;
        return {
          type: 'document',
          text: doc.caption || p.caption || `[Document${docName ? `: ${docName}` : ''}]`,
          hasMedia: true,
          mimetype: doc.mimetype ?? p.mimetype ?? undefined,
          fileName: docName,
          fileLength: readFileLength(doc.fileLength ?? p.fileLength),
          contextInfo: doc.contextInfo ?? contextInfo
        };
      }
      case 'stickerMessage':
        return {
          type: 'sticker',
          text: '[Sticker]',
          hasMedia: true,
          mimetype: p.mimetype ?? undefined,
          fileLength: readFileLength(p.fileLength),
          contextInfo
        };
      case 'pollCreationMessage':
      case 'pollCreationMessageV2':
      case 'pollCreationMessageV3': {
        const options = (p.options ?? [])
          .map((opt) => opt?.optionName?.trim())
          .filter((v): v is string => Boolean(v));
        const optionSuffix = options.length > 0 ? ` (${options.join(', ')})` : '';
        return {
          type: 'poll',
          text: `[Poll] ${p.name || 'Untitled'}${optionSuffix}`,
          hasMedia: false,
          contextInfo
        };
      }
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
      if (this.processedMessageIds.size > MAX_PROCESSED_MESSAGE_IDS) {
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
    const rawUsername = isGroup ? msg.key.participantUsername : msg.key.remoteJidUsername;
    let senderUsername = rawUsername
      ? rawUsername.trim().replace(/^@+/, '').toLowerCase() || undefined
      : undefined;

    // WhatsApp now addresses many people by an opaque "LID" instead of their phone number.
    // Only report a phone number when we actually know it; replies always go to chatJid.
    const phoneJid = isLidUser(senderJid) ? senderAlt : senderJid;
    if (phoneJid && isPnUser(phoneJid)) {
      this.recordVerifiedPhoneJid(phoneJid);
    }
    const phone = phoneJid ? phoneJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || null : null;
    const senderId = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    if (senderUsername) {
      this.upsertUsernameMapping(senderUsername, senderJid, phone ?? undefined, msg.pushName ?? undefined);
    } else {
      // Inbound 1:1 stanzas do not carry the sender's username, so use what we learned earlier,
      // and for an unknown LID ask WhatsApp once (bounded, cached).
      senderUsername = this.findUsernameForSender(senderJid, senderAlt, phone);
      if (!senderUsername && !isGroup && isLidUser(senderJid)) {
        senderUsername = await this.lookupUsernameForLid(senderJid);
      }
    }

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
      senderUsername,
      recipient: 'Hermes Agent',
      content: parsed.text,
      timestamp: this.formatDateTime(eventDate),
      isoTimestamp: eventDate.toISOString(),
      fromMe: false,
      isGroup,
      chatJid,
      messageType: parsed.type,
      hasMedia: parsed.hasMedia,
      webhookStatus: 'disabled'
    };

    this.stats.receivedCount++;
    this.cacheRawMessage(id, msg);
    this.addRecentMessage(record);

    if (!config.webhookUrl) return;
    if (!this.settings.forwardingEnabled) {
      record.webhookStatus = 'paused';
      this.scheduleActivitySave();
      return;
    }
    if (
      (isGroup && !config.forwardGroups) ||
      (config.allowedNumbers.length > 0 &&
        !config.allowedNumbers.some(
          (n) => n === phone || n === senderId || (senderUsername !== undefined && n === `@${senderUsername}`)
        ))
    ) {
      record.webhookStatus = 'filtered';
      this.scheduleActivitySave();
      return;
    }

    record.webhookStatus = 'forwarded';
    this.scheduleActivitySave();

    const payload = {
      event: 'message.received',
      messageId: id,
      /** Phone number in digits, or null when WhatsApp only exposed an anonymous ID (LID). */
      sender: phone,
      senderName: record.senderName ?? null,
      /** Normalized WhatsApp @username (without "@") when exposed by WhatsApp, otherwise null. */
      senderUsername: senderUsername ?? null,
      senderJid,
      /** Where to send replies. Always use this (or the sender's phone / @username) as "to" in POST /api/send. */
      chatJid,
      remoteJid: chatJid,
      isGroup,
      groupJid: isGroup ? chatJid : null,
      message: parsed.text,
      messageType: parsed.type,
      hasMedia: parsed.hasMedia,
      mimetype: parsed.mimetype ?? null,
      fileName: parsed.fileName ?? null,
      mentionsMe,
      isReplyToMe,
      quoted: ctx?.stanzaId ? { messageId: ctx.stanzaId, message: quotedContent?.text ?? null } : null,
      timestamp: record.timestamp,
      timezone: config.timezone,
      isoTimestamp: record.isoTimestamp,
      rawTimestamp: tsSeconds
    };

    try {
      const result = await this.withWebhookSlot(() => postToHermes(payload));

      if (!result.ok) {
        record.webhookStatus = 'failed';
        record.webhookError = `Hermes answered HTTP ${result.status}`;
        this.scheduleActivitySave();
        console.warn(`[Webhook] Hermes returned HTTP ${result.status} for message ${id}`);
        return;
      }

      this.stats.forwardedToHermesCount++;
      this.scheduleActivitySave();
      const reply = typeof result.json?.reply === 'string' ? result.json.reply.trim() : '';
      const stickerReply =
        typeof result.json?.sticker === 'string' && (result.json.sticker as string).trim()
          ? (result.json.sticker as string).trim()
          : typeof result.json?.stickerUrl === 'string' && (result.json.stickerUrl as string).trim()
            ? (result.json.stickerUrl as string).trim()
            : null;

      if (reply) {
        record.hermesReply = reply;
        const quote = typeof result.json?.quote === 'boolean' ? result.json.quote : isGroup;
        // On success sendMessage() marks this record as "replied" (see linkHermesReply).
        const sent = await this.sendMessage(chatJid, reply, {
          quotedMessageId: quote ? id : undefined,
          inReplyTo: id,
          source: 'hermes'
        });
        if (!sent.success) {
          record.webhookStatus = 'failed';
          record.webhookError = `Reply could not be sent: ${sent.error}`;
          this.scheduleActivitySave();
        }
      } else if (stickerReply) {
        record.hermesReply = '[Sticker]';
        const quote = typeof result.json?.quote === 'boolean' ? result.json.quote : isGroup;
        const sent = await this.sendSticker(chatJid, stickerReply, {
          quotedMessageId: quote ? id : undefined,
          inReplyTo: id,
          source: 'hermes',
          isAnimated: typeof result.json?.isAnimated === 'boolean' ? result.json.isAnimated : undefined,
          pack: typeof result.json?.pack === 'string' ? result.json.pack : undefined,
          author: typeof result.json?.author === 'string' ? result.json.author : undefined
        });
        if (!sent.success) {
          record.webhookStatus = 'failed';
          record.webhookError = `Sticker reply could not be sent: ${sent.error}`;
          this.scheduleActivitySave();
        }
      } else {
        record.webhookStatus = result.json?.status === 'processing' ? 'processing' : 'ignored';
        this.scheduleActivitySave();
      }
    } catch (err: unknown) {
      record.webhookStatus = 'failed';
      record.webhookError = err instanceof Error ? err.message : String(err);
      this.scheduleActivitySave();
      console.error(`[Webhook] Could not reach Hermes at ${config.webhookUrl}: ${record.webhookError}`);
    }
  }

  private addRecentMessage(message: RecentMessage): void {
    this.recentMessages.unshift(message);
    if (this.recentMessages.length > MAX_RECENT_MESSAGES) {
      this.recentMessages.pop();
    }
    this.scheduleActivitySave();
  }

  /**
   * Marks the inbound message a Hermes reply answers as "replied", so asynchronous replies
   * (sent later through POST /api/send) close the loop in the dashboard and the stats.
   */
  private linkHermesReply(chatJid: string, replyText: string, inReplyTo?: string): string | undefined {
    const target =
      (inReplyTo && this.recentMessages.find((m) => !m.fromMe && m.id === inReplyTo)) ||
      this.recentMessages.find((m) => !m.fromMe && m.chatJid === chatJid && m.webhookStatus === 'processing');
    if (!target || target.webhookStatus === 'replied') return undefined;
    target.webhookStatus = 'replied';
    target.hermesReply = replyText;
    delete target.webhookError;
    this.stats.hermesRepliesCount++;
    this.scheduleActivitySave();
    return target.id;
  }

  // ---------------------------------------------------------------------------
  // Outgoing actions (used by the dashboard and by Hermes)
  // ---------------------------------------------------------------------------

  /**
   * Synchronously turns a phone number, JID, or cached @username into a JID.
   * For uncached @usernames that require a live WhatsApp USync lookup, call resolveRecipient() instead.
   */
  public resolveJid(recipient: string): string | null {
    const parsed = parseRecipientInput(recipient);
    if (parsed.kind === 'jid' || parsed.kind === 'phone') {
      return parsed.jid;
    }
    if (parsed.kind === 'username') {
      return this.usernameDirectory.get(parsed.username)?.jid ?? null;
    }
    return null;
  }

  private formatSendError(err: unknown, targetLabel: string): string {
    const raw = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { output?: { statusCode?: number }; data?: unknown } | undefined)?.output?.statusCode;
    if (statusCode === 463 || /\b463\b/.test(raw)) {
      return `WhatsApp Error 463 (cold outreach restriction) sending to ${targetLabel}: linked devices cannot start brand-new 1:1 chats without a privacy token (tctoken). Do NOT auto-retry; initiate the first message manually from the primary phone.`;
    }
    return raw;
  }

  /**
   * Resolves a phone number, JID, or WhatsApp @username (with optional 4-digit PIN) into a deliverable JID.
   */
  public async resolveRecipient(
    recipient: string,
    opts: { pin?: string; forceRefresh?: boolean } = {}
  ): Promise<ResolveRecipientResult> {
    const parsed = parseRecipientInput(recipient, opts.pin);
    if (parsed.kind === 'invalid') {
      return { success: false, code: 400, error: parsed.error };
    }

    // Fast path for already-cached @username mappings (unless caller requested a live refresh)
    if (parsed.kind === 'username' && !opts.forceRefresh) {
      const cached = this.usernameDirectory.get(parsed.username);
      if (cached?.jid) {
        return {
          success: true,
          jid: cached.jid,
          username: parsed.username,
          displayRecipient: `@${parsed.username}`,
          isGroup: false,
          source: 'cache'
        };
      }
    }

    if (!this.sock || this.status !== 'connected') {
      return {
        success: false,
        code: 503,
        error: 'WhatsApp is not connected yet. Scan the QR code or press Reconnect first.'
      };
    }

    // 1. Direct JID or phone number
    if (parsed.kind === 'jid' || parsed.kind === 'phone') {
      let jid = parsed.jid;
      if (jid.endsWith('@s.whatsapp.net')) {
        const normalized = jidNormalizedUser(jid);
        const cachedVerified = this.verifiedPhoneJids.get(normalized);
        if (cachedVerified && !opts.forceRefresh && cachedVerified.expiresAt > Date.now()) {
          jid = cachedVerified.jid;
        } else {
          if (cachedVerified) this.verifiedPhoneJids.delete(normalized);
          try {
            const results = await this.sock.onWhatsApp(jid);
            // Baileys returns [] (or entries with exists=false) for numbers that are not on WhatsApp
            const match = results?.[0];
            if (Array.isArray(results) && (!match || !match.exists)) {
              return { success: false, code: 404, error: `${jid.split('@')[0]} is not registered on WhatsApp` };
            }
            if (match?.exists && match.jid) jid = match.jid;
            this.recordVerifiedPhoneJid(jid);
          } catch {
            // Lookup is best effort for phone numbers; proceed with constructed JID.
          }
        }
      }
      const isGroup = jid.endsWith('@g.us');
      const displayRecipient = isGroup ? `${jid.split('@')[0]} (Group)` : jid.split('@')[0];
      return {
        success: true,
        jid,
        displayRecipient,
        isGroup,
        source: parsed.kind
      };
    }

    // 2. WhatsApp @username live USync resolution
    const { username, pin } = parsed;

    try {
      const usyncQuery = new USyncQuery().withContactProtocol().withLIDProtocol();
      const usyncUser = new USyncUser().withUsername(username);
      if (pin) {
        usyncUser.withUsernameKey(pin);
      }
      usyncQuery.withUser(usyncUser);

      const userNodes: BinaryNode[] = usyncQuery.users.map((u) => ({
        tag: 'user',
        attrs: {
          ...(u.id && !u.phone ? { jid: u.id } : {})
        },
        content: usyncQuery.protocols
          .map((p) => p.getUserElement(u))
          .filter((node): node is BinaryNode => node !== null)
      }));

      const iq: BinaryNode = {
        tag: 'iq',
        attrs: {
          to: S_WHATSAPP_NET,
          type: 'get',
          xmlns: 'usync'
        },
        content: [
          {
            tag: 'usync',
            attrs: {
              context: usyncQuery.context,
              mode: usyncQuery.mode,
              sid: this.sock.generateMessageTag(),
              last: 'true',
              index: '0'
            },
            content: [
              {
                tag: 'query',
                attrs: {},
                content: usyncQuery.protocols.map((p) => p.getQueryElement())
              },
              {
                tag: 'list',
                attrs: {},
                content: userNodes
              }
            ]
          }
        ]
      };

      const rawResp = await this.sock.query(iq);
      // Baileys resolves undefined (instead of throwing) when the query times out
      if (!rawResp) {
        return {
          success: false,
          code: 503,
          error: `Timed out waiting for WhatsApp while resolving @${username}. Try again shortly.`
        };
      }

      const usyncNode = getBinaryNodeChild(rawResp, 'usync');
      if (!usyncNode) {
        return {
          success: false,
          code: 502,
          error: `Unexpected USync response from WhatsApp while resolving @${username}.`
        };
      }

      const resultNode = getBinaryNodeChild(usyncNode, 'result');
      const resultContactErr = getBinaryNodeChild(getBinaryNodeChild(resultNode, 'contact'), 'error');
      const resultLidErr = getBinaryNodeChild(getBinaryNodeChild(resultNode, 'lid'), 'error');
      const listNode = getBinaryNodeChild(usyncNode, 'list');
      const respUsers = getBinaryNodeChildren(listNode, 'user');

      let protocolErrNode: BinaryNode | undefined = resultContactErr ?? resultLidErr;
      for (const userNode of respUsers) {
        const contactErr = getBinaryNodeChild(getBinaryNodeChild(userNode, 'contact'), 'error');
        const lidErr = getBinaryNodeChild(getBinaryNodeChild(userNode, 'lid'), 'error');
        if (contactErr || lidErr) {
          protocolErrNode = contactErr ?? lidErr;
          break;
        }
      }

      if (protocolErrNode) {
        const errCode = Number(protocolErrNode.attrs?.code || 0);
        const errText = String(protocolErrNode.attrs?.text || '');
        return this.classifyUsyncError(errCode, errText, username, pin);
      }

      for (const userNode of respUsers) {
        const contactNode = getBinaryNodeChild(userNode, 'contact');
        const lidNode = getBinaryNodeChild(userNode, 'lid');
        const usernameNode = getBinaryNodeChild(userNode, 'username');
        const contactType = contactNode?.attrs?.type;
        const attrJid = userNode.attrs?.jid;
        const lidVal = lidNode?.attrs?.val;

        if (contactType === 'out') {
          continue;
        }

        const primaryJid = attrJid || lidVal;
        if (!primaryJid) {
          continue;
        }

        // Prefer the canonical handle WhatsApp returns (case / formatting), falling back to what was asked for
        const returnedUsername = readBinaryNodeText(usernameNode)?.trim().replace(/^@+/, '').toLowerCase();
        const canonicalUsername =
          returnedUsername && isValidWhatsAppUsername(returnedUsername) ? returnedUsername : username;

        const normalizedPrimary = jidNormalizedUser(primaryJid);
        const normalizedLid = lidVal ? jidNormalizedUser(lidVal) : isLidUser(normalizedPrimary) ? normalizedPrimary : undefined;
        const normalizedPn = attrJid && isPnUser(attrJid) ? jidNormalizedUser(attrJid) : undefined;

        if (normalizedLid && normalizedPn) {
          try {
            await this.sock.signalRepository.lidMapping.storeLIDPNMappings([{ lid: normalizedLid, pn: normalizedPn }]);
          } catch {
            // Non-fatal if signal store mapping cannot be updated
          }
        }

        const phoneDigits = normalizedPn ? digitsOfJid(normalizedPn) : undefined;
        this.upsertUsernameMapping(canonicalUsername, normalizedPrimary, phoneDigits);

        return {
          success: true,
          jid: normalizedPrimary,
          username: canonicalUsername,
          displayRecipient: `@${canonicalUsername}`,
          isGroup: false,
          source: 'usync'
        };
      }

      return {
        success: false,
        code: 404,
        error: pin
          ? `@${username} was not found on WhatsApp (or the 4-digit PIN was incorrect).`
          : `@${username} was not found on WhatsApp (or requires a 4-digit username PIN — pass "pin": "1234" or "@${username}#1234").`
      };
    } catch (err: unknown) {
      // Baileys throws a Boom for a top-level <iq><error code="..."/>; the code is in err.data
      const boom = err as { data?: unknown; output?: { statusCode?: number } } | undefined;
      const dataCode =
        typeof boom?.data === 'number'
          ? boom.data
          : Number((boom?.data as { attrs?: { code?: string } } | undefined)?.attrs?.code || 0);
      const errCode = dataCode || Number(boom?.output?.statusCode || 0);
      const errText = err instanceof Error ? err.message : String(err);
      return this.classifyUsyncError(errCode, errText, username, pin);
    }
  }

  /** Maps a WhatsApp USync error code/text to an HTTP-style result for @username lookups. */
  private classifyUsyncError(
    errCode: number,
    errText: string,
    username: string,
    pin?: string
  ): Extract<ResolveRecipientResult, { success: false }> {
    if (errCode === 429 || /rate|overlimit/i.test(errText)) {
      return {
        success: false,
        code: 429,
        error: `WhatsApp rate-limited @username lookups (${errText || '429'}). Wait before retrying.`
      };
    }
    if (errCode === 404 || /item-not-found|not.?found/i.test(errText)) {
      return {
        success: false,
        code: 404,
        error: pin
          ? `@${username} was not found on WhatsApp (or the 4-digit PIN was incorrect).`
          : `@${username} was not found on WhatsApp (or requires a 4-digit username PIN — pass "pin": "1234" or "@${username}#1234").`
      };
    }
    if (errCode === 408 || errCode === 500 || errCode === 503 || /timed?.?out|unavailable|connection closed/i.test(errText)) {
      return {
        success: false,
        code: 503,
        error: `WhatsApp could not resolve @${username} right now (${errText || errCode}). Try again shortly.`
      };
    }
    if (
      errCode === 401 ||
      errCode === 403 ||
      errCode === 406 ||
      errCode === 428 ||
      /pin|key|auth|forbidden|not-acceptable|precondition/i.test(errText)
    ) {
      return {
        success: false,
        code: 403,
        error: pin
          ? `WhatsApp rejected the 4-digit PIN for @${username} (${errText || errCode}). Confirm the PIN with the recipient.`
          : `@${username} requires a 4-digit WhatsApp username PIN. Ask for their PIN and pass "pin": "1234" (or "@${username}#1234").`
      };
    }
    return {
      success: false,
      code: 502,
      error: `WhatsApp USync error resolving @${username}: ${errText || errCode || 'unknown error'}`
    };
  }

  public async setPresence(
    recipient: string,
    presence: PresenceValue,
    pin?: string
  ): Promise<{ success: true } | { success: false; code: RecipientErrorCode; error: string }> {
    const precheck = this.precheckSend(recipient, pin);
    if (precheck) return precheck;
    const parsed = parseRecipientInput(recipient, pin);
    let targetJid: string;
    if (parsed.kind === 'jid') {
      targetJid = parsed.jid;
    } else {
      const resolved = await this.resolveRecipient(recipient, { pin });
      if (!resolved.success) return resolved;
      targetJid = resolved.jid;
    }
    const sock = this.sock;
    if (!sock || this.status !== 'connected') {
      return { success: false, code: 503, error: 'WhatsApp disconnected before the presence update could be sent.' };
    }
    try {
      await sock.sendPresenceUpdate(presence, targetJid);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Presence] Failed to set presence ${presence} for ${recipient}:`, err);
      return { success: false, code: 502, error: `Could not update presence: ${msg}` };
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

  /** Validates recipient/PIN format and connection state before any send, so bad input is always a 400. */
  private precheckSend(recipient: string, pin?: string): Extract<SendResult, { success: false }> | null {
    const parsed = parseRecipientInput(recipient, pin);
    if (parsed.kind === 'invalid') {
      return { success: false, code: 400, error: parsed.error };
    }
    if (!this.sock || this.status !== 'connected') {
      return { success: false, code: 503, error: 'WhatsApp is not connected yet. Scan the QR code or press Reconnect first.' };
    }
    return null;
  }

  /**
   * Sends through Baileys, then waits briefly for WhatsApp's server <ack class="message">, so immediate
   * server rejections (Error 463 cold-outreach restriction, Error 479, ...) fail with HTTP 502 instead of
   * falsely reporting "Sent". If no ack arrives in time the send is reported as successful, and a later
   * status=ERROR update (see handleMessageUpdates) rolls the dashboard record back to "Failed".
   */
  private async dispatchOutboundMessage(params: {
    resolved: Extract<ResolveRecipientResult, { success: true }>;
    content: Parameters<WASocket['sendMessage']>[1];
    summaryText: string;
    messageType?: string;
    quotedMessageId?: string;
    inReplyTo?: string;
    source?: 'hermes' | 'api';
    ackTimeoutMs?: number;
  }): Promise<SendResult> {
    const sock = this.sock;
    if (!sock || this.status !== 'connected') {
      return { success: false, code: 503, error: 'WhatsApp is not connected yet. Scan the QR code or press Reconnect first.' };
    }

    const { jid, isGroup, displayRecipient } = params.resolved;
    const quoted = params.quotedMessageId ? this.rawMessages.get(params.quotedMessageId) : undefined;
    // Pre-generate the id so the ack listener is attached before the stanza goes out
    const outboundId = generateMessageIDV2(sock.user?.id);
    const ackTimeoutMs = params.ackTimeoutMs ?? OUTBOUND_ACK_TIMEOUT_MS;

    let ackListener: ((node: BinaryNode) => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const ackPromise = new Promise<{ error?: string } | null>((resolve) => {
      ackListener = (node: BinaryNode) => {
        if (node?.tag !== 'ack' || node.attrs?.class !== 'message') return;
        resolve({ error: node.attrs?.error || undefined });
      };
      sock.ws.on(`TAG:${outboundId}`, ackListener);
    });

    try {
      const result = await sock.sendMessage(jid, params.content, {
        messageId: outboundId,
        ...(quoted ? { quoted } : {})
      });
      const messageId = result?.key?.id ?? outboundId;

      // Ack window starts after the upload/relay finished, so large media is not cut short
      const ack = await Promise.race([
        ackPromise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ackTimeoutMs);
        })
      ]);

      if (ack?.error) {
        const error = describeOutboundAckError(ack.error, displayRecipient);
        const ackDate = new Date();
        this.addRecentMessage({
          id: messageId,
          sender: params.source === 'hermes' ? 'Hermes Agent' : 'Dashboard / API',
          recipient: displayRecipient,
          content: params.summaryText,
          timestamp: this.formatDateTime(ackDate),
          isoTimestamp: ackDate.toISOString(),
          fromMe: true,
          isGroup,
          ...(params.messageType ? { messageType: params.messageType } : {}),
          deliveryError: error
        });
        return { success: false, code: 502, error };
      }

      this.stats.sentCount++;
      if (params.source === 'hermes') {
        const answeredId = this.linkHermesReply(jid, params.summaryText, params.inReplyTo ?? params.quotedMessageId);
        if (answeredId) {
          this.hermesReplyLinks.set(messageId, answeredId);
          if (this.hermesReplyLinks.size > MAX_CACHED_MESSAGES) {
            const oldest = this.hermesReplyLinks.keys().next().value;
            if (oldest) this.hermesReplyLinks.delete(oldest);
          }
        }
      }
      const sentDate = new Date();
      this.addRecentMessage({
        id: messageId,
        sender: params.source === 'hermes' ? 'Hermes Agent' : 'Dashboard / API',
        recipient: displayRecipient,
        content: params.summaryText,
        timestamp: this.formatDateTime(sentDate),
        isoTimestamp: sentDate.toISOString(),
        fromMe: true,
        isGroup,
        ...(params.messageType ? { messageType: params.messageType } : {})
      });

      return { success: true, messageId, jid };
    } catch (err: unknown) {
      return { success: false, code: 502, error: this.formatSendError(err, displayRecipient) };
    } finally {
      if (timer) clearTimeout(timer);
      if (ackListener) sock.ws.off(`TAG:${outboundId}`, ackListener);
    }
  }

  /** Rolls back optimistic "Sent" records when WhatsApp later reports a delivery error for them. */
  private handleMessageUpdates(updates: WAMessageUpdate[]): void {
    let changed = false;
    for (const { key, update } of updates) {
      if (!key?.fromMe || !key.id || update?.status !== WAMessageStatus.ERROR) continue;
      const record = this.recentMessages.find((m) => m.fromMe && m.id === key.id);
      if (!record || record.deliveryError) continue;
      const code = String(update.messageStubParameters?.[0] ?? 'unknown');
      record.deliveryError = describeOutboundAckError(code, record.recipient);
      this.stats.sentCount = Math.max(0, this.stats.sentCount - 1);
      changed = true;

      // If this was a Hermes reply, the inbound message it answered was not actually answered
      const answeredId = this.hermesReplyLinks.get(key.id);
      if (answeredId) {
        this.hermesReplyLinks.delete(key.id);
        const inbound = this.recentMessages.find((m) => !m.fromMe && m.id === answeredId);
        if (inbound && inbound.webhookStatus === 'replied') {
          inbound.webhookStatus = 'failed';
          inbound.webhookError = `Reply was rejected by WhatsApp: ${record.deliveryError}`;
          this.stats.hermesRepliesCount = Math.max(0, this.stats.hermesRepliesCount - 1);
        }
      }
      console.warn(`[WhatsApp] Message ${key.id} to ${record.recipient} was rejected by WhatsApp (error ${code}).`);
    }
    if (changed) {
      this.scheduleActivitySave();
    }
  }

  public async sendMessage(
    recipient: string,
    messageText: string,
    opts: {
      /** Optional 4-digit WhatsApp username PIN when messaging an unknown @username. */
      pin?: string;
      /** Inbound message to quote in the reply. */
      quotedMessageId?: string;
      /** Inbound message this reply answers (marks it "replied" in the dashboard). */
      inReplyTo?: string;
      source?: 'hermes' | 'api';
    } = {}
  ): Promise<SendResult> {
    if (!recipient?.trim() || !messageText?.trim()) {
      return { success: false, code: 400, error: 'Recipient and message text are required' };
    }
    const precheck = this.precheckSend(recipient, opts.pin);
    if (precheck) return precheck;

    const resolved = await this.resolveRecipient(recipient, { pin: opts.pin });
    if (!resolved.success) {
      return resolved;
    }

    const textToSend = formatWhatsAppText(messageText);
    return this.dispatchOutboundMessage({
      resolved,
      content: { text: textToSend },
      summaryText: textToSend,
      quotedMessageId: opts.quotedMessageId,
      inReplyTo: opts.inReplyTo,
      source: opts.source
    });
  }

  public async sendImage(
    recipient: string,
    imageUrl: string,
    caption?: string,
    opts: {
      /** Optional 4-digit WhatsApp username PIN when messaging an unknown @username. */
      pin?: string;
      /** Inbound message to quote in the reply. */
      quotedMessageId?: string;
      /** Inbound message this reply answers (marks it "replied" in the dashboard). */
      inReplyTo?: string;
      source?: 'hermes' | 'api';
    } = {}
  ): Promise<SendResult> {
    if (!recipient?.trim() || !imageUrl?.trim()) {
      return { success: false, code: 400, error: 'Recipient and image URL are required' };
    }
    const precheck = this.precheckSend(recipient, opts.pin);
    if (precheck) return precheck;

    const resolved = await this.resolveRecipient(recipient, { pin: opts.pin });
    if (!resolved.success) {
      return resolved;
    }

    const cleanImageUrl = imageUrl.trim();
    let resolvedMedia: { buffer: Buffer; mimetype?: string; fileName?: string };
    try {
      resolvedMedia = await resolveMediaInput(cleanImageUrl);
    } catch (err: unknown) {
      if (err instanceof MediaResolutionError) {
        return { success: false, code: err.statusCode, error: err.message };
      }
      return { success: false, code: 400, error: err instanceof Error ? err.message : String(err) };
    }

    const cleanCaption = caption?.trim() ? formatWhatsAppText(caption.trim()) : undefined;
    const summaryText = cleanCaption
      ? `[Image] ${cleanCaption}`
      : cleanImageUrl.startsWith('data:')
        ? '[Image]'
        : `[Image] ${resolvedMedia.fileName ?? cleanImageUrl}`;

    return this.dispatchOutboundMessage({
      resolved,
      content: {
        image: resolvedMedia.buffer,
        ...(resolvedMedia.mimetype ? { mimetype: resolvedMedia.mimetype } : {}),
        ...(cleanCaption ? { caption: cleanCaption } : {})
      },
      summaryText,
      messageType: 'image',
      quotedMessageId: opts.quotedMessageId,
      inReplyTo: opts.inReplyTo,
      source: opts.source
    });
  }

  public async sendDocument(
    recipient: string,
    documentUrl: string,
    opts: {
      /** Optional 4-digit WhatsApp username PIN when messaging an unknown @username. */
      pin?: string;
      fileName?: string;
      mimetype?: string;
      caption?: string;
      /** Inbound message to quote in the reply. */
      quotedMessageId?: string;
      /** Inbound message this reply answers (marks it "replied" in the dashboard). */
      inReplyTo?: string;
      source?: 'hermes' | 'api';
    } = {}
  ): Promise<SendResult> {
    if (!recipient?.trim() || !documentUrl?.trim()) {
      return { success: false, code: 400, error: 'Recipient and document URL are required' };
    }
    const precheck = this.precheckSend(recipient, opts.pin);
    if (precheck) return precheck;

    const resolved = await this.resolveRecipient(recipient, { pin: opts.pin });
    if (!resolved.success) {
      return resolved;
    }

    const cleanCaption = opts.caption?.trim() ? formatWhatsAppText(opts.caption.trim()) : undefined;
    const cleanFileName = opts.fileName?.trim();
    const cleanUrl = documentUrl.trim();

    let resolvedMedia: { buffer: Buffer; mimetype?: string; fileName?: string };
    try {
      resolvedMedia = await resolveMediaInput(cleanUrl);
    } catch (err: unknown) {
      if (err instanceof MediaResolutionError) {
        return { success: false, code: err.statusCode, error: err.message };
      }
      return { success: false, code: 400, error: err instanceof Error ? err.message : String(err) };
    }

    // Determine filename if not provided
    let resolvedFileName = cleanFileName || resolvedMedia.fileName;
    if (!resolvedFileName) {
      if (cleanUrl.startsWith('data:')) {
        const mimeMatch = resolvedMedia.mimetype ?? cleanUrl.match(/^data:([^;,]+)/)?.[1];
        let ext = 'bin';
        if (mimeMatch === 'application/pdf') ext = 'pdf';
        else if (mimeMatch === 'text/plain') ext = 'txt';
        else if (mimeMatch === 'text/markdown') ext = 'md';
        else if (mimeMatch === 'application/json') ext = 'json';
        else if (mimeMatch?.includes('/')) ext = mimeMatch.split('/')[1].split('+')[0];
        resolvedFileName = `document.${ext}`;
      } else {
        const candidate = cleanUrl.split('/').pop()?.split('?')[0]?.split('#')[0];
        resolvedFileName = candidate && candidate.trim() ? candidate.trim() : 'document';
      }
    }

    const mimetype = opts.mimetype?.trim() || resolvedMedia.mimetype || inferDocumentMimetype(resolvedFileName);

    const summaryText = cleanCaption
      ? `[Document: ${resolvedFileName}] ${cleanCaption}`
      : `[Document: ${resolvedFileName}]`;

    return this.dispatchOutboundMessage({
      resolved,
      content: {
        document: resolvedMedia.buffer,
        mimetype,
        fileName: resolvedFileName,
        ...(cleanCaption ? { caption: cleanCaption } : {})
      },
      summaryText,
      messageType: 'document',
      quotedMessageId: opts.quotedMessageId,
      inReplyTo: opts.inReplyTo,
      source: opts.source
    });
  }

  public async sendSticker(
    recipient: string,
    sticker: string | Buffer,
    opts: {
      /** Optional 4-digit WhatsApp username PIN when messaging an unknown @username. */
      pin?: string;
      pack?: string;
      author?: string;
      categories?: string[];
      isAnimated?: boolean;
      /** Inbound message to quote in the reply. */
      quotedMessageId?: string;
      /** Inbound message this reply answers (marks it "replied" in the dashboard). */
      inReplyTo?: string;
      source?: 'hermes' | 'api';
    } = {}
  ): Promise<SendResult> {
    if (!recipient?.trim() || !sticker || (typeof sticker === 'string' && !sticker.trim())) {
      return { success: false, code: 400, error: 'Recipient and sticker (URL, file path, base64, or Buffer) are required' };
    }
    const precheck = this.precheckSend(recipient, opts.pin);
    if (precheck) return precheck;

    const resolved = await this.resolveRecipient(recipient, { pin: opts.pin });
    if (!resolved.success) {
      return resolved;
    }

    let stickerBuffer: Buffer;
    try {
      stickerBuffer = await prepareSticker(sticker, {
        pack: opts.pack,
        author: opts.author,
        categories: opts.categories,
        isAnimated: opts.isAnimated
      });
    } catch (err: unknown) {
      if (err instanceof MediaResolutionError) {
        return { success: false, code: err.statusCode, error: err.message };
      }
      return { success: false, code: 400, error: `Failed to prepare sticker: ${err instanceof Error ? err.message : String(err)}` };
    }

    return this.dispatchOutboundMessage({
      resolved,
      content: {
        sticker: stickerBuffer,
        ...(typeof opts.isAnimated === 'boolean' ? { isAnimated: opts.isAnimated } : {})
      },
      summaryText: '[Sticker]',
      messageType: 'sticker',
      quotedMessageId: opts.quotedMessageId,
      inReplyTo: opts.inReplyTo,
      source: opts.source
    });
  }

  /** Downloads the media of a recently received message (the last few hundred are kept in memory). */
  public async downloadMedia(
    messageId: string
  ): Promise<{ success: true; buffer: Buffer; mimetype: string; fileName?: string } | { success: false; error: string; code: number }> {
    const inflight = this.pendingMediaDownloads.get(messageId);
    if (inflight) return inflight;

    const task = (async (): Promise<
      { success: true; buffer: Buffer; mimetype: string; fileName?: string } | { success: false; error: string; code: number }
    > => {
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
      if (parsed.fileLength !== undefined && parsed.fileLength > config.maxMediaBytes) {
        return {
          success: false,
          code: 413,
          error: `Inbound media (${parsed.fileLength} bytes) exceeds MAX_MEDIA_BYTES (${config.maxMediaBytes} bytes)`
        };
      }
      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: this.logger, reuploadRequest: this.sock.updateMediaMessage }
        );
        if (buffer.length > config.maxMediaBytes) {
          return {
            success: false,
            code: 413,
            error: `Inbound media (${buffer.length} bytes) exceeds MAX_MEDIA_BYTES (${config.maxMediaBytes} bytes)`
          };
        }
        return {
          success: true,
          buffer,
          mimetype: parsed.mimetype || 'application/octet-stream',
          ...(parsed.fileName ? { fileName: parsed.fileName } : {})
        };
      } catch (err: unknown) {
        return { success: false, code: 502, error: err instanceof Error ? err.message : String(err) };
      }
    })();

    this.pendingMediaDownloads.set(messageId, task);
    try {
      return await task;
    } finally {
      this.pendingMediaDownloads.delete(messageId);
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  public setForwardingEnabled(enabled: boolean): void {
    this.settings = { ...this.settings, forwardingEnabled: enabled };
    saveSettings(this.settings);
    this.notifyStateChange();
  }

  public getState(): WhatsAppClientState {
    return {
      status: this.status,
      qrCodeDataUrl: this.qrCodeDataUrl,
      user: this.user,
      lastConnectedAt: this.lastConnectedAt,
      lastConnectedIso: this.lastConnectedIso,
      lastError: this.lastError,
      stateVersion: this.stateVersion,
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
