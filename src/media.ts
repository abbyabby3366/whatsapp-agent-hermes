import dns from 'dns';
import fs from 'fs';
import net from 'net';
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
  allowPrivateNetwork?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  allowedDir?: string;
}

export interface ResolvedMedia {
  buffer: Buffer;
  mimetype?: string;
  fileName?: string;
}

const MAX_REMOTE_REDIRECTS = 5;

function parseIpv6Words(ip: string): number[] | null {
  let working = ip;
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const ipv4Part = working.slice(lastColon + 1);
    if (!net.isIPv4(ipv4Part)) return null;
    const octets = ipv4Part.split('.').map((n) => Number.parseInt(n, 10));
    const w0 = ((octets[0] << 8) | octets[1]).toString(16);
    const w1 = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${w0}:${w1}`;
  }

  const halves = working.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const isHexGroup = (g: string) => /^[0-9a-f]{1,4}$/.test(g);
  if (!left.every(isHexGroup) || !right.every(isHexGroup)) return null;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    return left.map((h) => Number.parseInt(h, 16));
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  return [
    ...left.map((h) => Number.parseInt(h, 16)),
    ...new Array<number>(missing).fill(0),
    ...right.map((h) => Number.parseInt(h, 16))
  ];
}

/**
 * Returns true when `rawIp` falls inside loopback, private, link-local, CGNAT, multicast, or reserved ranges.
 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const cleaned = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!cleaned) return true;

  if (net.isIPv4(cleaned)) {
    const octets = cleaned.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((o) => !Number.isFinite(o) || o < 0 || o > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8 ("this network")
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
    if (a >= 224) return true; // multicast / reserved / broadcast
    return false;
  }

  if (net.isIPv6(cleaned)) {
    const words = parseIpv6Words(cleaned);
    if (!words || words.some((w) => !Number.isFinite(w))) {
      return true;
    }
    const prefixZero6 = words.slice(0, 6).every((w) => w === 0);
    if (prefixZero6 && words[6] === 0 && (words[7] === 0 || words[7] === 1)) {
      return true; // :: and ::1
    }
    const isV4Mapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
    const isV4Compat = prefixZero6 && (words[6] !== 0 || words[7] > 1);
    if (isV4Mapped || isV4Compat) {
      const v4 = `${words[6] >>> 8}.${words[6] & 0xff}.${words[7] >>> 8}.${words[7] & 0xff}`;
      return isPrivateOrReservedIp(v4);
    }
    if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
    if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
    if ((words[0] & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
    return false;
  }

  return true;
}

async function assertSafeRemoteUrl(targetUrl: URL): Promise<void> {
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new MediaResolutionError(400, `Unsupported media URL protocol: ${targetUrl.protocol}`);
  }
  if (targetUrl.username || targetUrl.password) {
    throw new MediaResolutionError(400, 'Media URL must not include embedded credentials');
  }

  const host = targetUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    throw new MediaResolutionError(400, 'Media URL hostname is empty');
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new MediaResolutionError(403, 'Access denied: remote media URL points to a restricted internal host');
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new MediaResolutionError(
        403,
        'Access denied: remote media URL resolves to a private, loopback, or link-local address'
      );
    }
    return;
  }

  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (err: unknown) {
    throw new MediaResolutionError(
      502,
      `Could not resolve remote media host "${host}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!records.length) {
    throw new MediaResolutionError(502, `Could not resolve remote media host "${host}"`);
  }
  if (records.some((record) => isPrivateOrReservedIp(record.address))) {
    throw new MediaResolutionError(
      403,
      'Access denied: remote media URL resolves to a private, loopback, or link-local address'
    );
  }
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
  const allowPrivateNetwork = opts.allowPrivateNetwork ?? config.allowPrivateMediaUrls;
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

  // 1. Remote HTTP / HTTPS URL (SSRF-checked per hop, bounded timeout & byte ceiling)
  if (/^https?:\/\//i.test(str)) {
    let currentUrl: URL;
    try {
      currentUrl = new URL(str);
    } catch {
      throw new MediaResolutionError(400, `Invalid media URL: "${str.slice(0, 80)}"`);
    }

    const deadline = Date.now() + timeoutMs;
    try {
      let res: Response | null = null;
      for (let hop = 0; hop <= MAX_REMOTE_REDIRECTS; hop++) {
        if (!allowPrivateNetwork) {
          await assertSafeRemoteUrl(currentUrl);
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new MediaResolutionError(502, `Timed out downloading media from ${currentUrl.toString()} after ${timeoutMs}ms`);
        }
        res = await fetch(currentUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(remainingMs)
        });

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          await res.body?.cancel();
          if (!location) {
            throw new MediaResolutionError(502, `Redirect from ${currentUrl.toString()} (HTTP ${res.status}) missing Location header`);
          }
          if (hop === MAX_REMOTE_REDIRECTS) {
            throw new MediaResolutionError(502, 'Too many redirects while downloading media');
          }
          try {
            currentUrl = new URL(location, currentUrl);
          } catch {
            throw new MediaResolutionError(400, `Invalid redirect URL while downloading media`);
          }
          continue;
        }
        break;
      }

      if (!res) {
        throw new MediaResolutionError(502, `Failed to download media from ${currentUrl.toString()}`);
      }
      if (!res.ok) {
        throw new MediaResolutionError(502, `Failed to download media from ${currentUrl.toString()} (HTTP ${res.status})`);
      }

      const buffer = await readStreamWithLimit(res, maxBytes, currentUrl.toString());
      if (buffer.length === 0) {
        throw new MediaResolutionError(502, `Remote media from ${currentUrl.toString()} was empty`);
      }

      const rawContentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      const mimetype = rawContentType && rawContentType.includes('/') ? rawContentType : undefined;

      const rawBase = path.posix.basename(currentUrl.pathname);
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
        throw new MediaResolutionError(502, `Timed out downloading media from ${currentUrl.toString()} after ${timeoutMs}ms`);
      }
      throw new MediaResolutionError(
        502,
        `Failed to download media from ${currentUrl.toString()}: ${err instanceof Error ? err.message : String(err)}`
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
