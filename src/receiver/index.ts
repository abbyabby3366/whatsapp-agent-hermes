import { buildReceiverConfig, loadReceiverEnv, validateProductionReceiverConfig } from './config.js';
import { createReceiverServer } from './server.js';

async function main(): Promise<void> {
  loadReceiverEnv();
  const cfg = buildReceiverConfig();
  validateProductionReceiverConfig(cfg);

  const runtime = createReceiverServer(cfg);
  const srv = await runtime.start();
  const addr = srv.address();
  const boundPort = addr && typeof addr === 'object' ? addr.port : cfg.port;
  console.log(`[HermesReceiver] Listening on http://${cfg.host}:${boundPort}`);
  console.log(`[HermesReceiver] Gateway target: ${cfg.gatewayUrl} | Whisper model: ${cfg.whisperModel} (${cfg.whisperDtype})`);

  const replayed = await runtime.replayOrphans();
  if (replayed > 0) {
    console.log(`[HermesReceiver] Re-queued ${replayed} unanswered orphan inbound message(s)`);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[HermesReceiver] ${signal} received, draining up to ${cfg.drainSeconds}s...`);
      void runtime.shutdown().finally(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  console.error('[HermesReceiver] Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
