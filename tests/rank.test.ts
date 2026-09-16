import assert from 'node:assert/strict';
import test from 'node:test';
import { engagementScore, rankAndCap, recencyScore, scoreCandidate, type RankOptions } from '../src/rank';
import type { CandidateItem } from '../src/types';

const NOW = new Date('2026-09-16T12:00:00.000Z');

const OPTIONS: RankOptions = {
  now: NOW,
  lookbackHours: 36,
  maxCandidates: 10,
  maxItemsPerSource: 12,
};

function candidate(overrides: Partial<CandidateItem> = {}): CandidateItem {
  return {
    id: 'id',
    title: 'Something new',
    url: 'https://example.com/a',
    source: 'Test',
    publishedAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

test('recencyScore rewards fresh items and is zero-ish for stale ones', () => {
  const fresh = recencyScore('2026-09-16T11:00:00.000Z', NOW, 36);
  const older = recencyScore('2026-09-15T12:00:00.000Z', NOW, 36);
  const stale = recencyScore('2026-09-10T12:00:00.000Z', NOW, 36);

  assert.ok(fresh > older, 'fresher item should score higher');
  assert.ok(older > stale);
  assert.ok(stale < 1, 'items far outside the window should be effectively worth zero');
  assert.equal(recencyScore('not-a-date', NOW, 36), 0);
});

test('engagementScore grows sub-linearly with points, comments and stars', () => {
  assert.equal(engagementScore(undefined), 0);
  const modest = engagementScore({ points: 50, comments: 10 });
  const strong = engagementScore({ points: 500, comments: 100 });
  assert.ok(strong > modest);
  assert.ok(strong < modest * 3, 'score must stay compressed');
});

test('scoreCandidate boosts novelty keywords and penalizes promotional items', () => {
  const plain = scoreCandidate(candidate({ title: 'Thoughts on data modelling' }), OPTIONS);
  const novel = scoreCandidate(
    candidate({ title: 'Open-source LLM agent released', snippet: 'A new inference stack' }),
    OPTIONS,
  );
  const promo = scoreCandidate(candidate({ title: 'Webinar: register now for our AI summit' }), OPTIONS);

  assert.ok(novel > plain, 'novelty keywords should raise the score');
  assert.ok(promo < plain, 'promotional items should be pushed down');
});

test('rankAndCap drops items older than the lookback window', () => {
  const ranked = rankAndCap(
    [
      candidate({ url: 'https://example.com/fresh' }),
      candidate({ url: 'https://example.com/ancient', publishedAt: '2026-09-01T00:00:00.000Z' }),
    ],
    OPTIONS,
  );
  assert.deepEqual(
    ranked.map((item) => item.url),
    ['https://example.com/fresh'],
  );
});

test('rankAndCap respects maxCandidates, sorts by score and diversifies sources', () => {
  const items: CandidateItem[] = [];
  for (let i = 0; i < 5; i += 1) {
    items.push(candidate({ id: `noisy-${i}`, url: `https://noisy.example.com/${i}`, source: 'Noisy Feed', title: `Noisy item ${i}` }));
  }
  items.push(candidate({ id: 'quiet-1', url: 'https://quiet.example.com/1', source: 'Quiet Feed', title: 'Quiet item' }));

  const ranked = rankAndCap(items, { ...OPTIONS, maxItemsPerSource: 2, maxCandidates: 3 });

  assert.equal(ranked.length, 3);
  const noisyCount = ranked.filter((item) => item.source === 'Noisy Feed').length;
  assert.equal(noisyCount, 2, 'first pass honours the per-source cap');
  assert.ok(ranked.some((item) => item.source === 'Quiet Feed'), 'other sources get a slot');

  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok((ranked[i - 1]?.score ?? 0) >= (ranked[i]?.score ?? 0), 'output must be score-ordered');
  }
});
