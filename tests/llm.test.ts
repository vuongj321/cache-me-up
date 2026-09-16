import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNotTruncated,
  buildCandidatePayload,
  buildMessages,
  enforceUrlAllowlist,
  extractJson,
  generateDigest,
  isTruncated,
  LlmResponseError,
  LlmTruncationError,
  parseRawDigest,
  type LlmConfig,
} from '../src/llm';
import { CATEGORIES, type CandidateItem, type RawDigest } from '../src/types';

const NOW = new Date('2026-09-16T11:00:00.000Z');

function candidate(n: number, overrides: Partial<CandidateItem> = {}): CandidateItem {
  return {
    id: `id-${n}`,
    title: `Candidate ${n}`,
    url: `https://example.com/${n}`,
    source: `Feed ${n}`,
    publishedAt: '2026-09-16T09:00:00.000Z',
    ...overrides,
  };
}

test('extractJson accepts fenced, prose-wrapped and bare JSON', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":1} — hope that helps'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('{"a":"line\nbreak"}'), { a: 'line\nbreak' }, 'raw newlines are repaired');
  assert.throws(() => extractJson('I cannot help with that.'), /not valid JSON/);
  assert.throws(() => extractJson(''), /empty response/);
});

test('parseRawDigest normalizes strings and fills in every category', () => {
  const raw = parseRawDigest(
    '{"categories":{"new_models":[{"title":"  Spaced  ","summary":" Line\nbreak ","url":" https://example.com/1 ","source":" Model Co "}]}}',
  );

  for (const key of CATEGORIES) {
    assert.ok(Array.isArray(raw.categories[key]), `missing category ${key}`);
  }
  assert.equal(raw.categories.new_models.length, 1);
  assert.equal(raw.categories.new_models[0]?.title, 'Spaced');
  assert.equal(raw.categories.new_models[0]?.summary, 'Line break');
  assert.equal(raw.categories.new_models[0]?.url, 'https://example.com/1');
  assert.equal(raw.categories.cool_builds.length, 0);
});

test('parseRawDigest rejects responses that do not match the schema', () => {
  assert.throws(() => parseRawDigest('{"items":[]}'), /did not match the digest schema/);
  assert.throws(() => parseRawDigest('{"categories":{"new_models":[{"title":"","summary":"s","url":"u"}]}}'), /schema/);
});

test('enforceUrlAllowlist drops invented and duplicated URLs', () => {
  const raw: RawDigest = {
    categories: {
      new_models: [
        { title: 'Real', summary: 'Kept.', url: 'https://example.com/1', source: 'Feed 1' },
        { title: 'Invented', summary: 'Dropped.', url: 'https://evil.example.com/9', source: 'Made up' },
      ],
      project_inspiration: [
        { title: 'Duplicate', summary: 'Same story.', url: 'https://example.com/1?utm_source=llm', source: 'Feed 1' },
      ],
      concepts: [],
      cool_builds: [],
    },
  };

  const result = enforceUrlAllowlist(raw, [candidate(1), candidate(2)], NOW);

  assert.equal(result.kept, 1);
  assert.deepEqual(
    result.dropped.map((entry) => entry.reason),
    ['unknown-url', 'duplicate'],
  );
  assert.equal(result.digest.categories.new_models[0]?.url, 'https://example.com/1');
  assert.equal(result.digest.categories.project_inspiration.length, 0);
  assert.equal(result.digest.generatedAt, NOW.toISOString());
});

test('enforceUrlAllowlist falls back to the fetched source name', () => {
  const raw: RawDigest = {
    categories: {
      new_models: [{ title: 'Real', summary: 'Kept.', url: 'https://example.com/1', source: '' }],
      project_inspiration: [],
      concepts: [],
      cool_builds: [],
    },
  };

  const result = enforceUrlAllowlist(raw, [candidate(1)], NOW);
  assert.equal(result.digest.categories.new_models[0]?.source, 'Feed 1');
});

const LLM_CONFIG: LlmConfig = {
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://llm.example.com/v1',
  timeoutMs: 5000,
  maxCandidates: 50,
  maxOutputTokens: 6000,
};

/** The reply shape from the truncated run: valid JSON right up to the cut. */
const TRUNCATED_REPLY =
  '{"categories":{"new_models":[{"title":"Introducing Gemini 3.8 Live and 3.8 Live Extended Thinking","summary":"Google Deep';

