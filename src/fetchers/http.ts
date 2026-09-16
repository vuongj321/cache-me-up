/**
 * Thin HTTP layer on top of Node's global `fetch` (Node 20+).
 *
 * Adds three things the upstream sources need:
 *  - a timeout, so a hung feed cannot stall the whole run,
 *  - bounded retries with backoff for 429/5xx/network blips,
 *  - a descriptive User-Agent (Reddit and GitHub both reject anonymous calls).
 */

import { sleep } from '../util';

export const DEFAULT_USER_AGENT = 'cache-me-up-daily-digest/1.0 (GitHub Actions; +https://github.com/)';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  accept?: string;
  userAgent?: string;
  timeoutMs?: number;
  /** Extra attempts after the first (default 2). */
  retries?: number;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  contentType: string;
}

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 15000);
  }
  return Math.min(500 * 2 ** attempt, 8000);
}

/**
 * Perform an HTTP request with retries. Throws `HttpError` for non-2xx
 * responses that are not worth retrying.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const { retries = 2, timeoutMs = 20000 } = options;
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
    accept: options.accept ?? '*/*',
    ...options.headers,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        return {
          status: response.status,
          text: await response.text(),
          contentType: response.headers.get('content-type') ?? '',
        };
      }

      const body = await response.text().catch(() => '');
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) {
        throw new HttpError(
          `GET ${url} failed with ${response.status} ${response.statusText}`,
          response.status,
          body.slice(0, 300),
        );
      }

      const wait = backoffMs(attempt, response.headers.get('retry-after'));
      lastError = new HttpError(`GET ${url} returned ${response.status}; retrying in ${wait}ms`, response.status, body.slice(0, 300));
      await sleep(wait);
    } catch (error) {
      if (error instanceof HttpError && error.status > 0 && error.status < 500 && error.status !== 429) {
        throw error;
      }
      if (attempt === retries) {
        lastError = error as Error;
        break;
      }
      const wait = backoffMs(attempt, null);
      lastError = error as Error;
      await sleep(wait);
    }
  }

  throw lastError instanceof HttpError
    ? lastError
    : new HttpError(`GET ${url} failed: ${lastError?.message ?? 'unknown error'}`, 0);
}

export async function fetchText(url: string, options: RequestOptions = {}): Promise<string> {
  const response = await request(url, options);
  return response.text;
}

export async function fetchJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(url, { accept: 'application/json', ...options });
  try {
    return JSON.parse(response.text) as T;
  } catch (error) {
    throw new Error(`GET ${url} did not return valid JSON: ${(error as Error).message}`);
  }
}
