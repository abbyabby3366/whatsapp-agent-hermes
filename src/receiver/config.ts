import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPlaceholderSecret } from '../formatting.js';

export interface ReceiverConfig {
  host: string;
  port: number;
  dataDir: string;
  mediaDir: string;
  gatewayUrl: string;
  gatewayApiKey: string;
  hermesSecretToken: string;
  masterPhone: string;
  masterLid: string;
  masterName: string;
  defaultCountryCode: string;
  timezone: string;
  whisperModel: string;
  whisperDtype: 'fp32' | 'fp16' | 'q8' | 'q4';
  whisperCacheDir: string;
  hermesBin: string;
  rulesPath: string;
  repoAssetsDir: string;
  toolsetsContact: string;
  toolsetsOwner: string;
  agentTimeoutSeconds: number;
  coalesceWindowSeconds: number;
  maxConcurrentRuns: number;
  drainSeconds: number;
  startupReplay: boolean;
  replayMaxAgeMin: number;
  historyLimit: number;
  dailyReplyLimitPerPerson: number;
  hourlyGlobalReplyLimit: number;
  splitMessageDelaySeconds: number;
  maxMessagesPerTurn: number;
  maxMediaBytes: number;
  dryRun: boolean;
}

export function defaultReceiverDir(): string {
  return path.join(os.homedir(), 'whatsapp-hermes-receiver');
}

export function resolveEnvFileCandidates(explicitPath?: string): string[] {
  const candidates: string[] = [];
  if (explicitPath?.trim()) {
    candidates.push(path.resolve(explicitPath.trim()));
  }
  const fromEnv = process.env.RECEIVER_ENV_FILE?.trim();
  if (fromEnv) {
    candidates.push(path.resolve(fromEnv));
  }
  candidates.push(path.resolve(process.cwd(), 'receiver.env'));
  candidates.push(path.join(defaultReceiverDir(), 'receiver.env'));
  candidates.push(path.resolve(process.cwd(), '.env'));
  candidates.push(path.join(os.homedir(), 'whatsapp-agent-hermes', '.env'));
  return [...new Set(candidates)];
}

/** Loads the first existing receiver/gateway `.env` file into `process.env` without overriding exported vars. */
export function loadReceiverEnv(explicitPath?: string): string | null {
  for (const candidate of resolveEnvFileCandidates(explicitPath)) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return candidate;
    }
  }
  return null;
}

export function normalizeDigits(raw: string | null | undefined, defaultCountryCode = ''): string {
  if (!raw) return '';
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('0') && defaultCountryCode) {
    digits = defaultCountryCode + digits.slice(1);
  }
  return digits;
}

export function resolveWhisperModelId(raw: string | undefined): string {
  const clean = raw?.trim() || 'base';
  return clean.includes('/') ? clean : `onnx-community/whisper-${clean}`;
}

function parseNumberEnv(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`[ReceiverConfig] ${name} must be a valid ${allowZero ? 'non-negative' : 'positive'} number (got "${raw}").`);
  }
  return parsed;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function parseDtype(raw: string | undefined): ReceiverConfig['whisperDtype'] {
  const clean = raw?.trim().toLowerCase();
  if (clean === 'fp32' || clean === 'fp16' || clean === 'q8' || clean === 'q4') {
    return clean;
  }
  return 'q8';
}

