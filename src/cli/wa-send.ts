#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { inferDocumentMimetype } from '../mime.js';
import { buildReceiverConfig, loadReceiverEnv, type ReceiverConfig } from '../receiver/config.js';
import { GatewayClient } from '../receiver/gateway-client.js';
import { HistoryStore } from '../receiver/history.js';
import { ChatMapStore, ContactsStore, FlowStore, RuntimeStateStore, SessionStore } from '../receiver/stores.js';

interface ParsedFlags {
  positional: string[];
  pin?: string;
  replyTo?: string;
  name?: string;
  refresh?: boolean;
}

function parseArgs(args: string[]): ParsedFlags {
  const positional: string[] = [];
  let pin: string | undefined;
  let replyTo: string | undefined;
  let name: string | undefined;
  let refresh = false;
  let endOfFlags = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!endOfFlags && arg === '--') {
      endOfFlags = true;
    } else if (!endOfFlags && arg === '--pin' && i + 1 < args.length) {
      pin = args[++i];
    } else if (!endOfFlags && arg.startsWith('--pin=')) {
      pin = arg.slice('--pin='.length);
    } else if (!endOfFlags && arg === '--reply-to' && i + 1 < args.length) {
      replyTo = args[++i];
    } else if (!endOfFlags && arg.startsWith('--reply-to=')) {
      replyTo = arg.slice('--reply-to='.length);
    } else if (!endOfFlags && arg === '--name' && i + 1 < args.length) {
      name = args[++i];
    } else if (!endOfFlags && arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
    } else if (!endOfFlags && arg === '--refresh') {
      refresh = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, pin, replyTo, name, refresh };
}

function persistOutboundDelivery(
  cfg: ReceiverConfig,
  target: string,
  resData: { jid?: unknown; messageId?: unknown } | undefined,
  historyBody?: string
): void {
  const resolvedJid = typeof resData?.jid === 'string' && resData.jid.trim() ? resData.jid.trim() : '';
  if (!resolvedJid) return;

  const chatMap = new ChatMapStore(cfg.dataDir, cfg.defaultCountryCode);
  const identity = chatMap.recordOutboundResolution(target, resolvedJid);

  const history = new HistoryStore(cfg.dataDir, cfg.timezone);
  try {
    if (identity.previousKeys.length > 0) {
      const sessions = new SessionStore(cfg.dataDir);
      const flows = new FlowStore(cfg.dataDir, cfg.timezone);
      const contacts = new ContactsStore(cfg.dataDir);
      const runtimeState = new RuntimeStateStore(cfg.dataDir);
      for (const oldKey of identity.previousKeys) {
        history.migrateChatKey(oldKey, identity.chatKey);
        sessions.migrateKey(oldKey, identity.chatKey);
        flows.migrateKey(oldKey, identity.chatKey);
        contacts.migrateKey(oldKey, identity.chatKey);
        runtimeState.migrateKey(oldKey, identity.chatKey);
      }
    }

    if (historyBody) {
      const msgId =
        typeof resData?.messageId === 'string' && resData.messageId.trim()
          ? resData.messageId.trim()
          : crypto.randomUUID();
      history.recordOutbound({
        chatKey: identity.chatKey,
        chatJid: resolvedJid,
        inboundMessageId: `cli:${msgId}`,
        chunkIndex: 0,
        body: historyBody
      });
    }
  } finally {
    history.close();
  }
}

function encodeMediaSource(
  input: string,
  maxBytes: number
): { url: string; inferredFileName?: string; mimetype?: string } {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
    return { url: trimmed };
  }

  const absPath = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err: unknown) {
    throw new Error(`Media file not found: ${absPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!stat.isFile()) {
    throw new Error(`Media path is not a regular file: ${absPath}`);
  }
  if (stat.size === 0) {
    throw new Error(`Media file is empty: ${absPath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`Media file (${stat.size} bytes) exceeds MAX_MEDIA_BYTES (${maxBytes} bytes).`);
  }

  const buffer = fs.readFileSync(absPath);
  const mimetype = inferDocumentMimetype(absPath);
  return {
    url: `data:${mimetype};base64,${buffer.toString('base64')}`,
    inferredFileName: path.basename(absPath),
    mimetype
  };
}

function usageText(): string {
  return [
    'Usage:',
    '  wa-send text    <recipient> <message> [--pin 1234] [--reply-to <msgId>]',
    '  wa-send image   <recipient> <file_or_url> [caption] [--pin 1234] [--reply-to <msgId>]',
    '  wa-send doc     <recipient> <file_or_url> [caption] [--name <fileName>] [--pin 1234] [--reply-to <msgId>]',
    '  wa-send sticker <recipient> <file_or_url> [pack] [author] [--pin 1234] [--reply-to <msgId>]',
    '  wa-send resolve <target> [--pin 1234] [--refresh]',
    '  wa-send usernames'
  ].join('\n');
}

