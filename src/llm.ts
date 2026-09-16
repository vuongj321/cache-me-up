/**
 * LLM step — filter, categorize and summarize candidates into the strict JSON
 * contract described in docs/ARCHITECTURE.md section 5, then enforce the URL
 * allowlist that protects readers from hallucinated links.
 *
 * Any OpenAI-compatible chat-completions endpoint works (`OPENAI_BASE_URL`).
 */

import { z } from 'zod';
import { HttpError, request } from './fetchers/http';
import type { Logger } from './log';
import {
  CATEGORIES,
  CATEGORY_DEFINITIONS,
  type CategoryKey,
  type CandidateItem,
  type Digest,
  type DigestItem,
  type RawDigest,
} from './types';
import { canonicalizeUrl, collapseWhitespace, truncate } from './util';

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxCandidates: number;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Compact candidate view sent to the model (engagement signals are dropped). */
export interface LlmCandidate {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  interest?: CategoryKey;
  snippet?: string;
}

export class LlmResponseError extends Error {
  constructor(
    message: string,
    readonly rawResponse?: string,
  ) {
    super(message);
    this.name = 'LlmResponseError';
  }
}

export function buildCandidatePayload(candidates: CandidateItem[]): LlmCandidate[] {
  return candidates.map((candidate) => ({
    title: truncate(candidate.title, 200),
    url: candidate.url,
    source: candidate.source,
    publishedAt: candidate.publishedAt,
    ...(candidate.interest ? { interest: candidate.interest } : {}),
    ...(candidate.snippet ? { snippet: truncate(candidate.snippet, 300) } : {}),
  }));
}

const SYSTEM_PROMPT = [
  'You are the editor of a daily technology digest read by software engineers who follow AI.',
  'You receive a JSON list of candidate items collected from curated feeds in the last day or so.',
  'Pick the items genuinely worth a busy engineer\'s attention today and sort them into four categories.',
  '',
  'Rules:',
  '- Use ONLY the candidates provided. Never invent items, titles, or URLs.',
  '- Copy each url EXACTLY as given; never shorten, rewrite, or guess a URL.',
  '- Write a factual 1-2 sentence summary per item. No hype, no emojis, no hashtags.',
  '- Prefer novel, engineer-relevant items and concrete shipped work over generic opinion pieces.',
  '- Skip anything that is an ad, a job posting, a webinar, or purely promotional.',
  '- Aim for 3-5 items per category. Fewer (or none) is correct when quality is low.',
  '- Deduplicate: the same story from two feeds appears once, under the best-fitting category.',
  '- The "interest" field is only a weak hint; your judgement wins.',
  '',
  'Reply with JSON only, matching exactly this shape:',
  '{"categories":{"new_models":[{"title":"...","summary":"...","url":"...","source":"..."}],',
  '"project_inspiration":[],"concepts":[],"cool_builds":[]}}',
].join('\n');

export function buildMessages(candidates: CandidateItem[]): ChatMessage[] {
  const categoryGuide = CATEGORY_DEFINITIONS.map(
    (definition) => `- "${definition.key}" (${definition.label}): ${definition.description}`,
  ).join('\n');

  const userPrompt = [
    'Categories:',
    categoryGuide,
    '',
    `Candidates (${candidates.length}):`,
    JSON.stringify(buildCandidatePayload(candidates)),
    '',
    'Return the JSON digest now.',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
}

const digestItemSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  url: z.string().min(1),
  source: z.string().optional(),
});

const rawDigestSchema = z.object({
  categories: z.record(z.string(), z.array(digestItemSchema)),
});

/**
 * Best-effort repair for providers without structured-output mode: escape raw
 * control characters (real newlines/tabs) that appear inside JSON strings.
 */
