import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type http from 'node:http';
import sharp from 'sharp';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-gateway-test-'));
const testDataDir = path.join(tmpRoot, 'data');
const testSessionsDir = path.join(tmpRoot, 'sessions');
const testMediaDir = path.join(tmpRoot, 'media');
const TEST_API_KEY = 'unit-test-gateway-key-9876543210';

fs.mkdirSync(testDataDir, { recursive: true });
fs.mkdirSync(testSessionsDir, { recursive: true });
fs.mkdirSync(testMediaDir, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = testDataDir;
process.env.SESSIONS_DIR = testSessionsDir;
process.env.ALLOWED_MEDIA_DIR = testMediaDir;
process.env.GATEWAY_API_KEY = TEST_API_KEY;
process.env.TIMEZONE = 'Asia/Kuala_Lumpur';
process.env.DEFAULT_COUNTRY_CODE = '60';

const { formatDateTimeParts, flushSettings, isPlaceholderSecret } = await import('../src/config.js');
const { DebouncedJsonWriter } = await import('../src/persistence.js');
const { MediaResolutionError, resolveMediaInput } = await import('../src/media.js');
const { buildStickerExif, injectWebpExif, prepareSticker } = await import('../src/sticker.js');
const {
  formatWhatsAppText,
  inferDocumentMimetype,
  isValidWhatsAppUsername,
  parseRecipientInput,
  waClient
} = await import('../src/whatsapp.js');
const { app, resetAuthRateLimits } = await import('../src/index.js');

let server: http.Server;
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  await Promise.all([waClient.shutdown(), flushSettings()]);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Recipient parsing & validation', () => {
  it('parses JIDs, phone numbers with leading 0, and @usernames with optional PIN', () => {
    assert.deepEqual(parseRecipientInput('60123456789@s.whatsapp.net'), {
      kind: 'jid',
      jid: '60123456789@s.whatsapp.net'
    });
    assert.deepEqual(parseRecipientInput('012-345 6789'), {
      kind: 'phone',
      jid: '60123456789@s.whatsapp.net'
    });
    assert.deepEqual(parseRecipientInput('@Alex_Tan#0412'), {
      kind: 'username',
      username: 'alex_tan',
      pin: '0412'
    });
    assert.equal(parseRecipientInput('@123456').kind, 'invalid');
    assert.equal(parseRecipientInput('user@example.com').kind, 'invalid');
    assert.equal(isValidWhatsAppUsername('alex_tan.1'), true);
    assert.equal(isValidWhatsAppUsername('.alex'), false);
    assert.equal(isValidWhatsAppUsername('alex..tan'), false);
  });
});

describe('WhatsApp formatting & MIME inference', () => {
  it('protects fenced code blocks, inline code, and URLs with $ patterns while spacing CJK bold', () => {
    const input = [
      'Here is **bold** and 你好**世界**',
      'Check https://example.com/path?a=$1&b=$&*test*',
      'Inline `const x = **keep** + "$1";`',
      '```ts',
      'const y = "**also_keep** $2";',
      '```'
    ].join('\n');

    const out = formatWhatsAppText(input);
    assert.match(out, /Here is \*bold\* and 你好 \*世界\*/);
    assert.ok(out.includes('https://example.com/path?a=$1&b=$&*test*'));
    assert.ok(out.includes('`const x = **keep** + "$1";`'));
    assert.ok(out.includes('const y = "**also_keep** $2";'));
  });

  it('infers known document MIME types accurately and uses application/octet-stream for unknown extensions', () => {
    assert.equal(inferDocumentMimetype('notes.md'), 'text/markdown');
    assert.equal(inferDocumentMimetype('spec.pdf'), 'application/pdf');
    assert.equal(inferDocumentMimetype('config.yml'), 'application/yaml');
    assert.equal(inferDocumentMimetype('artifact.unknownext'), 'application/octet-stream');
  });
});

describe('Media resolution confinement & limits', () => {
  it('allows files inside ALLOWED_MEDIA_DIR and rejects outside, .env, or sessions paths with 403', async () => {
    const safeFile = path.join(testMediaDir, 'hello.txt');
    fs.writeFileSync(safeFile, 'hello world');
    const ok = await resolveMediaInput(safeFile);
    assert.equal(ok.buffer.toString('utf8'), 'hello world');
    assert.equal(ok.fileName, 'hello.txt');

    const envFile = path.join(testMediaDir, '.env.local');
    fs.writeFileSync(envFile, 'SECRET=1');
    await assert.rejects(
      () => resolveMediaInput(envFile),
      (err: unknown) => err instanceof MediaResolutionError && err.statusCode === 403
    );

    const sessionFile = path.join(testSessionsDir, 'creds.json');
    fs.writeFileSync(sessionFile, '{}');
    await assert.rejects(
      () => resolveMediaInput(sessionFile),
      (err: unknown) => err instanceof MediaResolutionError && err.statusCode === 403
    );

    const outsideFile = path.join(tmpRoot, 'outside.txt');
    fs.writeFileSync(outsideFile, 'nope');
    await assert.rejects(
      () => resolveMediaInput(outsideFile),
      (err: unknown) => err instanceof MediaResolutionError && err.statusCode === 403
    );

    await assert.rejects(
      () => resolveMediaInput(safeFile, { maxBytes: 4 }),
      (err: unknown) => err instanceof MediaResolutionError && err.statusCode === 413
    );
  });
});

