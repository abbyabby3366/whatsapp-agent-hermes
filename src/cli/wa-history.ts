#!/usr/bin/env node
import fs from 'fs';
import { pathToFileURL } from 'url';
import { formatDateTimeParts } from '../formatting.js';
import { buildReceiverConfig, loadReceiverEnv } from '../receiver/config.js';
import { HistoryStore } from '../receiver/history.js';
import { ChatMapStore } from '../receiver/stores.js';

function usageText(): string {
  return [
    'Usage:',
    '  wa-history stats',
    '  wa-history chats [limit]',
    '  wa-history recent <chat_key> [limit]',
    '  wa-history search <keyword> [limit]'
  ].join('\n');
}

export function runWaHistory(argv: string[], dataDirOverride?: string): number {
  loadReceiverEnv();
  const cfg = buildReceiverConfig(dataDirOverride ? { dataDir: dataDirOverride } : {});
  const [subcmd, ...rest] = argv;

  if (!subcmd || subcmd === '-h' || subcmd === '--help') {
    console.log(usageText());
    return 0;
  }

  const history = new HistoryStore(cfg.dataDir, cfg.timezone);
  try {
    if (subcmd === 'stats') {
      console.log(JSON.stringify(history.stats(), null, 2));
      return 0;
    }

    if (subcmd === 'chats') {
      const limit = rest[0] ? Math.max(1, Number.parseInt(rest[0], 10) || 50) : 50;
      const chats = history.listChats(limit);
      if (chats.length === 0) {
        console.log('No recorded chats yet.');
        return 0;
      }
      for (const c of chats) {
        console.log(`${c.chatKey} | ${c.messageCount} msgs | ${c.displayLastTimestamp} | ${c.lastDirection.toUpperCase()}: ${c.lastBody.slice(0, 80)}`);
      }
      return 0;
    }

    if (subcmd === 'recent') {
      const target = rest[0];
      if (!target) {
        console.error(usageText());
        return 1;
      }
      const chatMap = new ChatMapStore(cfg.dataDir, cfg.defaultCountryCode);
      const chatKey = chatMap.resolveKey(target).chatKey ?? target;
      const limit = rest[1] ? Math.max(1, Number.parseInt(rest[1], 10) || 30) : 30;
      const formatted = history.formatRecentContext(chatKey, limit);
      console.log(formatted || `No messages recorded for ${chatKey}.`);
      return 0;
    }

    if (subcmd === 'search') {
      const keyword = rest[0];
      if (!keyword) {
        console.error(usageText());
        return 1;
      }
      const limit = rest[1] ? Math.max(1, Number.parseInt(rest[1], 10) || 30) : 30;
      const rows = history.search(keyword, limit);
      if (rows.length === 0) {
        console.log(`No messages matching "${keyword}".`);
        return 0;
      }
      for (const row of rows) {
        const dt = row.waTimestamp ? new Date(row.waTimestamp) : new Date();
        const parts = Number.isNaN(dt.getTime()) ? formatDateTimeParts(new Date(), cfg.timezone) : formatDateTimeParts(dt, cfg.timezone);
        console.log(`[${parts.date} ${parts.time.slice(0, 5)}] ${row.chatKey} (${row.direction.toUpperCase()}): ${row.body}`);
      }
      return 0;
    }

    console.error(`Unknown subcommand "${subcmd}".\n${usageText()}`);
    return 1;
  } finally {
    history.close();
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isEntrypoint) {
  try {
    process.exit(runWaHistory(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error('[wa-history] Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