export function escapeControlCharsInStrings(text: string): string {
  let inString = false;
  let escaped = false;
  let out = '';

  for (const char of text) {
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += char;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inString = false;
      out += char;
      continue;
    }
    if (char === '\n') {
      out += '\\n';
      continue;
    }
    if (char === '\r') {
      out += '\\r';
      continue;
    }
    if (char === '\t') {
      out += '\\t';
      continue;
    }
    out += char;
  }

  return out;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    try {
      return JSON.parse(escapeControlCharsInStrings(text)) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** Strip ``` fences / stray prose and parse the JSON body. */
export function extractJson(text: string): unknown {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new LlmResponseError('LLM returned an empty response');

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  const direct = tryParse(body);
  if (direct !== undefined) return direct;

  // Fall back to the outermost object, in case the model wrapped JSON in prose.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = tryParse(body.slice(start, end + 1));
    if (sliced !== undefined) return sliced;
  }

  throw new LlmResponseError(`LLM response was not valid JSON (first 200 chars: ${truncate(trimmed, 200)})`, trimmed);
}

/** Validate a raw response against the digest schema and fill missing categories. */
export function parseRawDigest(text: string): RawDigest {
  const parsed = rawDigestSchema.safeParse(extractJson(text));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new LlmResponseError(`LLM response did not match the digest schema: ${detail}`, text);
  }

  const categories = {} as Record<CategoryKey, DigestItem[]>;
  for (const key of CATEGORIES) {
    const items = parsed.data.categories[key] ?? [];
    categories[key] = items.map((item) => ({
      title: collapseWhitespace(item.title),
      summary: collapseWhitespace(item.summary),
      url: item.url.trim(),
      source: collapseWhitespace(item.source ?? ''),
    }));
  }
  return { categories };
}

export interface AllowlistResult {
  digest: Digest;
  /** Items dropped because their URL was not in the candidate set (or duplicated). */
  dropped: Array<{ title: string; url: string; reason: 'unknown-url' | 'duplicate' }>;
  kept: number;
}

/**
 * Anti-hallucination gate (section 4, "Step 6"): keep only items whose URL was
 * actually fetched, and only once across the whole digest.
 */
export function enforceUrlAllowlist(
  raw: RawDigest,
  candidates: CandidateItem[],
  now: Date = new Date(),
): AllowlistResult {
  const allowlist = new Map<string, CandidateItem>();
  for (const candidate of candidates) {
    const canonical = canonicalizeUrl(candidate.url);
    if (canonical && !allowlist.has(canonical)) allowlist.set(canonical, candidate);
  }

  const used = new Set<string>();
  const dropped: AllowlistResult['dropped'] = [];
  const categories = {} as Record<CategoryKey, DigestItem[]>;
  let kept = 0;

  for (const key of CATEGORIES) {
    const items: DigestItem[] = [];
    for (const item of raw.categories[key] ?? []) {
      const canonical = canonicalizeUrl(item.url);
      if (!canonical || !allowlist.has(canonical)) {
        dropped.push({ title: item.title, url: item.url, reason: 'unknown-url' });
        continue;
      }
      if (used.has(canonical)) {
        dropped.push({ title: item.title, url: item.url, reason: 'duplicate' });
        continue;
      }
      used.add(canonical);

      const source = allowlist.get(canonical);
      items.push({
        title: truncate(item.title, 160),
        summary: truncate(item.summary, 320),
        // Emit the canonical candidate URL so every link is one we really fetched.
        url: canonical,
        source: collapseWhitespace(item.source) || source?.source || 'unknown',
      });
      kept += 1;
    }
    categories[key] = items;
  }

  return { digest: { generatedAt: now.toISOString(), categories }, dropped, kept };
}

/** Total items across all categories. */
export function countDigestItems(digest: Digest): number {
  return CATEGORIES.reduce((total, key) => total + (digest.categories[key]?.length ?? 0), 0);
}

/** An empty digest (used when nothing qualifies, or when there is no input). */
export function createEmptyDigest(now: Date = new Date()): Digest {
  const categories = {} as Record<CategoryKey, DigestItem[]>;
  for (const key of CATEGORIES) categories[key] = [];
  return { generatedAt: now.toISOString(), categories };
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
  usage?: { total_tokens?: number } | null;
  error?: { message?: string } | null;
}

export interface ChatCompletionResult {
  content: string;
  totalTokens?: number;
}

/**
 * POST to `${baseUrl}/chat/completions`. `jsonMode` requests the provider's
 * structured-output mode; providers that do not support it are retried without.
 */
export async function callChatCompletions(
  config: LlmConfig,
  messages: ChatMessage[],
  options: { jsonMode?: boolean } = {},
): Promise<ChatCompletionResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.2,
    max_tokens: config.maxOutputTokens ?? 2500,
  };
  if (options.jsonMode !== false) body.response_format = { type: 'json_object' };

  const response = await request(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    timeoutMs: config.timeoutMs,
    retries: 1,
    accept: 'application/json',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  let payload: ChatCompletionResponse;
  try {
    payload = JSON.parse(response.text) as ChatCompletionResponse;
  } catch (error) {
    throw new LlmResponseError(`Chat completions response was not JSON: ${(error as Error).message}`, response.text);
  }

  if (payload.error?.message) {
    throw new LlmResponseError(`LLM provider error: ${payload.error.message}`, response.text);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new LlmResponseError('LLM response contained no message content', response.text);
  }

  return { content, totalTokens: payload.usage?.total_tokens };
}

const REPAIR_INSTRUCTION =
  'Your previous reply could not be parsed. Reply again with JSON only — no prose, no markdown code fences — ' +
  'matching the required shape exactly.';

export interface GenerateDigestOptions {
  now?: Date;
  log?: Logger;
}

export interface GenerateDigestResult {
  digest: Digest;
  dropped: AllowlistResult['dropped'];
  /** Items that survived the URL allowlist. */
  kept: number;
  /** How many candidates were actually put in the prompt. */
  promptCandidateCount: number;
  attempts: number;
  totalTokens?: number;
}

/**
 * Full LLM stage: prompt -> call -> validate -> URL allowlist.
 *
 * Malformed output is retried once (without structured-output mode, which also
 * covers providers that reject `response_format`); a second failure throws so
 * the run fails loudly in Actions instead of silently posting nothing.
 */
export async function generateDigest(
  candidates: CandidateItem[],
  config: LlmConfig,
  options: GenerateDigestOptions = {},
): Promise<GenerateDigestResult> {
  const now = options.now ?? new Date();
  const capped = candidates.slice(0, config.maxCandidates);
  if (capped.length === 0) {
    return {
      digest: createEmptyDigest(now),
      dropped: [],
      kept: 0,
      promptCandidateCount: 0,
      attempts: 0,
    };
  }

  const messages = buildMessages(capped);
  let raw: RawDigest | undefined;
  let attempts = 0;
  let totalTokens: number | undefined;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= 2 && !raw; attempt += 1) {
    attempts = attempt;
    const conversation: ChatMessage[] =
      attempt === 1 ? messages : [...messages, { role: 'user', content: REPAIR_INSTRUCTION }];

    try {
      const completion = await callChatCompletions(config, conversation, { jsonMode: attempt === 1 });
      totalTokens = completion.totalTokens ?? totalTokens;
      raw = parseRawDigest(completion.content);
    } catch (error) {
      lastError = error as Error;
      const retryable =
        error instanceof LlmResponseError || (error instanceof HttpError && (error.status === 400 || error.status === 404));
      if (!retryable) throw error;
      options.log?.warn(`LLM attempt ${attempt} of 2 failed: ${lastError.message}`);
    }
  }

  if (!raw) {
    throw lastError instanceof LlmResponseError
      ? lastError
      : new LlmResponseError(lastError?.message ?? 'LLM digest generation failed');
  }

  const { digest, dropped, kept } = enforceUrlAllowlist(raw, capped, now);
  const unknownUrls = dropped.filter((entry) => entry.reason === 'unknown-url').length;
  if (unknownUrls > 0) {
    options.log?.warn(`URL allowlist rejected ${unknownUrls} item(s) the model invented or rewrote`);
  }
  options.log?.info(
    `LLM kept ${kept} of ${capped.length} candidates (attempts: ${attempts}${totalTokens ? `, tokens: ${totalTokens}` : ''})`,
  );

  return { digest, dropped, kept, promptCandidateCount: capped.length, attempts, totalTokens };
}