export function buildReceiverConfig(overrides: Partial<ReceiverConfig> = {}): ReceiverConfig {
  const dataDir = path.resolve(overrides.dataDir ?? (process.env.RECEIVER_DATA_DIR?.trim() || defaultReceiverDir()));
  const timezone = (overrides.timezone ?? process.env.TIMEZONE?.trim()) || 'Asia/Kuala_Lumpur';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw new Error(`[ReceiverConfig] Invalid TIMEZONE "${timezone}". Use a valid IANA timezone such as "Asia/Kuala_Lumpur".`);
  }

  const defaultCountryCode = (overrides.defaultCountryCode ?? process.env.DEFAULT_COUNTRY_CODE ?? '60').replace(/[^0-9]/g, '');
  const masterPhoneRaw = overrides.masterPhone ?? (process.env.MASTER_PHONE?.trim() || process.env.OWNER_WHATSAPP?.trim() || '');
  const masterLidRaw = overrides.masterLid ?? (process.env.MASTER_LID?.trim() || '');
  const repoAssetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill', 'assets');

  return {
    host: overrides.host ?? (process.env.RECEIVER_HOST?.trim() || '127.0.0.1'),
    port: overrides.port ?? parseNumberEnv('RECEIVER_PORT', 5000, true),
    dataDir,
    mediaDir: overrides.mediaDir ?? (process.env.RECEIVER_MEDIA_DIR?.trim() || path.join(dataDir, 'media')),
    gatewayUrl: (overrides.gatewayUrl ?? (process.env.WHATSAPP_GATEWAY_URL?.trim() || 'http://127.0.0.1:3100')).replace(/\/+$/, ''),
    gatewayApiKey: overrides.gatewayApiKey ?? (process.env.GATEWAY_API_KEY?.trim() || ''),
    hermesSecretToken: overrides.hermesSecretToken ?? (process.env.HERMES_SECRET_TOKEN?.trim() || ''),
    masterPhone: normalizeDigits(masterPhoneRaw, defaultCountryCode),
    masterLid: normalizeDigits(masterLidRaw.replace(/@lid$/i, '')),
    masterName: overrides.masterName ?? (process.env.MASTER_NAME?.trim() || ''),
    defaultCountryCode,
    timezone,
    whisperModel: overrides.whisperModel ?? resolveWhisperModelId(process.env.WHISPER_MODEL),
    whisperDtype: overrides.whisperDtype ?? parseDtype(process.env.WHISPER_DTYPE),
    whisperCacheDir: overrides.whisperCacheDir ?? (process.env.WHISPER_CACHE_DIR?.trim() || path.join(dataDir, 'models')),
    hermesBin: overrides.hermesBin ?? (process.env.HERMES_BIN?.trim() || 'hermes'),
    rulesPath: overrides.rulesPath ?? (process.env.HERMES_RULES_PATH?.trim() || path.join(os.homedir(), '.hermes', 'skills', 'whatsapp-agent-rules', 'SKILL.md')),
    repoAssetsDir: overrides.repoAssetsDir ?? repoAssetsDir,
    toolsetsContact: overrides.toolsetsContact ?? (process.env.AGENT_TOOLSETS?.trim() || 'web,vision'),
    toolsetsOwner: overrides.toolsetsOwner ?? (process.env.AGENT_TOOLSETS_OWNER?.trim() || 'terminal,file,web,vision'),
    agentTimeoutSeconds: overrides.agentTimeoutSeconds ?? parseNumberEnv('AGENT_TIMEOUT_SECONDS', 300),
    coalesceWindowSeconds: overrides.coalesceWindowSeconds ?? parseNumberEnv('COALESCE_WINDOW_SECONDS', 2.5, true),
    maxConcurrentRuns: Math.max(1, Math.floor(overrides.maxConcurrentRuns ?? parseNumberEnv('MAX_CONCURRENT_RUNS', 4))),
    drainSeconds: overrides.drainSeconds ?? parseNumberEnv('DRAIN_SECONDS', 120),
    startupReplay: overrides.startupReplay ?? parseBoolEnv('STARTUP_REPLAY', true),
    replayMaxAgeMin: overrides.replayMaxAgeMin ?? parseNumberEnv('REPLAY_MAX_AGE_MIN', 60),
    historyLimit: Math.floor(overrides.historyLimit ?? parseNumberEnv('HISTORY_LIMIT', 30, true)),
    dailyReplyLimitPerPerson: Math.floor(overrides.dailyReplyLimitPerPerson ?? parseNumberEnv('DAILY_REPLY_LIMIT_PER_PERSON', 25)),
    hourlyGlobalReplyLimit: Math.floor(overrides.hourlyGlobalReplyLimit ?? parseNumberEnv('HOURLY_GLOBAL_REPLY_LIMIT', 60)),
    splitMessageDelaySeconds: overrides.splitMessageDelaySeconds ?? parseNumberEnv('SPLIT_MESSAGE_DELAY_SECONDS', 2.0, true),
    maxMessagesPerTurn: Math.max(1, Math.floor(overrides.maxMessagesPerTurn ?? parseNumberEnv('MAX_MESSAGES_PER_TURN', 5))),
    maxMediaBytes: Math.floor(overrides.maxMediaBytes ?? parseNumberEnv('MAX_MEDIA_BYTES', 25 * 1024 * 1024)),
    dryRun: overrides.dryRun ?? parseBoolEnv('DRY_RUN', false)
  };
}

export function validateProductionReceiverConfig(cfg: ReceiverConfig): void {
  if (!cfg.gatewayApiKey || isPlaceholderSecret(cfg.gatewayApiKey)) {
    throw new Error('[ReceiverConfig] GATEWAY_API_KEY is required and must not be a placeholder secret.');
  }
  if (!cfg.hermesSecretToken || isPlaceholderSecret(cfg.hermesSecretToken)) {
    throw new Error('[ReceiverConfig] HERMES_SECRET_TOKEN is required and must not be a placeholder secret.');
  }
  if (!cfg.masterPhone) {
    throw new Error('[ReceiverConfig] MASTER_PHONE is required for Master 1:1 DM authentication and @@FLAG@@ alerts.');
  }
  if (!cfg.masterName) {
    throw new Error('[ReceiverConfig] MASTER_NAME is required for first-person ghostwriting.');
  }
}
