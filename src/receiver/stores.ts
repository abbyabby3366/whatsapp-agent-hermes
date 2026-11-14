import fs from 'fs';
import path from 'path';
import { formatDateTimeParts } from '../formatting.js';
import { normalizeDigits } from './config.js';

function writeJsonAtomicSync(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error if temp file was never created
    }
    throw err;
  }
}

/**
 * Loads a JSON file strictly: missing files (`ENOENT`) return `emptyFactory()`,
 * while corrupt or unreadable existing files throw explicitly instead of masking bugs.
 */
function readJsonStrict<T>(filePath: string, emptyFactory: () => T, validate?: (parsed: unknown) => parsed is T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return emptyFactory();
    }
    throw new Error(`[Store] Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`[Store] Corrupt JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (validate && !validate(parsed)) {
    throw new Error(`[Store] Invalid JSON schema in ${filePath}`);
  }
  return parsed as T;
}

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
  typeof val === 'object' && val !== null && !Array.isArray(val);

function getFileFingerprint(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. Canonical Contact Identity Store (chat_map.json)
// ---------------------------------------------------------------------------

export interface ChatIdentityRecord {
  chatKey: string;
  chatJids: string[];
  phone?: string;
  username?: string;
  lid?: string;
  name?: string;
  isGroup: boolean;
  updatedAt: string;
}

interface ChatMapFileData {
  records: Record<string, ChatIdentityRecord>;
}

function keyRank(key: string): number {
  if (!key) return 0;
  if (key.includes('@g.us') || key.includes('@')) {
    return key.startsWith('@') ? 2 : 0;
  }
  if (/^\d{7,14}$/.test(key)) return 3; // Phone digits (E.164 max 15, usually <= 14; check record fields primarily)
  return 1;
}

function stripDeviceSuffix(jid: string): string {
  const atIdx = jid.indexOf('@');
  if (atIdx === -1) return jid;
  const user = jid.slice(0, atIdx).split(':')[0];
  const domain = jid.slice(atIdx + 1).toLowerCase();
  return `${user}@${domain}`;
}

export class ChatMapStore {
  private readonly filePath: string;
  private records = new Map<string, ChatIdentityRecord>();
  private byJid = new Map<string, string>();
  private byPhone = new Map<string, string>();
  private byUsername = new Map<string, string>();
  private byLid = new Map<string, string>();
  private lastFingerprint: string | null = null;

  constructor(dataDir: string, private readonly defaultCountryCode = '60') {
    this.filePath = path.join(dataDir, 'chat_map.json');
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const data = readJsonStrict<ChatMapFileData>(
      this.filePath,
      () => ({ records: {} }),
      (v): v is ChatMapFileData => isPlainObject(v) && isPlainObject(v.records)
    );
    this.records.clear();
    for (const [key, rec] of Object.entries(data.records)) {
      if (rec && typeof rec.chatKey === 'string') {
        this.records.set(key, rec);
      }
    }
    this.rebuildIndexes();
    this.lastFingerprint = getFileFingerprint(this.filePath);
  }

  private syncFromDisk(): void {
    const current = getFileFingerprint(this.filePath);
    if (current !== this.lastFingerprint) {
      this.loadFromDisk();
    }
  }

  private rebuildIndexes(): void {
    this.byJid.clear();
    this.byPhone.clear();
    this.byUsername.clear();
    this.byLid.clear();

    for (const rec of this.records.values()) {
      for (const jid of rec.chatJids) {
        this.byJid.set(jid, rec.chatKey);
      }
      if (rec.phone) this.byPhone.set(rec.phone, rec.chatKey);
      if (rec.username) this.byUsername.set(rec.username.toLowerCase(), rec.chatKey);
      if (rec.lid) this.byLid.set(rec.lid, rec.chatKey);
    }
  }

  private persist(): void {
    const out: Record<string, ChatIdentityRecord> = {};
    for (const [k, v] of this.records.entries()) {
      out[k] = v;
    }
    writeJsonAtomicSync(this.filePath, { records: out });
    this.lastFingerprint = getFileFingerprint(this.filePath);
  }

  public get(chatKey: string): ChatIdentityRecord | undefined {
    this.syncFromDisk();
    return this.records.get(chatKey);
  }

  public resolveKey(target: string): { chatKey?: string; record?: ChatIdentityRecord } {
    this.syncFromDisk();
    const clean = target.trim();
    if (!clean) return {};
    if (this.records.has(clean)) {
      const rec = this.records.get(clean);
      return { chatKey: clean, record: rec };
    }
    if (clean.includes('@')) {
      const bare = stripDeviceSuffix(clean);
      const key = this.byJid.get(bare);
      if (key) return { chatKey: key, record: this.records.get(key) };
      if (clean.startsWith('@')) {
        const handle = clean.slice(1).split('#')[0].toLowerCase();
        const k2 = this.byUsername.get(handle);
        if (k2) return { chatKey: k2, record: this.records.get(k2) };
      }
      if (bare.endsWith('@lid')) {
        const lidDigits = bare.slice(0, bare.indexOf('@'));
        const k3 = this.byLid.get(lidDigits);
        if (k3) return { chatKey: k3, record: this.records.get(k3) };
      }
    }
    const digits = normalizeDigits(clean, this.defaultCountryCode);
    if (digits) {
      const byP = this.byPhone.get(digits);
      if (byP) return { chatKey: byP, record: this.records.get(byP) };
      const byL = this.byLid.get(digits);
      if (byL) return { chatKey: byL, record: this.records.get(byL) };
    }
    return {};
  }

  public upsertInbound(input: {
    chatJid: string;
    senderJid?: string | null;
    sender?: string | null;
    senderUsername?: string | null;
    senderName?: string | null;
    isGroup: boolean;
  }): { chatKey: string; previousKeys: string[]; record: ChatIdentityRecord } {
    this.syncFromDisk();
    const chatJid = stripDeviceSuffix(input.chatJid);
    const senderJid = input.senderJid ? stripDeviceSuffix(input.senderJid) : '';
    const nowIso = new Date().toISOString();

    if (input.isGroup || chatJid.endsWith('@g.us')) {
      const existing = this.records.get(chatJid);
      const record: ChatIdentityRecord = existing
        ? {
            ...existing,
            chatJids: Array.from(new Set([...existing.chatJids, chatJid])),
            name: input.senderName ?? existing.name,
            updatedAt: nowIso
          }
        : {
            chatKey: chatJid,
            chatJids: [chatJid],
            name: input.senderName ?? undefined,
            isGroup: true,
            updatedAt: nowIso
          };
      this.records.set(chatJid, record);
      this.rebuildIndexes();
      this.persist();
      return { chatKey: chatJid, previousKeys: [], record };
    }

    const lid =
      (senderJid.endsWith('@lid') ? senderJid.slice(0, senderJid.indexOf('@')) : '') ||
      (chatJid.endsWith('@lid') ? chatJid.slice(0, chatJid.indexOf('@')) : '');

    let phone = '';
    if (input.sender && /^\+?[0-9\s-]{7,15}$/.test(input.sender)) {
      phone = normalizeDigits(input.sender, this.defaultCountryCode);
    } else if (senderJid.endsWith('@s.whatsapp.net')) {
      phone = senderJid.slice(0, senderJid.indexOf('@'));
    } else if (chatJid.endsWith('@s.whatsapp.net')) {
      phone = chatJid.slice(0, chatJid.indexOf('@'));
    }
    if (lid && phone === lid) {
      phone = '';
    }

    const username = input.senderUsername ? input.senderUsername.replace(/^@+/, '').toLowerCase() : '';

    // Find all existing keys linked to any of these identifiers (usually 0 or 1, occasionally 2 if username was known before LID)
    const matchedKeys = new Set<string>();
    const jidMatch = this.byJid.get(chatJid) || (senderJid ? this.byJid.get(senderJid) : undefined);
    if (jidMatch) matchedKeys.add(jidMatch);
    if (phone && this.byPhone.has(phone)) matchedKeys.add(this.byPhone.get(phone)!);
    if (username && this.byUsername.has(username)) {
      const ownerKey = this.byUsername.get(username)!;
      // Only treat same-person if JID doesn't conflict with another distinct known phone/LID
      const existingOwner = this.records.get(ownerKey);
      if (existingOwner && !existingOwner.phone && !existingOwner.lid) {
        matchedKeys.add(ownerKey);
      } else if (existingOwner && ((phone && existingOwner.phone === phone) || (lid && existingOwner.lid === lid))) {
        matchedKeys.add(ownerKey);
      } else if (existingOwner && !matchedKeys.size) {
        // Handle was reassigned to a different JID; evict stale handle from the old record
        delete existingOwner.username;
      }
    }
    if (lid && this.byLid.has(lid)) matchedKeys.add(this.byLid.get(lid)!);

    let mergedPhone = phone;
    let mergedUsername = username;
    let mergedLid = lid;
    let mergedName = input.senderName ?? undefined;
    const jids = new Set<string>([chatJid]);
    if (senderJid && !senderJid.endsWith('@g.us')) jids.add(senderJid);

    for (const k of matchedKeys) {
      const rec = this.records.get(k);
      if (!rec) continue;
      for (const j of rec.chatJids) jids.add(j);
      if (!mergedPhone && rec.phone) mergedPhone = rec.phone;
      if (!mergedUsername && rec.username) mergedUsername = rec.username;
      if (!mergedLid && rec.lid) mergedLid = rec.lid;
      if (!mergedName && rec.name) mergedName = rec.name;
    }

    // Best canonical key priority: phone > @username > lid > chatJid
    const candidateKey =
      mergedPhone || (mergedUsername ? `@${mergedUsername}` : '') || mergedLid || chatJid;

    // Never demote an existing higher-rank canonical key
    let finalKey = candidateKey;
    const rankOfRecord = (rec: ChatIdentityRecord): number =>
      rec.phone && rec.chatKey === rec.phone
        ? 3
        : rec.username && rec.chatKey === `@${rec.username}`
          ? 2
          : rec.lid && rec.chatKey === rec.lid
            ? 1
            : keyRank(rec.chatKey);

    let bestExistingRank = -1;
    let bestExistingKey = candidateKey;
    for (const k of matchedKeys) {
      const rec = this.records.get(k);
      if (rec) {
        const r = rankOfRecord(rec);
        if (r > bestExistingRank) {
          bestExistingRank = r;
          bestExistingKey = k;
        }
      }
    }
    const candidateRank = mergedPhone ? 3 : mergedUsername ? 2 : mergedLid ? 1 : 0;
    if (bestExistingRank > candidateRank && matchedKeys.size > 0) {
      finalKey = bestExistingKey;
    }

    const previousKeys: string[] = [];
    for (const oldKey of matchedKeys) {
      if (oldKey !== finalKey) {
        previousKeys.push(oldKey);
        this.records.delete(oldKey);
      }
    }

    const finalRecord: ChatIdentityRecord = {
      chatKey: finalKey,
      chatJids: Array.from(jids),
      ...(mergedPhone ? { phone: mergedPhone } : {}),
      ...(mergedUsername ? { username: mergedUsername } : {}),
      ...(mergedLid ? { lid: mergedLid } : {}),
      ...(mergedName ? { name: mergedName } : {}),
      isGroup: false,
      updatedAt: nowIso
    };

    this.records.set(finalKey, finalRecord);
    this.rebuildIndexes();
    this.persist();
    return { chatKey: finalKey, previousKeys, record: finalRecord };
  }

  public recordOutboundResolution(
    target: string,
    resolvedJid: string
  ): { chatKey: string; previousKeys: string[]; record: ChatIdentityRecord } {
    this.syncFromDisk();
    const bare = stripDeviceSuffix(resolvedJid);
    const cleanTarget = target.trim();
    const isGroup = bare.endsWith('@g.us');
    const username = !isGroup && cleanTarget.startsWith('@')
      ? cleanTarget.slice(1).split('#')[0].replace(/^@+/, '').toLowerCase()
      : undefined;
    const phone = !isGroup && /^\+?[0-9\s-]{7,15}$/.test(cleanTarget)
      ? normalizeDigits(cleanTarget, this.defaultCountryCode)
      : undefined;

    return this.upsertInbound({
      chatJid: bare,
      ...(phone ? { sender: phone } : {}),
      ...(username ? { senderUsername: username } : {}),
      isGroup
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Handled Ledger (handled.json)
// ---------------------------------------------------------------------------

export type HandledOutcome = 'sent' | 'silent' | 'dry-run' | 'failed-502';

export interface HandledEntry {
  outcome: HandledOutcome;
  chatKey: string;
  at: string;
}

export class HandledLedger {
  private readonly filePath: string;
  private entries: Record<string, HandledEntry>;

  constructor(dataDir: string, private readonly maxEntries = 10_000) {
    this.filePath = path.join(dataDir, 'handled.json');
    this.entries = readJsonStrict<Record<string, HandledEntry>>(
      this.filePath,
      () => ({}),
      (v): v is Record<string, HandledEntry> => isPlainObject(v)
    );
  }

  public has(messageId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.entries, messageId);
  }

  public mark(messageId: string, outcome: HandledOutcome, chatKey: string): void {
    this.entries[messageId] = { outcome, chatKey, at: new Date().toISOString() };
    const keys = Object.keys(this.entries);
    if (keys.length > this.maxEntries) {
      for (const oldKey of keys.slice(0, keys.length - this.maxEntries)) {
        delete this.entries[oldKey];
      }
    }
    writeJsonAtomicSync(this.filePath, this.entries);
  }
}

// ---------------------------------------------------------------------------
// 3. Hermes Session Store (sessions.json)
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly filePath: string;
  private sessions: Record<string, string> = {};
  private lastFingerprint: string | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'sessions.json');
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    this.sessions = readJsonStrict<Record<string, string>>(
      this.filePath,
      () => ({}),
      (v): v is Record<string, string> => isPlainObject(v)
    );
    this.lastFingerprint = getFileFingerprint(this.filePath);
  }

  private syncFromDisk(): void {
    const current = getFileFingerprint(this.filePath);
    if (current !== this.lastFingerprint) {
      this.loadFromDisk();
    }
  }

  private persist(): void {
    writeJsonAtomicSync(this.filePath, this.sessions);
    this.lastFingerprint = getFileFingerprint(this.filePath);
  }

  public get(chatKey: string): string | undefined {
    this.syncFromDisk();
    const id = this.sessions[chatKey];
    return typeof id === 'string' && id.trim() ? id : undefined;
  }

  public set(chatKey: string, sessionId: string): void {
    this.syncFromDisk();
    if (!sessionId.trim()) return;
    this.sessions[chatKey] = sessionId.trim();
    this.persist();
  }

  public clear(chatKey: string): void {
    this.syncFromDisk();
    if (Object.prototype.hasOwnProperty.call(this.sessions, chatKey)) {
      delete this.sessions[chatKey];
      this.persist();
    }
  }

  public migrateKey(oldKey: string, newKey: string): void {
    this.syncFromDisk();
    if (!oldKey || !newKey || oldKey === newKey) return;
    if (Object.prototype.hasOwnProperty.call(this.sessions, oldKey)) {
      if (!this.sessions[newKey]) {
        this.sessions[newKey] = this.sessions[oldKey];
      }
      delete this.sessions[oldKey];
      this.persist();
    }
  }

  public count(): number {
    this.syncFromDisk();
    return Object.keys(this.sessions).length;
  }
}

// ---------------------------------------------------------------------------
// 4. Runtime Toggle & Quota State Store (state.json)
// ---------------------------------------------------------------------------

export interface PausedContactEntry {
  pausedAt: string;
  untilIso?: string;
  reason?: string;
}

interface StateFileData {
  autoReplyEnabled: boolean;
  masterLid?: string;
  pausedContacts: Record<string, PausedContactEntry>;
  replyTimestampsByChat: Record<string, number[]>;
  globalReplyTimestamps: number[];
}

export class RuntimeStateStore {
  private readonly filePath: string;
  private state!: StateFileData;
  private lastFingerprint: string | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'state.json');
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    this.state = readJsonStrict<StateFileData>(
      this.filePath,
      () => ({
        autoReplyEnabled: true,
        pausedContacts: {},
        replyTimestampsByChat: {},
        globalReplyTimestamps: []
      }),
      (v): v is StateFileData => isPlainObject(v) && typeof v.autoReplyEnabled === 'boolean' && isPlainObject(v.pausedContacts)
    );
    if (!isPlainObject(this.state.replyTimestampsByChat)) this.state.replyTimestampsByChat = {};
    if (!Array.isArray(this.state.globalReplyTimestamps)) this.state.globalReplyTimestamps = [];
    this.lastFingerprint = getFileFingerprint(this.filePath);
  }

  private syncFromDisk(): void {
    const current = getFileFingerprint(this.filePath);
    if (current !== this.lastFingerprint) {
      this.loadFromDisk();
    }
  }

  private persist(): void {
    writeJsonAtomicSync(this.filePath, this.state);
    this.lastFingerprint = getFileFingerprint(this.filePath);
  }

  public isAutoReplyEnabled(): boolean {
    this.syncFromDisk();
    return this.state.autoReplyEnabled;
  }

  public setAutoReplyEnabled(enabled: boolean): void {
    this.syncFromDisk();
    this.state.autoReplyEnabled = enabled;
    this.persist();
  }

  public getMasterLid(): string {
    this.syncFromDisk();
    return this.state.masterLid || '';
  }

  public setMasterLid(lidDigits: string): void {
    this.syncFromDisk();
    const clean = lidDigits.replace(/[^0-9]/g, '');
    if (clean && clean !== this.state.masterLid) {
      this.state.masterLid = clean;
      this.persist();
    }
  }

  public isContactPaused(chatKey: string, nowMs = Date.now()): { paused: boolean; entry?: PausedContactEntry } {
    this.syncFromDisk();
    const entry = this.state.pausedContacts[chatKey];
    if (!entry) return { paused: false };
    if (entry.untilIso) {
      const untilMs = Date.parse(entry.untilIso);
      if (Number.isFinite(untilMs) && untilMs <= nowMs) {
        delete this.state.pausedContacts[chatKey];
        this.persist();
        return { paused: false };
      }
    }
    return { paused: true, entry };
  }

  public pauseContact(chatKey: string, durationMs?: number, reason?: string): PausedContactEntry {
    this.syncFromDisk();
    const now = Date.now();
    const entry: PausedContactEntry = {
      pausedAt: new Date(now).toISOString(),
      ...(durationMs && durationMs > 0 ? { untilIso: new Date(now + durationMs).toISOString() } : {}),
      ...(reason ? { reason } : {})
    };
    this.state.pausedContacts[chatKey] = entry;
    this.persist();
    return entry;
  }

  public resumeContact(chatKey: string): boolean {
    this.syncFromDisk();
    if (!Object.prototype.hasOwnProperty.call(this.state.pausedContacts, chatKey)) {
      return false;
    }
    delete this.state.pausedContacts[chatKey];
    this.persist();
    return true;
  }

  public listPausedContacts(nowMs = Date.now()): Array<{ chatKey: string; entry: PausedContactEntry }> {
    this.syncFromDisk();
    let changed = false;
    const active: Array<{ chatKey: string; entry: PausedContactEntry }> = [];
    for (const [key, entry] of Object.entries(this.state.pausedContacts)) {
      if (entry.untilIso) {
        const untilMs = Date.parse(entry.untilIso);
        if (Number.isFinite(untilMs) && untilMs <= nowMs) {
          delete this.state.pausedContacts[key];
          changed = true;
          continue;
        }
      }
      active.push({ chatKey: key, entry });
    }
    if (changed) this.persist();
    return active;
  }

  private pruneQuotas(nowMs = Date.now()): { mutated: boolean } {
    const oneHourAgo = nowMs - 3_600_000;
    const oneDayAgo = nowMs - 86_400_000;
    let mutated = false;

    const prunedGlobal = this.state.globalReplyTimestamps.filter((ts) => ts > oneHourAgo);
    if (prunedGlobal.length !== this.state.globalReplyTimestamps.length) {
      this.state.globalReplyTimestamps = prunedGlobal;
      mutated = true;
    }

    for (const [k, timestamps] of Object.entries(this.state.replyTimestampsByChat)) {
      const kept = timestamps.filter((ts) => ts > oneDayAgo);
      if (kept.length !== timestamps.length) {
        mutated = true;
        if (kept.length === 0) {
          delete this.state.replyTimestampsByChat[k];
        } else {
          this.state.replyTimestampsByChat[k] = kept;
        }
      }
    }

    return { mutated };
  }

  public canSendReply(
    chatKey: string,
    dailyLimitPerPerson: number,
    hourlyGlobalLimit: number,
    nowMs = Date.now()
  ): { allowed: true } | { allowed: false; reason: 'person_daily_limit' | 'global_hourly_limit'; count: number; limit: number } {
    this.syncFromDisk();
    const { mutated } = this.pruneQuotas(nowMs);
    if (mutated) this.persist();

    if (this.state.globalReplyTimestamps.length >= hourlyGlobalLimit) {
      return {
        allowed: false,
        reason: 'global_hourly_limit',
        count: this.state.globalReplyTimestamps.length,
        limit: hourlyGlobalLimit
      };
    }

    const personCount = (this.state.replyTimestampsByChat[chatKey] ?? []).length;
    if (personCount >= dailyLimitPerPerson) {
      return {
        allowed: false,
        reason: 'person_daily_limit',
        count: personCount,
        limit: dailyLimitPerPerson
      };
    }

    return { allowed: true };
  }

  public recordReplySent(chatKey: string, nowMs = Date.now()): void {
    this.syncFromDisk();
    this.pruneQuotas(nowMs);
    this.state.globalReplyTimestamps.push(nowMs);
    const list = this.state.replyTimestampsByChat[chatKey] ?? [];
    list.push(nowMs);
    this.state.replyTimestampsByChat[chatKey] = list;
    this.persist();
  }

  public getQuotaSnapshot(nowMs = Date.now()): { globalLastHour: number; trackedChatsLastDay: number } {
    this.syncFromDisk();
    this.pruneQuotas(nowMs);
    return {
      globalLastHour: this.state.globalReplyTimestamps.length,
      trackedChatsLastDay: Object.keys(this.state.replyTimestampsByChat).length
    };
  }

  public migrateKey(oldKey: string, newKey: string): void {
    this.syncFromDisk();
    if (!oldKey || !newKey || oldKey === newKey) return;
    let changed = false;
    if (this.state.pausedContacts[oldKey]) {
      if (!this.state.pausedContacts[newKey]) {
        this.state.pausedContacts[newKey] = this.state.pausedContacts[oldKey];
      }
      delete this.state.pausedContacts[oldKey];
      changed = true;
    }
    if (this.state.replyTimestampsByChat[oldKey]) {
      const merged = [
        ...(this.state.replyTimestampsByChat[newKey] ?? []),
        ...this.state.replyTimestampsByChat[oldKey]
      ].sort((a, b) => a - b);
      this.state.replyTimestampsByChat[newKey] = merged;
      delete this.state.replyTimestampsByChat[oldKey];
      changed = true;
    }
    if (changed) this.persist();
  }
}

