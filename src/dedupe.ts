/**
 * Seen-ID cache — docs/ARCHITECTURE.md section 4, "Step 3".
 *
 * A small JSON file (`data/seen.json`) records which items were already
 * delivered (full window, default 5 days) and which were merely shown to the
 * LLM (short window, default 2 days) so a rejected item can resurface later.
 * In GitHub Actions the file is persisted with `actions/cache`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CATEGORIES, type CandidateItem, type Digest } from './types';
import { canonicalizeUrl } from './util';

export const SEEN_STORE_VERSION = 1;

export interface SeenEntry {
  /** ISO timestamp of the last time this key was recorded. */
  at: string;
  /** true = delivered in a digest; false = shown to the LLM but not delivered. */
  delivered: boolean;
}

export interface SeenStore {
  version: number;
  entries: Record<string, SeenEntry>;
}

export interface DedupeWindow {
  now: Date;
  /** Days a delivered item stays suppressed. */
  deliveredDays: number;
  /** Days an item shown to the LLM (but not delivered) stays suppressed. */
  consideredDays: number;
}

/** The dedupe key for an item: canonical URL, falling back to its id. */
export function seenKey(item: Pick<CandidateItem, 'url' | 'id'>): string {
  const canonical = canonicalizeUrl(item.url ?? '');
  return canonical || (item.id ?? '');
}

/**
 * Seen keys for the items that were actually posted.
 *
 * The pipeline only ever records what reached the Discord message, so this is
 * the single source of truth for "what counts as seen". Items with no usable URL
 * produce an empty key, which `markSeen` ignores.
 */
export function digestSeenKeys(digest: Digest): string[] {
  return CATEGORIES.flatMap((key) =>
    (digest.categories[key] ?? []).map((item) => seenKey({ url: item.url, id: item.url })),
  );
}

export function emptySeenStore(): SeenStore {
  return { version: SEEN_STORE_VERSION, entries: {} };
}

/** Parse the store defensively — a corrupt cache must never break a run. */
export function parseSeenStore(raw: string): SeenStore {
  try {
    const parsed = JSON.parse(raw) as Partial<SeenStore> | null;
    const entries: Record<string, SeenEntry> = {};
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      for (const [key, value] of Object.entries(parsed.entries)) {
        const entry = value as Partial<SeenEntry> | null;
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.at !== 'string' || Number.isNaN(new Date(entry.at).getTime())) continue;
        entries[key] = { at: entry.at, delivered: entry.delivered === true };
      }
    }
    return { version: SEEN_STORE_VERSION, entries };
  } catch {
    return emptySeenStore();
  }
}

export function loadSeenStore(filePath: string): SeenStore {
  try {
    return parseSeenStore(readFileSync(filePath, 'utf8'));
  } catch {
    // Missing file = cold start (documented as acceptable in section 10).
    return emptySeenStore();
  }
}

/** Drop entries older than their window. Pure: returns a new store. */
export function pruneSeen(store: SeenStore, window: DedupeWindow): SeenStore {
  const deliveredCutoff = window.now.getTime() - window.deliveredDays * 86400 * 1000;
  const consideredCutoff = window.now.getTime() - window.consideredDays * 86400 * 1000;

  const entries: Record<string, SeenEntry> = {};
  for (const [key, entry] of Object.entries(store.entries)) {
    const at = new Date(entry.at).getTime();
    if (Number.isNaN(at)) continue;
    const cutoff = entry.delivered ? deliveredCutoff : consideredCutoff;
    if (at >= cutoff) entries[key] = entry;
  }
  return { version: SEEN_STORE_VERSION, entries };
}

export interface DedupeResult {
  /** Items not present in the cache (and unique within the batch). */
  fresh: CandidateItem[];
  /** How many items were dropped as already seen / duplicated. */
  skipped: number;
  /** The pruned store, ready to be updated and saved. */
  store: SeenStore;
  /** Dedupe keys seen in this batch (used to mark items as "considered"). */
  batchKeys: string[];
}

/**
 * Remove candidates that are in the cache *or* duplicated within this batch
 * (the same story often arrives from several feeds).
 */
export function filterUnseen(candidates: CandidateItem[], store: SeenStore, window: DedupeWindow): DedupeResult {
  const pruned = pruneSeen(store, window);
  const known = new Set(Object.keys(pruned.entries));
  const fresh: CandidateItem[] = [];
  const batchKeys: string[] = [];
  const inBatch = new Set<string>();
  let skipped = 0;

  for (const item of candidates) {
    const key = seenKey(item);
    if (!key) continue;
    if (known.has(key) || inBatch.has(key)) {
      skipped += 1;
      continue;
    }
    inBatch.add(key);
    batchKeys.push(key);
    fresh.push(item);
  }

  return { fresh, skipped, store: pruned, batchKeys };
}

/** Record keys in the store (pure: returns a new store). */
export function markSeen(
  store: SeenStore,
  keys: string[],
  options: { now: Date; delivered: boolean },
): SeenStore {
  const entries = { ...store.entries };
  const at = options.now.toISOString();
  for (const key of keys) {
    if (!key) continue;
    const existing = entries[key];
    entries[key] = {
      at,
      // Never downgrade a delivered entry back to "considered".
      delivered: options.delivered || existing?.delivered === true,
    };
  }
  return { version: SEEN_STORE_VERSION, entries };
}

/** Persist the store, creating the data directory when needed. */
export function saveSeenStore(filePath: string, store: SeenStore): void {
  const directory = path.dirname(filePath);
  if (directory && directory !== '.') mkdirSync(directory, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}
