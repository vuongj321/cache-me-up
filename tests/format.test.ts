import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCORD_MESSAGE_LIMIT,
  escapeMarkdown,
  formatDigestMessages,
  formatItemLine,
  formatNothingNew,
} from '../src/format';
import { CATEGORIES, type CategoryKey, type Digest, type DigestItem } from '../src/types';

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

test('formatItemLine renders the documented bullet format', () => {
  assert.equal(formatItemLine(item(1)), '• **Title 1** — Summary 1. ([Source](https://example.com/1))');
});

test('escapeMarkdown neutralizes Discord markdown and newlines', () => {
  assert.equal(escapeMarkdown('**bold** _it_ `code`\nnext'), '\\*\\*bold\\*\\* \\_it\\_ \\`code\\` next');
  assert.equal(escapeMarkdown('> quoted | piped'), '\\> quoted \\| piped');
});

test('formatDigestMessages omits empty categories and fits in one message', () => {
  const messages = formatDigestMessages(digest({ new_models: [item(1)], cool_builds: [item(2)] }), { date: DATE });

  assert.equal(messages.length, 1);
  const message = messages[0] ?? '';
  assert.match(message, /Daily Tech Digest — 2026-09-16/);
  assert.match(message, /\*\*New AI models\*\*/);
  assert.match(message, /\*\*Cool builds\*\*/);
  assert.ok(!message.includes('Project inspiration'), 'empty categories are omitted');
  assert.ok(message.includes('([Source](https://example.com/1))'));
});

test('formatDigestMessages splits long digests, repeating the section title only', () => {
  const items = Array.from({ length: 40 }, (_, index) => item(index));
  const messages = formatDigestMessages(digest({ concepts: items }), { date: DATE, maxLength: 400 });

  assert.ok(messages.length > 1, 'expected the digest to be split');
  for (const message of messages) {
    assert.ok(message.length <= 400, `message exceeded maxLength: ${message.length}`);
  }
  assert.match(messages[0] ?? '', /Daily Tech Digest/);
  assert.ok(!(messages[1] ?? '').includes('Daily Tech Digest'), 'continuation messages drop the date header');
  assert.match(messages[1] ?? '', /\*\*AI \/ programming concepts\*\*/);
});

test('formatDigestMessages keeps every message under the Discord hard limit', () => {
  const items = Array.from({ length: 60 }, (_, index) => item(index, { summary: 'x'.repeat(300) }));
  const messages = formatDigestMessages(digest({ concepts: items, cool_builds: items }), { date: DATE });

  assert.ok(messages.length > 1);
  for (const message of messages) {
    assert.ok(message.length <= DISCORD_MESSAGE_LIMIT, `message exceeded Discord limit: ${message.length}`);
  }
});

test('formatNothingNew reuses the header', () => {
  assert.equal(formatNothingNew(DATE), '**Daily Tech Digest — 2026-09-16**\nNothing new worth sharing today.');
});
