export const isPlaceholderSecret = (value: string): boolean => /^change-me(-|$)/i.test(value.trim());

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function formatDateTimeParts(
  date: Date = new Date(),
  timeZone: string = 'Asia/Kuala_Lumpur'
): { date: string; time: string; full: string } {
  const formatter = getDateTimeFormatter(timeZone);
  const parts = new Map<string, string>();
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts.set(part.type, part.value);
    }
  }
  const day = parts.get('day') ?? '';
  const month = parts.get('month') ?? '';
  const year = parts.get('year') ?? '';
  const hour = parts.get('hour') ?? '';
  const minute = parts.get('minute') ?? '';
  const second = parts.get('second') ?? '';
  const dateStr = `${day}-${month}-${year}`;
  const timeStr = `${hour}:${minute}:${second}`;
  return { date: dateStr, time: timeStr, full: `${dateStr} ${timeStr}` };
}

/**
 * Normalizes text formatting for WhatsApp:
 * 1. Converts standard Markdown **bold** to WhatsApp *bold*.
 * 2. Ensures space boundaries before opening * and after closing * when adjacent to alphanumeric/CJK characters,
 *    preventing WhatsApp from rendering raw asterisks (e.g. "be*bold*" -> "be *bold*", "字*粗体*" -> "字 *粗体*").
 * 3. Preserves fenced code blocks, inline code spans, isolated multiplication/asterisk operators (e.g. "2 * 3 = 6"), and URLs.
 */
export function formatWhatsAppText(text: string): string {
  if (!text) return text;

  // Temporarily shield fenced code blocks, inline code spans, and URLs so inner asterisks are never altered
  const shielded: string[] = [];
  const stash = (match: string): string => {
    const token = `\x00SHIELD${shielded.length}\x00`;
    shielded.push(match);
    return token;
  };

  let formatted = text
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/`[^`\n]+`/g, stash)
    .replace(/https?:\/\/[^\s)>]+/g, stash);

  // Convert Markdown **bold** to *bold*
  formatted = formatted.replace(/\*\*([^\n*]+?)\*\*/g, '*$1*');

  // Ensure leading space before opening * if preceded by alphanumeric/CJK letter/number
  formatted = formatted.replace(/([\p{L}\p{N}])\*([^\s*](?:[^*\n]*?[^\s*])?)\*/gu, '$1 *$2*');

  // Ensure trailing space after closing * if followed by alphanumeric/CJK letter/number
  formatted = formatted.replace(/\*([^\s*](?:[^*\n]*?[^\s*])?)\*([\p{L}\p{N}])/gu, '*$1* $2');

  // Restore shielded blocks via replacer function so literal "$" characters stay untouched
  return formatted.replace(/\x00SHIELD(\d+)\x00/g, (_match, idx) => shielded[Number(idx)] ?? '');
}
