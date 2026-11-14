import fs from 'fs';
import { formatWhatsAppText } from '../formatting.js';

export type ParsedHermesOutput =
  | { kind: 'no-answer'; flags: []; chunks: [] }
  | { kind: 'silent'; flags: string[]; chunks: [] }
  | { kind: 'reply'; flags: string[]; chunks: string[] };

export interface ContactRuleMatchers {
  phone?: string;
  username?: string;
  lid?: string;
  name?: string;
}

/**
 * Strips reserved control tokens and XML boundary tags from untrusted WhatsApp inputs
 * (`senderName`, `message`, `quoted.message`, and voice transcripts).
 */
export function cleanUntrusted(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replaceAll('===MSG===', '[split]')
    .replaceAll('@@FLAG@@', '[flag]')
    .replace(/<\/untrusted_inbound_message\s*>/gi, '[/untrusted_inbound_message]')
    .replace(/<untrusted_inbound_message\b[^>]*>/gi, '[untrusted_inbound_message]');
}

function stripFrontmatterAndComments(markdown: string): string {
  let text = markdown.replace(/\r\n/g, '\n');
  if (text.startsWith('---\n')) {
    const endIdx = text.indexOf('\n---', 4);
    if (endIdx !== -1) {
      text = text.slice(endIdx + 4);
    }
  }
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function extractLevel2Section(body: string, sectionNumber: number): string {
  const headerRegex = new RegExp(`^##\\s+${sectionNumber}\\.\\s*[^\\n]*$`, 'm');
  const match = headerRegex.exec(body);
  if (!match) return '';

  const afterHeader = body.slice(match.index + match[0].length);
  const nextSectionMatch = /^##\s+/m.exec(afterHeader);
  const slice = nextSectionMatch ? afterHeader.slice(0, nextSectionMatch.index) : afterHeader;
  return slice.trim();
}

function headerMatchesContact(header: string, matchers: ContactRuleMatchers): boolean {
  const tokens = header
    .split(/[|/,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const normalizedPhone = matchers.phone?.replace(/[^0-9]/g, '') || '';
  const normalizedUsername = matchers.username?.replace(/^@+/, '').toLowerCase() || '';
  const normalizedLid = matchers.lid?.replace(/[^0-9]/g, '') || '';
  const normalizedName = matchers.name?.trim().toLowerCase() || '';

  for (const token of tokens) {
    const clean = token.trim();
    if (!clean) continue;

    if (clean.startsWith('@') && normalizedUsername) {
      if (clean.slice(1).toLowerCase() === normalizedUsername) return true;
    }

    const tokenDigits = clean.replace(/[^0-9]/g, '');
    if (tokenDigits.length >= 6) {
      if (normalizedPhone && tokenDigits === normalizedPhone) return true;
      if (normalizedLid && tokenDigits === normalizedLid) return true;
    }

    if (normalizedName && clean.toLowerCase() === normalizedName) {
      return true;
    }
  }
  return false;
}

/**
 * Hot-loads Section 2 (Global Contact Reply Rules) and ONLY the matching `###` contact block
 * from Section 3 of `whatsapp-agent-rules/SKILL.md`. Never exposes Section 1 or other contacts' notes.
 */
export function loadContactRules(
  rulesPath: string,
  matchers: ContactRuleMatchers
): { globalRules: string; contactRules: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(rulesPath, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { globalRules: '', contactRules: '' };
    }
    throw new Error(`[Rules] Failed to read ${rulesPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = stripFrontmatterAndComments(raw);
  const globalRules = extractLevel2Section(body, 2);
  const section3 = extractLevel2Section(body, 3);
  if (!section3) {
    return { globalRules, contactRules: '' };
  }

  const subHeadingRegex = /^###\s+([^\n]+)$/gm;
  const matches = [...section3.matchAll(subHeadingRegex)];
  const matchedBlocks: string[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const headerText = m[1].trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? section3.length) : section3.length;
    const content = section3.slice(start, end).trim();
    if (content && headerMatchesContact(headerText, matchers)) {
      matchedBlocks.push(`### ${headerText}\n${content}`);
    }
  }

  return { globalRules, contactRules: matchedBlocks.join('\n\n') };
}

const ROUTING_HEADER_PREFIX_RE =
  /^\s*(?:@@TO@@[^\n]*(?:\n|$)|(?:To|Recipient):\s*(?:@[A-Za-z0-9_.]{3,35}(?:#\d{4})?|\+?[0-9][^\n]*|[A-Za-z0-9_.:-]+@(?:lid|s\.whatsapp\.net|g\.us))(?:\n+|$)|(?:Bot|AI|Assistant|Contact reply|Message|Reply):\s*)/i;

/**
 * Normalizes agent reply text into WhatsApp-native formatting:
 * strips routing prefixes, flattens Markdown links, converts headings and **bold** -> *bold*
 * (with code/URL protection & CJK/ASCII boundary spacing), and replaces em/en dashes.
 */
export function sanitizeReply(text: string): string {
  let cleaned = text;
  for (let i = 0; i < 10; i++) {
    const next = cleaned.replace(ROUTING_HEADER_PREFIX_RE, '');
    if (next === cleaned) break;
    cleaned = next;
  }

  // Convert Markdown links [label](https://...) -> label (https://...) safely
  cleaned = cleaned.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `${label} (${url})`);

  // Shield code blocks, inline code, and URLs so headings/dash normalization never corrupts them
  const shielded: string[] = [];
  const stash = (match: string): string => {
    const token = `\x00SAN${shielded.length}\x00`;
    shielded.push(match);
    return token;
  };

  cleaned = cleaned
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/`[^`\n]+`/g, stash)
    .replace(/https?:\/\/[^\s)>]+/g, stash);

  // Convert Markdown headings (# Heading -> *Heading*)
  cleaned = cleaned.replace(/^#{1,6}\s+(.+?)\s*$/gm, '*$1*');

  // Replace em/en dashes and space-flanked double hyphens with comma + space
  cleaned = cleaned.replace(/\s*(?:—|–)\s*|\s+--\s+/g, ', ');

  // Restore shielded blocks via callback replacer so literal "$" stays intact
  cleaned = cleaned.replace(/\x00SAN(\d+)\x00/g, (_match, idx: string) => shielded[Number(idx)] ?? '');

  // Convert **bold** -> *bold* with boundary spacing while preserving URLs and code blocks
  return formatWhatsAppText(cleaned).trim();
}

/**
 * Parses `hermes chat -Q` stdout in strict order:
 * 1) Empty stdout -> `no-answer` (eligible for startup replay)
 * 2) Extract & strip `@@FLAG@@` lines first
 * 3) Evaluate `NO_REPLY` (or empty body when flags were extracted) -> `silent`
 * 4) Split on `===MSG===`, sanitize each chunk, drop empty chunks, cap at `maxMessagesPerTurn`
 */
export function parseHermesOutput(rawStdout: string, maxMessagesPerTurn = 5): ParsedHermesOutput {
  if (!rawStdout || !rawStdout.trim()) {
    return { kind: 'no-answer', flags: [], chunks: [] };
  }

  const flags: string[] = [];
  const keptLines: string[] = [];
  for (const line of rawStdout.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^\s*@@FLAG@@\s*(.*)$/.exec(line);
    if (match) {
      flags.push(match[1].trim() || 'Manual review requested');
    } else {
      keptLines.push(line);
    }
  }

  const body = keptLines.join('\n').trim();
  if (body === 'NO_REPLY' || (body === '' && flags.length > 0)) {
    return { kind: 'silent', flags, chunks: [] };
  }

  const sanitizedChunks = body
    .split('===MSG===')
    .map((chunk) => sanitizeReply(chunk))
    .filter(Boolean);

  if (sanitizedChunks.length === 0) {
    return flags.length > 0 ? { kind: 'silent', flags, chunks: [] } : { kind: 'no-answer', flags: [], chunks: [] };
  }

  const cap = Math.max(1, maxMessagesPerTurn);
  if (sanitizedChunks.length > cap) {
    const head = sanitizedChunks.slice(0, cap - 1);
    const tail = sanitizedChunks.slice(cap - 1).join('\n\n');
    return { kind: 'reply', flags, chunks: [...head, tail] };
  }

  return { kind: 'reply', flags, chunks: sanitizedChunks };
}
