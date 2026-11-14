import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export class MediaResolutionError extends Error {
  public readonly statusCode: 400 | 403 | 413 | 502;

  constructor(statusCode: 400 | 403 | 413 | 502, message: string) {
    super(message);
    this.name = 'MediaResolutionError';
    this.statusCode = statusCode;
  }
}

export interface ResolveMediaOptions {
  allowRawBase64?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  allowedDir?: string;
}

export interface ResolvedMedia {
  buffer: Buffer;
  mimetype?: string;
  fileName?: string;
}

function isInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const rel = path.relative(rootDir, candidatePath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isForbiddenTarget(resolvedPath: string, realSessionsDir: string | null): boolean {
  const baseName = path.basename(resolvedPath).toLowerCase();
  if (baseName === '.env' || baseName.startsWith('.env.')) {
    return true;
  }
  if (realSessionsDir) {
    const normalizedSessions = path.resolve(realSessionsDir);
    if (resolvedPath === normalizedSessions || isInsideDirectory(normalizedSessions, resolvedPath)) {
      return true;
    }
  }
  return false;
}

async function resolveSafeRealPath(dirPath: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(dirPath);
  } catch {
    return null;
  }
}

async function readStreamWithLimit(res: Response, maxBytes: number, sourceUrl: string): Promise<Buffer> {
  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader) {
    const declaredBytes = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await res.body?.cancel();
      throw new MediaResolutionError(
        413,
        `Remote media (${declaredBytes} bytes) exceeds MAX_MEDIA_BYTES (${maxBytes} bytes)`
      );
    }
  }

  if (!res.body) {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new MediaResolutionError(
        413,
        `Remote media (${buffer.length} bytes) exceeds MAX_MEDIA_BYTES (${maxBytes} bytes)`
      );
    }
    return buffer;
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new MediaResolutionError(
          413,
          `Remote media exceeds MAX_MEDIA_BYTES (${maxBytes} bytes) while downloading from ${sourceUrl}`
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

/**
 * Resolves a Buffer, HTTP(S) URL, data URI, optional raw base64 string, or allowlisted local file path
 * into raw bytes while enforcing size, timeout, and directory-containment boundaries.
 */
export async function resolveMediaInput(
  input: string | Buffer,
  opts: ResolveMediaOptions = {}
): Promise<ResolvedMedia> {
  const maxBytes = opts.maxBytes ?? config.maxMediaBytes;
  const timeoutMs = opts.timeoutMs ?? config.mediaFetchTimeoutMs;
  const allowedDir = path.resolve(opts.allowedDir ?? config.allowedMediaDir);

  if (Buffer.isBuffer(input)) {
    if (input.length === 0) {
      throw new MediaResolutionError(400, 'Provided media Buffer is empty');
    }
    if (input.length > maxBytes) {
      throw new MediaResolutionError(413, `Media Buffer (${input.length} bytes) exceeds MAX_MEDIA_BYTES (${maxBytes} bytes)`);
    }
    return { buffer: input };
  }

  const str = input.trim();
  if (!str) {
    throw new MediaResolutionError(400, 'Media input string is empty');
  }

  // 1. Remote HTTP / HTTPS URL (bounded timeout & byte ceiling)
  if (/^https?:\/\//i.test(str)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(str);
    } catch {
      throw new MediaResolutionError(400, `Invalid media URL: "${str.slice(0, 80)}"`);
    }

    try {
      const res = await fetch(parsedUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        throw new MediaResolutionError(502, `Failed to download media from ${parsedUrl.toString()} (HTTP ${res.status})`);
      }

      const buffer = await readStreamWithLimit(res, maxBytes, parsedUrl.toString());
      if (buffer.length === 0) {
        throw new MediaResolutionError(502, `Remote media from ${parsedUrl.toString()} was empty`);
      }

      const rawContentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      const mimetype = rawContentType && rawContentType.includes('/') ? rawContentType : undefined;

      const rawBase = path.posix.basename(parsedUrl.pathname);
      let fileName: string | undefined;
      if (rawBase && rawBase !== '/') {
        try {
          fileName = decodeURIComponent(rawBase);
        } catch {
          fileName = rawBase;
        }
      }

      return { buffer, mimetype, fileName };
    } catch (err: unknown) {
      if (err instanceof MediaResolutionError) {
        throw err;
      }
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new MediaResolutionError(502, `Timed out downloading media from ${parsedUrl.toString()} after ${timeoutMs}ms`);
      }
      throw new MediaResolutionError(
        502,
        `Failed to download media from ${parsedUrl.toString()}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 2. Data URI (e.g. data:image/png;base64,...)
  if (/^data:/i.test(str)) {
    const commaIndex = str.indexOf(',');
    if (commaIndex === -1) {
      throw new MediaResolutionError(400, 'Invalid data URI format: missing comma separator');
    }
    const header = str.slice(5, commaIndex);
    const body = str.slice(commaIndex + 1);
    const headerParts = header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
    const isBase64 = headerParts.some((part) => part.toLowerCase() === 'base64');
    const firstPart = headerParts[0]?.toLowerCase();
    const mimetype = firstPart && firstPart.includes('/') ? firstPart : undefined;

    let buffer: Buffer;
    if (isBase64) {
      const compact = body.replace(/\s+/g, '');
      const estimatedBytes = Math.floor((compact.length * 3) / 4);
      if (estimatedBytes > maxBytes + 3) {
        throw new MediaResolutionError(413, `Data URI exceeds MAX_MEDIA_BYTES (${maxBytes} bytes)`);
      }
      buffer = Buffer.from(compact, 'base64');
    } else {
      try {
        buffer = Buffer.from(decodeURIComponent(body), 'utf8');
      } catch {
        buffer = Buffer.from(body, 'utf8');
      }
    }

    if (buffer.length === 0) {
      throw new MediaResolutionError(400, 'Data URI decoded to an empty buffer');
    }
    if (buffer.length > maxBytes) {
      throw new MediaResolutionError(413, `Data URI (${buffer.length} bytes) exceeds MAX_MEDIA_BYTES (${maxBytes} bytes)`);
    }
    return { buffer, mimetype };
  }

  // 3. Raw base64 string (optional, used by stickers)
  if (opts.allowRawBase64 && /^[A-Za-z0-9+/=]+$/.test(str) && str.length > 30) {
    const estimatedBytes = Math.floor((str.length * 3) / 4);
    if (estimatedBytes > maxBytes + 3) {
      throw new MediaResolutionError(413, `Base64 media exceeds MAX_MEDIA_BYTES (${maxBytes} bytes)`);
    }
    const buffer = Buffer.from(str, 'base64');
    if (buffer.length === 0) {
      throw new MediaResolutionError(400, 'Base64 media decoded to an empty buffer');
    }
    if (buffer.length > maxBytes) {
      throw new MediaResolutionError(413, `Base64 media (${buffer.length} bytes) exceeds MAX_MEDIA_BYTES (${maxBytes} bytes)`);
    }
    return { buffer };
  }

  // 4. Local filesystem path (strictly confined to ALLOWED_MEDIA_DIR; never sessions or .env)
  const looksLikePath =
    path.isAbsolute(str) ||
    str.includes('/') ||
    str.includes('\\') ||
    str.startsWith('.') ||
    fs.existsSync(str);

  if (!looksLikePath) {
    throw new MediaResolutionError(
      400,
      `Cannot resolve media "${str.slice(0, 60)}": expected an http(s) URL, data URI, or file inside ALLOWED_MEDIA_DIR (${allowedDir}).`
    );
  }

  await fs.promises.mkdir(allowedDir, { recursive: true });
  const realAllowedRoot = await fs.promises.realpath(allowedDir);
  const realSessionsDir = await resolveSafeRealPath(path.resolve(config.sessionsDir));
  const candidatePath = path.resolve(str);

  if (!isInsideDirectory(realAllowedRoot, candidatePath) || isForbiddenTarget(candidatePath, realSessionsDir)) {
    throw new MediaResolutionError(
      403,
      `Access denied: local media paths must reside inside ALLOWED_MEDIA_DIR (${realAllowedRoot}).`
    );
  }

  let realTarget: string;
  try {
    realTarget = await fs.promises.realpath(candidatePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new MediaResolutionError(400, `Media file not found inside ALLOWED_MEDIA_DIR: ${str}`);
    }
    throw new MediaResolutionError(400, `Cannot access media file "${str}": ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isInsideDirectory(realAllowedRoot, realTarget) || isForbiddenTarget(realTarget, realSessionsDir)) {
    throw new MediaResolutionError(
      403,
      `Access denied: local media paths must reside inside ALLOWED_MEDIA_DIR (${realAllowedRoot}).`
    );
  }

  const stat = await fs.promises.stat(realTarget);
  if (!stat.isFile()) {
    throw new MediaResolutionError(400, `Media path is not a regular file: ${str}`);
  }
  if (stat.size === 0) {
    throw new MediaResolutionError(400, `Media file is empty: ${str}`);
  }
  if (stat.size > maxBytes) {
    throw new MediaResolutionError(
      413,
      `Local media file (${stat.size} bytes) exceeds MAX_MEDIA_BYTES (${maxBytes} bytes)`
    );
  }

  const buffer = await fs.promises.readFile(realTarget);
  return { buffer, fileName: path.basename(realTarget) };
}
