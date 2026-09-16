/**
 * Pre-ranking — docs/ARCHITECTURE.md section 4, "Step 4".
 *
 * The LLM has a limited attention budget and every candidate costs tokens, so
 * candidates are scored by recency + engagement + keyword relevance and capped
 * before they are ever sent. This stage never removes ideas the LLM could use
 * to good effect; it only orders and truncates.
 */

import type { CandidateItem, CandidateSignals, RankedCandidate } from './types';
import { clamp } from './util';

export interface KeywordRule {
  pattern: RegExp;
  weight: number;
  label: string;
}

/** Terms that suggest novelty or engineer relevance. */
export const NOVELTY_RULES: readonly KeywordRule[] = [
  { label: 'release', pattern: /\b(release[sd]?|launch(es|ed)?|introduc\w+|announc\w+|unveil\w*|ships?|rolls? out)\b/i, weight: 6 },
  { label: 'open-source', pattern: /\b(open[-\s]?sourc\w+|open[-\s]?weight\w*|apache[-\s]?2|mit[-\s]?licen\w+)\b/i, weight: 5 },
  { label: 'ai-core', pattern: /\b(llm|slm|agent\w*|transformer\w*|diffusion|inference|quantiz\w+|fine[-\s]?tun\w+|rag|embedding\w*|rlhf|moe|attention|benchmark\w*)\b/i, weight: 5 },
  { label: 'built-it', pattern: /\b(show hn|i built|i made|we built|weekend project|side project|from scratch)\b/i, weight: 5 },
  { label: 'model-names', pattern: /\b(gpt-?\d?[\w.]*|claude\w*|gemini\w*|llama\w*|mistral\w*|qwen\w*|deepseek\w*|whisper\w*|flux\w*|sdxl)\b/i, weight: 4 },
  { label: 'tooling', pattern: /\b(rust|wasm|webgpu|zig|sqlite|postgres\w*|kubernetes|docker|typescript|python|golang)\b/i, weight: 3 },
  { label: 'learning', pattern: /\b(tutorial|explained|deep[-\s]?dive|how (we|i) |post[-\s]?mortem|lessons? learned|internals)\b/i, weight: 3 },
  { label: 'research', pattern: /\b(paper|preprint|study|we show|experiments?|ablation)\b/i, weight: 2 },
];

/** Terms that reliably indicate non-digest material. */
export const NOISE_RULES: readonly KeywordRule[] = [
  { label: 'hiring', pattern: /\b(we'?re hiring|now hiring|job (opening|posting)|recruit\w*|apply now)\b/i, weight: 18 },
  { label: 'promo', pattern: /\b(webinar|register now|sponsored|giveaway|coupon|discount code|black friday|limited time offer)\b/i, weight: 18 },
  { label: 'off-topic', pattern: /\b(election|senate|celebrity|box office|nba|nfl|super bowl)\b/i, weight: 12 },
  { label: 'filler', pattern: /\b(newsletter|podcast episode|episode \d+)\b/i, weight: 6 },
];

export interface RankOptions {
  now: Date;
  lookbackHours: number;
  maxCandidates: number;
  maxItemsPerSource: number;
  noveltyRules?: readonly KeywordRule[];
  noiseRules?: readonly KeywordRule[];
}

/** Exponential decay over the lookback window: fresh items dominate. */
export function recencyScore(publishedAt: string, now: Date, lookbackHours: number): number {
  const published = new Date(publishedAt).getTime();
  if (Number.isNaN(published)) return 0;
  const ageHours = Math.max(0, (now.getTime() - published) / 3600000);
  const halfLifeHours = Math.max(lookbackHours / 2, 6);
  return 40 * Math.exp(-ageHours / halfLifeHours);
}

function log10(value: number): number {
  return Math.log10(1 + Math.max(0, value));
}

/** Compressed engagement score — a 1000-point story beats a 100-point one, not by 10x. */
export function engagementScore(signals: CandidateSignals | undefined): number {
  if (!signals) return 0;
  return (
    10 * log10(signals.points ?? 0) +
    5 * log10(signals.comments ?? 0) +
    9 * log10(signals.starsToday ?? 0) +
    6 * log10(signals.stars ?? 0) +
    4 * log10(signals.likes ?? 0) +
    2 * log10((signals.downloads ?? 0) / 50) +
    3 * log10((signals.trendingScore ?? 0) / 10)
  );
}

export function keywordAdjustment(text: string, rules: readonly KeywordRule[], cap: number, sign: 1 | -1): number {
  let total = 0;
  for (const rule of rules) {
    if (rule.pattern.test(text)) total += rule.weight;
  }
  return sign * Math.min(total, cap);
}

/** Score one candidate. Exported for tests. */
export function scoreCandidate(item: CandidateItem, options: RankOptions): number {
  const noveltyRules = options.noveltyRules ?? NOVELTY_RULES;
  const noiseRules = options.noiseRules ?? NOISE_RULES;
  const text = `${item.title} ${item.snippet ?? ''}`;

  const base = recencyScore(item.publishedAt, options.now, options.lookbackHours);
  const engagement = engagementScore(item.signals);
  const boost = keywordAdjustment(text, noveltyRules, 18, 1);
  const penalty = keywordAdjustment(text, noiseRules, 40, -1);

  return clamp(base + engagement + boost + penalty, 0, 1000);
}


/** Score, diversify across sources, then cap the list handed to the LLM. */
export function rankAndCap(candidates: CandidateItem[], options: RankOptions): RankedCandidate[] {
  const cutoff = options.now.getTime() - options.lookbackHours * 3600 * 1000;

  const scored: RankedCandidate[] = [];
  for (const item of candidates) {
    const published = new Date(item.publishedAt).getTime();
    if (!Number.isNaN(published) && published < cutoff) continue;
    scored.push({ ...item, score: scoreCandidate(item, options) });
  }

  scored.sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt));

  // First pass honours the per-source cap so one noisy feed cannot fill the
  // list; the second pass backfills unused slots with the next best items.
  const perSource = new Map<string, number>();
  const selected: RankedCandidate[] = [];
  const deferred: RankedCandidate[] = [];
  for (const item of scored) {
    const used = perSource.get(item.source) ?? 0;
    if (used < options.maxItemsPerSource) {
      perSource.set(item.source, used + 1);
      selected.push(item);
    } else {
      deferred.push(item);
    }
  }

  for (const item of deferred) {
    if (selected.length >= options.maxCandidates) break;
    selected.push(item);
  }

  return selected.slice(0, options.maxCandidates).sort((a, b) => b.score - a.score);
}
