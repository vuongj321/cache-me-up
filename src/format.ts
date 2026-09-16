/**
 * Discord formatting — docs/ARCHITECTURE.md section 4, "Step 7".
 *
 * Pure functions only: `Digest` in, ready-to-post webhook payloads out, already
 * packed to respect Discord's limits (10 embeds and 6000 characters per message).
 * Every section becomes one coloured embed card, so a digest that has to be split
 * continues on the next message instead of printing its headers a second time.
 */

import type { DiscordEmbed, DiscordEmbedField, DiscordMessage } from './discord';
import { CATEGORY_DEFINITIONS, type Digest, type DigestItem } from './types';
import { clamp, truncate } from './util';

/** Discord rejects message content longer than this. */
export const DISCORD_MESSAGE_LIMIT = 2000;
/** Discord renders at most this many embeds in one message. */
export const EMBEDS_PER_MESSAGE = 10;
/** Hard cap Discord applies to all embeds of one message combined. */
export const EMBED_CHAR_LIMIT = 6000;
/** Budget actually used when packing, leaving headroom below the hard cap. */
export const EMBED_CHAR_BUDGET = 5600;
/** Discord renders at most this many fields in one embed. */
export const EMBED_FIELD_LIMIT = 25;
/** Discord truncates embed titles beyond this. */
export const EMBED_TITLE_LIMIT = 256;
/** Discord truncates embed field names/values beyond these. */
export const FIELD_NAME_LIMIT = 256;
export const FIELD_VALUE_LIMIT = 1024;

/** Accent used by the "nothing new" note. */
const NOTHING_NEW_COLOR = 0xfaa61a;

export interface FormatOptions {
  /** Timestamp shown in the header (defaults to `digest.generatedAt`). */
  date?: Date;
  /** Per-message budget for the embeds' text; clamped below the Discord hard limit. */
  charBudget?: number;
  /** Max embeds per message; clamped to Discord's own limit. */
  embedsPerMessage?: number;
}

