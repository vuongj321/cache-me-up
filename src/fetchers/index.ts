/**
 * Fetcher registry + runner.
 *
 * Sources are fetched in small concurrent batches, and each source is isolated:
 * one dead or rate-limited feed is logged and skipped rather than failing the
 * whole run (docs/ARCHITECTURE.md section 10, "Failure modes").
 */

import type { Logger } from '../log';
import type { CandidateItem, SourceConfig, SourceKind } from '../types';
import { canonicalizeUrl, collapseWhitespace, isHttpUrl, toIsoDate, truncate } from '../util';
import { fetchArxivSource } from './arxiv';
import type { Fetcher, FetchContext } from './context';
import { fetchGithubSearchSource, fetchGithubTrendingSource } from './github';
import { fetchHackerNewsSource } from './hackernews';
import { fetchHuggingFaceSource } from './huggingface';
import { DEFAULT_USER_AGENT } from './http';
import { fetchRssSource } from './rss';

export const FETCHERS: Record<SourceKind, Fetcher> = {
  rss: fetchRssSource,
  hackernews: fetchHackerNewsSource,
  arxiv: fetchArxivSource,
  huggingface: fetchHuggingFaceSource,
  'github-trending': fetchGithubTrendingSource,
  'github-search': fetchGithubSearchSource,
};

export interface SourceOutcome {
  sourceId: string;
  count: number;
}

export interface SourceError {
  sourceId: string;
  message: string;
}

export interface FetchResult {
  items: CandidateItem[];
  outcomes: SourceOutcome[];
  errors: SourceError[];
}

export interface FetchOptions {
  /** How many sources to fetch at once. */
  concurrency?: number;
  userAgent?: string;
}

export function createFetchContext(env: {
  now: Date;
  lookbackHours: number;
  timeoutMs: number;
  githubToken?: string;
  log: Logger;
}): FetchContext {
  return {
    now: env.now,
    since: new Date(env.now.getTime() - env.lookbackHours * 3600 * 1000),
    lookbackHours: env.lookbackHours,
    timeoutMs: env.timeoutMs,
    userAgent: DEFAULT_USER_AGENT,
    githubToken: env.githubToken,
    log: env.log,
  };
}

/** Normalize or discard a single candidate. Exported for tests. */
export function sanitizeCandidate(item: CandidateItem, fallbackDate: string): CandidateItem | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const title = collapseWhitespace(item.title ?? '');
  if (!title) return undefined;

  const rawUrl = item.url ?? '';
  if (!isHttpUrl(rawUrl)) return undefined;

  return {
    ...item,
    id: item.id || canonicalizeUrl(rawUrl),
    title: truncate(title, 220),
    url: canonicalizeUrl(rawUrl),
    source: collapseWhitespace(item.source ?? 'unknown') || 'unknown',
    publishedAt: toIsoDate(item.publishedAt) ?? fallbackDate,
    snippet: item.snippet ? truncate(collapseWhitespace(item.snippet), 400) : undefined,
  };
}

export function sanitizeCandidates(items: CandidateItem[], fallbackDate: string): CandidateItem[] {
  const cleaned: CandidateItem[] = [];
  for (const item of items) {
    const sanitized = sanitizeCandidate(item, fallbackDate);
    if (sanitized) cleaned.push(sanitized);
  }
  return cleaned;
}

async function runFetcher(source: SourceConfig, ctx: FetchContext): Promise<CandidateItem[]> {
  const fetcher = FETCHERS[source.kind];
  if (!fetcher) throw new Error(`no fetcher registered for kind "${source.kind}"`);
  const items = await fetcher(source, ctx);
  return sanitizeCandidates(Array.isArray(items) ? items : [], ctx.now.toISOString());
}

/** Fetch every enabled source, isolating failures. */
export async function fetchAllSources(
  sources: SourceConfig[],
  ctx: FetchContext,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const result: FetchResult = { items: [], outcomes: [], errors: [] };

  for (let index = 0; index < sources.length; index += concurrency) {
    const batch = sources.slice(index, index + concurrency);
    const settled = await Promise.allSettled(batch.map((source) => runFetcher(source, ctx)));

    settled.forEach((outcome, position) => {
      const source = batch[position];
      if (!source) return;

      if (outcome.status === 'fulfilled') {
        result.items.push(...outcome.value);
        result.outcomes.push({ sourceId: source.id, count: outcome.value.length });
        ctx.log.debug(`source "${source.id}" returned ${outcome.value.length} item(s)`);
      } else {
        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        result.errors.push({ sourceId: source.id, message });
        ctx.log.warn(`source "${source.id}" failed: ${message}`);
      }
    });
  }

  return result;
}
