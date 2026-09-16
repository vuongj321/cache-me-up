import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadEnv, loadSources, parseSourcesFile } from '../src/config';
import { buildArxivUrl } from '../src/fetchers/arxiv';
import { FETCHERS, sanitizeCandidate, sanitizeCandidates } from '../src/fetchers';
import { mapSearchRepos, mapTrendingRepos, parseTrendingHtml } from '../src/fetchers/github';
import { mapHits } from '../src/fetchers/hackernews';
import { mapFeedItems, parseFeed } from '../src/fetchers/rss';
import { createLogger } from '../src/log';
import type { CandidateItem, SourceConfig } from '../src/types';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const CTX = {
  now: NOW,
  since: new Date(NOW.getTime() - 36 * 3600 * 1000),
  lookbackHours: 36,
  timeoutMs: 20000,
  userAgent: 'test',
  log: createLogger('error'),
};

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Lobsters: ai</title>
    <link>https://lobste.rs/</link>
    <item>
      <title>Model Training Incidents are Negligence</title>
      <link>https://taggart-tech.com/lying/</link>
      <guid>https://lobste.rs/s/ujnlm5</guid>
      <pubDate>Tue, 15 Sep 2026 08:55:32 -0500</pubDate>
      <description>&lt;p&gt;Some text &amp;amp; more&lt;/p&gt;</description>
    </item>
    <item>
      <title>Item without a usable link</title>
      <guid>not-a-url</guid>
      <pubDate>Tue, 15 Sep 2026 07:00:00 -0500</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query: search_query=cat:cs.AI</title>
  <entry>
    <id>http://arxiv.org/abs/2609.17527v1</id>
    <title>Agentic Societies Need a Social Harness</title>
    <updated>2026-09-15T17:57:27Z</updated>
    <published>2026-09-15T17:57:27Z</published>
    <link href="https://arxiv.org/abs/2609.17527v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2609.17527v1" rel="related" type="application/pdf"/>
    <summary>We show that \\emph{social harnesses} matter for coordination.</summary>
  </entry>
</feed>`;

const TRENDING_FIXTURE = `<div>
  <article class="Box-row">
    <div class="float-right d-flex">
      <a href="/login?return_to=%2Falibaba%2Fopen-code-review" rel="nofollow">Star</a>
    </div>
    <h2 class="h3 lh-condensed">
      <a data-hydro-click="{&quot;event_type&quot;:&quot;explore.click&quot;}" href="/alibaba/open-code-review" class="Link">
        <svg aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418"/></svg>
        <span class="text-normal">alibaba /</span>
        open-code-review</a>
    </h2>
    <p class="col-9 color-fg-muted my-1 tmp-pr-4">Fast code review tool. OpenAI &amp; Anthropic compatible.</p>
    <span data-view-component="true" class="d-inline-block float-sm-right">
      <svg aria-hidden="true"><path/></svg>
      3,215 stars today
    </span>
  </article>
  <article class="Box-row">
    <h2 class="h3 lh-condensed"><span class="text-normal">broken /</span> entry</h2>
  </article>