// ---------------------------------------------------------------------------
// 5. Hot-Reloaded Contact Profiles Store (contacts.json)
// ---------------------------------------------------------------------------

export interface ContactProfile {
  name?: string;
  username?: string;
  relation?: string;
  auto_reply?: boolean;
  persona?: string;
  notes?: {
    what_we_know?: string;
    what_is_missing?: string;
    how_to_approach?: string;
  };
}

export class ContactsStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'contacts.json');
  }

  private readAll(): Record<string, ContactProfile> {
    return readJsonStrict<Record<string, ContactProfile>>(
      this.filePath,
      () => ({}),
      (v): v is Record<string, ContactProfile> => isPlainObject(v)
    );
  }

  public get(keys: { chatKey: string; username?: string; phone?: string; lid?: string }): ContactProfile | undefined {
    const all = this.readAll();
    const candidates = [
      keys.chatKey,
      keys.phone,
      keys.username ? `@${keys.username.replace(/^@+/, '').toLowerCase()}` : '',
      keys.username ? keys.username.replace(/^@+/, '').toLowerCase() : '',
      keys.lid
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (all[candidate]) return all[candidate];
    }

    if (keys.username) {
      const targetHandle = keys.username.replace(/^@+/, '').toLowerCase();
      for (const profile of Object.values(all)) {
        if (profile?.username?.replace(/^@+/, '').toLowerCase() === targetHandle) {
          return profile;
        }
      }
    }
    return undefined;
  }

  public migrateKey(oldKey: string, newKey: string): void {
    if (!oldKey || !newKey || oldKey === newKey || !fs.existsSync(this.filePath)) return;
    const all = this.readAll();
    if (all[oldKey]) {
      if (!all[newKey]) {
        all[newKey] = all[oldKey];
      }
      delete all[oldKey];
      writeJsonAtomicSync(this.filePath, all);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Per-Contact Flow Store (flows.json)
// ---------------------------------------------------------------------------

export interface FlowEvent {
  t: string;
  display: string;
  text: string;
}

export interface ContactFlow {
  name?: string;
  open: string[];
  facts: string[];
  events: FlowEvent[];
}

export class FlowStore {
  private readonly filePath: string;

  constructor(dataDir: string, private readonly timezone = 'Asia/Kuala_Lumpur') {
    this.filePath = path.join(dataDir, 'flows.json');
  }

  private readAll(): Record<string, ContactFlow> {
    return readJsonStrict<Record<string, ContactFlow>>(
      this.filePath,
      () => ({}),
      (v): v is Record<string, ContactFlow> => isPlainObject(v)
    );
  }

  private ensureEntry(all: Record<string, ContactFlow>, key: string, name?: string): ContactFlow {
    const existing = all[key];
    if (existing) {
      if (name && !existing.name) existing.name = name;
      if (!Array.isArray(existing.open)) existing.open = [];
      if (!Array.isArray(existing.facts)) existing.facts = [];
      if (!Array.isArray(existing.events)) existing.events = [];
      return existing;
    }
    const created: ContactFlow = {
      ...(name ? { name } : {}),
      open: [],
      facts: [],
      events: []
    };
    all[key] = created;
    return created;
  }

  public listContacts(): Array<{ key: string; flow: ContactFlow }> {
    const all = this.readAll();
    return Object.entries(all).map(([key, flow]) => ({ key, flow }));
  }

  public get(key: string): ContactFlow | undefined {
    const all = this.readAll();
    return all[key];
  }

  public addOpen(key: string, item: string, name?: string): ContactFlow {
    const all = this.readAll();
    const entry = this.ensureEntry(all, key, name);
    const trimmed = item.trim();
    if (trimmed && !entry.open.includes(trimmed)) {
      entry.open.push(trimmed);
      writeJsonAtomicSync(this.filePath, all);
    }
    return entry;
  }

  public closeOpen(key: string, item: string): { removed: boolean; flow?: ContactFlow } {
    const all = this.readAll();
    const entry = all[key];
    if (!entry) return { removed: false };
    const needle = item.trim().toLowerCase();
    const next = entry.open.filter((o) => o.trim().toLowerCase() !== needle && !o.trim().toLowerCase().includes(needle));
    if (next.length === entry.open.length) {
      return { removed: false, flow: entry };
    }
    entry.open = next;
    writeJsonAtomicSync(this.filePath, all);
    return { removed: true, flow: entry };
  }

  public addFact(key: string, fact: string, name?: string): ContactFlow {
    const all = this.readAll();
    const entry = this.ensureEntry(all, key, name);
    const trimmed = fact.trim();
    if (trimmed && !entry.facts.includes(trimmed)) {
      entry.facts.push(trimmed);
      writeJsonAtomicSync(this.filePath, all);
    }
    return entry;
  }

  public addEvent(key: string, text: string, name?: string): ContactFlow {
    const all = this.readAll();
    const entry = this.ensureEntry(all, key, name);
    const now = new Date();
    const parts = formatDateTimeParts(now, this.timezone);
    const trimmed = text.trim();
    if (trimmed) {
      entry.events.push({
        t: now.toISOString(),
        display: `${parts.date} ${parts.time.slice(0, 5)}`,
        text: trimmed
      });
      if (entry.events.length > 50) {
        entry.events = entry.events.slice(-50);
      }
      writeJsonAtomicSync(this.filePath, all);
    }
    return entry;
  }

  public migrateKey(oldKey: string, newKey: string): void {
    if (!oldKey || !newKey || oldKey === newKey || !fs.existsSync(this.filePath)) return;
    const all = this.readAll();
    const src = all[oldKey];
    if (!src) return;
    const dst = this.ensureEntry(all, newKey, src.name);
    for (const o of src.open ?? []) {
      if (!dst.open.includes(o)) dst.open.push(o);
    }
    for (const f of src.facts ?? []) {
      if (!dst.facts.includes(f)) dst.facts.push(f);
    }
    dst.events = [...(dst.events ?? []), ...(src.events ?? [])]
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
      .slice(-50);
    delete all[oldKey];
    writeJsonAtomicSync(this.filePath, all);
  }
}

// ---------------------------------------------------------------------------
// 7. Flag Outbox Store (outbox.json)
// ---------------------------------------------------------------------------

export interface OutboxFlagRecord {
  messageId: string;
  targetChatJid: string;
  targetChatKey: string;
  targetName?: string;
  summary: string;
  createdAt: string;
}

export class OutboxStore {
  private readonly filePath: string;
  private entries: Record<string, OutboxFlagRecord>;

  constructor(dataDir: string, private readonly maxEntries = 1000) {
    this.filePath = path.join(dataDir, 'outbox.json');
    this.entries = readJsonStrict<Record<string, OutboxFlagRecord>>(
      this.filePath,
      () => ({}),
      (v): v is Record<string, OutboxFlagRecord> => isPlainObject(v)
    );
  }

  public record(entry: OutboxFlagRecord): void {
    this.entries[entry.messageId] = entry;
    const keys = Object.keys(this.entries);
    if (keys.length > this.maxEntries) {
      for (const oldKey of keys.slice(0, keys.length - this.maxEntries)) {
        delete this.entries[oldKey];
      }
    }
    writeJsonAtomicSync(this.filePath, this.entries);
  }

  public get(messageId: string): OutboxFlagRecord | undefined {
    return this.entries[messageId];
  }
}
