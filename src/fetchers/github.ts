/**
 * GitHub adapters.
 *
 *  - `github-trending`: scrapes the public trending page (no API exists). The
 *    markup is parsed defensively and a zero-result parse is not fatal.
 *  - `github-search`  : the official search API, for freshly created repos
 *    that are already attracting stars (`created:>DATE stars:>=N`).
 */

import type { CandidateItem, SourceConfig } from '../types';
import { stripHtml, toIsoDate, truncate } from '../util';
import type { FetchContext } from './context';
import { fetchJson, fetchText } from './http';

export const GITHUB_TRENDING_URL = 'https://github.com/trending?since=daily';
export const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';

export interface TrendingRepo {
  fullName: string;
  url: string;
  title: string;
  description?: string;
  starsToday?: number;
}

function parseIntSafe(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.replace(/[,\s]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse `https://github.com/trending` markup into repository records. */
export function parseTrendingHtml(html: string): TrendingRepo[] {
  const blocks = html.split(/<article class="Box-row">/i).slice(1);
  const repos: TrendingRepo[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.split(/<\/article>/i)[0] ?? rawBlock;
    const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1];
    if (!heading) continue;

    const path = /href="\/([^"\s?#]+)"/i.exec(heading)?.[1];
    if (!path || path.split('/').length !== 2 || path.startsWith('login')) continue;

    const descriptionMatch = /<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1];
    const starsMatch = /float-sm-right[\s\S]*?([\d,]+)\s*stars?\s*today/i.exec(block)?.[1];
    const title = stripHtml(heading).replace(/\s*\/\s*/g, ' / ');
    const description = stripHtml(descriptionMatch);

    repos.push({
      fullName: path,
      url: `https://github.com/${path}`,
      title: title || path,
      description: description || undefined,
      starsToday: parseIntSafe(starsMatch),
    });
  }

  return repos;
}

/** Map scraped repositories onto `CandidateItem`s. Exported for tests. */
export function mapTrendingRepos(repos: TrendingRepo[], source: SourceConfig, ctx: FetchContext): CandidateItem[] {
  const items: CandidateItem[] = [];
  for (const repo of repos) {
    const snippetParts = [
      repo.description ? truncate(repo.description, 240) : '',
      repo.starsToday !== undefined ? `${repo.starsToday} stars today` : '',
    ].filter(Boolean);

    items.push({
      id: `gh-trending:${repo.fullName}`,
      title: truncate(repo.title, 200),
      url: repo.url,
      source: source.name,
      // The trending page carries no publish date; treat it as "now".
      publishedAt: ctx.now.toISOString(),
      snippet: snippetParts.join(' — ') || undefined,
      signals: { starsToday: repo.starsToday ?? 0 },
      interest: source.interest,
    });
  }
  return items;
}

export async function fetchGithubTrendingSource(source: SourceConfig, ctx: FetchContext): Promise<CandidateItem[]> {
  const limit = source.limit ?? 15;
  const html = await fetchText(source.url ?? GITHUB_TRENDING_URL, {
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
    accept: 'text/html',
  });

  const repos = parseTrendingHtml(html).slice(0, limit);
  if (repos.length === 0) {
    ctx.log.warn(`github-trending("${source.id}") parsed 0 repositories; GitHub markup may have changed`);
  }
  return mapTrendingRepos(repos, source, ctx);
}

interface GithubRepo {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  created_at?: string;
  pushed_at?: string;
  stargazers_count?: number;
  language?: string | null;
  topics?: string[];
  archived?: boolean;
  fork?: boolean;
}

/** Map GitHub search results onto `CandidateItem`s. Exported for tests. */
export function mapSearchRepos(repos: GithubRepo[], source: SourceConfig, ctx: FetchContext): CandidateItem[] {
  const items: CandidateItem[] = [];
  for (const repo of repos) {
    if (!repo.full_name || !repo.html_url || repo.archived === true || repo.fork === true) continue;

    const snippetParts = [
      repo.description ? truncate(repo.description, 220) : '',
      repo.language ? repo.language : '',
      (repo.topics ?? []).slice(0, 4).join(', '),
      `${repo.stargazers_count ?? 0} stars`,
    ].filter(Boolean);

    items.push({
      id: `gh:${repo.full_name}`,
      title: truncate(repo.full_name, 200),
      url: repo.html_url,
      source: source.name,
      publishedAt: toIsoDate(repo.created_at) ?? ctx.now.toISOString(),
      snippet: snippetParts.join(' — '),
      signals: { stars: repo.stargazers_count ?? 0 },
      interest: source.interest,
    });
  }
  return items;
}

export async function fetchGithubSearchSource(source: SourceConfig, ctx: FetchContext): Promise<CandidateItem[]> {
  const limit = source.limit ?? 15;
  const minStars = source.minStars ?? 50;
  const sinceDate = ctx.since.toISOString().slice(0, 10);
  const query = source.query ?? `created:>${sinceDate} stars:>=${minStars}`;
  const url = `${source.url ?? GITHUB_SEARCH_URL}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.min(
    limit,
    100,
  )}`;

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (ctx.githubToken) headers.authorization = `Bearer ${ctx.githubToken}`;

  const payload = await fetchJson<{ items?: GithubRepo[] }>(url, {
    timeoutMs: ctx.timeoutMs,
    userAgent: ctx.userAgent,
    headers,
  });

  const repos = Array.isArray(payload.items) ? payload.items : [];
  return mapSearchRepos(repos, source, ctx).slice(0, limit);
}
