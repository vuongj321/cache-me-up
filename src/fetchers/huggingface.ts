/**
 * Hugging Face Hub adapter — the primary "New AI models" source.
 *
 * Two API calls are merged: the newest checkpoints (`sort=createdAt`) and the
 * currently trending ones (`sort=trendingScore`), so the LLM sees both
 * "brand new" and "everyone is talking about it" models.
 */

import type { CandidateItem, SourceConfig } from '../types';
import { truncate } from '../util';
import type { FetchContext } from './context';
import { fetchJson } from './http';

export const HF_MODELS_ENDPOINT = 'https://huggingface.co/api/models';
export const HF_MODEL_PAGE = 'https://huggingface.co/';

const NOISE_TAGS = new Set(['region:us', 'endpoints_compatible', 'eval-results', 'private', 'custom_code']);

interface HfModel {
  id?: string;
  modelId?: string;
  createdAt?: string;
  likes?: number;
  downloads?: number;
  trendingScore?: number;
  pipeline_tag?: string;
  library_name?: string;
  tags?: string[];
  private?: boolean;
}

function hasSignal(model: HfModel): boolean {
  return (model.likes ?? 0) >= 1 || (model.downloads ?? 0) >= 50 || (model.trendingScore ?? 0) > 0;
}

function describe(model: HfModel): string {
  const kind = [model.pipeline_tag, model.library_name].filter((value): value is string => Boolean(value)).join(' · ');
  const topical = (model.tags ?? [])
    .filter((tag) => !NOISE_TAGS.has(tag))
    .filter((tag) => !tag.startsWith('license:') && !tag.startsWith('base_model'))
    .slice(0, 4)
    .join(', ');
  const popularity = `${model.likes ?? 0} likes · ${model.downloads ?? 0} downloads`;
  return truncate([kind, topical, popularity].filter(Boolean).join(' — '), 240);
}

/** Map HF model records onto `CandidateItem`s. Exported for tests. */
export function mapModels(models: HfModel[], source: SourceConfig, ctx: FetchContext): CandidateItem[] {
  const items: CandidateItem[] = [];
  for (const model of models) {
    const modelId = model.id ?? model.modelId;
    if (!modelId || model.private === true || !hasSignal(model)) continue;

    items.push({
      id: `hf:${modelId}`,
      title: truncate(modelId, 200),
      url: `${HF_MODEL_PAGE}${modelId}`,
      source: source.name,
      publishedAt: model.createdAt ?? ctx.now.toISOString(),
      snippet: describe(model),
      signals: {
        likes: model.likes ?? 0,
        downloads: model.downloads ?? 0,
        trendingScore: model.trendingScore ?? 0,
      },
      interest: source.interest,
    });
  }
  return items;
}

function dedupeById(items: CandidateItem[]): CandidateItem[] {
  const seen = new Set<string>();
  const result: CandidateItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export async function fetchHuggingFaceSource(source: SourceConfig, ctx: FetchContext): Promise<CandidateItem[]> {
  const endpoint = source.url ?? HF_MODELS_ENDPOINT;
  const limit = source.limit ?? 15;
  const perCall = Math.min(Math.max(limit, 10), 50);
  const common = `limit=${perCall}&direction=-1&full=false`;

  const [newest, trending] = await Promise.all([
    fetchJson<HfModel[]>(`${endpoint}?sort=createdAt&${common}`, { timeoutMs: ctx.timeoutMs }),
    fetchJson<HfModel[]>(`${endpoint}?sort=trendingScore&${common}`, { timeoutMs: ctx.timeoutMs }),
  ]);

  const recent = mapModels(Array.isArray(newest) ? newest : [], source, ctx);
  const hot = mapModels(Array.isArray(trending) ? trending : [], source, ctx);
  const merged = dedupeById([...recent, ...hot]);

  ctx.log.debug(`huggingface("${source.id}") newest=${recent.length} trending=${hot.length}`);
  return merged.slice(0, limit * 2);
}
