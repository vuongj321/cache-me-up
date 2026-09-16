/**
 * Shared fetcher contract. `index.ts` wires the adapters into a registry;
 * `rss.ts`, `hackernews.ts`, ... each implement one `SourceKind`.
 */

import type { Logger } from '../log';
import type { CandidateItem, SourceConfig } from '../types';

export interface FetchContext {
  /** Timestamp the run started — used as a fallback publish time. */
  now: Date;
  /** `now` minus the lookback window; fetchers should not return older items. */
  since: Date;
  lookbackHours: number;
  timeoutMs: number;
  userAgent: string;
  githubToken?: string;
  log: Logger;
}

export type Fetcher = (source: SourceConfig, ctx: FetchContext) => Promise<CandidateItem[]>;

/** Feed/API payloads vary wildly; helpers below normalize the common cases. */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
