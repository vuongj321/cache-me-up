/**
 * CLI entry point — the orchestrator that wires the stages together in order:
 *
 *   fetch -> dedupe -> pre-rank -> LLM -> URL allowlist -> format -> post
 *   (docs/ARCHITECTURE.md section 4 and section 12)
 *
 * Usage:
 *   npm run digest                     # full run (requires OPENAI_API_KEY + DISCORD_WEBHOOK_URL)
 *   npm run digest -- --dry-run        # run + print the messages, post nothing, write no cache
 *   npm run digest -- --print-candidates   # also dump the ranked candidate list
 *   npm run digest -- --help
 */

import { assertSecrets, loadEnv, loadSources } from './config';
import { filterUnseen, loadSeenStore, markSeen, saveSeenStore, seenKey, type SeenStore } from './dedupe';
import { isValidWebhookUrl, maskWebhookUrl, postToDiscord } from './discord';
import { createFetchContext, fetchAllSources } from './fetchers';
import { formatDigestMessages, formatNothingNew, messagesToPlainText } from './format';
import { countDigestItems, generateDigest, type LlmConfig } from './llm';
import { createLogger, type Logger } from './log';
import { rankAndCap } from './rank';
import { CATEGORY_DEFINITIONS } from './types';

export interface CliOptions {
  dryRun: boolean;
  printCandidates: boolean;
  help: boolean;
}

const USAGE = [
  'Daily Tech Digest',
  '',
  'Usage: npm run digest [-- options]',
  '',
  'Options:',
  '  --dry-run             Run the whole pipeline but print the digest instead of posting',
  '                        it, and do not write the seen cache.',
  '  --print-candidates    Log every ranked candidate that would be sent to the LLM.',
  '  --help, -h            Show this message.',
  '',
  'Required environment variables (see .env.example):',
  '  OPENAI_API_KEY        Chat-completions API key.',
  '  DISCORD_WEBHOOK_URL   Channel webhook used to post the digest.',
].join('\n');

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, printCandidates: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n' || arg === '--no-post') options.dryRun = true;
    else if (arg === '--print-candidates' || arg === '--verbose-candidates') options.printCandidates = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}


function persistSeen(store: SeenStore, filePath: string, log: Logger): void {
  saveSeenStore(filePath, store);
  log.debug(`seen cache written: ${filePath} (${Object.keys(store.entries).length} entries)`);
}

