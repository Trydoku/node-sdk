import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { Trydoku, Batch, BatchItem, PollingTimeoutError, BatchNotReadyError, TrydokuApiError } from '../src/index.ts';
import { batchEnvelope, jsonResponse, mockFetch, requestHeaders } from './helpers.ts';

afterEach(() => vi.useRealTimers());

describe('batches', () => {
  it('gets batch status and maps item download URLs and errors', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope({
      status: 'completed', processed_items: 1, failed_items: 1,
      items: [
        { row_index: 0, status: 'completed', download_url: 'https://example.com/document.docx', error: null },
        { row_index: 1, status: 'failed', download_url: null, error: 'Missing variable' },
      ],
    })));

    const batch = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1');

    expect(batch).toBeInstanceOf(Batch);
    expect(batch.items).toHaveLength(2);
    expect(batch.items[0]).toBeInstanceOf(BatchItem);
    expect(batch.items[0]?.isCompleted()).toBe(true);
    expect(batch.items[0]?.downloadUrl).toBe('https://example.com/document.docx');
    expect(batch.items[1]?.isFailed()).toBe(true);
    expect(batch.items[1]?.error).toBe('Missing variable');
    expect(batch.hasFailed()).toBe(true);
  });

  it('downloads binary ZIP bytes without text conversion or corruption', async () => {
    const bytes = Uint8Array.of(80, 75, 3, 4, 0, 128, 192, 255, 13, 10);
    const fetchMock = mockFetch().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'application/zip' } }));

    const result = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.downloadZip('id/part?query#fragment');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(Buffer.from(bytes));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://www.trydoku.com/api/v1/batches/id%2Fpart%3Fquery%23fragment/zip');
    expect(init?.method).toBe('GET');
    expect(requestHeaders(init).get('accept')).toContain('application/zip');
    expect(requestHeaders(init).get('authorization')).toBe('Bearer key');
  });

  it('maps API errors on binary downloads to the same typed errors', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({ error: { code: 'BATCH_NOT_READY', message: 'Still processing' } }, 400));

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.downloadZip('batch-1')).rejects.toBeInstanceOf(BatchNotReadyError);
  });

  it.each(['', '   ', '.', '..'])('rejects an invalid batch ID (%j) without sending a request', async (id) => {
    const fetchMock = mockFetch();
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });

    await expect(client.batches.get(id)).rejects.toBeInstanceOf(TypeError);
    await expect(client.batches.downloadZip(id)).rejects.toBeInstanceOf(TypeError);
    await expect(client.batches.waitForCompletion(id, { intervalMs: 0 })).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { total_items: '2' }, { failed_items: -1 }, { processed_items: 0.5 },
    { links: null }, { links: { self: 2 } }, { items: {} }, { items: [null] },
    { items: [{ row_index: -1, status: 'completed' }] }, { created_at: 'not a date' },
    { status: '' }, { setup_status: null },
  ])('rejects malformed batch payloads and retains the response context (%j)', async (override) => {
    const body = JSON.stringify(batchEnvelope(override));
    const fetchMock = mockFetch().mockResolvedValue(new Response(body, { status: 200 }));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1');

    await expect(request).rejects.toBeInstanceOf(TrydokuApiError);
    await expect(request).rejects.toMatchObject({ status: 200, responseBody: body });
  });
});

describe('waitForCompletion', () => {
  it('returns an already completed batch immediately without sleeping', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope({ status: 'completed', processed_items: 2 })));

    const batch = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1');

    expect(batch.isCompleted()).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls only after the requested interval until processing completes', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(jsonResponse(batchEnvelope()))
      .mockResolvedValueOnce(jsonResponse(batchEnvelope()))
      .mockResolvedValueOnce(jsonResponse(batchEnvelope({ status: 'completed', processed_items: 2 })));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { maxAttempts: 5, intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);

    expect((await request).isCompleted()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['pending', 'setup_pending'])('keeps polling during %s setup even when GET has no pending code', async (setup_status) => {
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(jsonResponse(batchEnvelope({ setup_status }), 202))
      .mockResolvedValueOnce(jsonResponse(batchEnvelope({ status: 'completed', processed_items: 2 })));

    const batch = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { intervalMs: 0 });

    expect(batch.isCompleted()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('continues polling while setup is pending even if status is completed', async () => {
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(jsonResponse(batchEnvelope({ status: 'completed', setup_status: 'pending' })))
      .mockResolvedValueOnce(jsonResponse(batchEnvelope({ status: 'completed', setup_status: 'ready' })));

    const batch = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { intervalMs: 0 });

    expect(batch.isSetupPending()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('continues a processing batch that already has failed rows', async () => {
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(jsonResponse(batchEnvelope({ failed_items: 1 })))
      .mockResolvedValueOnce(jsonResponse(batchEnvelope({ status: 'completed', processed_items: 1, failed_items: 1 })));

    const batch = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { intervalMs: 0 });

    expect(batch.isCompleted()).toBe(true);
    expect(batch.hasFailed()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 'completed', failed_items: 1 },
    { status: 'failed' },
    { status: 'processing', setup_status: 'failed' },
    { status: 'processing', setup_status: 'setup_failed' },
  ])('returns terminal failures/partial completions without an extra request (%j)', async (override) => {
    vi.useFakeTimers();
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope(override)));

    const batch = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { maxAttempts: 5, intervalMs: 100 });

    expect(batch.isTerminal()).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('throws a typed polling timeout containing the last batch and does not sleep after the final attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch().mockImplementation(async () => jsonResponse(batchEnvelope()));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { maxAttempts: 2, intervalMs: 100 });
    const assertion = expect(request).rejects.toMatchObject({ batchId: 'batch-1', maxAttempts: 2, lastBatch: { id: 'batch-1', status: 'processing' } });

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await expect(request).rejects.toBeInstanceOf(PollingTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses 30 attempts by default', async () => {
    const fetchMock = mockFetch().mockImplementation(async () => jsonResponse(batchEnvelope()));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { intervalMs: 0 });

    await expect(request).rejects.toMatchObject({ maxAttempts: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it.each([
    { maxAttempts: 0 }, { maxAttempts: -1 }, { maxAttempts: 1.2 }, { maxAttempts: Number.NaN },
    { intervalMs: -1 }, { intervalMs: 0.5 }, { intervalMs: Number.POSITIVE_INFINITY }, { intervalMs: 2_147_483_648 },
  ])('rejects invalid polling options before fetching (%j)', async (options) => {
    const fetchMock = mockFetch();

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', options)).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts an interval promptly, preserves the reason, and clears the sleep timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('Stop polling');
    const fetchMock = mockFetch().mockImplementation(async () => jsonResponse(batchEnvelope()));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { intervalMs: 2_000, signal: controller.signal });
    const assertion = expect(request).rejects.toBe(reason);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    controller.abort(reason);

    await assertion;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates API errors during polling and does not automatically retry', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({ message: 'Rate limited' }, 429));

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.waitForCompletion('batch-1', { intervalMs: 0 })).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
