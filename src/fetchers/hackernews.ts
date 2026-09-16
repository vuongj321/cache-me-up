/**
 * Hacker News adapter built on the Algolia search API
 * (`https://hn.algolia.com/api/v1/search_by_date`).
 *
 * `tags` selects the story set: `["story"]` for the front page, `["show_hn"]`
 * for Show HN. `minPoints` filters noise server-side via `numericFilters`.
 */

import type { CandidateItem, SourceConfig } from '../types';
import { canonicalizeUrl, stripHtml, toIsoDate, truncate } from '../util';
import type { FetchContext } from './context';
import { fetchJson } from './http';

export const HN_ALGOLIA_ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';
export const HN_ITEM_URL = 'https://news.ycombinator.com/item?id=';

interface HnHit {
  objectID?: string;
  story_id?: number;
  title?: string;
  story_title?: string;
  url?: string;
  story_url?: string;
  created_at?: string;
  points?: number;
  num_comments?: number;
  author?: string;
  story_text?: string;
  _tags?: string[];
}

interface HnResponse {
  hits?: HnHit[];
}

/** Map raw Algolia hits onto `CandidateItem`s. Exported for tests. */
export function mapHits(hits: HnHit[], source: SourceConfig, ctx: FetchContext, minPoints = 0): CandidateItem[] {
  const items: CandidateItem[] = [];
  for (const hit of hits) {
    const objectId = hit.objectID ?? (hit.story_id !== undefined ? String(hit.story_id) : '');
    if (!objectId) continue;

    const title = stripHtml(hit.title ?? hit.story_title ?? '');
    if (!title) continue;

    const external = hit.url ?? hit.story_url;
    const url = external && /^https?:\/\//i.test(external) ? external : `${HN_ITEM_URL}${objectId}`;
    const points = hit.points ?? 0;
    if (points < minPoints) continue;

    const snippetSource = hit.story_text ? stripHtml(hit.story_text) : '';
    const snippet = snippetSource
      ? truncate(snippetSource, 300)
      : truncate([`${points} points`, `${hit.num_comments ?? 0} comments`, `by ${hit.author ?? 'unknown'}`].join(' · '), 200);

    items.push({
      id: `hn:${objectId}`,
      title: truncate(title, 200),
      url: canonicalizeUrl(url),
      source: source.name,
      publishedAt: toIsoDate(hit.created_at) ?? ctx.now.toISOString(),
      snippet,
      signals: { points, comments: hit.num_comments ?? 0 },
      interest: source.interest,
    });
  }
  return items;
}

export async function fetchHackerNewsSource(source: SourceConfig, ctx: FetchContext): Promise<CandidateItem[]> {
  const endpoint = source.url ?? HN_ALGOLIA_ENDPOINT;
  const limit = source.limit ?? 30;
  const minPoints = source.minPoints ?? 0;
  const tags = (source.tags && source.tags.length > 0 ? source.tags : ['story']).join(',');

  const numericFilters = [`created_at_i>${Math.floor(ctx.since.getTime() / 1000)}`];
  if (minPoints > 0) numericFilters.push(`points>=${minPoints}`);

  const url = `${endpoint}?tags=${encodeURIComponent(tags)}&numericFilters=${encodeURIComponent(
    numericFilters.join(','),
  )}&hitsPerPage=${Math.min(Math.max(limit * 3, 30), 200)}`;

  const payload = await fetchJson<HnResponse>(url, { timeoutMs: ctx.timeoutMs });
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  const mapped = mapHits(hits, source, ctx, minPoints);
  ctx.log.debug(`hackernews("${source.id}") returned ${mapped.length} usable hits from ${hits.length}`);
  return mapped.slice(0, limit);
}
