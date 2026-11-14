import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import ffmpegStatic from 'ffmpeg-static';
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { ReceiverConfig } from './config.js';
import { cleanUntrusted } from './sanitizer.js';

const execFileAsync = promisify(execFile);

const UNCLEAR_VOICE_NOTE = '[voice note | engine: whisper-onnx | quality: unclear | transcript: "(inaudible/muffled)"]';
const WHISPER_NOISE_ONLY_RE = /^(?:\[[^\]]+\]|\([^)]+\)|♪+|…+|\.+)$/;

let cachedPipelineKey = '';
let cachedPipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let transcribeMutex: Promise<void> = Promise.resolve();

function resolveFfmpegBinary(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv) return fromEnv;
  const imported: unknown = ffmpegStatic;
  const candidate =
    typeof imported === 'string'
      ? imported
      : typeof (imported as { default?: unknown } | null)?.default === 'string'
        ? (imported as { default: string }).default
        : '';
  if (candidate.trim() && fs.existsSync(candidate)) {
    return candidate;
  }
  return 'ffmpeg';
}

async function decodeAudioToFloat32Pcm(audioPath: string): Promise<Float32Array> {
  const ffmpegBin = resolveFfmpegBinary();
  const { stdout } = await execFileAsync(
    ffmpegBin,
    ['-nostdin', '-v', 'error', '-i', audioPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
    {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000
    }
  );

  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  const sampleCount = Math.floor(buf.byteLength / 4);
  if (sampleCount === 0) {
    return new Float32Array(0);
  }
  const pcm = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = buf.readFloatLE(i * 4);
  }
  return pcm;
}

function hasAudibleSignal(samples: Float32Array): boolean {
  // Whisper requires at least ~0.15s (2400 samples at 16 kHz) and non-silent energy
  if (samples.length < 2400) return false;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    energy += v * v;
  }
  const rms = Math.sqrt(energy / samples.length);
  return Number.isFinite(rms) && rms >= 1e-4;
}

async function getWhisperPipeline(
  cfg: Pick<ReceiverConfig, 'whisperModel' | 'whisperDtype' | 'whisperCacheDir'>
): Promise<AutomaticSpeechRecognitionPipeline> {
  const key = `${cfg.whisperModel}::${cfg.whisperDtype}::${cfg.whisperCacheDir}`;
  if (cachedPipelinePromise && cachedPipelineKey === key) {
    return cachedPipelinePromise;
  }

  fs.mkdirSync(cfg.whisperCacheDir, { recursive: true });
  env.cacheDir = cfg.whisperCacheDir;

  cachedPipelineKey = key;
  cachedPipelinePromise = pipeline('automatic-speech-recognition', cfg.whisperModel, {
    dtype: cfg.whisperDtype,
    device: 'cpu',
    cache_dir: cfg.whisperCacheDir
  }).catch((err: unknown) => {
    cachedPipelinePromise = null;
    cachedPipelineKey = '';
    throw err;
  });

  return cachedPipelinePromise;
}

async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prior = transcribeMutex;
  transcribeMutex = prior.then(() => gate, () => gate);
  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Downloads and initializes the local ONNX Whisper model ahead of time (used by `scripts/install.sh`). */
export async function warmupWhisperModel(
  cfg: Pick<ReceiverConfig, 'whisperModel' | 'whisperDtype' | 'whisperCacheDir'>
): Promise<void> {
  await withMutex(async () => {
    await getWhisperPipeline(cfg);
  });
}

/**
 * Decodes an inbound voice note locally with ffmpeg and transcribes it using
 * `@huggingface/transformers` (ONNX Whisper on CPU, zero external API keys).
 */
export async function transcribeWithLocalWhisper(
  audioPath: string,
  cfg: Pick<ReceiverConfig, 'whisperModel' | 'whisperDtype' | 'whisperCacheDir'>
): Promise<string> {
  const samples = await decodeAudioToFloat32Pcm(audioPath);
  if (!hasAudibleSignal(samples)) {
    return UNCLEAR_VOICE_NOTE;
  }

  return withMutex(async () => {
    const asr = await getWhisperPipeline(cfg);
    const output = await asr(samples, {
      chunk_length_s: 30,
      stride_length_s: 5,
      task: 'transcribe',
      return_timestamps: false
    });
    const rawText = Array.isArray(output) ? output.map((o) => o.text).join(' ') : output.text;
    const text = cleanUntrusted(rawText).replace(/\s+/g, ' ').trim();
    if (!text || WHISPER_NOISE_ONLY_RE.test(text)) {
      return UNCLEAR_VOICE_NOTE;
    }
    return `[voice note | engine: whisper-onnx | transcript: "${text}"]`;
  });
}