/** Escape characters Discord would interpret as markdown. */
export function escapeMarkdown(text: string): string {
  return (text ?? '').replace(/[\\*_~`|>[\]]/g, (match) => `\\${match}`).replace(/\s+/g, ' ').trim();
}

/** YYYY-MM-DD in UTC (the schedule is UTC-based, see section 7.1). */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Escape parentheses/whitespace so a URL cannot break out of `[label](url)`. */
function maskLink(label: string, url: string): string {
  return `[${label}](${url.replace(/[()\s]/g, (match) => encodeURIComponent(match))})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * One item inside a section card.
 *
 * The item title becomes the clickable line (field `name`), the summary stays
 * plain body text, and the source is demoted to subtext (`-#`) — three pieces of
 * information with three visual weights, instead of one crowded line.
 */
export function formatItemField(item: DigestItem): DiscordEmbedField {
  const title = escapeMarkdown(item.title) || 'Untitled';
  const summary = escapeMarkdown(item.summary);
  const source = escapeMarkdown(item.source) || 'link';

  const linked = maskLink(truncate(title, Math.max(24, FIELD_NAME_LIMIT - item.url.length - 4)), item.url);
  // A pathological URL can push the masked link past the name limit; then keep the
  // readable title as the name and link from the value instead of losing the link.
  const nameFits = linked.length <= FIELD_NAME_LIMIT;
  const name = nameFits ? linked : truncate(title, FIELD_NAME_LIMIT);
  const attribution = nameFits ? `-# ${source}` : `-# ${maskLink(source, item.url)}`;

  const body = truncate(summary, Math.max(24, FIELD_VALUE_LIMIT - attribution.length - 1));
  return { name, value: body ? `${body}\n${attribution}` : attribution };
}

/** Header line for the first message: the date plus a compact item/section count. */
export function formatHeader(date: Date, itemCount?: number, sectionCount?: number): string {
  const header = `## Daily Tech Digest — ${formatDate(date)}`;
  if (!itemCount || !sectionCount) return header;
  return `${header}\n-# ${plural(itemCount, 'item')} across ${plural(sectionCount, 'section')}`;
}

/** Message posted when a run produces nothing (only if DIGEST_POST_EMPTY=true). */
export function formatNothingNew(date: Date = new Date()): DiscordMessage[] {
  return [
    {
      content: formatHeader(date),
      embeds: [{ color: NOTHING_NEW_COLOR, description: 'Nothing new worth sharing today.' }],
    },
  ];
}

/** Characters Discord counts for one embed (title, description and every field). */
export function embedChars(embed: DiscordEmbed): number {
  const fields = (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + fields;
}

/**
 * Convert a digest into one or more ready-to-post Discord messages.
 *
 * Layout: the date header rides on the first message; every non-empty category
 * becomes one embed card (coloured accent + emoji title + one field per item).
 * A section that outgrows a card continues in a second card with the same accent
 * and no title, and a message is only started once Discord's limits are reached —
 * so nothing is ever printed twice.
 */
export function formatDigestMessages(digest: Digest, options: FormatOptions = {}): DiscordMessage[] {
  const date = options.date ?? new Date(digest.generatedAt);
  const charBudget = clamp(options.charBudget ?? EMBED_CHAR_BUDGET, 200, EMBED_CHAR_LIMIT);
  const embedsPerMessage = clamp(options.embedsPerMessage ?? EMBEDS_PER_MESSAGE, 1, EMBEDS_PER_MESSAGE);

  const sections = CATEGORY_DEFINITIONS.flatMap((definition) => {
    const items = digest.categories[definition.key] ?? [];
    return items.length === 0 ? [] : [{ definition, items }];
  });
  if (sections.length === 0) return [];

  const itemCount = sections.reduce((total, section) => total + section.items.length, 0);

  const messages: DiscordMessage[] = [];
  let pending: { content?: string; embeds: DiscordEmbed[] } = {
    content: formatHeader(date, itemCount, sections.length),
    embeds: [],
  };
  let pendingChars = 0;

  function flush(): void {
    if (pending.embeds.length === 0 && !pending.content) return;
    messages.push(pending);
    // Continuation messages are embeds only — no repeated date header.
    pending = { embeds: [] };
    pendingChars = 0;
  }

  for (const { definition, items } of sections) {
    let titlePending: string | undefined = truncate(`${definition.emoji} ${definition.label}`, EMBED_TITLE_LIMIT);
    let embed: DiscordEmbed = { color: definition.color, fields: [] };
    let cardChars = 0;

    function openEmbed(): void {
      embed = { color: definition.color, fields: [] };
      cardChars = 0;
      if (titlePending) {
        embed.title = titlePending;
        cardChars += titlePending.length;
        // Only the first card of a section is titled; continuations share the colour.
        titlePending = undefined;
      }
    }

    function closeEmbed(): void {
      if ((embed.fields ?? []).length === 0) return;
      if (pending.embeds.length >= embedsPerMessage || pendingChars + cardChars > charBudget) flush();
      pending.embeds.push(embed);
      pendingChars += cardChars;
    }

    openEmbed();
    for (const item of items) {
      const field = formatItemField(item);
      const cost = field.name.length + field.value.length;
      const cardFull = (embed.fields ?? []).length >= EMBED_FIELD_LIMIT || cardChars + cost > charBudget;
      if (cardFull && (embed.fields ?? []).length > 0) {
        closeEmbed();
        openEmbed();
      }
      embed.fields = [...(embed.fields ?? []), field];
      cardChars += cost;
    }
    closeEmbed();
  }

  flush();
  return messages;
}

/**
 * Human-readable rendering used by `--dry-run`, where Discord markdown and embed
 * colours cannot be previewed. One block per message; `▐` marks a section card.
 */
export function messagesToPlainText(messages: DiscordMessage[]): string {
  return messages
    .map((message, index) => {
      const lines = [`----- message ${index + 1}/${messages.length} -----`];
      if (message.content) lines.push(message.content);
      for (const embed of message.embeds ?? []) {
        lines.push(`▐ ${embed.title ?? '(continuation of the section above)'}`);
        if (embed.description) lines.push(`  ${embed.description}`);
        for (const field of embed.fields ?? []) {
          lines.push(`  • ${field.name}`);
          for (const line of field.value.split('\n')) lines.push(`    ${line}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
