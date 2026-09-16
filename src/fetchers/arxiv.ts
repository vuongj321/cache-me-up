/**
 * arXiv adapter. arXiv serves an Atom feed, so parsing reuses the generic feed
 * parser; this module only builds the query URL and re-labels ids/URLs.
 */

import type { CandidateItem, SourceConfig } from '../types';
import { canonicalizeUrl, hashString, isHttpUrl, truncate } from '../util';
import type { FetchContext } from './context';
import { fetchFeedItems, type ParsedFeedItem } from './rss';

export const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';
export const DEFAULT_ARXIV_CATEGORIES = ['cs.AI', 'cs.LG'];

/** Build an arXiv API query for the newest submissions in `categories`. */
export function buildArxivUrl(categories: string[], limit: number, endpoint = ARXIV_ENDPOINT): string {
  const searchQuery = categories.map((category) => `cat:${category}`).join(' OR ');
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: '0',
    max_results: String(limit),
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });
  return `${endpoint}?${params.toString()}`;
}

/** Map arXiv feed entries onto `CandidateItem`s. Exported for tests. */
export function mapArxivItems(
  items: ParsedFeedItem[],
  source: SourceConfig,
  ctx: FetchContext,
  categories: string[],
): CandidateItem[] {
  const mapped: CandidateItem[] = [];

  for (const item of items) {
    if (!item.title || !isHttpUrl(item.url)) continue;
    const abstractId = item.id ?? item.url;
    const url = canonicalizeUrl(item.url);
    const details = [
      categories.length > 0 ? categories.join(', ') : '',
      abstractId && abstractId !== item.url ? abstractId.replace(/^https?:\/\//, '') : '',
    ].filter(Boolean);

    mapped.push({
      id: `arxiv:${hashString(abstractId)}`,
      title: truncate(item.title, 200),
      url,
      source: source.name,
      publishedAt: item.publishedAt ?? ctx.now.toISOString(),
      snippet: item.snippet ? truncate([item.snippet, details.join(' · ')].filter(Boolean).join(' — '), 400) : details.join(' · '),
      interest: source.interest,
    });
  }
  return mapped;
}

export async function fetchArxivSource(source: SourceConfig, ctx: FetchContext): Promise<CandidateItem[]> {
  const categories = source.tags && source.tags.length > 0 ? source.tags : DEFAULT_ARXIV_CATEGORIES;
  const limit = source.limit ?? 30;
  const url = source.url ?? buildArxivUrl(categories, limit);

  const feedItems = await fetchFeedItems(url, { timeoutMs: ctx.timeoutMs, userAgent: ctx.userAgent });
  return mapArxivItems(feedItems, source, ctx, categories);
}
