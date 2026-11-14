import crypto from 'crypto';
import sharp from 'sharp';
import { resolveMediaInput } from './media.js';

const MAX_STATIC_STICKER_BYTES = 100 * 1024;
const MAX_ANIMATED_STICKER_BYTES = 500 * 1024;

export interface StickerOptions {
  pack?: string;
  author?: string;
  categories?: string[];
  id?: string;
  isAnimated?: boolean;
  quality?: number;
}

/**
 * Builds the WhatsApp WebP EXIF metadata buffer containing pack name, author, categories, etc.
 */
export function buildStickerExif(options: {
  pack?: string;
  author?: string;
  categories?: string[];
  id?: string;
}): Buffer {
  const metadata = {
    'sticker-pack-id': options.id || crypto.randomUUID(),
    'sticker-pack-name': options.pack || '',
    'sticker-pack-publisher': options.author || '',
    emojis: options.categories || []
  };

  const jsonString = JSON.stringify(metadata);
  const jsonBuf = Buffer.from(jsonString, 'utf-8');

  // Little-endian TIFF header followed by tag 0x5343 (W A) for WhatsApp sticker metadata
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x16, 0x00, 0x00, 0x00
  ]);

  const exifBody = Buffer.concat([exifHeader, jsonBuf]);
  exifBody.writeUIntLE(jsonBuf.length, 14, 4);
  return exifBody;
}

/**
 * Injects an EXIF chunk into a WebP buffer so WhatsApp recognizes the sticker pack and author.
 */
export function injectWebpExif(webpBuf: Buffer, exifBody: Buffer): Buffer {
  if (
    webpBuf.length < 20 ||
    webpBuf.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    webpBuf.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    throw new Error('Invalid WebP buffer: missing RIFF/WEBP signature');
  }

  const fourCC = webpBuf.subarray(12, 16).toString('ascii');
  let result: Buffer;

  if (fourCC === 'VP8X') {
    if (webpBuf.length < 30) {
      throw new Error('Malformed WebP buffer: truncated VP8X header');
    }
    const modified = Buffer.from(webpBuf);
    // Set bit 3 (0x08) on flags byte to indicate EXIF is present
    modified[20] |= 0x08;

    // Filter out any existing EXIF chunk
    let offset = 30; // 12 (RIFF+WEBP) + 8 (VP8X chunk header) + 10 (VP8X payload)
    const chunks: Buffer[] = [modified.subarray(0, 30)];
    while (offset < modified.length) {
      if (offset + 8 > modified.length) {
        throw new Error(`Malformed WebP buffer: truncated chunk header at offset ${offset}`);
      }
      const tag = modified.subarray(offset, offset + 4).toString('ascii');
      const size = modified.readUInt32LE(offset + 4);
      if (offset + 8 + size > modified.length) {
        throw new Error(`Malformed WebP buffer: chunk "${tag}" exceeds buffer length`);
      }
      const totalChunkLen = 8 + size + (size % 2);
      if (tag !== 'EXIF') {
        chunks.push(modified.subarray(offset, Math.min(offset + totalChunkLen, modified.length)));
      }
      offset += totalChunkLen;
    }

    const exifChunkHeader = Buffer.alloc(8);
    exifChunkHeader.write('EXIF', 0, 4, 'ascii');
    exifChunkHeader.writeUInt32LE(exifBody.length, 4);
    const pad = exifBody.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);

    chunks.push(exifChunkHeader, exifBody, pad);
    result = Buffer.concat(chunks);
  } else {
    // WebP without VP8X (simple VP8 or VP8L). Inspect frame dimensions and alpha, then wrap with VP8X.
    const chunkSize = webpBuf.readUInt32LE(16);
    if (20 + chunkSize > webpBuf.length) {
      throw new Error(`Malformed WebP buffer: chunk "${fourCC}" exceeds buffer length`);
    }

    let widthMinus1 = 511;
    let heightMinus1 = 511;
    let hasAlpha = false;

    if (fourCC === 'VP8L') {
      if (webpBuf.length < 25 || webpBuf[20] !== 0x2f) {
        throw new Error('Malformed WebP buffer: invalid VP8L bitstream header');
      }
      const bits = webpBuf.readUInt32LE(21);
      widthMinus1 = bits & 0x3fff;
      heightMinus1 = (bits >>> 14) & 0x3fff;
      hasAlpha = Boolean((bits >>> 28) & 0x01);
    } else if (fourCC === 'VP8 ') {
      if (webpBuf.length < 30 || webpBuf[23] !== 0x9d || webpBuf[24] !== 0x01 || webpBuf[25] !== 0x2a) {
        throw new Error('Malformed WebP buffer: invalid VP8 bitstream header');
      }
      widthMinus1 = Math.max(0, (webpBuf.readUInt16LE(26) & 0x3fff) - 1);
      heightMinus1 = Math.max(0, (webpBuf.readUInt16LE(28) & 0x3fff) - 1);
    } else {
      throw new Error(`Unsupported WebP chunk format "${fourCC}"`);
    }

    const vp8xHeader = Buffer.alloc(18);
    vp8xHeader.write('VP8X', 0, 4, 'ascii');
    vp8xHeader.writeUInt32LE(10, 4);
    vp8xHeader[8] = 0x08 | (hasAlpha ? 0x10 : 0x00); // Preserve Alpha (0x10) alongside EXIF (0x08)
    vp8xHeader.writeUIntLE(widthMinus1, 12, 3);
    vp8xHeader.writeUIntLE(heightMinus1, 15, 3);

    const payloadTail = webpBuf.subarray(12);
    const payloadPad = payloadTail.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);

    const exifChunkHeader = Buffer.alloc(8);
    exifChunkHeader.write('EXIF', 0, 4, 'ascii');
    exifChunkHeader.writeUInt32LE(exifBody.length, 4);
    const pad = exifBody.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);

    result = Buffer.concat([
      webpBuf.subarray(0, 12),
      vp8xHeader,
      payloadTail,
      payloadPad,
      exifChunkHeader,
      exifBody,
      pad
    ]);
  }

  // Update total file size in RIFF header: total length minus 8 bytes ('RIFF' + 4-byte size)
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

