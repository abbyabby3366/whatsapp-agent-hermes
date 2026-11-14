import crypto from 'crypto';
import fs from 'fs';
import type http from 'http';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { formatDateTimeParts } from '../formatting.js';
import { handleMasterAdminCommand } from './admin-commands.js';
import type { ReceiverConfig } from './config.js';
import { GatewayClient } from './gateway-client.js';
import { runHermesWithSessionFallback, type RunHermesOptions, type RunHermesResult } from './hermes-runner.js';
import { HistoryStore } from './history.js';
import { cleanUntrusted, loadContactRules, parseHermesOutput } from './sanitizer.js';
import {
  ChatMapStore,
  ContactsStore,
  FlowStore,
  HandledLedger,
  OutboxStore,
  RuntimeStateStore,
  SessionStore
} from './stores.js';
import { transcribeWithLocalWhisper } from './transcribe.js';

export interface WebhookPayload {
  event: string;
  messageId: string;
  sender?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderJid?: string | null;
  chatJid: string;
  remoteJid?: string | null;
  isGroup?: boolean;
  groupJid?: string | null;
  message?: string | null;
  messageType?: string | null;
  hasMedia?: boolean;
  mimetype?: string | null;
  fileName?: string | null;
  mentionsMe?: boolean;
  isReplyToMe?: boolean;
  quoted?: { messageId?: string; message?: string } | null;
  timestamp?: string | null;
  timezone?: string | null;
  isoTimestamp?: string | null;
  rawTimestamp?: number | null;
}

interface QueuedInboundTurnItem {
  payload: WebhookPayload;
  chatKey: string;
  chatJid: string;
  isGroup: boolean;
  isMasterDm: boolean;
  bodyText: string;
  imagePaths: string[];
  quotedMessageId?: string;
  quotedText?: string;
}

interface ChatQueueState {
  generation: number;
  pending: QueuedInboundTurnItem[];
  timer: NodeJS.Timeout | null;
  abortController: AbortController | null;
  activeRun: Promise<void> | null;
}

class ConcurrencySemaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  public async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

export interface ReceiverDependencies {
  gateway?: GatewayClient;
  transcribeAudio?: (audioPath: string) => Promise<string>;
  runHermes?: (
    cfg: Pick<ReceiverConfig, 'hermesBin' | 'dataDir' | 'agentTimeoutSeconds'>,
    opts: RunHermesOptions & { onStaleSession?: () => void }
  ) => Promise<RunHermesResult>;
}

export interface ReceiverRuntime {
  app: express.Express;
  start: () => Promise<http.Server>;
  shutdown: () => Promise<void>;
  replayOrphans: () => Promise<number>;
  waitForIdle: () => Promise<void>;
  getActiveTurnCount: () => number;
  stores: {
    chatMap: ChatMapStore;
    history: HistoryStore;
    handled: HandledLedger;
    sessions: SessionStore;
    runtimeState: RuntimeStateStore;
    contacts: ContactsStore;
    flows: FlowStore;
    outbox: OutboxStore;
  };
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf'
};

