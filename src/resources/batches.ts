import type { Buffer } from 'node:buffer';
import { PollingTimeoutError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { Batch } from '../types/index.js';
import type { RequestOptions, WaitOptions } from '../types/index.js';

function batchPath(id: string): string {
  if (typeof id !== 'string' || id.trim() === '' || id === '.' || id === '..') {
    throw new TypeError('batchId must be a non-empty resource identifier.');
  }
  return `batches/${encodeURIComponent(id)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Batches {
  /** @internal Use Trydoku.batches to obtain this resource. */
  constructor(private readonly http: HttpClient) {}

  async get(batchId: string, options: RequestOptions = {}): Promise<Batch> {
    return this.http.json('GET', batchPath(batchId), Batch.fromApiResponse, undefined, options);
  }

  async downloadZip(batchId: string, options: RequestOptions = {}): Promise<Buffer> {
    return this.http.binary(`${batchPath(batchId)}/zip`, options);
  }

  /** Returns terminal failures and partial completion; inspect the batch before download. */
  async waitForCompletion(batchId: string, options: WaitOptions = {}): Promise<Batch> {
    const maxAttempts = options.maxAttempts ?? 30;
    const intervalMs = options.intervalMs ?? 2000;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError('maxAttempts must be a positive safe integer.');
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647) {
      throw new TypeError('intervalMs must be an integer between 0 and 2147483647.');
    }
    let batch = await this.get(batchId, options);
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      if (batch.isTerminal()) return batch;
      await delay(intervalMs, options.signal);
      batch = await this.get(batchId, options);
    }
    if (batch.isTerminal()) return batch;
    throw new PollingTimeoutError(batchId, maxAttempts, batch);
  }
}
