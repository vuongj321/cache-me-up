/**
 * Discord formatting — docs/ARCHITECTURE.md section 4, "Step 7".
 *
 * Pure functions only: `Digest` in, ready-to-post markdown string(s) out,
 * already split to respect Discord's 2000-character message limit.
 */

import { CATEGORY_DEFINITIONS, type Digest, type DigestItem } from './types';
import { clamp, truncate } from './util';

/** Discord rejects messages longer than this. */
export const DISCORD_MESSAGE_LIMIT = 2000;
/** Default budget per message, leaving headroom for the 2000-char hard limit. */
export const DEFAULT_MAX_LENGTH = 1800;

export interface FormatOptions {
  /** Timestamp shown in the header (defaults to `digest.generatedAt`). */
  date?: Date;
  /** Soft per-message budget; clamped below the Discord hard limit. */
  maxLength?: number;
}

/** Escape characters Discord would interpret as markdown. */
export function escapeMarkdown(text: string): string {
  return (text ?? '').replace(/[\\*_~`|>[\]]/g, (match) => `\\${match}`).replace(/\s+/g, ' ').trim();
}

/** YYYY-MM-DD in UTC (the schedule is UTC-based, see section 7.1). */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** One digest bullet: `• **Title** — summary ([source](url))`. */
export function formatItemLine(item: DigestItem): string {
  const label = escapeMarkdown(item.source) || 'link';
  const title = escapeMarkdown(item.title) || 'Untitled';
  const summary = escapeMarkdown(item.summary);
  const link = `([${label}](${item.url.replace(/[()\s]/g, (match) => encodeURIComponent(match))}))`;
  return summary ? `• **${title}** — ${summary} ${link}` : `• **${title}** ${link}`;
}

export function formatHeader(date: Date): string {
  return `**Daily Tech Digest — ${formatDate(date)}**`;
}

/** Message posted when a run produces nothing (only if DIGEST_POST_EMPTY=true). */
export function formatNothingNew(date: Date = new Date()): string {
  return `${formatHeader(date)}\nNothing new worth sharing today.`;
}

/**
 * Convert a digest into one or more Discord message bodies.
 *
 * Empty categories are omitted entirely; if a digest is longer than one message
 * it is split on item boundaries, repeating the section title on continuation
 * messages and keeping the date header on the first message only.
 */
export function formatDigestMessages(digest: Digest, options: FormatOptions = {}): string[] {
  const maxLength = clamp(options.maxLength ?? DEFAULT_MAX_LENGTH, 200, DISCORD_MESSAGE_LIMIT - 10);
  const date = options.date ?? new Date(digest.generatedAt);
  const header = formatHeader(date);

  const messages: string[] = [];
  let current = `${header}\n`;
  let currentSection: string | null = null;

  for (const definition of CATEGORY_DEFINITIONS) {
    const items = digest.categories[definition.key] ?? [];
    if (items.length === 0) continue;

    const sectionTitle = `**${definition.label}**`;

    for (const item of items) {
      const line = formatItemLine(item);
      const includeTitle = currentSection !== definition.key;
      const addition = `${includeTitle ? `${sectionTitle}\n` : ''}${line}\n`;

      if (current.length + addition.length <= maxLength) {
        current += addition;
        currentSection = definition.key;
        continue;
      }

      // Doesn't fit: close the current message (if it has content) and retry
      // on a fresh one, repeating the section title.
      if (current.trim()) {
        messages.push(current.trimEnd());
        current = '';
        currentSection = null;
      }

      const retry = `${sectionTitle}\n${line}\n`;
      if (retry.length <= maxLength) {
        current = retry;
      } else {
        const available = Math.max(80, maxLength - sectionTitle.length - 2);
        current = `${sectionTitle}\n${truncate(line, available)}\n`;
      }
      currentSection = definition.key;
    }
  }

  if (current.trim()) messages.push(current.trimEnd());
  return messages;
}
