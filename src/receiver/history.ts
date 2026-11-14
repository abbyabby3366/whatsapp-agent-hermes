import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { formatDateTimeParts } from '../formatting.js';

export interface InboundHistoryInput {
  chatKey: string;
  chatJid: string;
  messageId: string;
  senderName: string | null;
  senderNumber: string | null;
  body: string;
  isoTimestamp: string;
  rawTimestamp: number;
  payloadJson?: string | null;
}

export interface OutboundHistoryInput {
  chatKey: string;
  chatJid: string;
  inboundMessageId: string;
  chunkIndex: number;
  body: string;
  isoTimestamp?: string;
}

export interface HistoryRow {
  chatKey: string;
  chatJid: string;
  messageId: string;
  direction: 'in' | 'out';
  senderName: string | null;
  senderNumber: string | null;
  body: string;
  waTimestamp: string;
  rawTimestamp: number | null;
  storedAt: string;
  payloadJson: string | null;
}

export interface HistoryStats {
  totalMessages: number;
  inboundMessages: number;
  outboundMessages: number;
  totalChats: number;
}

export interface ChatSummaryRow {
  chatKey: string;
  messageCount: number;
  lastTimestamp: string;
  displayLastTimestamp: string;
  lastDirection: string;
  lastBody: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : null;
}