/**
 * Resolves any input (URL, data URI, base64, allowlisted local file path, or Buffer) into raw image bytes.
 */
export async function resolveImageBuffer(input: string | Buffer): Promise<Buffer> {
  const resolved = await resolveMediaInput(input, { allowRawBase64: true });
  return resolved.buffer;
}

/**
 * Formats an image (PNG, JPG, WebP, GIF, etc.) into a 512x512 WebP WhatsApp sticker with Exif metadata,
 * stepping down quality if needed to stay within WhatsApp's sticker payload ceilings.
 */
export async function prepareSticker(
  input: string | Buffer,
  options: StickerOptions = {}
): Promise<Buffer> {
  const rawBuffer = await resolveImageBuffer(input);

  // Probe format and animation once, then clone for encoding passes
  const baseSharp = sharp(rawBuffer, {
    animated: options.isAnimated ?? true,
    limitInputPixels: 64_000_000
  });
  const meta = await baseSharp.metadata();

  const isAnimated = Boolean(options.isAnimated || (meta.pages && meta.pages > 1));
  const initialQuality = options.quality ?? 80;
  const maxBytes = isAnimated ? MAX_ANIMATED_STICKER_BYTES : MAX_STATIC_STICKER_BYTES;

  const exifBody =
    options.pack || options.author || options.categories || options.id
      ? buildStickerExif({
          pack: options.pack,
          author: options.author,
          categories: options.categories,
          id: options.id
        })
      : null;

  const qualities = [initialQuality, ...[60, 40, 25, 15].filter((q) => q < initialQuality)];
  let lastSize = 0;

  for (let i = 0; i < qualities.length; i++) {
    const quality = qualities[i];
    const effort = i === 0 ? 4 : 6;

    let webpBuffer = await baseSharp
      .clone()
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp({ quality, effort })
      .toBuffer();

    if (exifBody) {
      webpBuffer = Buffer.from(injectWebpExif(webpBuffer, exifBody));
    }

    lastSize = webpBuffer.length;
    if (webpBuffer.length <= maxBytes) {
      return webpBuffer;
    }
  }

  throw new Error(
    `Prepared ${isAnimated ? 'animated ' : ''}sticker (${lastSize} bytes) exceeds WhatsApp's ${Math.round(maxBytes / 1024)} KB limit even at minimum quality`
  );
}