describe('Sticker WebP EXIF & size ceiling', () => {
  it('produces <= 100 KB static WebP preserving alpha & EXIF flags, and rejects truncated buffers', async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 180, b: 90, alpha: 0.5 } }
    })
      .png()
      .toBuffer();

    const stickerBuf = await prepareSticker(png, { pack: 'Hermes Pack', author: 'Agent' });
    assert.equal(stickerBuf.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(stickerBuf.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.equal(stickerBuf.subarray(12, 16).toString('ascii'), 'VP8X');
    assert.ok((stickerBuf[20] & 0x08) !== 0, 'expected EXIF flag bit 0x08');
    assert.ok((stickerBuf[20] & 0x10) !== 0, 'expected Alpha flag bit 0x10');
    assert.ok(stickerBuf.includes(Buffer.from('EXIF', 'ascii')));
    assert.ok(stickerBuf.length <= 100 * 1024);

    const exif = buildStickerExif({ pack: 'P', author: 'A' });
    const badWebp = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 \x99\x00\x00\x00truncated');
    assert.throws(() => injectWebpExif(badWebp, exif), /Malformed WebP buffer/);
  });
});

describe('Persistence & GMT+8 date formatting', () => {
  it('coalesces DebouncedJsonWriter writes atomically and formats dates as DD-MM-YY in GMT+8', async () => {
    const targetFile = path.join(testDataDir, 'writer-test.json');
    const writer = new DebouncedJsonWriter<{ seq: number }>(targetFile, 200);
    writer.schedule(() => ({ seq: 1 }));
    writer.schedule(() => ({ seq: 2 }));
    writer.schedule(() => ({ seq: 3 }));
    await writer.flush();

    const saved = JSON.parse(fs.readFileSync(targetFile, 'utf8')) as { seq: number };
    assert.equal(saved.seq, 3);
    const leftoverTmp = fs.readdirSync(testDataDir).filter((f) => f.includes('writer-test.json.') && f.endsWith('.tmp'));
    assert.equal(leftoverTmp.length, 0);

    const parts = formatDateTimeParts(new Date('2026-09-22T04:05:06.000Z'), 'Asia/Kuala_Lumpur');
    assert.deepEqual(parts, {
      date: '22-09-26',
      time: '12:05:06',
      full: '22-09-26 12:05:06'
    });

    assert.equal(isPlaceholderSecret('change-me-to-a-long-random-string'), true);
    assert.equal(isPlaceholderSecret('c4d9f1a0e81b44f0a1234567'), false);
  });
});

describe('HTTP Gateway (Express 5, CSP, Auth Rate Limit, SSE)', () => {
  it('serves health, hardens dashboard HTML headers, enforces auth + rate limit, and streams SSE events', async () => {
    resetAuthRateLimits();

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { success: boolean; whatsapp: string };
    assert.equal(healthJson.success, true);

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(htmlRes.headers.get('x-frame-options'), 'DENY');
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(htmlRes.headers.get('cross-origin-resource-policy'), 'same-origin');
    const htmlBody = await htmlRes.text();
    assert.ok(htmlBody.includes('<script defer src="/app.js"></script>'));
    assert.ok(htmlBody.includes('<search class="activity-search"'));

    const unauthRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(unauthRes.status, 401);

    const okRes = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-api-key': TEST_API_KEY }
    });
    assert.equal(okRes.status, 200);
    const okJson = (await okRes.json()) as { success: boolean; data: { stateVersion: number; timezone: string } };
    assert.equal(okJson.success, true);
    assert.equal(typeof okJson.data.stateVersion, 'number');
    assert.equal(okJson.data.timezone, 'Asia/Kuala_Lumpur');

    const badJsonRes = await fetch(`${baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'x-api-key': TEST_API_KEY, 'Content-Type': 'application/json' },
      body: '{"broken":'
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonBody = (await badJsonRes.json()) as { success: boolean; error: string };
    assert.equal(badJsonBody.error, 'Request body is not valid JSON');

    // SSE stream check
    const sseAbort = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/events`, {
      headers: { 'x-api-key': TEST_API_KEY, Accept: 'text/event-stream' },
      signal: sseAbort.signal
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/);
    assert.ok(sseRes.body);
    const reader = sseRes.body.getReader();
    const firstChunk = await reader.read();
    const sseText = new TextDecoder().decode(firstChunk.value || new Uint8Array());
    assert.match(sseText, /^event: status\ndata: \{/);
    sseAbort.abort();
    await reader.cancel().catch(() => undefined);

    // Rate limit brute-force 401s -> 429 on 21st attempt
    resetAuthRateLimits();
    for (let i = 0; i < 20; i++) {
      const attempt = await fetch(`${baseUrl}/api/status`, {
        headers: { 'x-api-key': 'wrong-key' }
      });
      assert.equal(attempt.status, 401);
    }
    const lockedRes = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-api-key': TEST_API_KEY }
    });
    assert.equal(lockedRes.status, 429);
    assert.ok(lockedRes.headers.get('retry-after'));
    resetAuthRateLimits();

    const recoveredRes = await fetch(`${baseUrl}/api/status`, {
      headers: { 'x-api-key': TEST_API_KEY }
    });
    assert.equal(recoveredRes.status, 200);
  });
});
