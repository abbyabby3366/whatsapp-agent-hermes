import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
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

const { config, formatDateTimeParts, flushSettings, isPlaceholderSecret } = await import('../src/config.js');
const { expandHomePath } = await import('../src/formatting.js');
const { DebouncedJsonWriter } = await import('../src/persistence.js');
const { isPrivateOrReservedIp, MediaResolutionError, resolveMediaInput } = await import('../src/media.js');
const { buildStickerExif, injectWebpExif, prepareSticker } = await import('../src/sticker.js');
const {
  formatWhatsAppText,
  inferDocumentMimetype,
  isValidWhatsAppUsername,
  parseRecipientInput,
  WhatsAppClient,
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

  it('serves GET /api/qr.png with auth, 404 when unready, raw PNG on qr_ready, and 409 when connected', async () => {
    const unauthQr = await fetch(`${baseUrl}/api/qr.png`);
    assert.equal(unauthQr.status, 401);

    const pngBytes = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    })
      .png()
      .toBuffer();
    const originalGetState = waClient.getState.bind(waClient);

    try {
      waClient.getState = () => ({
        ...originalGetState(),
        status: 'disconnected',
        qrCodeDataUrl: null
      });
      const notReadyRes = await fetch(`${baseUrl}/api/qr.png`, {
        headers: { 'x-api-key': TEST_API_KEY }
      });
      assert.equal(notReadyRes.status, 404);

      waClient.getState = () => ({
        ...originalGetState(),
        status: 'qr_ready',
        qrCodeDataUrl: `data:image/png;base64,${pngBytes.toString('base64')}`
      });
      const qrRes = await fetch(`${baseUrl}/api/qr.png`, {
        headers: { 'x-api-key': TEST_API_KEY }
      });
      assert.equal(qrRes.status, 200);
      assert.equal(qrRes.headers.get('content-type'), 'image/png');
      assert.equal(qrRes.headers.get('cache-control'), 'no-store');
      const bodyBytes = Buffer.from(await qrRes.arrayBuffer());
      assert.equal(bodyBytes.equals(pngBytes), true);

      waClient.getState = () => ({
        ...originalGetState(),
        status: 'connected',
        user: { id: '60123456789@s.whatsapp.net', name: 'Test' },
        qrCodeDataUrl: null
      });
      const connectedRes = await fetch(`${baseUrl}/api/qr.png`, {
        headers: { 'x-api-key': TEST_API_KEY }
      });
      assert.equal(connectedRes.status, 409);
    } finally {
      waClient.getState = originalGetState;
    }
  });
});

