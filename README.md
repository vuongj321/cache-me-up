# cache-me-up — Daily Tech Digest

An automated daily digest of tech/AI news that lands in a Discord channel every morning.

It **fetches** recent items from a curated set of RSS feeds and APIs, **filters and
categorizes** them with an LLM into four reader-friendly sections, **formats** the
result as one Discord message, and **posts** it via a webhook — all on a GitHub
Actions schedule, with no server to run.

> New to cron jobs, webhooks or the overall design? Read
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first — it explains every external
> concept from scratch.

**The four sections** (each targets ~3–5 items; empty sections are simply omitted):

| Section | Purpose |
| --- | --- |
| **New AI models** | Recently released or newly notable models |
| **Project inspiration** | Ideas worth building / things that spark a side project |
| **AI / programming concepts** | Papers, explainers, techniques |
| **Cool builds** | Impressive projects and tools people have shipped |

## How it works

```
GitHub Actions cron ─► fetch feeds/APIs ─► dedupe vs. seen cache ─► pre-rank & cap
      ─► LLM filter + categorize + summarize ─► URL allowlist check
      ─► format markdown ─► Discord webhook POST
```

| Stage | Code | Notes |
| --- | --- | --- |
| Fetch | `src/fetchers/*.ts` | One adapter per source type, all normalized to `CandidateItem` |
| Dedupe | `src/dedupe.ts` | `data/seen.json`, persisted between runs with `actions/cache` |
| Pre-rank | `src/rank.ts` | Recency + engagement + keyword boosts, capped at `maxCandidates` |
| LLM | `src/llm.ts` | Strict JSON via any OpenAI-compatible chat-completions endpoint |
| Validate | `src/llm.ts` | Any URL the model invented/wrote is dropped |
| Format | `src/format.ts` | Markdown, split to respect Discord's 2000-char limit |
| Post | `src/discord.ts` | Sequential webhook POSTs with retry/backoff |

## Quick start (local)

```bash
# 1. Node 20+ required
node --version

# 2. Install dependencies
npm install

# 3. Configure secrets
cp .env.example .env        # Windows: copy .env.example .env
#   then edit .env: OPENAI_API_KEY, DISCORD_WEBHOOK_URL

# 4. Validate fetching/ranking without any keys (prints the ranked candidates)
npm run digest:dry -- --print-candidates

# 5. Full pipeline, but print the digest instead of posting it
npm run digest:dry

# 6. Real run: posts to Discord and updates data/seen.json
npm run digest
```

`npm run digest -- --help` lists every CLI flag.

## Configuration

### Sources — `config/sources.json`

Adding or removing a feed is a **config change, not a code change**. Each entry:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable identifier (must be unique); used in logs |
| `name` | yes | Human label shown as the item's source in Discord |
| `kind` | yes | Which fetcher to use (see below) |
| `url` | depends | Endpoint/feed URL (required for `rss`; optional override elsewhere) |
| `tags` | depends | HN tags (`story`, `show_hn`) or arXiv categories (`cs.AI`, `cs.LG`, …) |
| `interest` | no | Weak ranking hint for one of the four categories |
| `enabled` | no | Set `false` to keep an entry but skip it |
| `limit` | no | Max items this source may contribute |
| `minPoints` | no | `hackernews` only — minimum HN score |
| `minStars` | no | `github-search` only — minimum star count |
| `query` | no | `github-search` only — replace the default search query |

Source kinds:

| `kind` | What it does |
| --- | --- |
| `rss` | RSS 2.0 / Atom / RSS 1.0 feed (lab blogs, Lobsters, Reddit, …) |
| `hackernews` | HN Algolia API — `["story"]` for the front page, `["show_hn"]` for Show HN |
| `arxiv` | Newest submissions in the given categories (served as Atom) |
| `huggingface` | Hugging Face Hub models, merging newest + trending |
| `github-trending` | Scrapes `github.com/trending?since=daily` (no API exists) |
| `github-search` | Official API for repos created recently with lots of stars |

Top-level settings (env vars act as fallbacks when omitted):

```json
{
  "lookbackHours": 36,      // ignore items older than this
  "maxCandidates": 30,      // hard cap on what the LLM sees
  "maxItemsPerSource": 12   // diversification cap so one feed can't dominate
}
```

Notes on the shipped defaults:

- **Reddit feeds ship disabled.** Reddit aggressively rate-limits (HTTP 429) shared
  and datacenter IPs, including GitHub runners. Flip `"enabled": true` on
  `reddit-*` if you want to try them; a failure there is isolated and non-fatal.
- **Anthropic publishes no public RSS feed**, so it is not in the defaults.
  Google DeepMind, Google AI, Meta AI, OpenAI and the Hugging Face blog are.
- A failed source is logged and skipped; the rest of the run continues.

### Environment variables

Copy `.env.example` to `.env` for local runs, or use GitHub secrets (below).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | **yes** | — | Authenticates the chat-completions call |
| `DISCORD_WEBHOOK_URL` | **yes** | — | Where the digest is posted |
| `OPENAI_MODEL` | no | `gpt-4o-mini` | Model name |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Any OpenAI-compatible provider |
| `LOOKBACK_HOURS` | no | `36` | Freshness window |
| `MAX_CANDIDATES` | no | `30` | LLM input cap |
| `MAX_ITEMS_PER_SOURCE` | no | `12` | Per-source diversification cap |
| `SEEN_STORE_PATH` | no | `data/seen.json` | Dedupe cache location |
| `SEEN_WINDOW_DAYS` | no | `5` | How long a delivered item stays suppressed |
| `CONSIDERED_WINDOW_DAYS` | no | `2` | How long an LLM-reviewed item stays suppressed |
| `DIGEST_POST_EMPTY` | no | `false` | Post a "nothing new" note instead of staying silent |
| `FETCH_TIMEOUT_MS` | no | `20000` | Per-request HTTP timeout |
| `LLM_MAX_OUTPUT_TOKENS` | no | `6000` | Most tokens the model may write; a reply cut off by this fails the run |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `GITHUB_TOKEN` | no | — | Raises the GitHub search API rate limit |

