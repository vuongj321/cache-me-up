import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiscordEmbedField, DiscordMessage } from '../src/discord';
import {
  DISCORD_MESSAGE_LIMIT,
  EMBED_CHAR_BUDGET,
  EMBED_CHAR_LIMIT,
  EMBED_FIELD_LIMIT,
  EMBEDS_PER_MESSAGE,
  FIELD_VALUE_LIMIT,
  embedChars,
  escapeMarkdown,
  formatDigestMessages,
  formatItemField,
  formatNothingNew,
  messagesToPlainText,
} from '../src/format';
import { CATEGORIES, CATEGORY_DEFINITIONS, type CategoryKey, type Digest, type DigestItem } from '../src/types';

const DATE = new Date('2026-09-16T11:00:00.000Z');

function item(n: number, overrides: Partial<DigestItem> = {}): DigestItem {
  return {
    title: `Title ${n}`,
    summary: `Summary ${n}.`,
    url: `https://example.com/${n}`,
    source: 'Source',
    ...overrides,
  };
}

function digest(items: Partial<Record<CategoryKey, DigestItem[]>>): Digest {
  const categories = {} as Record<CategoryKey, DigestItem[]>;
  for (const key of CATEGORIES) categories[key] = items[key] ?? [];
  return { generatedAt: DATE.toISOString(), categories };
}

/** Every field of every card in a message, in order. */
function fields(message: DiscordMessage | undefined): DiscordEmbedField[] {
  return (message?.embeds ?? []).flatMap((embed) => embed.fields ?? []);
}

test('formatItemField makes the title the clickable line and demotes the source to subtext', () => {
  assert.deepEqual(formatItemField(item(1)), {
    name: '[Title 1](https://example.com/1)',
    value: 'Summary 1.\n-# Source',
  });
});

test('formatItemField escapes markdown and truncates what Discord would reject', () => {
  const field = formatItemField(item(1, { title: '**Bold** _x_', summary: 'y'.repeat(4000) }));
  assert.ok(field.name.startsWith('[\\*\\*Bold\\*\\* \\_x\\_'), `name was ${field.name}`);
  assert.ok(field.value.length <= FIELD_VALUE_LIMIT, `value was ${field.value.length} chars`);
  assert.ok(field.value.endsWith('-# Source'), `value was ${field.value.slice(-40)}`);

  const longTitle = formatItemField(
    item(1, { title: 't'.repeat(500), url: `https://example.com/${'u'.repeat(300)}` }),
  );
  assert.ok(longTitle.name.length <= 256, `name was ${longTitle.name.length} chars`);
  assert.ok(longTitle.value.includes('[Source](https://example.com/'), 'the fallback keeps the link in the value');
});

test('escapeMarkdown neutralizes Discord markdown and newlines', () => {
  assert.equal(escapeMarkdown('**bold** _it_ `code`\nnext'), '\\*\\*bold\\*\\* \\_it\\_ \\`code\\` next');
  assert.equal(escapeMarkdown('> quoted | piped'), '\\> quoted \\| piped');
});

test('formatDigestMessages gives each non-empty section one coloured card and omits empty ones', () => {
  const messages = formatDigestMessages(digest({ new_models: [item(1)], cool_builds: [item(2)] }), { date: DATE });

  assert.equal(messages.length, 1, 'a normal digest should fit in a single message');
  const [message] = messages;
  assert.match(message?.content ?? '', /## Daily Tech Digest — 2026-09-16/);
  assert.match(message?.content ?? '', /-# 2 items across 2 sections/);

  assert.equal(message?.embeds?.length, 2);
  const [models, builds] = message?.embeds ?? [];
  assert.equal(models?.title, '🧠 New AI models');
  assert.equal(models?.color, CATEGORY_DEFINITIONS[0]?.color);
  assert.equal(builds?.title, '🛠️ Cool builds');
  assert.equal(builds?.color, CATEGORY_DEFINITIONS[3]?.color);
  assert.ok(!(message?.content ?? '').includes('Project inspiration'), 'empty categories are omitted');
  assert.deepEqual(fields(message)[0], { name: '[Title 1](https://example.com/1)', value: 'Summary 1.\n-# Source' });
});

test('a section that outgrows one card continues without repeating its header', () => {
  const items = Array.from({ length: EMBED_FIELD_LIMIT + 3 }, (_, index) => item(index));
  const messages = formatDigestMessages(digest({ concepts: items }), { date: DATE });
  const embeds = messages.flatMap((message) => message.embeds ?? []);

  assert.equal(embeds.length, 2, `${EMBED_FIELD_LIMIT + 3} fields do not fit in one ${EMBED_FIELD_LIMIT}-field card`);
  assert.equal(embeds[0]?.title, '📚 AI / programming concepts');
  assert.equal(embeds[1]?.title, undefined, 'the continuation card must not repeat the section name');
  assert.equal(embeds[1]?.color, embeds[0]?.color, 'the continuation keeps the accent colour');
  assert.equal(
    embeds.reduce((total, embed) => total + (embed.fields?.length ?? 0), 0),
    EMBED_FIELD_LIMIT + 3,
    'no item may be dropped',
  );
  assert.ok(embeds.every((embed) => (embed.fields?.length ?? 0) <= EMBED_FIELD_LIMIT));
});

test('continuation messages carry embeds only — never a repeated date header', () => {
  const messages = formatDigestMessages(digest({ new_models: [item(1)], cool_builds: [item(2)] }), {
    date: DATE,
    embedsPerMessage: 1,
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0]?.content ?? '', /Daily Tech Digest/);
  assert.equal(messages[1]?.content, undefined, 'continuation messages drop the date header');
  assert.equal(messages[1]?.embeds?.[0]?.title, '🛠️ Cool builds');
});

test('every message stays inside the Discord embed limits', () => {
  const items = Array.from({ length: 60 }, (_, index) => item(index, { summary: 'x'.repeat(300) }));
  const messages = formatDigestMessages(digest({ concepts: items, cool_builds: items }), { date: DATE });

  assert.ok(messages.length > 1, 'expected the digest to be split');
  for (const message of messages) {
    assert.ok((message.content?.length ?? 0) <= DISCORD_MESSAGE_LIMIT, 'content limit');
    assert.ok((message.embeds?.length ?? 0) <= EMBEDS_PER_MESSAGE, 'embed count limit');
    const total = (message.embeds ?? []).reduce((sum, embed) => sum + embedChars(embed), 0);
    assert.ok(total <= EMBED_CHAR_LIMIT, `message used ${total} embed chars`);
  }
  assert.ok(EMBED_CHAR_BUDGET <= EMBED_CHAR_LIMIT, 'the packing budget stays below the hard limit');
});

test('an empty digest produces no messages', () => {
  assert.deepEqual(formatDigestMessages(digest({}), { date: DATE }), []);
});

test('formatNothingNew posts one card instead of a bare line of text', () => {
  const messages = formatNothingNew(DATE);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content, '## Daily Tech Digest — 2026-09-16');
  assert.equal(messages[0]?.embeds?.[0]?.description, 'Nothing new worth sharing today.');
});

test('messagesToPlainText renders every card for dry runs', () => {
  const text = messagesToPlainText(formatDigestMessages(digest({ new_models: [item(1)] }), { date: DATE }));

  assert.match(text, /----- message 1\/1 -----/);
  assert.match(text, /▐ 🧠 New AI models/);
  assert.match(text, /\[Title 1\]\(https:\/\/example\.com\/1\)/);
  assert.match(text, /Summary 1\./);
});
