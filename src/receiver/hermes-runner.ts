import { spawn, type ChildProcess } from 'child_process';
import type { ReceiverConfig } from './config.js';

export interface RunHermesOptions {
  prompt: string;
  toolsets: string;
  sessionId?: string;
  imagePaths?: string[];
  signal?: AbortSignal;
  spawnImpl?: typeof spawn;
}

export interface RunHermesResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  sessionId?: string;
  superseded: boolean;
  timedOut: boolean;
  proxyAuthError: boolean;
}

const SESSION_ID_RE = /session_id:\s*([A-Za-z0-9_.:-]+)/i;
const PROXY_AUTH_ERROR_RE = /\b(401|402|403|429)\b|unauthoriz|insufficient|budget|quota/i;

export function buildHermesChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Deny-list ONLY receiver-only secrets so host AI proxy auth/config variables pass through intact.
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv };
  delete childEnv.GATEWAY_API_KEY;
  delete childEnv.HERMES_SECRET_TOKEN;
  return childEnv;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child signal if process group already exited
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process already terminated
  }
}

export function spawnHermesOnce(
  cfg: Pick<ReceiverConfig, 'hermesBin' | 'dataDir' | 'agentTimeoutSeconds'>,
  opts: RunHermesOptions
): Promise<RunHermesResult> {
  return new Promise((resolve) => {
    const args = ['chat', '-Q', '--toolsets', opts.toolsets];
    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }
    for (const img of opts.imagePaths ?? []) {
      args.push('--image', img);
    }
    args.push('-q', opts.prompt);

    let settled = false;
    let superseded = false;
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let hardKillTimer: NodeJS.Timeout | undefined;

    const spawner = opts.spawnImpl ?? spawn;
    const child = spawner(cfg.hermesBin, args, {
      cwd: cfg.dataDir,
      env: buildHermesChildEnv(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const terminate = (reason: 'superseded' | 'timeout') => {
      if (reason === 'superseded') superseded = true;
      if (reason === 'timeout') timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      hardKillTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 3000);
      hardKillTimer.unref();
    };

    const onAbort = () => terminate('superseded');
    if (opts.signal) {
      if (opts.signal.aborted) {
        terminate('superseded');
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const timeoutHandle = setTimeout(() => terminate('timeout'), cfg.agentTimeoutSeconds * 1000);
    timeoutHandle.unref();

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      opts.signal?.removeEventListener('abort', onAbort);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const sidMatch = SESSION_ID_RE.exec(stderr);

      resolve({
        stdout,
        stderr,
        exitCode: code,
        sessionId: sidMatch?.[1],
        superseded,
        timedOut,
        proxyAuthError: code !== 0 && !superseded && PROXY_AUTH_ERROR_RE.test(stderr)
      });
    };

    child.on('error', (err: Error) => {
      stderrChunks.push(Buffer.from(err.message, 'utf8'));
      finish(127);
    });
    child.on('close', (code) => finish(code));
  });
}

export async function runHermesWithSessionFallback(
  cfg: Pick<ReceiverConfig, 'hermesBin' | 'dataDir' | 'agentTimeoutSeconds'>,
  opts: RunHermesOptions & { onStaleSession?: () => void }
): Promise<RunHermesResult> {
  const first = await spawnHermesOnce(cfg, opts);
  if (
    opts.sessionId &&
    !first.superseded &&
    !first.timedOut &&
    !first.proxyAuthError &&
    first.exitCode !== 0 &&
    !first.stdout.trim()
  ) {
    opts.onStaleSession?.();
    return spawnHermesOnce(cfg, { ...opts, sessionId: undefined });
  }
  return first;
}
