import assert from 'node:assert/strict';
import test from 'node:test';
import {
  digestSeenKeys,
  filterUnseen,
  markSeen,
  parseSeenStore,
  pruneSeen,
  seenKey,
  emptySeenStore,
  type SeenStore,
} from '../src/dedupe';
import type { CandidateItem, Digest } from '../src/types';

const NOW = new Date('2026-09-16T11:00:00.000Z');

function candidate(overrides: Partial<CandidateItem> = {}): CandidateItem {
  return {
    id: 'id-1',
    title: 'A story',
    url: 'https://example.com/post',
    source: 'Test',
    publishedAt: '2026-09-16T09:00:00.000Z',
    ...overrides,
  };
}

const WINDOW = { now: NOW, deliveredDays: 5, consideredDays: 2 };

test('seenKey canonicalizes URLs so the same story from two feeds collides', () => {
  assert.equal(
    seenKey({ url: 'https://www.Example.com/post/?utm_source=rss&utm_medium=feed#top', id: 'x' }),
    seenKey({ url: 'https://example.com/post', id: 'y' }),
  );
  assert.equal(seenKey({ url: '', id: 'hn:12345' }), 'hn:12345');
});

test('filterUnseen drops cached items and de-duplicates within the batch', () => {
  const store: SeenStore = {
    version: 1,
    entries: { 'https://example.com/old': { at: '2026-09-15T11:00:00.000Z', delivered: true } },
  };
  const result = filterUnseen(
    [
      candidate({ url: 'https://example.com/old' }),
      candidate({ url: 'https://example.com/new' }),
      candidate({ url: 'https://example.com/new?utm_source=hn' }),
    ],
    store,
    WINDOW,
  );

  assert.equal(result.fresh.length, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.fresh[0]?.url, 'https://example.com/new');
  assert.deepEqual(result.batchKeys, ['https://example.com/new']);
});

test('pruneSeen keeps delivered entries inside the window and drops older ones', () => {
  const store: SeenStore = {
    version: 1,
    entries: {
      'delivered-recent': { at: '2026-09-14T11:00:00.000Z', delivered: true },
      'delivered-old': { at: '2026-09-01T11:00:00.000Z', delivered: true },
      'considered-recent': { at: '2026-09-15T11:00:00.000Z', delivered: false },
      'considered-old': { at: '2026-09-12T11:00:00.000Z', delivered: false },
      'invalid-date': { at: 'not-a-date', delivered: true },
    },
  };

  const pruned = pruneSeen(store, WINDOW);
  assert.deepEqual(Object.keys(pruned.entries).sort(), ['considered-recent', 'delivered-recent']);
});

test('parseSeenStore tolerates corrupt or partial caches', () => {
  assert.deepEqual(parseSeenStore('not json at all'), emptySeenStore());
  assert.deepEqual(parseSeenStore('{"entries": "nope"}'), emptySeenStore());

  const parsed = parseSeenStore(
    JSON.stringify({ entries: { a: { at: '2026-09-16T00:00:00.000Z', delivered: true }, b: 'garbage' } }),
  );
  assert.deepEqual(Object.keys(parsed.entries), ['a']);
  assert.equal(parsed.entries.a?.delivered, true);
});

test('markSeen records new keys, refreshes timestamps and never downgrades delivered', () => {
  const store: SeenStore = {
    version: 1,
    entries: { kept: { at: '2026-09-15T00:00:00.000Z', delivered: true } },
  };

  const considered = markSeen(store, ['kept', 'fresh'], { now: NOW, delivered: false });
  assert.equal(considered.entries.kept?.delivered, true, 'delivered must stay delivered');
  assert.equal(considered.entries.fresh?.delivered, false);
  assert.equal(considered.entries.fresh?.at, NOW.toISOString());

  const delivered = markSeen(considered, ['fresh'], { now: NOW, delivered: true });
  assert.equal(delivered.entries.fresh?.delivered, true);
  // Pure updates: the input store is untouched.
  assert.equal(store.entries.fresh, undefined);
});

test('digestSeenKeys returns one canonical key per posted item, across all categories', () => {
  const posted: Digest = {
    generatedAt: NOW.toISOString(),
    categories: {
      new_models: [
        { title: 'A', summary: 'a', url: 'https://www.Example.com/post/?utm_source=rss#top', source: 'Feed' },
        { title: 'No url', summary: 'b', url: '', source: 'Feed' },
      ],
      project_inspiration: [],
      concepts: [{ title: 'B', summary: 'b', url: 'https://example.com/post', source: 'Second feed' }],
      cool_builds: [{ title: 'C', summary: 'c', url: 'https://example.com/other/', source: 'Feed' }],
    },
  };

  assert.deepEqual(digestSeenKeys(posted), [
    'https://example.com/post', // www, tracking params and the fragment are stripped
    '', // no usable URL -> no key, and markSeen ignores empty keys
    'https://example.com/post', // the same story from a second feed collapses to one key
    'https://example.com/other', // trailing slash stripped
  ]);
});