export class HistoryStore {
  public readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dataDir: string, private readonly timezone = 'Asia/Kuala_Lumpur') {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'wa_history.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL,
        chat_jid TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL UNIQUE,
        direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        sender_name TEXT,
        sender_number TEXT,
        body TEXT NOT NULL,
        wa_timestamp TEXT NOT NULL,
        raw_timestamp INTEGER,
        stored_at TEXT NOT NULL,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_key_id ON messages (chat_key, id);
      CREATE INDEX IF NOT EXISTS idx_messages_direction_raw_ts ON messages (direction, raw_timestamp);
    `);
  }

  public recordInbound(input: InboundHistoryInput): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (
        chat_key, chat_jid, message_id, direction, sender_name, sender_number,
        body, wa_timestamp, raw_timestamp, stored_at, payload_json
      ) VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      input.chatKey,
      input.chatJid,
      input.messageId,
      input.senderName,
      input.senderNumber,
      input.body,
      input.isoTimestamp,
      Math.trunc(input.rawTimestamp),
      new Date().toISOString(),
      input.payloadJson ?? null
    );
  }

  public recordOutbound(input: OutboundHistoryInput): void {
    const msgId =
      input.chunkIndex === 0 ? `out:${input.inboundMessageId}` : `out:${input.inboundMessageId}:${input.chunkIndex}`;
    const iso = input.isoTimestamp || new Date().toISOString();
    const rawTs = Math.floor(Date.parse(iso) / 1000);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        chat_key, chat_jid, message_id, direction, sender_name, sender_number,
        body, wa_timestamp, raw_timestamp, stored_at, payload_json
      ) VALUES (?, ?, ?, 'out', NULL, NULL, ?, ?, ?, ?, NULL)
    `);
    stmt.run(
      input.chatKey,
      input.chatJid,
      msgId,
      input.body,
      iso,
      Number.isFinite(rawTs) ? rawTs : Math.floor(Date.now() / 1000),
      new Date().toISOString()
    );
  }

  public getRecent(chatKey: string, limit: number, excludeMessageIds?: Set<string>): HistoryRow[] {
    if (limit <= 0) return [];
    const fetchCount = limit + (excludeMessageIds?.size ?? 0) + 10;
    const rows = this.db
      .prepare(`
        SELECT chat_key, chat_jid, message_id, direction, sender_name, sender_number,
               body, wa_timestamp, raw_timestamp, stored_at, payload_json
        FROM messages
        WHERE chat_key = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(chatKey, fetchCount)
      .map(mapRow);

    const filtered = excludeMessageIds?.size ? rows.filter((r) => !excludeMessageIds.has(r.messageId)) : rows;
    return filtered.slice(0, limit).reverse();
  }

  public formatRecentContext(chatKey: string, limit: number, excludeMessageIds?: Set<string>): string {
    const rows = this.getRecent(chatKey, limit, excludeMessageIds);
    if (rows.length === 0) return '';
    return rows
      .map((row) => {
        const dt = row.waTimestamp ? new Date(row.waTimestamp) : new Date();
        const parts = Number.isNaN(dt.getTime()) ? formatDateTimeParts(new Date(), this.timezone) : formatDateTimeParts(dt, this.timezone);
        const hm = parts.time.slice(0, 5);
        const dir = row.direction === 'in' ? 'IN' : 'OUT';
        return `[${parts.date} ${hm}] ${dir}: ${row.body}`;
      })
      .join('\n');
  }

  public findOrphans(cutoffRawTimestamp: number, isHandled: (messageId: string) => boolean): HistoryRow[] {
    const rows = this.db
      .prepare(`
        SELECT m.chat_key, m.chat_jid, m.message_id, m.direction, m.sender_name, m.sender_number,
               m.body, m.wa_timestamp, m.raw_timestamp, m.stored_at, m.payload_json
        FROM messages m
        WHERE m.direction = 'in'
          AND m.raw_timestamp IS NOT NULL
          AND m.raw_timestamp >= ?
          AND NOT EXISTS (
            SELECT 1 FROM messages o WHERE o.message_id = 'out:' || m.message_id
          )
        ORDER BY m.id ASC
      `)
      .all(Math.floor(cutoffRawTimestamp))
      .map(mapRow);

    return rows.filter((r) => !isHandled(r.messageId));
  }

  public migrateChatKey(oldKey: string, newKey: string): number {
    if (!oldKey || !newKey || oldKey === newKey) return 0;
    const res = this.db.prepare(`UPDATE messages SET chat_key = ? WHERE chat_key = ?`).run(newKey, oldKey);
    return Number(res.changes);
  }

  public stats(): HistoryStats {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS totalMessages,
          SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inboundMessages,
          SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outboundMessages,
          COUNT(DISTINCT chat_key) AS totalChats
        FROM messages
      `)
      .get();

    return {
      totalMessages: Number(row?.totalMessages ?? 0),
      inboundMessages: Number(row?.inboundMessages ?? 0),
      outboundMessages: Number(row?.outboundMessages ?? 0),
      totalChats: Number(row?.totalChats ?? 0)
    };
  }

  public listChats(limit = 50): ChatSummaryRow[] {
    const rows = this.db
      .prepare(`
        SELECT
          m.chat_key AS chat_key,
          COUNT(*) AS message_count,
          MAX(m.id) AS last_id
        FROM messages m
        GROUP BY m.chat_key
        ORDER BY last_id DESC
        LIMIT ?
      `)
      .all(limit);

    const lastStmt = this.db.prepare(`SELECT direction, body, wa_timestamp FROM messages WHERE id = ?`);
    return rows.map((row) => {
      const last = lastStmt.get(Number(row.last_id));
      const waTs = asString(last?.wa_timestamp);
      const dt = waTs ? new Date(waTs) : new Date();
      const parts = Number.isNaN(dt.getTime()) ? formatDateTimeParts(new Date(), this.timezone) : formatDateTimeParts(dt, this.timezone);
      return {
        chatKey: asString(row.chat_key),
        messageCount: Number(row.message_count ?? 0),
        lastTimestamp: waTs,
        displayLastTimestamp: `${parts.date} ${parts.time.slice(0, 5)}`,
        lastDirection: asString(last?.direction),
        lastBody: asString(last?.body)
      };
    });
  }

  public search(keyword: string, limit = 30): HistoryRow[] {
    const escaped = keyword.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    return this.db
      .prepare(`
        SELECT chat_key, chat_jid, message_id, direction, sender_name, sender_number,
               body, wa_timestamp, raw_timestamp, stored_at, payload_json
        FROM messages
        WHERE body LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\' OR chat_key LIKE ? ESCAPE '\\'
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, limit)
      .map(mapRow)
      .reverse();
  }

  public close(): void {
    if (this.db.isOpen) {
      this.db.close();
    }
  }
}

function mapRow(raw: Record<string, unknown>): HistoryRow {
  return {
    chatKey: asString(raw.chat_key),
    chatJid: asString(raw.chat_jid),
    messageId: asString(raw.message_id),
    direction: raw.direction === 'out' ? 'out' : 'in',
    senderName: asNullableString(raw.sender_name),
    senderNumber: asNullableString(raw.sender_number),
    body: asString(raw.body),
    waTimestamp: asString(raw.wa_timestamp),
    rawTimestamp: asNullableNumber(raw.raw_timestamp),
    storedAt: asString(raw.stored_at),
    payloadJson: asNullableString(raw.payload_json)
  };
}
