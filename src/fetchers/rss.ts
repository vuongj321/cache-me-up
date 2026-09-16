/**
 * Generic RSS 2.0 / Atom / RSS 1.0 feed adapter.
 *
 * One parser handles every feed-shaped source in `config/sources.json`
 * (lab blogs, Lobsters, Reddit, and arXiv — which serves Atom).
 */

import { XMLParser } from 'fast-xml-parser';
import type { CandidateItem, SourceConfig } from '../types';
import { canonicalizeUrl, hashString, isHttpUrl, stripHtml, toIsoDate, truncate } from '../util';
import { asArray, type FetchContext } from './context';
import { fetchText } from './http';

export interface ParsedFeedItem {
  title?: string;
  url?: string;
  id?: string;
  publishedAt?: string;
  snippet?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
});

const TITLE_FIELDS = ['title'];
const LINK_FIELDS = ['link'];
const ID_FIELDS = ['id', 'guid'];
const DATE_FIELDS = ['pubDate', 'published', 'updated', 'dc:date', 'date'];
const SNIPPET_FIELDS = ['content:encoded', 'description', 'summary', 'content', 'media:description'];

/** Text content of a parsed node (string, number, `#text`, or first array entry). */
function textOf(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record['#text'] !== undefined) return String(record['#text']);
    if (record['@_href'] !== undefined) return String(record['@_href']);
  }
  return '';
}

function attributeOf(node: unknown, attribute: string): string {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const value = (node as Record<string, unknown>)[`@_${attribute}`];
    if (value !== undefined) return String(value);
  }
  return '';
}

function firstField(entry: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = textOf(entry[field]);
    if (value.trim()) return value;
  }
  return '';
}

/** Atom entries carry an array of `<link>` nodes; prefer `rel="alternate"`. */
function resolveLink(entry: Record<string, unknown>): string {
  for (const field of LINK_FIELDS) {
    const links = asArray(entry[field]);
    const resolved = links
      .map((link) => ({ href: textOf(link), rel: attributeOf(link, 'rel') || 'alternate' }))
      .filter((link) => isHttpUrl(link.href));

    const alternate = resolved.find((link) => link.rel === 'alternate' || link.rel === '');
    if (alternate) return alternate.href;
    const first = resolved[0];
    if (first) return first.href;
  }
  return '';
}

const CONTAINER_PATHS: string[][] = [
  ['feed', 'entry'], // Atom
  ['rss', 'channel', 'item'], // RSS 2.0
  ['rdf:RDF', 'item'], // RSS 1.0
  ['channel', 'item'], // bare channel
];

function pickEntryNodes(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const pathParts of CONTAINER_PATHS) {
    let current: unknown = parsed;
    for (const part of pathParts) {
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        current = undefined;
        break;
      }
    }
    const nodes = asArray(current).filter(
      (node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object' && !Array.isArray(node),
    );
    if (nodes.length > 0) return nodes;
  }
  return [];
}

/** Parse RSS/Atom XML into normalized feed items. Throws on malformed XML. */
export function parseFeed(xml: string): ParsedFeedItem[] {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const entries = pickEntryNodes(parsed);

  const items: ParsedFeedItem[] = [];
  for (const entry of entries) {
    const title = stripHtml(firstField(entry, TITLE_FIELDS));
    const rawLink = resolveLink(entry);
    const rawId = firstField(entry, ID_FIELDS);
    const url = isHttpUrl(rawLink) ? rawLink : isHttpUrl(rawId) ? rawId : '';
    const date = toIsoDate(firstField(entry, DATE_FIELDS));
    const snippet = stripHtml(firstField(entry, SNIPPET_FIELDS));

    items.push({
      title,
      url,
      id: rawId || url,
      publishedAt: date,
      snippet: snippet ? truncate(snippet, 400) : undefined,
    });
  }
  return items;
}

/** Fetch + parse a feed (no filtering or capping). */
export async function fetchFeedItems(
  url: string,
  opts: { timeoutMs: number; userAgent: string },
): Promise<ParsedFeedItem[]> {
  const xml = await fetchText(url, {
    timeoutMs: opts.timeoutMs,
    userAgent: opts.userAgent,
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  });
  return parseFeed(xml);
}

/** Map parsed feed items onto `CandidateItem`s, dropping anything unusable. */
export function mapFeedItems(items: ParsedFeedItem[], source: SourceConfig, ctx: FetchContext): CandidateItem[] {
  const mapped: CandidateItem[] = [];
  for (const item of items) {
    if (!item.title || !isHttpUrl(item.url)) continue;
    const canonical = canonicalizeUrl(item.url);
    mapped.push({
      id: `feed:${hashString(canonical)}`,
      title: truncate(item.title, 200),
      url: canonical,
      source: source.name,
      publishedAt: item.publishedAt ?? ctx.now.toISOString(),
      snippet: item.snippet,
      interest: source.interest,
    });
  }
  return mapped;
}

/** Fallback cap for feeds whose entries are not limited in config. */
export const DEFAULT_FEED_ITEMS = 50;

export async function fetchRssSource(source: SourceConfig, ctx: FetchContext): Promise<CandidateItem[]> {
  if (!source.url) throw new Error(`source "${source.id}" (rss) is missing "url"`);
  const items = await fetchFeedItems(source.url, { timeoutMs: ctx.timeoutMs, userAgent: ctx.userAgent });
  const mapped = mapFeedItems(items, source, ctx);
  // Feeds are newest-first; several lab blogs return their whole archive, so an
  // unconfigured source is capped to keep memory and log noise bounded.
  return mapped.slice(0, source.limit ?? DEFAULT_FEED_ITEMS);
}
