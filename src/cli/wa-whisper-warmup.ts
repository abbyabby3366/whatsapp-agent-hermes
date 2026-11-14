#!/usr/bin/env node
import { buildReceiverConfig, loadReceiverEnv } from '../receiver/config.js';
import { warmupWhisperModel } from '../receiver/transcribe.js';

async function main(): Promise<void> {
  loadReceiverEnv();
  const cfg = buildReceiverConfig();
  console.log(
    `[wa-whisper-warmup] Pre-loading ${cfg.whisperModel} (dtype=${cfg.whisperDtype}) into ${cfg.whisperCacheDir}...`
  );
  await warmupWhisperModel(cfg);
  console.log('[wa-whisper-warmup] Whisper ONNX model is ready.');
}

main().catch((err: unknown) => {
  console.error('[wa-whisper-warmup] Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