/** Execute one digest run. Returns the process exit code. */
export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const env = loadEnv();
  const log = createLogger(env.logLevel);
  const startedAt = new Date();

  const { settings, sources, disabled } = loadSources();
  const lookbackHours = settings.lookbackHours ?? env.lookbackHours;
  const maxCandidates = settings.maxCandidates ?? env.maxCandidates;
  const maxItemsPerSource = settings.maxItemsPerSource ?? env.maxItemsPerSource;

  log.info(
    `starting run — ${sources.length} source(s) enabled, ${disabled.length} disabled, ` +
      `lookback ${lookbackHours}h, max ${maxCandidates} candidates, max_tokens ${env.llmMaxOutputTokens}` +
      `${options.dryRun ? ' (dry run)' : ''}`,
  );

  // Step 2: fetch every enabled source (failures are isolated per source).
  const ctx = createFetchContext({
    now: startedAt,
    lookbackHours,
    timeoutMs: env.fetchTimeoutMs,
    githubToken: env.githubToken,
    log,
  });
  const fetched = await fetchAllSources(sources, ctx);
  log.info(
    `fetched ${fetched.items.length} candidate(s) — ${fetched.outcomes.length}/${sources.length} source(s) responded, ` +
      `${fetched.errors.length} failed`,
  );

  // Step 3: dedupe against the rolling seen cache.
  const store = loadSeenStore(env.seenStorePath);
  const dedupeWindow = { now: startedAt, deliveredDays: env.seenWindowDays, consideredDays: env.consideredWindowDays };
  const { fresh, skipped, store: prunedStore, batchKeys } = filterUnseen(fetched.items, store, dedupeWindow);
  log.info(`dedupe: ${fresh.length} unseen item(s), ${skipped} suppressed by ${env.seenStorePath}`);

  // Step 4: pre-rank + cap.
  const ranked = rankAndCap(fresh, { now: startedAt, lookbackHours, maxCandidates, maxItemsPerSource });
  log.info(`pre-rank: sending ${ranked.length} of ${fresh.length} candidate(s) to the LLM`);
  if (options.printCandidates) {
    for (const item of ranked) {
      log.info(`  score=${item.score.toFixed(1)} [${item.source}] ${item.title} :: ${item.url}`);
    }
  }

  if (ranked.length === 0) {
    log.info('nothing new today — skipping the post');
    if (!options.dryRun) {
      persistSeen(markSeen(prunedStore, batchKeys, { now: startedAt, delivered: false }), env.seenStorePath, log);
    }
    return 0;
  }

  // Without a key the dry run still validates fetching, dedupe and ranking.
  if (options.dryRun && !env.openaiApiKey) {
    log.warn('OPENAI_API_KEY is not set — stopping after pre-rank (fetchers, dedupe and ranking were exercised).');
    return 0;
  }

  assertSecrets(env, { llm: true, discord: !options.dryRun });
  if (!options.dryRun && !isValidWebhookUrl(env.discordWebhookUrl)) {
    throw new Error(
      'DISCORD_WEBHOOK_URL is not a Discord webhook URL (expected https://discord.com/api/webhooks/<id>/<token>).',
    );
  }

  // Steps 5 + 6: LLM filter/categorize/summarize, then the URL allowlist.
  const llmConfig: LlmConfig = {
    apiKey: env.openaiApiKey as string,
    model: env.openaiModel,
    baseUrl: env.openaiBaseUrl,
    timeoutMs: env.llmTimeoutMs,
    maxCandidates,
    maxOutputTokens: env.llmMaxOutputTokens,
  };
  const { digest, dropped } = await generateDigest(ranked, llmConfig, { now: startedAt, log });

  // Ranked items are recorded as "considered" so they are not re-sent to the
  // LLM every run while still being allowed to resurface after a couple of days.
  const consideredStore = markSeen(prunedStore, batchKeys, { now: startedAt, delivered: false });

  // Step 7: format. An empty digest is skipped by default to reduce noise.
  const itemCount = countDigestItems(digest);
  if (itemCount === 0) {
    if (env.postEmptyDigest) {
      const note = formatNothingNew(startedAt);
      if (options.dryRun) {
        log.info('dry run — would post the "nothing new" note:');
        console.log(messagesToPlainText(note));
      } else {
        await postToDiscord(env.discordWebhookUrl as string, note, { log, timeoutMs: env.fetchTimeoutMs });
      }
    } else {
      log.info('digest is empty after filtering — skipping the post (set DIGEST_POST_EMPTY=true to post a note)');
    }
    if (!options.dryRun) persistSeen(consideredStore, env.seenStorePath, log);
    return 0;
  }

  const messages = formatDigestMessages(digest, { date: startedAt });
  const cardCount = messages.reduce((total, message) => total + (message.embeds?.length ?? 0), 0);
  log.info(
    `digest built: ${itemCount} item(s) in ${messages.length} message(s) / ${cardCount} section card(s); ` +
      `URL allowlist dropped ${dropped.length} item(s)`,
  );

  if (options.dryRun) {
    log.info('dry run — Discord message(s) follow');
    console.log(messagesToPlainText(messages));
    log.info('dry run complete — nothing posted, seen cache unchanged');
    return 0;
  }

  // Step 8: post, then persist what was delivered.
  log.info(`posting to ${maskWebhookUrl(env.discordWebhookUrl as string)}`);
  await postToDiscord(env.discordWebhookUrl as string, messages, { log, timeoutMs: env.fetchTimeoutMs });

  const deliveredKeys = CATEGORY_DEFINITIONS.flatMap((definition) =>
    (digest.categories[definition.key] ?? []).map((item) => seenKey({ url: item.url, id: item.url })),
  );
  const updatedStore = markSeen(consideredStore, deliveredKeys, { now: startedAt, delivered: true });
  persistSeen(updatedStore, env.seenStorePath, log);

  log.info(
    `run complete: ${deliveredKeys.length} delivered, ${skipped} suppressed, ${fetched.errors.length} source failure(s)`,
  );
  return 0;
}

/** Process-level wrapper: turns thrown errors into a non-zero exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const code = await run(argv);
    process.exitCode = code;
    return code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FATAL] ${message}`);
    if (process.env.LOG_LEVEL === 'debug' && error instanceof Error) console.error(error.stack);
    process.exitCode = 1;
    return 1;
  }
}

if (require.main === module) {
  void main();
}
