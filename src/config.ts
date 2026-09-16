/**
 * Configuration loading: environment variables (`.env` locally, Actions secrets
 * in CI) and the declarative source list in `config/sources.json`.
 *
 * See docs/ARCHITECTURE.md section 8, "Configuration and secrets".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import type { SourceConfig, SourcesFile } from './types';

export const DEFAULT_SOURCES_PATH = path.join('config', 'sources.json');

export interface AppEnv {
  openaiApiKey?: string;
  openaiModel: string;
  openaiBaseUrl: string;
  discordWebhookUrl?: string;
  lookbackHours: number;
  maxCandidates: number;
  maxItemsPerSource: number;
  seenStorePath: string;
  seenWindowDays: number;
  consideredWindowDays: number;
  logLevel: string;
  postEmptyDigest: boolean;
  fetchTimeoutMs: number;
  llmTimeoutMs: number;
  githubToken?: string;
}

export interface SourceSettings {
  /** Undefined when `config/sources.json` does not override the env default. */
  lookbackHours?: number;
  maxCandidates?: number;
  maxItemsPerSource?: number;
}

export interface LoadedSources {
  settings: SourceSettings;
  /** Enabled sources only. */
  sources: SourceConfig[];
  /** Sources present in config but disabled. */
  disabled: SourceConfig[];
}

let dotenvLoaded = false;

function ensureDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  dotenv.config({ quiet: true });
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function intFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFrom(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Read + normalize all environment settings (does not validate secrets). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (source === process.env) ensureDotenv();

  const maxCandidates = intFrom(source.MAX_CANDIDATES, 50);
  return {
    openaiApiKey: optional(source.OPENAI_API_KEY),
    openaiModel: optional(source.OPENAI_MODEL) ?? 'gpt-4o-mini',
    openaiBaseUrl: (optional(source.OPENAI_BASE_URL) ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    discordWebhookUrl: optional(source.DISCORD_WEBHOOK_URL),
    lookbackHours: intFrom(source.LOOKBACK_HOURS, 36),
    maxCandidates: maxCandidates > 0 ? maxCandidates : 50,
    maxItemsPerSource: intFrom(source.MAX_ITEMS_PER_SOURCE, 12),
    seenStorePath: optional(source.SEEN_STORE_PATH) ?? path.join('data', 'seen.json'),
    seenWindowDays: intFrom(source.SEEN_WINDOW_DAYS, 5),
    consideredWindowDays: intFrom(source.CONSIDERED_WINDOW_DAYS, 2),
    logLevel: optional(source.LOG_LEVEL) ?? 'info',
    postEmptyDigest: boolFrom(source.DIGEST_POST_EMPTY, false),
    fetchTimeoutMs: intFrom(source.FETCH_TIMEOUT_MS, 20000),
    llmTimeoutMs: intFrom(source.LLM_TIMEOUT_MS, 120000),
    githubToken: optional(source.GITHUB_TOKEN),
  };
}

/**
 * Throw a single readable error listing every missing secret. Called right
 * before the stage that needs it, so `--dry-run` works without any keys.
 */
export function assertSecrets(env: AppEnv, needs: { llm?: boolean; discord?: boolean } = {}): void {
  const missing: string[] = [];
  if (needs.llm && !env.openaiApiKey) missing.push('OPENAI_API_KEY');
  if (needs.discord && !env.discordWebhookUrl) missing.push('DISCORD_WEBHOOK_URL');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy .env.example to .env for local runs, or add repository secrets in GitHub Actions.',
    );
  }
}

const categoryEnum = z.enum(['new_models', 'project_inspiration', 'concepts', 'cool_builds']);

const sourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(['rss', 'hackernews', 'arxiv', 'huggingface', 'github-trending', 'github-search']),
    url: z.string().url().optional(),
    tags: z.array(z.string().min(1)).optional(),
    interest: categoryEnum.optional(),
    enabled: z.boolean().optional(),
    limit: z.number().int().positive().max(200).optional(),
    minPoints: z.number().int().nonnegative().optional(),
    minStars: z.number().int().nonnegative().optional(),
    query: z.string().min(1).optional(),
  })
  .strict();

const sourcesFileSchema = z
  .object({
    lookbackHours: z.number().positive().max(24 * 14).optional(),
    maxCandidates: z.number().int().positive().max(500).optional(),
    maxItemsPerSource: z.number().int().positive().max(100).optional(),
    sources: z.array(sourceSchema).min(1),
  })
  .strict();

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}

/** Validate an already-parsed `sources.json` object (exported for tests). */
export function parseSourcesFile(raw: unknown, fileName = DEFAULT_SOURCES_PATH): LoadedSources {
  const parsed = sourcesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${fileName}: ${describeIssues(parsed.error)}`);
  }

  const file = parsed.data as SourcesFile;
  const seenIds = new Set<string>();
  for (const source of file.sources) {
    if (seenIds.has(source.id)) {
      throw new Error(`Invalid ${fileName}: duplicate source id "${source.id}"`);
    }
    seenIds.add(source.id);
  }

  return {
    settings: {
      lookbackHours: file.lookbackHours,
      maxCandidates: file.maxCandidates,
      maxItemsPerSource: file.maxItemsPerSource,
    },
    sources: file.sources.filter((source) => source.enabled !== false),
    disabled: file.sources.filter((source) => source.enabled === false),
  };
}

/** Read and validate `config/sources.json` from disk. */
export function loadSources(filePath: string = DEFAULT_SOURCES_PATH): LoadedSources {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read source config at ${filePath}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${filePath} as JSON: ${(error as Error).message}`);
  }

  return parseSourcesFile(json, filePath);
}
