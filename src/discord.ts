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

/** One line of an embed card: the item title (name) and its summary (value). */
export interface DiscordEmbedField {
  name: string;
  value: string;
}

/** A rich card. Discord renders up to 10 per message and 6000 characters in total. */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  /** Accent colour as `0xRRGGBB`; this is the coloured bar that groups a section. */
  color?: number;
  fields?: DiscordEmbedField[];
}

/**
 * One webhook post. `content` is optional because continuation messages carry
 * embeds only — that is what keeps a split digest from repeating its header.
 */
export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
}

export interface DiscordPayload {
  content?: string;
  embeds?: DiscordEmbed[];
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

/** Strip empty fields so Discord never sees `content: undefined` or `embeds: []`. */
export function toDiscordPayload(message: DiscordMessage): DiscordPayload {
  return {
    ...(message.content ? { content: message.content } : {}),
    ...(message.embeds && message.embeds.length > 0 ? { embeds: message.embeds } : {}),
    allowed_mentions: { parse: [] },
  };
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
  messages: DiscordMessage[],
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

  for (const [index, message] of messages.entries()) {
    const payload = toDiscordPayload(message);

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
      const cards = payload.embeds?.length ?? 0;
      options.log?.debug(
        `posted Discord message ${index + 1}/${messages.length} ` +
          `(${response.status}, ${cards} embed(s))`,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw new Error(
          `Discord rejected message ${index + 1}/${messages.length}: ${error.status} ${error.body ?? ''}`.trim(),
        );
      }
      throw error;
    }

    if (index < messages.length - 1) await sleep(delayMs);
  }

  options.log?.info(`posted ${statuses.length} message(s) to Discord`);
  return { sent: statuses.length, statuses };
}
