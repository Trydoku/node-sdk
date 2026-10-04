import { afterEach, describe, expect, it, vi } from 'vitest';
import { Trydoku, RequestTimeoutError, TrydokuTransportError } from '../src/index.ts';
import { abortableFetch, batchEnvelope, jsonResponse, mockFetch, requestHeaders } from './helpers.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('client configuration and transport', () => {
  it('uses native fetch, the production URL, bearer authentication, and blocks redirects', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope()));
    vi.stubGlobal('fetch', fetchMock);

    await new Trydoku({ apiKey: 'test-api-key' }).batches.get('batch-1');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://www.trydoku.com/api/v1/batches/batch-1');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(requestHeaders(init).get('authorization')).toBe('Bearer test-api-key');
    expect(requestHeaders(init).get('accept')).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes a custom base URL and encodes an ID as one path segment', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope()));
    const client = new Trydoku({ apiKey: 'key', baseUrl: 'http://localhost:8080/api/v1/', fetch: fetchMock });

    await client.batches.get('id/part?query#fragment');

    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:8080/api/v1/batches/id%2Fpart%3Fquery%23fragment');
  });

  it.each(['', '   ', 'key\r\ninjected: true'])('rejects invalid API keys (%j)', (apiKey) => {
    expect(() => new Trydoku({ apiKey })).toThrow(TypeError);
  });

  it.each(['relative/path', 'ftp://example.com', 'https://user:password@example.com', 'https://example.com/api?x=1', 'https://example.com/api#fragment', 'https://example.com/api?', 'https://example.com/api#'])('rejects invalid base URLs (%s)', (baseUrl) => {
    expect(() => new Trydoku({ apiKey: 'key', baseUrl })).toThrow(TypeError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('rejects invalid configured timeout (%s)', (timeoutMs) => {
    expect(() => new Trydoku({ apiKey: 'key', timeoutMs })).toThrow(TypeError);
  });

  it('wraps network failures with their original cause and never retries', async () => {
    const cause = new TypeError('Socket closed');
    const fetchMock = mockFetch().mockRejectedValue(cause);
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });

    const request = client.batches.get('batch-1');

    await expect(request).rejects.toBeInstanceOf(TrydokuTransportError);
    await expect(request).rejects.toMatchObject({ cause });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('times out with the configured value and aborts the fetch signal', async () => {
    vi.useFakeTimers();
    const fetchMock = abortableFetch();
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock, timeoutMs: 50 });
    const request = client.batches.get('batch-1');
    const assertion = expect(request).rejects.toMatchObject({ name: 'RequestTimeoutError', timeoutMs: 50 });

    await vi.advanceTimersByTimeAsync(50);

    await assertion;
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(request).rejects.toBeInstanceOf(TrydokuTransportError);
  });

  it('uses a 60 second request timeout by default', async () => {
    vi.useFakeTimers();
    const client = new Trydoku({ apiKey: 'key', fetch: abortableFetch() });
    const request = client.batches.get('batch-1');
    const assertion = expect(request).rejects.toMatchObject({ timeoutMs: 60_000 });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('lets a per-request timeout override the client timeout', async () => {
    vi.useFakeTimers();
    const client = new Trydoku({ apiKey: 'key', fetch: abortableFetch(), timeoutMs: 500 });
    const request = client.batches.get('batch-1', { timeoutMs: 20 });
    const assertion = expect(request).rejects.toMatchObject({ timeoutMs: 20 });

    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it('keeps the timeout active while consuming a JSON response body', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch().mockImplementation(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    }), { headers: { 'content-type': 'application/json' } }));
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock, timeoutMs: 30 });
    const request = client.batches.get('batch-1');
    const assertion = expect(request).rejects.toMatchObject({ timeoutMs: 30 });

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the timeout active while consuming a ZIP response body', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch().mockImplementation(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0x50, 0x4b));
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    })));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock, timeoutMs: 30 }).batches.downloadZip('batch-1');
    const assertion = expect(request).rejects.toBeInstanceOf(RequestTimeoutError);

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });

  it('preserves the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('Stopped by the caller');
    const fetchMock = abortableFetch();
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1', { signal: controller.signal });
    const assertion = expect(request).rejects.toBe(reason);

    controller.abort(reason);
    await assertion;
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('does not fetch when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('Already stopped');
    controller.abort(reason);
    const fetchMock = mockFetch();

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1', { signal: controller.signal })).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes pending timeout timers after success and after an HTTP error', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(jsonResponse(batchEnvelope()))
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized' }, 401));
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });

    await client.batches.get('batch-1');
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.batches.get('batch-1')).rejects.toMatchObject({ status: 401 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])('rejects invalid per-request timeout (%s) before fetching', async (timeoutMs) => {
    const fetchMock = mockFetch();
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });

    await expect(client.batches.get('batch-1', { timeoutMs })).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
