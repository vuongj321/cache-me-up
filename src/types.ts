/**
 * Shared data shapes for the Daily Tech Digest pipeline.
 *
 * Every fetcher normalizes its source-specific payload into `CandidateItem`, and
 * every stage downstream (dedupe -> rank -> LLM -> format -> post) reads only
 * that one shape. See docs/ARCHITECTURE.md section 4, "Step 2".
 */

export const CATEGORIES = ['new_models', 'project_inspiration', 'concepts', 'cool_builds'] as const;

export type CategoryKey = (typeof CATEGORIES)[number];

export interface CategoryDefinition {
  key: CategoryKey;
  /** Human label used as the Discord section title. */
  label: string;
  /** Instruction handed to the LLM so it can route items correctly. */
  description: string;
}

export const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    key: 'new_models',
    label: 'New AI models',
    description:
      'Newly released or newly notable AI models and checkpoints: open-weight releases, multimodal or coding models, ' +
      'significant version updates, and notable inference/serving stacks for them.',
  },
  {
    key: 'project_inspiration',
    label: 'Project inspiration',
    description:
      'Ideas worth building. Tools, techniques, or observations that suggest a side project, a new approach to an ' +
      'existing problem, or a clever workaround an engineer could apply this week.',
  },
  {
    key: 'concepts',
    label: 'AI / programming concepts',
    description:
      'Educational material that teaches something: papers, explainers, deep dives, benchmarks, and engineering ' +
      'write-ups about a technique, algorithm, architecture, or tooling concept.',
  },
  {
    key: 'cool_builds',
    label: 'Cool builds',
    description:
      'Impressive things people actually shipped: open-source projects, demos, developer tools, and polished hobby builds.',
  },
];

/** Which fetcher adapter handles a configured source. */
export type SourceKind = 'rss' | 'hackernews' | 'arxiv' | 'huggingface' | 'github-trending' | 'github-search';

/** One entry of `config/sources.json`. */
export interface SourceConfig {
  /** Stable id, used in log lines and per-source caps. */
  id: string;
  /** Human label, used as `CandidateItem.source`. */
  name: string;
  kind: SourceKind;
  /** Endpoint override (RSS URL, API base, trending page, ...). */
  url?: string;
  /** Category hints (arXiv categories, HN tags, ...). */
  tags?: string[];
  /** Ranking hint only; the LLM makes the final call. */
  interest?: CategoryKey;
  /** Set to false to keep an entry in config but skip it. Defaults to enabled. */
  enabled?: boolean;
  /** Max items this source may contribute. */
  limit?: number;
  /** Minimum HN points (hackernews only). */
  minPoints?: number;
  /** Minimum star count (github-search only). */
  minStars?: number;
  /** Free-form query override (github-search only). */
  query?: string;
}

/** Parsed `config/sources.json`. */
export interface SourcesFile {
  lookbackHours?: number;
  maxCandidates?: number;
  maxItemsPerSource?: number;
  sources: SourceConfig[];
}

/** Engagement signals used only for pre-ranking (never sent to the LLM). */
export interface CandidateSignals {
  points?: number;
  comments?: number;
  starsToday?: number;
  stars?: number;
  likes?: number;
  downloads?: number;
  trendingScore?: number;
}

/** The normalized shape every fetcher produces. */
export interface CandidateItem {
  id: string;
  title: string;
  url: string;
  source: string;
  /** ISO timestamp. */
  publishedAt: string;
  snippet?: string;
  signals?: CandidateSignals;
  interest?: CategoryKey;
}

export interface RankedCandidate extends CandidateItem {
  score: number;
}

/** One digest line as returned by the LLM (and validated before use). */
export interface DigestItem {
  title: string;
  summary: string;
  url: string;
  source: string;
}

/** The validated, URL-checked digest. */
export interface Digest {
  generatedAt: string;
  categories: Record<CategoryKey, DigestItem[]>;
}

/** Raw (pre-URL-validation) LLM response shape. */
export interface RawDigest {
  categories: Record<CategoryKey, DigestItem[]>;
}