function completionBody(content: string, finishReason = 'stop'): string {
  return JSON.stringify({
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
    usage: { total_tokens: 100, completion_tokens: 60 },
  });
}

/** Run `call` with `globalThis.fetch` replaced by a canned chat-completions responder. */
async function withStubbedCompletions<T>(
  respond: () => string,
  call: () => Promise<T>,
): Promise<{ calls: number; value?: T; error?: unknown }> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(respond(), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    // `calls` must be read *after* the awaited call, not before.
    const value = await call();
    return { calls, value };
  } catch (error) {
    return { calls, error };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('isTruncated recognizes the finish reasons that mean "ran out of room"', () => {
  assert.equal(isTruncated('length'), true);
  assert.equal(isTruncated('max_tokens'), true, 'several OpenAI-compatible providers report it this way');
  assert.equal(isTruncated('stop'), false);
  assert.equal(isTruncated(undefined), false);
});

test('assertNotTruncated describes a cut-off reply with its size, cap and tail', () => {
  assert.doesNotThrow(() => assertNotTruncated('{"categories":{}}', 'stop', 6000));

  assert.throws(
    () => assertNotTruncated(TRUNCATED_REPLY, 'length', 6000),
    (error: unknown) => {
      assert.ok(error instanceof LlmTruncationError, 'expected a dedicated truncation error');
      assert.match(error.message, /truncated after \d+ chars/);
      assert.match(error.message, /max_tokens=6000/);
      assert.match(error.message, /LLM_MAX_OUTPUT_TOKENS/);
      assert.match(error.message, /Tail: .*Google Deep/, 'the tail is what reveals the cut-off');
      return true;
    },
  );
});

test('generateDigest fails fast on a truncated reply instead of replaying the prompt', async () => {
  const { calls, error } = await withStubbedCompletions(
    () => completionBody(TRUNCATED_REPLY, 'length'),
    () => generateDigest([candidate(1)], LLM_CONFIG, { now: NOW }),
  );

  assert.ok(error instanceof LlmTruncationError, `expected LlmTruncationError, got ${String(error)}`);
  assert.equal(calls, 1, 'retrying the same prompt would be cut off in the same place');
});

test('generateDigest still retries a complete but malformed reply once', async () => {
  const { calls, error } = await withStubbedCompletions(
    () => completionBody('I cannot help with that.'),
    () => generateDigest([candidate(1)], LLM_CONFIG, { now: NOW }),
  );

  assert.ok(error instanceof LlmResponseError);
  assert.ok(!(error instanceof LlmTruncationError), 'a complete reply is a formatting problem, not a truncation');
  assert.match(error.message, /not valid JSON/);
  assert.match(error.message, /last 200:/);
  assert.equal(calls, 2, 'the repair attempt is still made');
});

test('generateDigest accepts a complete reply and keeps the allowlisted URL', async () => {
  const reply = JSON.stringify({
    categories: {
      new_models: [{ title: 'Real', summary: 'Kept.', url: 'https://example.com/1', source: 'Feed 1' }],
    },
  });

  const { calls, value } = await withStubbedCompletions(
    () => completionBody(reply),
    () => generateDigest([candidate(1)], LLM_CONFIG, { now: NOW }),
  );

  assert.equal(calls, 1);
  assert.equal(value?.kept, 1);
  assert.equal(value?.attempts, 1);
  assert.equal(value?.totalTokens, 100);
  assert.equal(value?.digest.categories.new_models[0]?.url, 'https://example.com/1');
});

test('buildMessages carries the categories, the rules and the exact URLs', () => {
  const messages = buildMessages([candidate(1)]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'system');

  const system = messages[0]?.content ?? '';
  const user = messages[1]?.content ?? '';
  assert.match(system, /never invent/i);
  assert.match(system, /new_models/);
  assert.match(user, /https:\/\/example\.com\/1/);
  assert.match(user, /project_inspiration/);
});

test('buildCandidatePayload drops engagement signals and caps field lengths', () => {
  const payload = buildCandidatePayload([candidate(1, { signals: { points: 999 }, snippet: 'y'.repeat(600) })]);

  assert.equal(payload.length, 1);
  assert.ok(!('signals' in (payload[0] as object)), 'signals must not be sent to the model');
  assert.ok((payload[0]?.snippet?.length ?? 0) <= 300);
  assert.equal(payload[0]?.url, 'https://example.com/1');
});
