/**
 * Small pure helpers shared by fetchers, dedupe and ranking.
 */

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic, non-cryptographic hash — used to build stable item ids. */
export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

const TRACKING_PARAMS = [
  /^utm_/i,
  /^ref$/i,
  /^ref_src$/i,
  /^source$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
  /^igshid$/i,
  /^__twitter_impression$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
];

/**
 * Normalize a URL for dedupe + allowlist comparison:
 * lowercases the host, drops the fragment and tracking query params, strips
 * `www.` and a trailing slash. Returns the input unchanged if it is not a URL.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }

  parsed.hash = '';
  parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  parsed.protocol = parsed.protocol.toLowerCase();
  // `https://example.com/post/` and `https://example.com/post` are the same page.
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  const keep: Array<[string, string]> = [];
  parsed.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
      keep.push([key, value]);
    }
  });
  // Preserve parameter order deterministically.
  keep.sort(([a], [b]) => a.localeCompare(b));
  const search = new URLSearchParams();
  for (const [key, value] of keep) search.append(key, value);
  parsed.search = search.toString();

  let result = parsed.toString();
  if (result.endsWith('/') && parsed.pathname === '/') {
    result = result.replace(/\/$/, '');
  }
  return result;
}

export function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse a date-ish string into an ISO timestamp, or undefined when invalid. */
export function toIsoDate(value: string | number | Date | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/** Strip HTML tags, decode the handful of entities feeds leak, collapse whitespace. */
export function stripHtml(input: string | undefined): string {
  if (!input) return '';
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&hellip;/gi, '…')
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1') // arXiv LaTeX like \emph{x}
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collapse whitespace without touching markup-free text. */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Truncate on a word boundary and append an ellipsis. */
export function truncate(input: string, maxLength: number): string {
  const text = collapseWhitespace(input);
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const safe = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${safe.replace(/[,;:.\-–—]$/, '')}…`;
}

/** Clamp a number into a range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
