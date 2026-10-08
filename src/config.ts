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

const listFromEnv = (name: string): string[] =>
  (process.env[name] ?? '')
    .split(',')
    .map((v) => v.replace(/[^0-9]/g, ''))
    .filter(Boolean);

export const config = {
  port: intFromEnv('PORT', 3100),
  /** Loopback by default: Hermes runs on the same server, so nothing else needs to reach the gateway. */
  host: process.env.HOST?.trim() || '127.0.0.1',
  sessionsDir: process.env.SESSIONS_DIR || './sessions',
  dataDir: process.env.DATA_DIR || './data',
  /** Optional key protecting /api/* (except /api/health). Send as "Authorization: Bearer <key>" or "x-api-key". */
  apiKey: process.env.GATEWAY_API_KEY?.trim() || '',
  webhookUrl: process.env.HERMES_WEBHOOK_URL?.trim() || '',
  webhookToken: process.env.HERMES_SECRET_TOKEN || '',
  webhookTimeoutMs: intFromEnv('HERMES_WEBHOOK_TIMEOUT_MS', 15000),
  webhookRetries: intFromEnv('HERMES_WEBHOOK_RETRIES', 2),
  /** Digits only. A number starting with 0 gets this country code instead (e.g. 60 for Malaysia). Empty disables. */
  defaultCountryCode: (process.env.DEFAULT_COUNTRY_CODE ?? '60').replace(/[^0-9]/g, ''),
  /** Comma-separated phone numbers. When set, only these senders are forwarded to Hermes. */
  allowedNumbers: listFromEnv('ALLOWED_NUMBERS'),
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
