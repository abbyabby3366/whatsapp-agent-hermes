import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';

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
    webpBuf.length < 12 ||
    webpBuf.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    webpBuf.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    throw new Error('Invalid WebP buffer: missing RIFF/WEBP signature');
  }

  const fourCC = webpBuf.subarray(12, 16).toString('ascii');
  let result: Buffer;

  if (fourCC === 'VP8X') {
    const modified = Buffer.from(webpBuf);
    // Set bit 3 (0x08) on flags byte to indicate EXIF is present
    modified[20] |= 0x08;

    // Filter out any existing EXIF chunk
    let offset = 30; // 12 (RIFF+WEBP) + 8 (VP8X chunk header) + 10 (VP8X payload)
    const chunks: Buffer[] = [modified.subarray(0, 30)];
    while (offset < modified.length) {
      const tag = modified.subarray(offset, offset + 4).toString('ascii');
      const size = modified.readUInt32LE(offset + 4);
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
    // WebP without VP8X (simple VP8 or VP8L). Wrap it with an extended VP8X header.
    const vp8xHeader = Buffer.alloc(18);
    vp8xHeader.write('VP8X', 0, 4, 'ascii');
    vp8xHeader.writeUInt32LE(10, 4);
    vp8xHeader[8] = 0x08; // Set EXIF flag
    // Width - 1 (511 for 512x512)
    vp8xHeader.writeUIntLE(511, 12, 3);
    // Height - 1 (511 for 512x512)
    vp8xHeader.writeUIntLE(511, 15, 3);

    const exifChunkHeader = Buffer.alloc(8);
    exifChunkHeader.write('EXIF', 0, 4, 'ascii');
    exifChunkHeader.writeUInt32LE(exifBody.length, 4);
    const pad = exifBody.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);

    result = Buffer.concat([
      webpBuf.subarray(0, 12),
      vp8xHeader,
      webpBuf.subarray(12),
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
 * Resolves any input (URL, data URI, base64, local file path, or Buffer) into raw image bytes.
 */
export async function resolveImageBuffer(input: string | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(input)) {
    if (input.length === 0) {
      throw new Error('Provided image Buffer is empty');
    }
    return input;
  }

  const str = input.trim();
  if (!str) {
    throw new Error('Image input string is empty');
  }

  // Remote HTTP / HTTPS URL
  if (str.startsWith('http://') || str.startsWith('https://')) {
    const res = await fetch(str);
    if (!res.ok) {
      throw new Error(`Failed to download sticker image from ${str} (HTTP ${res.status})`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // Data URI (e.g. data:image/png;base64,...)
  if (str.startsWith('data:')) {
    const commaIndex = str.indexOf(',');
    if (commaIndex === -1) {
      throw new Error('Invalid data URI format: missing comma separator');
    }
    const base64Data = str.slice(commaIndex + 1);
    return Buffer.from(base64Data, 'base64');
  }

  // Local file path
  if (fs.existsSync(str)) {
    return await fs.promises.readFile(str);
  }

  // Raw base64 string
  if (/^[A-Za-z0-9+/=]+$/.test(str) && str.length > 30) {
    return Buffer.from(str, 'base64');
  }

  throw new Error(
    `Cannot resolve sticker image: "${str.slice(0, 60)}" is neither a reachable URL, existing file, data URI, nor valid base64`
  );
}

/**
 * Formats an image (PNG, JPG, WebP, GIF, etc.) into a 512x512 WebP WhatsApp sticker with Exif metadata.
 */
export async function prepareSticker(
  input: string | Buffer,
  options: StickerOptions = {}
): Promise<Buffer> {
  const rawBuffer = await resolveImageBuffer(input);

  // Probe format and animation
  let sharpInstance = sharp(rawBuffer, { animated: options.isAnimated ?? true });
  const meta = await sharpInstance.metadata();

  const isAnimated = Boolean(options.isAnimated || (meta.pages && meta.pages > 1));
  const quality = options.quality ?? 80;

  // Resize to fit within 512x512 with transparent background
  sharpInstance = sharp(rawBuffer, { animated: isAnimated })
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ quality, effort: 4 });

  let webpBuffer = await sharpInstance.toBuffer();

  // Attach WhatsApp sticker metadata if specified
  if (options.pack || options.author || options.categories || options.id) {
    const exifBody = buildStickerExif({
      pack: options.pack,
      author: options.author,
      categories: options.categories,
      id: options.id
    });
    webpBuffer = Buffer.from(injectWebpExif(webpBuffer, exifBody));
  }

  return webpBuffer;
}
