import fs from 'fs';
import path from 'path';

/**
 * Atomically writes JSON to `filePath` by writing a unique sibling temp file first
 * and renaming it into place so partial writes never corrupt existing state files.
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = `${filePath}.${uniqueSuffix}.tmp`;
  const serialized = JSON.stringify(data, null, 2);

  try {
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // Ignore cleanup failure when the temp file was never created or already moved.
    }
    throw err;
  }
}

/**
 * Coalesces bursts of mutations into debounced, serialized, atomic disk writes.
 */
export class DebouncedJsonWriter<T> {
  private timer: NodeJS.Timeout | null = null;
  private queuedSnapshot: (() => T) | null = null;
  private activeLoop: Promise<void> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly debounceMs = 400,
    private readonly onError?: (err: unknown) => void
  ) {}

  public schedule(snapshot: () => T): void {
    this.queuedSnapshot = snapshot;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  public async flush(snapshot?: () => T): Promise<void> {
    if (snapshot) {
      this.queuedSnapshot = snapshot;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.activeLoop || (this.queuedSnapshot && !this.timer)) {
      if (this.activeLoop) {
        await this.activeLoop;
      } else {
        await this.drain();
      }
    }
  }

  private drain(): Promise<void> {
    if (this.activeLoop) {
      return this.activeLoop;
    }

    this.activeLoop = (async () => {
      try {
        while (this.queuedSnapshot && !this.timer) {
          const getSnapshot = this.queuedSnapshot;
          this.queuedSnapshot = null;
          try {
            await writeJsonAtomic(this.filePath, getSnapshot());
          } catch (err: unknown) {
            if (this.onError) {
              this.onError(err);
            } else {
              console.error(
                `[Persistence] Failed to write ${this.filePath}:`,
                err instanceof Error ? err.message : err
              );
            }
          }
        }
      } finally {
        this.activeLoop = null;
      }
    })();

    return this.activeLoop;
  }
}