describe('Security, tilde paths, self-chat, manual echoes & LID phone resolution', () => {
  it('expands leading tilde paths cleanly without altering regular paths', () => {
    assert.equal(expandHomePath('~', '/home/tester'), '/home/tester');
    assert.equal(expandHomePath('~/sub/file.env', '/home/tester'), path.join('/home/tester', 'sub/file.env'));
    assert.equal(expandHomePath('./relative', '/home/tester'), './relative');
    assert.equal(expandHomePath('/abs/path', '/home/tester'), '/abs/path');
  });

  it('blocks private, loopback, link-local metadata URLs and redirects to private IPs (SSRF)', async () => {
    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
    assert.equal(isPrivateOrReservedIp('10.1.2.3'), true);
    assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
    assert.equal(isPrivateOrReservedIp('192.168.1.10'), true);
    assert.equal(isPrivateOrReservedIp('::1'), true);
    assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('0:0:0:0:0:ffff:127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('0:0:0:0:0:ffff:8.8.8.8'), false);
    assert.equal(isPrivateOrReservedIp('fe80::1'), true);
    assert.equal(isPrivateOrReservedIp('fc00::1'), true);
    assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);

    const mediaSrv = http.createServer((req, res) => {
      if (req.url === '/redirect-local') {
        res.writeHead(302, { Location: `http://127.0.0.1:${(mediaSrv.address() as { port: number }).port}/ok.txt` });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok-bytes');
    });
    await new Promise<void>((resolve) => mediaSrv.listen(0, '127.0.0.1', () => resolve()));
    const addr = mediaSrv.address() as { port: number };

    try {
      for (const blockedUrl of [
        `http://127.0.0.1:${addr.port}/ok.txt`,
        `http://[::1]:${addr.port}/ok.txt`,
        `http://localhost:${addr.port}/ok.txt`,
        'http://169.254.169.254/latest/meta-data/'
      ]) {
        await assert.rejects(
          () => resolveMediaInput(blockedUrl),
          (err: unknown) => err instanceof MediaResolutionError && err.statusCode === 403
        );
      }

      const allowed = await resolveMediaInput(`http://127.0.0.1:${addr.port}/redirect-local`, {
        allowPrivateNetwork: true
      });
      assert.equal(allowed.buffer.toString('utf8'), 'ok-bytes');

      // Simulate a public URL redirecting to internal loopback -> must reject hop 1 with 403
      const origFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${addr.port}/ok.txt` } });
      }) as typeof fetch;
      try {
        await assert.rejects(
          () => resolveMediaInput('https://8.8.8.8/image.png'),
          (err: unknown) => err instanceof MediaResolutionError && err.statusCode === 403
        );
        assert.equal(fetchCalls, 1);
      } finally {
        globalThis.fetch = origFetch;
      }
    } finally {
      await new Promise<void>((resolve) => mediaSrv.close(() => resolve()));
    }
  });

  it('forwards self-chat DMs and manual phone echoes, filters gateway echoes, and resolves LID phones locally', async () => {
    const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-client-iso-'));
    const isoSessions = path.join(isoRoot, 'sessions');
    const isoData = path.join(isoRoot, 'data');

    const receivedHooks: Array<Record<string, unknown>> = [];
    const hookSrv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedHooks.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'processing', reply: null }));
      });
    });
    await new Promise<void>((resolve) => hookSrv.listen(0, '127.0.0.1', () => resolve()));
    const hookAddr = hookSrv.address() as { port: number };

    const prevWebhookUrl = config.webhookUrl;
    const prevWebhookToken = config.webhookToken;
    const prevRetries = config.webhookRetries;
    const prevAllowed = [...config.allowedNumbers];
    const prevDataDir = config.dataDir;

    config.dataDir = isoData;
    config.webhookUrl = `http://127.0.0.1:${hookAddr.port}/api/webhook`;
    config.webhookToken = '';
    config.webhookRetries = 0;
    config.allowedNumbers = [];

    const client = new WhatsAppClient(isoSessions, isoData);
    const fakeWs = new EventEmitter();
    const fakeSock = {
      user: { id: '60123456789:0@s.whatsapp.net', lid: '111222333444555:0@lid', name: 'Desmond' },
      ws: fakeWs,
      ev: { removeAllListeners: () => undefined },
      end: () => undefined,
      onWhatsApp: async (jid: string) => [{ exists: true, jid }],
      generateMessageTag: () => 'tag_1',
      query: async () => ({ tag: 'iq', attrs: {}, content: [] }),
      sendMessage: async (_jid: string, _content: unknown, opts?: { messageId?: string }) => {
        const id = opts?.messageId || 'gw_out_fallback';
        queueMicrotask(() => fakeWs.emit(`TAG:${id}`, { tag: 'ack', attrs: { class: 'message' } }));
        return { key: { id } };
      },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid: string) => {
            if (lid === '111222333444555@lid') return '60123456789@s.whatsapp.net';
            if (lid === '222333444555666@lid') return '60187654321@s.whatsapp.net';
            return null;
          },
          storeLIDPNMappings: async () => undefined
        }
      }
    };

    const internal = client as unknown as {
      sock: unknown;
      status: string;
      handleIncomingMessage: (msg: unknown) => Promise<void>;
    };
    internal.sock = fakeSock;
    internal.status = 'connected';

    try {
      // 1. Gateway's own outbound message echoed back -> ignored
      const sent = await client.sendMessage('60187654321', 'Hello from gateway');
      assert.equal(sent.success, true);
      assert.ok(sent.messageId);
      await internal.handleIncomingMessage({
        key: { id: sent.messageId, remoteJid: '60187654321@s.whatsapp.net', fromMe: true },
        message: { conversation: 'Hello from gateway' }
      });
      assert.equal(receivedHooks.length, 0);

      // 2. Owner's non-gateway self-chat message over @lid -> forwarded with fromMe + isSelfChat + phone
      await internal.handleIncomingMessage({
        key: { id: 'self_msg_1', remoteJid: '111222333444555@lid', fromMe: true },
        message: { conversation: 'status' }
      });
      assert.equal(receivedHooks.length, 1);
      assert.equal(receivedHooks[0].event, 'message.received');
      assert.equal(receivedHooks[0].fromMe, true);
      assert.equal(receivedHooks[0].isSelfChat, true);
      assert.equal(receivedHooks[0].sender, '60123456789');

      // 3. Owner's manual reply from phone to contact -> message.echo without incrementing receivedCount
      const beforeCount = client.getState().stats.receivedCount;
      await internal.handleIncomingMessage({
        key: { id: 'manual_phone_1', remoteJid: '60187654321@s.whatsapp.net', fromMe: true },
        message: { conversation: 'Manual phone reply' }
      });
      assert.equal(client.getState().stats.receivedCount, beforeCount);
      assert.equal(receivedHooks.length, 2);
      assert.equal(receivedHooks[1].event, 'message.echo');
      assert.equal(receivedHooks[1].fromMe, true);
      assert.equal(receivedHooks[1].isSelfChat, false);
      assert.equal(receivedHooks[1].message, 'Manual phone reply');

      // 4. Inbound @lid without remoteJidAlt resolves phone from signalRepository.lidMapping and passes ALLOWED_NUMBERS
      config.allowedNumbers = ['60187654321'];
      await internal.handleIncomingMessage({
        key: { id: 'lid_only_1', remoteJid: '222333444555666@lid', fromMe: false },
        pushName: 'Lid Contact',
        message: { conversation: 'Hi via LID' }
      });
      assert.equal(receivedHooks.length, 3);
      assert.equal(receivedHooks[2].event, 'message.received');
      assert.equal(receivedHooks[2].sender, '60187654321');
    } finally {
      config.webhookUrl = prevWebhookUrl;
      config.webhookToken = prevWebhookToken;
      config.webhookRetries = prevRetries;
      config.allowedNumbers = prevAllowed;
      config.dataDir = prevDataDir;
      await client.shutdown();
      await new Promise<void>((resolve) => hookSrv.close(() => resolve()));
      fs.rmSync(isoRoot, { recursive: true, force: true });
    }
  });
});
