import { vi } from 'vitest';

export function batchEnvelope(overrides: Readonly<Record<string, unknown>> = {}, code?: string) {
  return {
    data: {
      id: 'batch-1',
      status: 'processing',
      setup_status: 'ready',
      total_items: 2,
      processed_items: 0,
      failed_items: 0,
      created_at: '2026-07-16T18:20:00.000000Z',
      updated_at: null,
      links: {
        self: 'https://www.trydoku.com/api/v1/batches/batch-1',
        zip: null,
      },
      ...overrides,
    },
    ...(code === undefined ? {} : { code }),
  };
}

export function jsonResponse(body: unknown, status = 200, headers?: ConstructorParameters<typeof Headers>[0]): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });
}

export function mockFetch() {
  return vi.fn<typeof fetch>();
}

export function requestHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

export function requestBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body.');
  return JSON.parse(init.body) as unknown;
}

export function abortableFetch() {
  return mockFetch().mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error('Expected a request abort signal.');
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
}