export function createReceiverServer(cfg: ReceiverConfig, deps: ReceiverDependencies = {}): ReceiverRuntime {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.mediaDir, { recursive: true });

  const chatMap = new ChatMapStore(cfg.dataDir, cfg.defaultCountryCode);
  const history = new HistoryStore(cfg.dataDir, cfg.timezone);
  const handled = new HandledLedger(cfg.dataDir);
  const sessions = new SessionStore(cfg.dataDir);
  const runtimeState = new RuntimeStateStore(cfg.dataDir);
  const contacts = new ContactsStore(cfg.dataDir);
  const flows = new FlowStore(cfg.dataDir, cfg.timezone);
  const outbox = new OutboxStore(cfg.dataDir);

  const gateway = deps.gateway ?? new GatewayClient(cfg);
  const transcribeAudio = deps.transcribeAudio ?? ((audioPath: string) => transcribeWithLocalWhisper(audioPath, cfg));
  const runHermes = deps.runHermes ?? runHermesWithSessionFallback;

  const semaphore = new ConcurrencySemaphore(cfg.maxConcurrentRuns);
  const chatQueues = new Map<string, ChatQueueState>();
  const inflightIngests = new Set<Promise<void>>();
  let activeTurns = 0;
  let shuttingDown = false;
  let lastProxyAlertMs = 0;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const verifyWebhookToken = (req: Request, res: Response, next: NextFunction): void => {
    if (!cfg.hermesSecretToken) {
      next();
      return;
    }
    const provided = String(req.headers['x-hermes-token'] ?? '');
    if (provided && crypto.timingSafeEqual(sha256(provided), sha256(cfg.hermesSecretToken))) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: 'Unauthorized webhook token' });
  };

  const healthHandler = (_req: Request, res: Response) => {
    res.json({
      ok: true,
      turns_active: activeTurns,
      auto_reply_enabled: runtimeState.isAutoReplyEnabled(),
      paused_contacts: runtimeState.listPausedContacts().length
    });
  };
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  app.post('/api/webhook', verifyWebhookToken, (req: Request, res: Response) => {
    const payload = (req.body ?? {}) as Partial<WebhookPayload>;
    if (payload.event === 'test.ping') {
      res.json({ ok: true });
      return;
    }

    if (shuttingDown) {
      res.status(503).json({ ok: false, error: 'Receiver shutting down' });
      return;
    }

    if (!payload.messageId || !payload.chatJid) {
      res.status(400).json({ ok: false, error: 'messageId and chatJid are required' });
      return;
    }

    if (payload.isGroup && !payload.mentionsMe && !payload.isReplyToMe) {
      res.json({ reply: null, ignored: true });
      return;
    }

    if (handled.has(payload.messageId)) {
      res.json({ reply: null, duplicate: true });
      return;
    }

    res.json({ reply: null, status: 'processing' });
    const p = ingestInbound(payload as WebhookPayload).catch((err: unknown) => {
      console.error(`[Receiver] Failed to ingest ${payload.messageId}:`, err instanceof Error ? err.message : err);
    });
    inflightIngests.add(p);
    void p.finally(() => inflightIngests.delete(p));
  });

  function readTemplate(fileName: string): string {
    const candidates = [path.join(cfg.dataDir, fileName), path.join(cfg.repoAssetsDir, fileName)];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf8').replaceAll('${MASTER_NAME}', cfg.masterName);
      }
    }
    throw new Error(`[Receiver] Required prompt template "${fileName}" not found in ${cfg.dataDir} or ${cfg.repoAssetsDir}`);
  }

  function isMasterPrincipal(
    payload: WebhookPayload,
    record: { phone?: string; lid?: string; chatJids: string[] }
  ): boolean {
    if (payload.isGroup || payload.chatJid.endsWith('@g.us')) return false;
    const isOneToOneJid =
      payload.chatJid.endsWith('@s.whatsapp.net') || payload.chatJid.endsWith('@lid');
    if (!isOneToOneJid) return false;

    const senderDigits = payload.sender ? payload.sender.replace(/[^0-9]/g, '') : '';
    const effectivePhone = senderDigits || record.phone || '';
    if (effectivePhone && effectivePhone === cfg.masterPhone) {
      if (record.lid) {
        runtimeState.setMasterLid(record.lid);
      }
      return true;
    }

    const senderLid =
      payload.senderJid?.endsWith('@lid') ? payload.senderJid.slice(0, payload.senderJid.indexOf('@')).split(':')[0] : record.lid || '';
    const knownMasterLid = cfg.masterLid || runtimeState.getMasterLid();
    return Boolean(senderLid && knownMasterLid && senderLid === knownMasterLid);
  }

  function migrateAllStores(oldKey: string, newKey: string): void {
    history.migrateChatKey(oldKey, newKey);
    sessions.migrateKey(oldKey, newKey);
    flows.migrateKey(oldKey, newKey);
    contacts.migrateKey(oldKey, newKey);
    runtimeState.migrateKey(oldKey, newKey);
  }

  async function saveInboundMedia(payload: WebhookPayload): Promise<{
    localPath?: string;
    isImage: boolean;
    isAudio: boolean;
    descriptor?: string;
    errorNote?: string;
  }> {
    if (!payload.hasMedia) {
      return { isImage: false, isAudio: false };
    }
    const dl = await gateway.downloadMedia(payload.messageId);
    if (!dl.ok) {
      return {
        isImage: false,
        isAudio: false,
        errorNote: `[media download failed: HTTP ${dl.status}]`
      };
    }

    const mimetype = (dl.mimetype || payload.mimetype || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const safeId = payload.messageId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
    const ext =
      (dl.fileName && path.extname(dl.fileName).replace(/^\./, '')) ||
      (payload.fileName && path.extname(payload.fileName).replace(/^\./, '')) ||
      MIME_TO_EXT[mimetype] ||
      'bin';
    const fileName = `${safeId}.${ext}`;
    const localPath = path.join(cfg.mediaDir, fileName);
    fs.writeFileSync(localPath, dl.buffer);

    const msgType = (payload.messageType || '').toLowerCase();
    const isImage = msgType === 'image' || mimetype.startsWith('image/');
    const isAudio = msgType === 'voice' || msgType === 'audio' || mimetype.startsWith('audio/');
    const descriptor =
      !isImage && !isAudio
        ? `[media: ${msgType || 'file'} | mime: ${mimetype}${payload.fileName ? ` | file: ${cleanUntrusted(payload.fileName)}` : ''} | path: ${localPath}]`
        : undefined;

    return { localPath, isImage, isAudio, descriptor };
  }

  async function ingestInbound(payload: WebhookPayload, options: { fromReplay?: boolean } = {}): Promise<void> {
    if (handled.has(payload.messageId)) return;

    const isGroup = Boolean(payload.isGroup || payload.chatJid.endsWith('@g.us'));
    const identity = chatMap.upsertInbound({
      chatJid: payload.chatJid,
      senderJid: payload.senderJid,
      sender: payload.sender,
      senderUsername: payload.senderUsername,
      senderName: payload.senderName,
      isGroup
    });
    for (const oldKey of identity.previousKeys) {
      migrateAllStores(oldKey, identity.chatKey);
    }

    const isMasterDm = isMasterPrincipal(payload, identity.record);
    const imagePaths: string[] = [];
    const bodyParts: string[] = [];
    const rawCaptionOrText = (payload.message ?? '').trim();

    if (!options.fromReplay) {
      const media = await saveInboundMedia(payload);
      if (media.errorNote) {
        bodyParts.push(media.errorNote);
      } else if (media.localPath) {
        if (media.isImage) {
          imagePaths.push(media.localPath);
          bodyParts.push('[image attached]');
        } else if (media.isAudio) {
          try {
            const transcript = await transcribeAudio(media.localPath);
            bodyParts.push(transcript);
          } catch (err: unknown) {
            console.error(`[Receiver] Transcription failed for ${payload.messageId}:`, err);
            bodyParts.push('[voice note | engine: whisper-onnx | quality: unclear | transcript: "(transcription error)"]');
          }
        } else if (media.descriptor) {
          bodyParts.push(media.descriptor);
        }
      }
    } else if (payload.hasMedia && (payload.messageType === 'image' || payload.mimetype?.startsWith('image/'))) {
      const safeId = payload.messageId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
      if (fs.existsSync(cfg.mediaDir)) {
        const cachedImage = fs.readdirSync(cfg.mediaDir).find((f) => f.startsWith(`${safeId}.`));
        if (cachedImage) {
          imagePaths.push(path.join(cfg.mediaDir, cachedImage));
        }
      }
    }

    if (rawCaptionOrText && !(payload.hasMedia && /^\[(image|video|voice message|audio|document|sticker)\]/i.test(rawCaptionOrText))) {
      bodyParts.push(rawCaptionOrText);
    }
    const composedBody = bodyParts.join('\n').trim() || rawCaptionOrText || '[empty message]';

    const isoTimestamp = payload.isoTimestamp || new Date().toISOString();
    const rawTimestamp =
      typeof payload.rawTimestamp === 'number' && Number.isFinite(payload.rawTimestamp)
        ? payload.rawTimestamp
        : Math.floor(Date.parse(isoTimestamp) / 1000) || Math.floor(Date.now() / 1000);

    history.recordInbound({
      chatKey: identity.chatKey,
      chatJid: payload.chatJid,
      messageId: payload.messageId,
      senderName: payload.senderName ?? null,
      senderNumber: identity.record.phone ?? payload.sender ?? null,
      body: composedBody,
      isoTimestamp,
      rawTimestamp,
      payloadJson: JSON.stringify(payload)
    });

    if (!isMasterDm) {
      const profile = contacts.get({
        chatKey: identity.chatKey,
        username: identity.record.username,
        phone: identity.record.phone,
        lid: identity.record.lid
      });
      const pauseState = runtimeState.isContactPaused(identity.chatKey);
      if (!runtimeState.isAutoReplyEnabled() || pauseState.paused || profile?.auto_reply === false) {
        handled.mark(payload.messageId, 'silent', identity.chatKey);
        return;
      }
    }

    enqueueTurnItem({
      payload,
      chatKey: identity.chatKey,
      chatJid: payload.chatJid,
      isGroup,
      isMasterDm,
      bodyText: composedBody,
      imagePaths,
      quotedMessageId: payload.quoted?.messageId,
      quotedText: payload.quoted?.message
    });
  }

  function enqueueTurnItem(item: QueuedInboundTurnItem): void {
    let q = chatQueues.get(item.chatKey);
    if (!q) {
      q = {
        generation: 0,
        pending: [],
        timer: null,
        abortController: null,
        activeRun: null
      };
      chatQueues.set(item.chatKey, q);
    }

    q.pending.push(item);
    q.generation += 1;

    // Supersede any active in-flight turn for this chat immediately
    if (q.abortController) {
      q.abortController.abort();
    }

    if (q.timer) {
      clearTimeout(q.timer);
    }

    const delayMs = Math.max(0, Math.round(cfg.coalesceWindowSeconds * 1000));
    q.timer = setTimeout(() => {
      q!.timer = null;
      void scheduleDrain(item.chatKey);
    }, delayMs);
    q.timer.unref?.();
  }

  async function scheduleDrain(chatKey: string): Promise<void> {
    const q = chatQueues.get(chatKey);
    if (!q || shuttingDown) return;
    if (q.activeRun) {
      await q.activeRun;
    }
    if (!q.pending.length || q.timer || shuttingDown) return;

    const run = processChatBurst(chatKey, q).finally(() => {
      if (q.activeRun === run) {
        q.activeRun = null;
      }
    });
    q.activeRun = run;
    await run;
  }

  function buildPrompt(chatKey: string, items: QueuedInboundTurnItem[]): string {
    const latest = items[items.length - 1];
    const identity = chatMap.get(chatKey);

    if (latest.isMasterDm) {
      const ownerTemplate = readTemplate('prompt_template_owner.txt');
      const parts: string[] = [ownerTemplate];

      for (const item of items) {
        if (item.quotedMessageId) {
          const flag = outbox.get(item.quotedMessageId);
          if (flag) {
            parts.push(
              `[Quoted Escalation Context]\nThis Master DM quotes [FLAG] messageId=${flag.messageId} concerning contact key=${flag.targetChatKey}, chatJid=${flag.targetChatJid}${flag.targetName ? ` (${flag.targetName})` : ''}.\nFlag Summary: ${flag.summary}`
            );
          }
        }
      }

      const priorHistory = history.formatRecentContext(
        chatKey,
        cfg.historyLimit,
        new Set(items.map((i) => i.payload.messageId))
      );
      if (priorHistory) {
        parts.push(`[Recent 1:1 Master History]\n${priorHistory}`);
      }

      const nowParts = formatDateTimeParts(
        latest.payload.isoTimestamp ? new Date(latest.payload.isoTimestamp) : new Date(),
        cfg.timezone
      );
      const msgsList = items
        .map((it, idx) => `${idx + 1}. ${it.quotedText ? `[Replying to "${it.quotedText}"] ` : ''}${it.bodyText}`)
        .join('\n');

      parts.push(`[Master DM Turn — ${nowParts.full} GMT+8]\n${msgsList}`);
      return parts.join('\n\n');
    }

    // Contact / Group Sandbox Prompt
    const contactTemplate = readTemplate('prompt_template.txt');
    const contextLines: string[] = [];

    const profile = contacts.get({
      chatKey,
      username: identity?.username,
      phone: identity?.phone,
      lid: identity?.lid
    });
    if (profile) {
      if (profile.name || profile.relation) {
        contextLines.push(
          `Contact: ${profile.name || chatKey}${profile.relation ? ` (Relation: ${profile.relation})` : ''}`
        );
      }
      if (profile.persona) contextLines.push(`Persona: ${profile.persona}`);
      if (profile.notes?.what_we_know) contextLines.push(`Known: ${profile.notes.what_we_know}`);
      if (profile.notes?.what_is_missing) contextLines.push(`Missing: ${profile.notes.what_is_missing}`);
      if (profile.notes?.how_to_approach) contextLines.push(`Approach: ${profile.notes.how_to_approach}`);
    }

    const flow = flows.get(chatKey);
    if (flow) {
      if (flow.open.length) contextLines.push(`Open Flow Items: ${flow.open.join(' | ')}`);
      if (flow.facts.length) contextLines.push(`Verified Flow Facts: ${flow.facts.join(' | ')}`);
      if (flow.events.length) {
        const recentEvents = flow.events.slice(-5).map((e) => `${e.display}: ${e.text}`).join(' | ');
        contextLines.push(`Recent Milestones: ${recentEvents}`);
      }
    }

    const rules = loadContactRules(cfg.rulesPath, {
      phone: identity?.phone,
      username: identity?.username,
      lid: identity?.lid,
      name: profile?.name || latest.payload.senderName || undefined
    });
    if (rules.globalRules) {
      contextLines.push(`[Global Reply Rules & Business Facts]\n${rules.globalRules}`);
    }
    if (rules.contactRules) {
      contextLines.push(`[Contact-Specific Rules]\n${rules.contactRules}`);
    }

    const sections: string[] = [contactTemplate];
    if (contextLines.length > 0) {
      sections.push(`[Trusted Operator Context]\n${contextLines.join('\n')}`);
    }

    const priorHistory = history.formatRecentContext(
      chatKey,
      cfg.historyLimit,
      new Set(items.map((i) => i.payload.messageId))
    );
    if (priorHistory) {
      sections.push(`[Earlier Conversation History (Oldest First — Context Only, Do Not Re-Answer)]\n${priorHistory}`);
    }

    const tsParts = formatDateTimeParts(
      latest.payload.isoTimestamp ? new Date(latest.payload.isoTimestamp) : new Date(),
      cfg.timezone
    );
    const cleanSender = cleanUntrusted(latest.payload.senderName || identity?.name || chatKey);
    const cleanQuoted = cleanUntrusted(latest.quotedText);
    const messageLines = items
      .map((item, idx) => `${idx + 1}. ${cleanUntrusted(item.bodyText)}`)
      .join('\n');

    sections.push(
      [
        '[New Inbound Turn — Answer ONLY What Is Inside <untrusted_inbound_message>]',
        '<untrusted_inbound_message>',
        `chat_type: ${latest.isGroup ? 'group' : 'direct'}`,
        `sender_name: ${cleanSender}`,
        `timestamp_gmt8: ${tsParts.full}`,
        `quoted: ${cleanQuoted ? JSON.stringify(cleanQuoted) : 'null'}`,
        `messages (count=${items.length}):`,
        messageLines,
        '</untrusted_inbound_message>'
      ].join('\n')
    );

    return sections.join('\n\n');
  }

  async function sendMasterAlert(message: string): Promise<void> {
    if (!cfg.masterPhone) return;
    await gateway.sendText({ to: cfg.masterPhone, message });
  }

  async function processChatBurst(chatKey: string, q: ChatQueueState): Promise<void> {
    const release = await semaphore.acquire();
    activeTurns += 1;

    try {
      if (q.pending.length === 0 || shuttingDown) return;

      const items = q.pending.splice(0, q.pending.length);
      const capturedGeneration = q.generation;
      const latest = items[items.length - 1];
      const chatJid = latest.chatJid;

      // Single-message 1:1 Master DM Admin Command Fast-Path
      if (
        latest.isMasterDm &&
        items.length === 1 &&
        !latest.quotedMessageId &&
        latest.imagePaths.length === 0 &&
        !latest.payload.hasMedia
      ) {
        const adminReply = await handleMasterAdminCommand(latest.bodyText, {
          cfg,
          runtimeState,
          chatMap,
          sessions,
          gateway,
          getActiveTurns: () => activeTurns
        });
        if (adminReply !== null) {
          await gateway.markRead(latest.payload.messageId);
          const sendRes = await gateway.sendText({ to: chatJid, message: adminReply });
          if (sendRes.ok) {
            history.recordOutbound({
              chatKey,
              chatJid,
              inboundMessageId: latest.payload.messageId,
              chunkIndex: 0,
              body: adminReply
            });
            handled.mark(latest.payload.messageId, 'sent', chatKey);
          }
          return;
        }
      }

      // Enforce per-person daily & global hourly quotas on external contacts
      if (!latest.isMasterDm) {
        const quota = runtimeState.canSendReply(
          chatKey,
          cfg.dailyReplyLimitPerPerson,
          cfg.hourlyGlobalReplyLimit
        );
        if (!quota.allowed) {
          console.warn(`[Receiver] Quota reached (${quota.reason}: ${quota.count}/${quota.limit}) for ${chatKey}`);
          for (const item of items) handled.mark(item.payload.messageId, 'silent', chatKey);
          await sendMasterAlert(
            `[FLAG] ${chatKey}: auto-reply paused for turn due to quota (${quota.reason}: ${quota.count}/${quota.limit}).`
          );
          return;
        }
      }

      // If superseded while waiting in the semaphore queue, put items back cleanly
      if (capturedGeneration !== q.generation || shuttingDown) {
        q.pending.unshift(...items);
        return;
      }

      const abortController = new AbortController();
      q.abortController = abortController;

      const prompt = buildPrompt(chatKey, items);
      const toolsets = latest.isMasterDm ? cfg.toolsetsOwner : cfg.toolsetsContact;
      const existingSessionId = sessions.get(chatKey);
      const imagePaths = Array.from(new Set(items.flatMap((i) => i.imagePaths)));

      const result = await runHermes(cfg, {
        prompt,
        toolsets,
        sessionId: existingSessionId,
        imagePaths,
        signal: abortController.signal,
        onStaleSession: () => sessions.clear(chatKey)
      });

      if (q.abortController === abortController) {
        q.abortController = null;
      }

      // Superseded mid-turn by a newer message: merge these items back before the new items
      if (result.superseded || capturedGeneration !== q.generation) {
        q.pending.unshift(...items);
        return;
      }

      if (result.sessionId) {
        sessions.set(chatKey, result.sessionId);
      }

      if (result.proxyAuthError) {
        const now = Date.now();
        if (now - lastProxyAlertMs > 15 * 60_000) {
          lastProxyAlertMs = now;
          await sendMasterAlert(
            `[Alert] Hermes AI proxy rejected \`hermes chat -Q\` (exit=${result.exitCode}). Check host proxy credentials/budget.`
          );
        }
      }

      const parsed = parseHermesOutput(result.stdout, cfg.maxMessagesPerTurn);
      if (parsed.kind === 'no-answer') {
        console.error(
          `[Receiver] Empty/failed Hermes response for ${chatKey} (exit=${result.exitCode}, timedOut=${result.timedOut}): ${result.stderr.slice(0, 300)}`
        );
        return; // Leave unledgered for replayOrphans()
      }

      // 1. Dispatch any @@FLAG@@ escalations FIRST
      const senderLabel = cleanUntrusted(latest.payload.senderName || chatMap.get(chatKey)?.name || '');
      for (const flagSummary of parsed.flags) {
        const flagMsg = `[FLAG] ${chatKey}${senderLabel ? ` (${senderLabel})` : ''}: ${flagSummary}`;
        const flagRes = await gateway.sendText({ to: cfg.masterPhone, message: flagMsg });
        if (flagRes.ok && flagRes.data?.messageId) {
          outbox.record({
            messageId: flagRes.data.messageId,
            targetChatJid: chatJid,
            targetChatKey: chatKey,
            targetName: senderLabel || undefined,
            summary: flagSummary,
            createdAt: new Date().toISOString()
          });
        }
      }

      // 2. Deliberate silence (NO_REPLY)
      if (parsed.kind === 'silent') {
        for (const item of items) handled.mark(item.payload.messageId, 'silent', chatKey);
        return;
      }

      // 3. Dry run check
      if (cfg.dryRun) {
        console.log(`[DRY_RUN] Would reply to ${chatJid}:`, parsed.chunks);
        for (const item of items) handled.mark(item.payload.messageId, 'dry-run', chatKey);
        return;
      }

      // 4. Mark read right before dispatching chunk 1 (never prematurely!)
      await gateway.markRead(latest.payload.messageId);

      for (let i = 0; i < parsed.chunks.length; i++) {
        const chunk = parsed.chunks[i];
        if (i > 0 && cfg.splitMessageDelaySeconds > 0) {
          await gateway.setPresence(chatJid, 'composing');
          await sleep(Math.round(cfg.splitMessageDelaySeconds * 1000));
        }

        const sendRes = await gateway.sendText({
          to: chatJid,
          message: chunk,
          ...(i === 0 && latest.isGroup ? { replyToMessageId: latest.payload.messageId } : {})
        });

        if (i > 0) {
          await gateway.setPresence(chatJid, 'paused');
        }

        if (!sendRes.ok) {
          if (sendRes.status === 502) {
            // Permanent WhatsApp stanza / cold outreach rejection (Error 463 / 479): never retry in a loop
            for (const item of items) handled.mark(item.payload.messageId, 'failed-502', chatKey);
            await sendMasterAlert(`[FLAG] Failed sending reply to ${chatKey} (HTTP 502): ${sendRes.error || 'Rejected'}`);
            return;
          }
          // Transient outage after retries -> leave unledgered for replayOrphans()
          await sendMasterAlert(`[Alert] Failed sending reply to ${chatKey} (HTTP ${sendRes.status}): ${sendRes.error || 'Error'}`);
          return;
        }

        history.recordOutbound({
          chatKey,
          chatJid,
          inboundMessageId: latest.payload.messageId,
          chunkIndex: i,
          body: chunk
        });
      }

      if (!latest.isMasterDm) {
        runtimeState.recordReplySent(chatKey);
      }
      for (const item of items) {
        handled.mark(item.payload.messageId, 'sent', chatKey);
      }
    } finally {
      activeTurns = Math.max(0, activeTurns - 1);
      release();
    }
  }

  async function replayOrphans(): Promise<number> {
    if (!cfg.startupReplay) return 0;
    const cutoffEpoch = Math.floor(Date.now() / 1000) - cfg.replayMaxAgeMin * 60;
    const orphans = history.findOrphans(cutoffEpoch, (msgId) => handled.has(msgId));
    let count = 0;

    for (const row of orphans) {
      let payload: WebhookPayload;
      if (row.payloadJson) {
        try {
          payload = JSON.parse(row.payloadJson) as WebhookPayload;
        } catch {
          payload = {
            event: 'message.received',
            messageId: row.messageId,
            sender: row.senderNumber,
            senderName: row.senderName,
            chatJid: row.chatJid,
            isGroup: row.chatJid.endsWith('@g.us'),
            message: row.body,
            isoTimestamp: row.waTimestamp,
            rawTimestamp: row.rawTimestamp
          };
        }
      } else {
        payload = {
          event: 'message.received',
          messageId: row.messageId,
          sender: row.senderNumber,
          senderName: row.senderName,
          chatJid: row.chatJid,
          isGroup: row.chatJid.endsWith('@g.us'),
          message: row.body,
          isoTimestamp: row.waTimestamp,
          rawTimestamp: row.rawTimestamp
        };
      }
      await ingestInbound({ ...payload, message: row.body }, { fromReplay: true });
      count += 1;
    }
    return count;
  }

  async function waitForIdle(): Promise<void> {
    while (inflightIngests.size > 0) {
      await Promise.all(Array.from(inflightIngests));
    }
    while (true) {
      const pendingWork: Promise<void>[] = [];
      for (const q of chatQueues.values()) {
        if (q.timer) {
          // Wait slightly past next coalesce timer
          pendingWork.push(sleep(25));
        }
        if (q.activeRun) {
          pendingWork.push(q.activeRun);
        }
      }
      if (pendingWork.length === 0) break;
      await Promise.all(pendingWork);
    }
  }

  let httpServer: http.Server | null = null;

  async function start(): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const srv = app.listen(cfg.port, cfg.host, () => {
        httpServer = srv;
        resolve(srv);
      });
      srv.on('error', reject);
    });
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    for (const q of chatQueues.values()) {
      if (q.timer) {
        clearTimeout(q.timer);
        q.timer = null;
      }
    }

    const activeRuns = Array.from(chatQueues.values())
      .map((q) => q.activeRun)
      .filter((p): p is Promise<void> => Boolean(p));

    if (activeRuns.length > 0) {
      await Promise.race([Promise.allSettled(activeRuns), sleep(cfg.drainSeconds * 1000)]);
      // Abort anything still running past DRAIN_SECONDS
      for (const q of chatQueues.values()) {
        q.abortController?.abort();
      }
    }

    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }
    history.close();
  }

  return {
    app,
    start,
    shutdown,
    replayOrphans,
    waitForIdle,
    getActiveTurnCount: () => activeTurns,
    stores: {
      chatMap,
      history,
      handled,
      sessions,
      runtimeState,
      contacts,
      flows,
      outbox
    }
  };
}
