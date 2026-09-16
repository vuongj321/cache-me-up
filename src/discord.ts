/**
 * Discord webhook client — docs/ARCHITECTURE.md section 4, "Step 8".
 *
 * A webhook is a one-way "post a message here" URL, so this module is
 * deliberately thin: build the JSON body, POST it, retry politely on 429/5xx.
 */

import { HttpError, request } from './fetchers/http';
import type { Logger } from './log';
import { sleep } from './util';

/** Accepts the standard, canary and PTB webhook hosts. */
export const WEBHOOK_URL_PATTERN =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;

export interface DiscordPayload {
  content: string;
  /** Never ping anyone, whatever the digest text contains. */
  allowed_mentions: { parse: string[] };
}

export function isValidWebhookUrl(url: string | undefined): url is string {
  return typeof url === 'string' && WEBHOOK_URL_PATTERN.test(url.trim());
}

/** Webhook URLs are secrets: only ever log the id, never the token. */
export function maskWebhookUrl(url: string): string {
  const match = /webhooks\/(\d+)\//.exec(url);
  return match?.[1] ? `https://discord.com/api/webhooks/${match[1]}/***` : 'https://discord.com/api/webhooks/***';
}

export function toDiscordPayload(content: string): DiscordPayload {
  return { content, allowed_mentions: { parse: [] } };
}

export interface PostOptions {
  timeoutMs?: number;
  /** Pause between messages so a long digest stays under the webhook rate limit. */
  delayMs?: number;
  retries?: number;
  log?: Logger;
}

export interface PostResult {
  sent: number;
  statuses: number[];
}

/** POST each message in order. Throws on the first message Discord rejects. */
export async function postToDiscord(
  webhookUrl: string,
  contents: string[],
  options: PostOptions = {},
): Promise<PostResult> {
  if (!isValidWebhookUrl(webhookUrl)) {
    throw new Error(
      'DISCORD_WEBHOOK_URL does not look like a Discord webhook URL ' +
        '(expected https://discord.com/api/webhooks/<id>/<token>).',
    );
  }

  const delayMs = options.delayMs ?? 1000;
  const statuses: number[] = [];

  for (const [index, content] of contents.entries()) {
    const payload = toDiscordPayload(content);

    try {
      const response = await request(webhookUrl, {
        method: 'POST',
        timeoutMs: options.timeoutMs ?? 20000,
        retries: options.retries ?? 2,
        accept: 'application/json',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      statuses.push(response.status);
      options.log?.debug(`posted Discord message ${index + 1}/${contents.length} (${response.status})`);
    } catch (error) {
      if (error instanceof HttpError) {
        throw new Error(`Discord rejected message ${index + 1}/${contents.length}: ${error.status} ${error.body ?? ''}`.trim());
      }
      throw error;
    }

    if (index < contents.length - 1) await sleep(delayMs);
  }

  options.log?.info(`posted ${statuses.length} message(s) to Discord`);
  return { sent: statuses.length, statuses };
}
