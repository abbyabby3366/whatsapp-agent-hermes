#!/usr/bin/env node
import fs from 'fs';
import { pathToFileURL } from 'url';
import { buildReceiverConfig, loadReceiverEnv } from '../receiver/config.js';
import { ChatMapStore, FlowStore } from '../receiver/stores.js';

function usageText(): string {
  return [
    'Usage:',
    '  wa-flow contacts',
    '  wa-flow show <key>',
    '  wa-flow open <key> <item>',
    '  wa-flow close <key> <item>',
    '  wa-flow fact <key> <fact>',
    '  wa-flow event <key> <event>'
  ].join('\n');
}

export function runWaFlow(argv: string[], dataDirOverride?: string): number {
  loadReceiverEnv();
  const cfg = buildReceiverConfig(dataDirOverride ? { dataDir: dataDirOverride } : {});
  const [subcmd, rawKey, ...rest] = argv;

  if (!subcmd || subcmd === '-h' || subcmd === '--help') {
    console.log(usageText());
    return 0;
  }

  const flows = new FlowStore(cfg.dataDir, cfg.timezone);
  const chatMap = new ChatMapStore(cfg.dataDir, cfg.defaultCountryCode);

  if (subcmd === 'contacts') {
    console.log(JSON.stringify(flows.listContacts(), null, 2));
    return 0;
  }

  if (!rawKey) {
    console.error(usageText());
    return 1;
  }

  const resolved = chatMap.resolveKey(rawKey);
  const key = resolved.chatKey ?? rawKey;
  const text = rest.join(' ').trim();

  if (subcmd === 'show') {
    const flow = flows.get(key);
    console.log(JSON.stringify(flow ?? { open: [], facts: [], events: [] }, null, 2));
    return 0;
  }

  if (!text) {
    console.error(usageText());
    return 1;
  }

  if (subcmd === 'open') {
    console.log(JSON.stringify(flows.addOpen(key, text, resolved.record?.name), null, 2));
    return 0;
  }
  if (subcmd === 'close') {
    console.log(JSON.stringify(flows.closeOpen(key, text), null, 2));
    return 0;
  }
  if (subcmd === 'fact') {
    console.log(JSON.stringify(flows.addFact(key, text, resolved.record?.name), null, 2));
    return 0;
  }
  if (subcmd === 'event') {
    console.log(JSON.stringify(flows.addEvent(key, text, resolved.record?.name), null, 2));
    return 0;
  }

  console.error(`Unknown subcommand "${subcmd}".\n${usageText()}`);
  return 1;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isEntrypoint) {
  try {
    process.exit(runWaFlow(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error('[wa-flow] Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