export async function runWaSend(
  argv: string[],
  overrides: { gatewayUrl?: string; apiKey?: string; maxMediaBytes?: number; dataDir?: string } = {}
): Promise<number> {
  loadReceiverEnv();
  const cfg = buildReceiverConfig({
    ...(overrides.gatewayUrl ? { gatewayUrl: overrides.gatewayUrl } : {}),
    ...(overrides.apiKey ? { gatewayApiKey: overrides.apiKey } : {}),
    ...(overrides.maxMediaBytes ? { maxMediaBytes: overrides.maxMediaBytes } : {}),
    ...(overrides.dataDir ? { dataDir: overrides.dataDir } : {})
  });

  if (!cfg.gatewayApiKey) {
    console.error('[wa-send] GATEWAY_API_KEY is missing. Set it in env, receiver.env, or .env.');
    return 1;
  }

  const { positional, pin, replyTo, name, refresh } = parseArgs(argv);
  const [subcmd, ...rest] = positional;
  if (!subcmd || subcmd === '-h' || subcmd === '--help') {
    console.log(usageText());
    return 0;
  }

  const client = new GatewayClient(cfg);

  if (subcmd === 'usernames') {
    const res = await client.listUsernames();
    console.log(JSON.stringify(res.data ?? { success: false, error: res.error }, null, 2));
    return res.ok ? 0 : 1;
  }

  if (subcmd === 'resolve') {
    const target = rest[0];
    if (!target) {
      console.error(usageText());
      return 1;
    }
    const res = await client.resolveRecipient(target, pin, refresh);
    if (res.ok) {
      persistOutboundDelivery(cfg, target, res.data);
    }
    console.log(JSON.stringify(res.data ?? { success: false, error: res.error, status: res.status }, null, 2));
    return res.ok ? 0 : 1;
  }

  if (subcmd === 'text') {
    const [to, ...msgParts] = rest;
    const message = msgParts.join(' ').trim();
    if (!to || !message) {
      console.error(usageText());
      return 1;
    }
    const res = await client.sendText({ to, message, pin, replyToMessageId: replyTo });
    if (res.ok) {
      persistOutboundDelivery(cfg, to, res.data, message);
    }
    console.log(JSON.stringify(res.data ?? { success: false, error: res.error, status: res.status }, null, 2));
    if (!res.ok) printErrorHint(res.status, res.error);
    return res.ok ? 0 : 1;
  }

  if (subcmd === 'image') {
    const [to, source, ...captionParts] = rest;
    const caption = captionParts.join(' ').trim() || undefined;
    if (!to || !source) {
      console.error(usageText());
      return 1;
    }
    const media = encodeMediaSource(source, cfg.maxMediaBytes);
    const res = await client.sendImage({ to, url: media.url, caption, pin, replyToMessageId: replyTo });
    if (res.ok) {
      persistOutboundDelivery(cfg, to, res.data, caption ? `[image sent] ${caption}` : '[image sent]');
    }
    console.log(JSON.stringify(res.data ?? { success: false, error: res.error, status: res.status }, null, 2));
    if (!res.ok) printErrorHint(res.status, res.error);
    return res.ok ? 0 : 1;
  }

  if (subcmd === 'doc' || subcmd === 'document') {
    const [to, source, ...captionParts] = rest;
    const caption = captionParts.join(' ').trim() || undefined;
    if (!to || !source) {
      console.error(usageText());
      return 1;
    }
    const media = encodeMediaSource(source, cfg.maxMediaBytes);
    const res = await client.sendDocument({
      to,
      url: media.url,
      fileName: name || media.inferredFileName,
      mimetype: media.mimetype,
      caption,
      pin,
      replyToMessageId: replyTo
    });
    if (res.ok) {
      const effectiveName = name || media.inferredFileName || 'document';
      persistOutboundDelivery(
        cfg,
        to,
        res.data,
        caption ? `[document sent: ${effectiveName}] ${caption}` : `[document sent: ${effectiveName}]`
      );
    }
    console.log(JSON.stringify(res.data ?? { success: false, error: res.error, status: res.status }, null, 2));
    if (!res.ok) printErrorHint(res.status, res.error);
    return res.ok ? 0 : 1;
  }

  if (subcmd === 'sticker') {
    const [to, source, pack, author] = rest;
    if (!to || !source) {
      console.error(usageText());
      return 1;
    }
    const media = encodeMediaSource(source, cfg.maxMediaBytes);
    const res = await client.sendSticker({ to, url: media.url, pack, author, pin, replyToMessageId: replyTo });
    if (res.ok) {
      persistOutboundDelivery(cfg, to, res.data, '[sticker sent]');
    }
    console.log(JSON.stringify(res.data ?? { success: false, error: res.error, status: res.status }, null, 2));
    if (!res.ok) printErrorHint(res.status, res.error);
    return res.ok ? 0 : 1;
  }

  console.error(`Unknown subcommand "${subcmd}".\n${usageText()}`);
  return 1;
}

function printErrorHint(status: number, error?: string): void {
  if (status === 403 || (status === 404 && error?.toLowerCase().includes('pin'))) {
    console.error('Hint: Recipient requires a 4-digit WhatsApp username PIN. Retry with --pin 1234 or @username#1234.');
  } else if (status === 502 && error?.includes('463')) {
    console.error('Hint: WhatsApp blocked cold 1:1 outreach (Error 463). Do not retry in a loop; send first message from phone app.');
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isEntrypoint) {
  runWaSend(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error('[wa-send] Error:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
