import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCandidatePayload,
  buildMessages,
  enforceUrlAllowlist,
  extractJson,
  parseRawDigest,
} from '../src/llm';
import { CATEGORIES, type CandidateItem, type RawDigest } from '../src/types';

const NOW = new Date('2026-09-16T11:00:00.000Z');

function candidate(n: number, overrides: Partial<CandidateItem> = {}): CandidateItem {
  return {
    id: `id-${n}`,
    title: `Candidate ${n}`,
    url: `https://example.com/${n}`,
    source: `Feed ${n}`,
    publishedAt: '2026-09-16T09:00:00.000Z',
    ...overrides,
  };
}

test('extractJson accepts fenced, prose-wrapped and bare JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":1} — hope that helps'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('{"a":"line\nbreak"}'), { a: 'line\nbreak' }, 'raw newlines are repaired');
  assert.throws(() => extractJson('I cannot help with that.'), /not valid JSON/);
  assert.throws(() => extractJson(''), /empty response/);
});

test('parseRawDigest normalizes strings and fills in every category', () => {
  const raw = parseRawDigest(
    '{"categories":{"new_models":[{"title":"  Spaced  ","summary":" Line\nbreak ","url":" https://example.com/1 ","source":" Model Co "}]}}',
  );

  for (const key of CATEGORIES) {
    assert.ok(Array.isArray(raw.categories[key]), `missing category ${key}`);
  }
  assert.equal(raw.categories.new_models.length, 1);
  assert.equal(raw.categories.new_models[0]?.title, 'Spaced');
  assert.equal(raw.categories.new_models[0]?.summary, 'Line break');
  assert.equal(raw.categories.new_models[0]?.url, 'https://example.com/1');
  assert.equal(raw.categories.cool_builds.length, 0);
});

test('parseRawDigest rejects responses that do not match the schema', () => {
  assert.throws(() => parseRawDigest('{"items":[]}'), /did not match the digest schema/);
  assert.throws(() => parseRawDigest('{"categories":{"new_models":[{"title":"","summary":"s","url":"u"}]}}'), /schema/);
});

test('enforceUrlAllowlist drops invented and duplicated URLs', () => {
  const raw: RawDigest = {
    categories: {
      new_models: [
        { title: 'Real', summary: 'Kept.', url: 'https://example.com/1', source: 'Feed 1' },
        { title: 'Invented', summary: 'Dropped.', url: 'https://evil.example.com/9', source: 'Made up' },
      ],
      project_inspiration: [
        { title: 'Duplicate', summary: 'Same story.', url: 'https://example.com/1?utm_source=llm', source: 'Feed 1' },
      ],
      concepts: [],
      cool_builds: [],
    },
  };

  const result = enforceUrlAllowlist(raw, [candidate(1), candidate(2)], NOW);

  assert.equal(result.kept, 1);
  assert.deepEqual(
    result.dropped.map((entry) => entry.reason),
    ['unknown-url', 'duplicate'],
  );
  assert.equal(result.digest.categories.new_models[0]?.url, 'https://example.com/1');
  assert.equal(result.digest.categories.project_inspiration.length, 0);
  assert.equal(result.digest.generatedAt, NOW.toISOString());
});

test('enforceUrlAllowlist falls back to the fetched source name', () => {
  const raw: RawDigest = {
    categories: {
      new_models: [{ title: 'Real', summary: 'Kept.', url: 'https://example.com/1', source: '' }],
      project_inspiration: [],
      concepts: [],
      cool_builds: [],
    },
  };

  const result = enforceUrlAllowlist(raw, [candidate(1)], NOW);
  assert.equal(result.digest.categories.new_models[0]?.source, 'Feed 1');
});

test('buildMessages carries the categories, the rules and the exact URLs', () => {
  const messages = buildMessages([candidate(1)]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'system');

  const system = messages[0]?.content ?? '';
  const user = messages[1]?.content ?? '';
  assert.match(system, /never invent/i);
  assert.match(system, /new_models/);
  assert.match(user, /https:\/\/example\.com\/1/);
  assert.match(user, /project_inspiration/);
});

test('buildCandidatePayload drops engagement signals and caps field lengths', () => {
  const payload = buildCandidatePayload([candidate(1, { signals: { points: 999 }, snippet: 'y'.repeat(600) })]);

  assert.equal(payload.length, 1);
  assert.ok(!('signals' in (payload[0] as object)), 'signals must not be sent to the model');
  assert.ok((payload[0]?.snippet?.length ?? 0) <= 300);
  assert.equal(payload[0]?.url, 'https://example.com/1');
});
