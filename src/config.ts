import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  formatDateTimeParts as formatDateTimePartsForZone,
  getDateTimeFormatter,
  isPlaceholderSecret
} from './formatting.js';
import { DebouncedJsonWriter } from './persistence.js';

export { isPlaceholderSecret };

const intFromEnv = (name: string, fallback: number): number => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const positiveIntFromEnv = (name: string, defaultValue: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[Config] ${name} must be a positive integer (got "${raw}").`);
  }
  return parsed;
};

const boolFromEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
};

/**
 * Parses ALLOWED_NUMBERS: phone numbers become digits (a leading 0 gets DEFAULT_COUNTRY_CODE),
 * while WhatsApp @username handles are kept as lowercase "@handle" (including handles with digits, e.g. @john99).
 * Entries containing letters are treated as handles even without the leading "@". Unusable entries are reported.
 */
const allowedSendersFromEnv = (name: string, defaultCountryCode: string): string[] => {
  const parsed: string[] = [];
  for (const rawEntry of (process.env[name] ?? '').split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (entry.startsWith('@') || /[a-z]/i.test(entry)) {
      const handle = entry.replace(/^@+/, '').toLowerCase();
      if (/^[a-z0-9._]{3,35}$/.test(handle) && /[a-z]/.test(handle)) {
        parsed.push(`@${handle}`);
        continue;
      }
    } else {
      let digits = entry.replace(/[^0-9]/g, '');
      if (digits.startsWith('0') && defaultCountryCode) {
        digits = defaultCountryCode + digits.substring(1);
      }
      if (digits.length >= 8 && digits.length <= 15) {
        parsed.push(digits);
        continue;
      }
    }
    console.warn(`[Config] Ignoring invalid ${name} entry "${entry}" (use a phone number like 60123456789 or a @username).`);
  }
  return parsed;
};

const defaultCountryCode = (process.env.DEFAULT_COUNTRY_CODE ?? '60').replace(/[^0-9]/g, '');
const dataDir = process.env.DATA_DIR || './data';
const timezone = process.env.TIMEZONE?.trim() || 'Asia/Kuala_Lumpur';

try {
  getDateTimeFormatter(timezone);
} catch {
  throw new Error(`[Config] Invalid TIMEZONE "${timezone}". Use a valid IANA timezone such as "Asia/Kuala_Lumpur".`);
}

export function formatDateTimeParts(
  date: Date = new Date(),
  timeZone: string = timezone
): { date: string; time: string; full: string } {
  return formatDateTimePartsForZone(date, timeZone);
}

const apiKey = process.env.GATEWAY_API_KEY?.trim() || '';
const webhookToken = process.env.HERMES_SECRET_TOKEN || '';

export const config = {
  port: intFromEnv('PORT', 3100),
  /** Loopback by default: Hermes runs on the same server, so nothing else needs to reach the gateway. */
  host: process.env.HOST?.trim() || '127.0.0.1',
  sessionsDir: process.env.SESSIONS_DIR || './sessions',
  dataDir,
  /** Optional key protecting /api/* (except /api/health). Send as "Authorization: Bearer <key>" or "x-api-key". */
  apiKey,
  hasPlaceholderApiKey: Boolean(apiKey) && isPlaceholderSecret(apiKey),
  webhookUrl: process.env.HERMES_WEBHOOK_URL?.trim() || '',
  webhookToken,
  hasPlaceholderWebhookToken: Boolean(webhookToken) && isPlaceholderSecret(webhookToken),
  webhookTimeoutMs: intFromEnv('HERMES_WEBHOOK_TIMEOUT_MS', 15000),
  webhookRetries: intFromEnv('HERMES_WEBHOOK_RETRIES', 2),
  webhookConcurrency: Math.max(1, intFromEnv('WEBHOOK_CONCURRENCY', 8)),
  /** Directory allowlisted for local file paths passed to outbound media APIs. */
  allowedMediaDir: path.resolve(process.env.ALLOWED_MEDIA_DIR?.trim() || path.join(dataDir, 'media')),
  maxMediaBytes: positiveIntFromEnv('MAX_MEDIA_BYTES', 25 * 1024 * 1024),
  mediaFetchTimeoutMs: positiveIntFromEnv('MEDIA_FETCH_TIMEOUT_MS', 15000),
  /** Digits only. A number starting with 0 gets this country code instead (e.g. 60 for Malaysia). Empty disables. */
  defaultCountryCode,
  /**
   * Comma-separated phone numbers and/or @usernames (e.g. "60123456789, @alex_tan").
   * When set, only these senders are forwarded to Hermes.
   */
  allowedNumbers: allowedSendersFromEnv('ALLOWED_NUMBERS', defaultCountryCode),
  forwardGroups: boolFromEnv('FORWARD_GROUPS', true),
  /** IANA timezone used for the timestamps shown in the dashboard and sent in the webhook. */
  timezone
};

export const isLoopbackHost = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1';

// --- Runtime settings (toggled from the dashboard, persisted across restarts) ---

export interface RuntimeSettings {
  forwardingEnabled: boolean;
}

const settingsFile = (): string => path.resolve(config.dataDir, 'settings.json');
const settingsWriter = new DebouncedJsonWriter<RuntimeSettings>(settingsFile(), 250, (err) => {
  console.error('[Settings] Could not persist settings:', err instanceof Error ? err.message : err);
});

export function loadSettings(): RuntimeSettings {
  const defaults: RuntimeSettings = { forwardingEnabled: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<RuntimeSettings>;
    return { forwardingEnabled: parsed.forwardingEnabled !== false };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: RuntimeSettings): void {
  settingsWriter.schedule(() => settings);
}

export async function flushSettings(): Promise<void> {
  await settingsWriter.flush();
}