## Deploying with GitHub Actions

`.github/workflows/daily-digest.yml` runs on a schedule and on demand.

**1. Create a Discord webhook**

Discord → your channel → **Edit Channel → Integrations → Webhooks → New Webhook**
→ **Copy Webhook URL**. Treat that URL as a password: anyone holding it can post
to the channel.

**2. Get an LLM API key** from OpenAI (or any OpenAI-compatible provider).

**3. Add repository secrets** — Settings → Secrets and variables → Actions:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `OPENAI_API_KEY` | your key |
| Secret | `DISCORD_WEBHOOK_URL` | the webhook URL |
| Variable | `OPENAI_MODEL` *(optional)* | e.g. `gpt-4o-mini` |
| Variable | `OPENAI_BASE_URL` *(optional)* | e.g. `https://api.openai.com/v1` |

**4. Enable Actions** on the repository (Actions tab) and run once manually via
**Run workflow** — with *dry run* ticked first if you want to see the output
without posting.

**Schedule:** `cron: '0 11 * * *'` → 11:00 UTC, which is **5:00 AM CST**. GitHub
runs schedules in UTC and does not guarantee the exact minute (delays of minutes
to an hour happen under load). During Central Daylight Time (roughly March–November)
11:00 UTC is 6:00 AM local; change the cron to `0 10 * * *` if you want 5:00 AM
wall-clock time year-round.

**Dedupe cache:** runners are ephemeral, so `data/seen.json` is restored at the
start of each run and saved at the end via `actions/cache`. Every run writes a new
cache key and `restore-keys` picks up the newest previous one, which is what makes
the seen list "a few days long" rather than permanent.

## Local development

| Command | What it does |
| --- | --- |
| `npm run digest` | Full run: fetch → dedupe → rank → LLM → post → save cache |
| `npm run digest:dry` | Same pipeline, prints the messages, posts nothing, writes no cache |
| `npm run digest:dry -- --print-candidates` | Also logs every ranked candidate |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Node's built-in runner via `tsx`) |
| `npm run test:all` | Typecheck + tests |
| `npm run build` | Emit compiled JS to `dist/` |

Without `OPENAI_API_KEY`, a dry run stops after pre-ranking — that is enough to
validate every fetcher, the dedupe cache and the ranking.

### Project layout

```
cache-me-up/
  config/sources.json          # declarative source list (no code needed to change feeds)
  src/
    index.ts                   # CLI: fetch → dedupe → rank → LLM → format → post
    fetchers/                  # per-source adapters + shared HTTP helper
    types.ts                   # shared data shapes (CandidateItem, Digest, ...)
    config.ts                  # env + sources.json loading/validation
    dedupe.ts                  # rolling seen-ID cache
    rank.ts                    # pre-ranking + capping
    llm.ts                     # prompt, chat call, JSON validation, URL allowlist
    format.ts                  # Digest -> Discord markdown (+ 2000-char splitting)
    discord.ts                 # webhook POST
    util.ts / log.ts           # small shared helpers
  tests/                       # unit tests (no network access required)
  .github/workflows/ci.yml             # typecheck + tests on push/PR
  .github/workflows/daily-digest.yml   # the daily cron
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Missing required environment variable(s)` | Set the secret locally in `.env` or in Actions secrets |
| A source logs `failed: ... 429` | Rate limited (Reddit, mainly). It is skipped; disable it in `config/sources.json` if it is persistent |
| `github-trending` parsed 0 repositories | GitHub changed its markup; the `github-search` source still covers new repos |
| `LLM response was not valid JSON` / `did not match the digest schema` | The call is retried once without structured-output mode, then the run fails loudly so you see it in Actions. The message shows the reply's length plus its first **and last** 200 characters, so an incomplete trailing brace is visible |
| `LLM output was truncated ... hit max_tokens=` | The model ran out of output budget mid-reply, so the JSON has no closing braces and cannot be parsed. Not retried (the same prompt truncates in the same place). Raise `LLM_MAX_OUTPUT_TOKENS` or lower `MAX_CANDIDATES` |
| Nothing was posted | The digest was empty after filtering (default = stay silent). Set `DIGEST_POST_EMPTY=true` for a "nothing new" note |
| Links look short/rewritten | Not possible: any URL that was not in the fetched candidate set is dropped by the allowlist |
| Digest arrives in several messages | Working as intended — Discord caps messages at 2000 characters |

## Costs and limits

- One LLM request per day, carrying at most `maxCandidates` (30) short items —
  typically a fraction of a cent with a small model.
- Everything else is free: GitHub Actions minutes (well within the free tier),
  public feeds/APIs, and a Discord webhook.
- Set `LOG_LEVEL=debug` (or dispatch the workflow with `log_level: debug`) to see
  per-source item counts.

## Out of scope (v1)

A Discord bot, a web UI, email delivery, multi-channel routing, personalization
ML, and open-ended agentic web search. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §11.
