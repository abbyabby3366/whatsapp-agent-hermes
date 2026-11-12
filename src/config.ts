import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const intFromEnv = (name: string, fallback: number): number => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

export const config = {
  port: intFromEnv('PORT', 3100),
  /** Loopback by default: the AI agent receiver runs on the same server, so nothing else needs to reach the gateway. */
  host: process.env.HOST?.trim() || '127.0.0.1',
  sessionsDir: process.env.SESSIONS_DIR || './sessions',
  dataDir: process.env.DATA_DIR || './data',
  /** Optional key protecting /api/* (except /api/health). Send as "Authorization: Bearer <key>" or "x-api-key". */
  apiKey: process.env.GATEWAY_API_KEY?.trim() || '',
  webhookUrl: process.env.AGENT_WEBHOOK_URL?.trim() || '',
  webhookToken: process.env.AGENT_SECRET_TOKEN || '',
  webhookTimeoutMs: intFromEnv('WEBHOOK_TIMEOUT_MS', 15000),
  webhookRetries: intFromEnv('WEBHOOK_RETRIES', 2),
  /** Digits only. A number starting with 0 gets this country code instead (e.g. 60 for Malaysia). Empty disables. */
  defaultCountryCode,
  /**
   * Comma-separated phone numbers and/or @usernames (e.g. "60123456789, @alex_tan").
   * When set, only these senders are forwarded to the AI agent.
   */
  allowedNumbers: allowedSendersFromEnv('ALLOWED_NUMBERS', defaultCountryCode),
  forwardGroups: boolFromEnv('FORWARD_GROUPS', true),
  /** IANA timezone used for the timestamps shown in the dashboard and sent in the webhook. */
  timezone: process.env.TIMEZONE?.trim() || 'Asia/Kuala_Lumpur'
};

export const isLoopbackHost = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1';

// --- Runtime settings (toggled from the dashboard, persisted across restarts) ---

export interface RuntimeSettings {
  forwardingEnabled: boolean;
}

const settingsFile = (): string => path.resolve(config.dataDir, 'settings.json');

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
  try {
    fs.mkdirSync(path.resolve(config.dataDir), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err: unknown) {
    console.error('[Settings] Could not persist settings:', err instanceof Error ? err.message : err);
  }
}