</div>`;

const RSS_SOURCE: SourceConfig = { id: 'rss-test', name: 'Lobsters', kind: 'rss', interest: 'concepts' };
const HN_SOURCE: SourceConfig = { id: 'hn-test', name: 'Hacker News', kind: 'hackernews', interest: 'cool_builds' };
const GH_SOURCE: SourceConfig = { id: 'gh-test', name: 'GitHub Trending', kind: 'github-trending' };

test('parseFeed reads RSS 2.0 items', () => {
  const items = parseFeed(RSS_FIXTURE);

  assert.equal(items.length, 2);
  assert.equal(items[0]?.title, 'Model Training Incidents are Negligence');
  assert.equal(items[0]?.url, 'https://taggart-tech.com/lying/');
  assert.equal(items[0]?.publishedAt, '2026-09-15T13:55:32.000Z');
  assert.equal(items[0]?.snippet, 'Some text & more');
  assert.equal(items[1]?.url, '', 'a guid that is not a URL must not become the link');
});

test('parseFeed reads Atom entries and prefers the alternate link', () => {
  const items = parseFeed(ATOM_FIXTURE);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.url, 'https://arxiv.org/abs/2609.17527v1');
  assert.equal(items[0]?.publishedAt, '2026-09-15T17:57:27.000Z');
  assert.match(items[0]?.snippet ?? '', /social harnesses/);
  assert.ok(!(items[0]?.snippet ?? '').includes('\\emph'), 'LaTeX wrappers should be unwrapped');
});

test('mapFeedItems drops items with no title or no usable URL', () => {
  const mapped = mapFeedItems(parseFeed(RSS_FIXTURE), RSS_SOURCE, CTX);

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]?.source, 'Lobsters');
  assert.equal(mapped[0]?.interest, 'concepts');
  assert.match(mapped[0]?.id ?? '', /^feed:/);
});

test('mapHits maps HN hits, filters low scores and falls back to the HN thread URL', () => {
  const hits = [
    {
      objectID: '49727072',
      title: 'Show HN: Stateful LLM API',
      url: 'https://twigg.ai',
      created_at: '2026-09-16T13:53:49Z',
      points: 42,
      num_comments: 7,
      author: 'mdebeer',
    },
    { objectID: '49727073', title: 'Ask HN: anything', created_at: '2026-09-16T13:00:00Z', points: 5 },
  ];

  const filtered = mapHits(hits, HN_SOURCE, CTX, 10);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.url, 'https://twigg.ai');
  assert.equal(filtered[0]?.id, 'hn:49727072');
  assert.equal(filtered[0]?.signals?.points, 42);

  const all = mapHits(hits, HN_SOURCE, CTX, 0);
  assert.equal(all.length, 2);
  assert.equal(all[1]?.url, 'https://news.ycombinator.com/item?id=49727073');
});

test('parseTrendingHtml reads repositories, descriptions and stars-today', () => {
  const repos = parseTrendingHtml(TRENDING_FIXTURE);

  assert.equal(repos.length, 1, 'a block without a repository link is skipped');
  assert.equal(repos[0]?.fullName, 'alibaba/open-code-review');
  assert.equal(repos[0]?.url, 'https://github.com/alibaba/open-code-review');
  assert.match(repos[0]?.description ?? '', /OpenAI & Anthropic compatible/);
  assert.equal(repos[0]?.starsToday, 3215);

  const mapped = mapTrendingRepos(repos, GH_SOURCE, CTX);
  assert.equal(mapped[0]?.publishedAt, NOW.toISOString(), 'trending has no date, so "now" is used');
  assert.equal(mapped[0]?.signals?.starsToday, 3215);
});

test('mapSearchRepos skips archived and forked repositories', () => {
  const mapped = mapSearchRepos(
    [
      {
        full_name: 'acme/tool',
        html_url: 'https://github.com/acme/tool',
        description: 'A tool',
        created_at: '2026-09-15T00:00:00Z',
        stargazers_count: 900,
        language: 'Rust',
        topics: ['cli'],
      },
      { full_name: 'acme/old', html_url: 'https://github.com/acme/old', archived: true },
      { full_name: 'acme/fork', html_url: 'https://github.com/acme/fork', fork: true },
    ],
    GH_SOURCE,
    CTX,
  );

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0]?.signals?.stars, 900);
  assert.match(mapped[0]?.snippet ?? '', /Rust/);
});

test('buildArxivUrl builds a category query sorted by submission date', () => {
  const url = buildArxivUrl(['cs.AI', 'cs.LG'], 25);

  assert.match(url, /^https:\/\/export\.arxiv\.org\/api\/query\?/);
  assert.ok(url.includes('cat%3Acs.AI+OR+cat%3Acs.LG'));
  assert.ok(url.includes('max_results=25'));
  assert.ok(url.includes('sortBy=submittedDate'));
  assert.ok(url.includes('sortOrder=descending'));
});

test('sanitizeCandidate enforces a usable URL, title and timestamp', () => {
  const good = sanitizeCandidate(
    {
      id: 'x',
      title: '  Spaced   title  ',
      url: 'https://Example.com/post/?utm_source=rss#frag',
      source: 'Feed',
      publishedAt: 'nonsense',
    },
    NOW.toISOString(),
  );

  assert.equal(good?.title, 'Spaced title');
  assert.equal(good?.url, 'https://example.com/post');
  assert.equal(good?.publishedAt, NOW.toISOString(), 'invalid dates fall back to the run timestamp');

  assert.equal(
    sanitizeCandidate({ ...good, url: 'mailto:someone@example.com' } as CandidateItem, NOW.toISOString()),
    undefined,
  );
  assert.equal(sanitizeCandidate({ ...good, title: '   ' } as CandidateItem, NOW.toISOString()), undefined);
});

test('sanitizeCandidates filters a mixed batch', () => {
  const cleaned = sanitizeCandidates(
    [
      { id: 'a', title: 'Keep me', url: 'https://example.com/a', source: 'Feed', publishedAt: NOW.toISOString() },
      { id: 'b', title: '', url: 'https://example.com/b', source: 'Feed', publishedAt: NOW.toISOString() },
      { id: 'c', title: 'No url', url: 'not a url', source: 'Feed', publishedAt: NOW.toISOString() },
    ],
    NOW.toISOString(),
  );

  assert.deepEqual(
    cleaned.map((item) => item.id),
    ['a'],
  );
});

test('config/sources.json is valid and every source kind has a fetcher', () => {
  const loaded = loadSources(path.join(__dirname, '..', 'config', 'sources.json'));

  assert.ok(loaded.sources.length >= 5, 'expected the shipped config to enable several sources');
  assert.ok(loaded.disabled.length >= 1, 'Reddit feeds ship disabled because of 429 rate limiting');

  for (const source of [...loaded.sources, ...loaded.disabled]) {
    assert.ok(FETCHERS[source.kind], `no fetcher registered for kind "${source.kind}" (${source.id})`);
  }
  assert.equal(loaded.settings.lookbackHours, 36);
  assert.equal(loaded.settings.maxCandidates, 30);
});

test('loadEnv defaults keep the LLM input small and the output budget generous', () => {
  const defaults = loadEnv({});
  assert.equal(defaults.maxCandidates, 30);
  assert.equal(defaults.llmMaxOutputTokens, 6000);

  const overridden = loadEnv({ MAX_CANDIDATES: '12', LLM_MAX_OUTPUT_TOKENS: '9000' });
  assert.equal(overridden.maxCandidates, 12);
  assert.equal(overridden.llmMaxOutputTokens, 9000);
});

test('parseSourcesFile rejects typos, bad kinds and duplicate ids', () => {
  assert.throws(
    () => parseSourcesFile({ sources: [{ id: 'a', name: 'A', kind: 'rss', url: 'https://example.com/feed', typo: true }] }),
    /Invalid/,
  );
  assert.throws(() => parseSourcesFile({ sources: [{ id: 'a', name: 'A', kind: 'telepathy' }] }), /Invalid/);
  assert.throws(
    () =>
      parseSourcesFile({
        sources: [
          { id: 'dup', name: 'A', kind: 'rss', url: 'https://example.com/feed' },
          { id: 'dup', name: 'B', kind: 'rss', url: 'https://example.com/feed2' },
        ],
      }),
    /duplicate source id/,
  );
});
