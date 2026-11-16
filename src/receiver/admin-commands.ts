import { formatDateTimeParts } from '../formatting.js';
import { normalizeDigits, type ReceiverConfig } from './config.js';
import type { GatewayClient } from './gateway-client.js';
import type { ChatMapStore, ContactLookupKeys, RuntimeStateStore, SessionStore } from './stores.js';

function resolveAdminTarget(
  rawTarget: string,
  chatMap: ChatMapStore,
  defaultCountryCode: string
): { key: string; lookup: ContactLookupKeys } {
  const resolved = chatMap.resolveKey(rawTarget);
  if (resolved.chatKey) {
    return {
      key: resolved.chatKey,
      lookup: {
        chatKey: resolved.chatKey,
        phone: resolved.record?.phone,
        username: resolved.record?.username,
        lid: resolved.record?.lid,
        chatJids: resolved.record?.chatJids
      }
    };
  }

  const clean = rawTarget.trim();
  const bare = clean.includes('@') && !clean.startsWith('@') ? clean.toLowerCase() : clean;
  let key: string;
  if (bare.endsWith('@g.us')) {
    key = bare;
  } else if (bare.endsWith('@s.whatsapp.net')) {
    const userPart = bare.slice(0, bare.indexOf('@')).split(':')[0];
    key = normalizeDigits(userPart, defaultCountryCode) || clean;
  } else if (bare.endsWith('@lid')) {
    key = bare.slice(0, bare.indexOf('@')).split(':')[0].replace(/[^0-9]/g, '') || bare;
  } else if (clean.startsWith('@') || /[a-z]/i.test(clean)) {
    const handle = clean.replace(/^@+/, '').split('#')[0].trim().toLowerCase();
    key = handle ? `@${handle}` : clean;
  } else {
    key = normalizeDigits(clean, defaultCountryCode) || clean;
  }

  return { key, lookup: { chatKey: key } };
}

export function parseDurationMs(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const m = /^(\d+(?:\.\d+)?)(m|min|mins|h|hr|hrs|d|day|days)?$/i.exec(token.trim());
  if (!m) return undefined;
  const val = Number.parseFloat(m[1]);
  if (!Number.isFinite(val) || val <= 0) return undefined;
  const unit = (m[2] ?? 'h').toLowerCase();
  if (unit.startsWith('m')) return Math.round(val * 60_000);
  if (unit.startsWith('d')) return Math.round(val * 86_400_000);
  return Math.round(val * 3_600_000);
}

/**
 * Evaluates verified 1:1 Master DM control commands (`status`, `on`, `off`, `pause`, `resume`).
 * Returns formatted WhatsApp response string if handled as a command, or `null` to pass to Hermes.
 */
export async function handleMasterAdminCommand(
  rawText: string,
  deps: {
    cfg: ReceiverConfig;
    runtimeState: RuntimeStateStore;
    chatMap: ChatMapStore;
    sessions: SessionStore;
    gateway: GatewayClient;
    getActiveTurns: () => number;
  }
): Promise<string | null> {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  if (lower === 'status') {
    const gw = await deps.gateway.getHealth();
    const waStatus = gw.ok ? (gw.data?.whatsapp ?? 'unknown') : `unreachable (${gw.status})`;
    const paused = deps.runtimeState.listPausedContacts();
    const quotas = deps.runtimeState.getQuotaSnapshot();
    const pausedLines =
      paused.length === 0
        ? '- Paused contacts: none'
        : `- Paused contacts (${paused.length}): ` +
          paused
            .map(({ chatKey, entry }) => {
              if (!entry.untilIso) return `${chatKey} (indefinite)`;
              const parts = formatDateTimeParts(new Date(entry.untilIso), deps.cfg.timezone);
              return `${chatKey} until ${parts.date} ${parts.time.slice(0, 5)} GMT+8`;
            })
            .join(', ');

    return [
      `*WhatsApp Agent Status*`,
      `- Gateway: *${waStatus}*`,
      `- Auto-reply: *${deps.runtimeState.isAutoReplyEnabled() ? 'ON' : 'OFF'}*`,
      `- Active turns: ${deps.getActiveTurns()} / ${deps.cfg.maxConcurrentRuns}`,
      `- Active sessions: ${deps.sessions.count()}`,
      `- Replies (last hour): ${quotas.globalLastHour} / ${deps.cfg.hourlyGlobalReplyLimit}`,
      pausedLines
    ].join('\n');
  }

  if (lower === 'on') {
    deps.runtimeState.setAutoReplyEnabled(true);
    return 'Global auto-reply is now *ON*.';
  }

  if (lower === 'off') {
    deps.runtimeState.setAutoReplyEnabled(false);
    return 'Global auto-reply is now *OFF*. Incoming messages are still logged to history.';
  }

  const pauseMatch = /^pause\s+(\S+)(?:\s+(\S+))?$/i.exec(trimmed);
  if (pauseMatch) {
    const rawTarget = pauseMatch[1];
    const durationToken = pauseMatch[2];
    const { key } = resolveAdminTarget(rawTarget, deps.chatMap, deps.cfg.defaultCountryCode);
    const durationMs = parseDurationMs(durationToken);
    if (durationToken && !durationMs) {
      return `Invalid duration "${durationToken}". Try e.g. \`pause ${rawTarget} 4h\`, \`30m\`, or \`1d\`.`;
    }
    const entry = deps.runtimeState.pauseContact(key, durationMs);
    if (entry.untilIso) {
      const parts = formatDateTimeParts(new Date(entry.untilIso), deps.cfg.timezone);
      return `Paused auto-reply for *${key}* until ${parts.date} ${parts.time.slice(0, 5)} GMT+8.`;
    }
    return `Paused auto-reply for *${key}* indefinitely. Send \`resume ${key}\` to re-enable.`;
  }

  const resumeMatch = /^resume\s+(\S+)$/i.exec(trimmed);
  if (resumeMatch) {
    const rawTarget = resumeMatch[1];
    const { key, lookup } = resolveAdminTarget(rawTarget, deps.chatMap, deps.cfg.defaultCountryCode);
    const removed = deps.runtimeState.resumeContact(lookup);
    return removed
      ? `Resumed auto-reply for *${key}*.`
      : `Contact *${key}* was not paused.`;
  }

  return null;
}
