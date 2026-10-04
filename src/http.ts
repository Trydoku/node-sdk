import { Buffer } from 'node:buffer';
import { createApiError, RequestTimeoutError, TrydokuApiError, TrydokuTransportError } from './errors.js';
import type { JsonObject, RequestOptions, TrydokuOptions } from './types/index.js';

export const DEFAULT_BASE_URL = 'https://www.trydoku.com/api/v1';
export const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

/** @internal */
export function validateTimeout(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new TypeError(`timeoutMs must be an integer between 1 and ${MAX_TIMER_MS}.`);
  }
}

/** @internal The transport deliberately has no automatic retry policy. */
export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: TrydokuOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '' || /[\r\n]/.test(options.apiKey)) {
      throw new TypeError('apiKey must be a non-empty string without line breaks.');
    }
    this.apiKey = options.apiKey.trim();
    let url: URL;
    try {
      url = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    } catch {
      throw new TypeError('baseUrl must be an absolute HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
      throw new TypeError('baseUrl must be an HTTP(S) URL without credentials, query or fragment.');
    }
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    validateTimeout(this.timeoutMs);
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== 'function') {
      throw new TypeError('A native fetch implementation is required (Node.js 18 or newer).');
    }
  }

  async json<T>(
    method: 'GET' | 'POST',
    path: string,
    decode: (value: unknown) => T,
    body?: JsonObject,
    options: RequestOptions = {},
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    // Encode before the HTTP request, so bad arguments stay local errors.
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return this.perform(method, path, options, async (response) => {
      const responseBody = await response.text();
      if (!response.ok) throw createApiError(response, responseBody);
      try {
        const decoded: unknown = JSON.parse(responseBody);
        return decode(decoded);
      } catch (cause) {
        throw new TrydokuApiError(
          cause instanceof SyntaxError ? 'The API returned invalid JSON.'
            : cause instanceof Error ? cause.message : 'The API returned an invalid response.',
          { status: response.status, responseBody, headers: response.headers, cause },
        );
      }
    }, encoded, { Accept: 'application/json', ...extraHeaders });
  }

  async binary(path: string, options: RequestOptions = {}): Promise<Buffer> {
    return this.perform('GET', path, options, async (response) => {
      if (!response.ok) throw createApiError(response, await response.text());
      return Buffer.from(await response.arrayBuffer());
    }, undefined, { Accept: 'application/zip, application/octet-stream' });
  }

  private async perform<T>(
    method: string,
    path: string,
    options: RequestOptions,
    consume: (response: Response) => Promise<T>,
    body: string | undefined,
    extraHeaders: Readonly<Record<string, string>>,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    validateTimeout(timeoutMs);
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new RequestTimeoutError(timeoutMs)), timeoutMs);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const headers = new Headers(extraHeaders);
      headers.set('Authorization', `Bearer ${this.apiKey}`);
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'error' };
      if (body !== undefined) init.body = body;
      return await Promise.race([
        (async () => consume(await this.fetcher(`${this.baseUrl}/${path}`, init)))(),
        aborted,
      ]);
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cause instanceof TrydokuApiError) throw cause;
      throw new TrydokuTransportError('The TRYDOKU HTTP request failed.', { cause });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
