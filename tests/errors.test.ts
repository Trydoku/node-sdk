import { describe, expect, it, vi } from 'vitest';
import {
  Trydoku, TrydokuApiError, AuthenticationError, AuthorizationError,
  InsufficientCreditsError, ValidationError, IdempotencyKeyConflictError,
  ConflictError, BatchFilesMissingError, PayloadTooLargeError,
  UnsupportedMediaTypeError, RateLimitError, BatchNotReadyError,
  GenerationSetupFailedError, NotFoundError,
} from '../src/index.ts';
import { jsonResponse, mockFetch } from './helpers.ts';

describe('API errors', () => {
  it.each([
    [401, 'UNAUTHENTICATED', AuthenticationError],
    [403, 'FORBIDDEN', AuthorizationError],
    [402, 'INSUFFICIENT_CREDITS', InsufficientCreditsError],
    [422, 'VALIDATION_FAILED', ValidationError],
    [422, 'IDEMPOTENCY_KEY_CONFLICT', IdempotencyKeyConflictError],
    [409, 'IDEMPOTENCY_IN_PROGRESS', ConflictError],
    [409, 'BATCH_FILES_MISSING', BatchFilesMissingError],
    [413, 'PAYLOAD_TOO_LARGE', PayloadTooLargeError],
    [415, 'UNSUPPORTED_CONTENT_ENCODING', UnsupportedMediaTypeError],
    [429, 'RATE_LIMITED', RateLimitError],
    [400, 'BATCH_NOT_READY', BatchNotReadyError],
    [503, 'GENERATION_SETUP_FAILED', GenerationSetupFailedError],
    [404, 'RESOURCE_NOT_FOUND', NotFoundError],
    [500, 'INTERNAL_SERVER_ERROR', TrydokuApiError],
  ] as const)('maps HTTP %s and %s to the right typed error', async (status, code, ErrorClass) => {
    const body = { error: { code, message: 'Precise server message', details: { request_id: 'request-123' } }, message: 'Top-level message' };
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(body, status, { 'x-request-id': 'request-123' }));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1');

    await expect(request).rejects.toBeInstanceOf(ErrorClass);
    await expect(request).rejects.toBeInstanceOf(TrydokuApiError);
    await expect(request).rejects.toMatchObject({ status, code, message: 'Top-level message', responseBody: JSON.stringify(body), details: { request_id: 'request-123' } });
    try {
      await request;
    } catch (error) {
      expect(error).toBeInstanceOf(TrydokuApiError);
      if (!(error instanceof TrydokuApiError)) throw error;
      expect(error.headers.get('x-request-id')).toBe('request-123');
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [401, AuthenticationError], [403, AuthorizationError], [402, InsufficientCreditsError],
    [422, ValidationError], [409, ConflictError], [413, PayloadTooLargeError],
    [415, UnsupportedMediaTypeError], [429, RateLimitError], [404, NotFoundError],
    [500, TrydokuApiError],
  ] as const)('maps a non-JSON HTTP %s error without discarding the original body', async (status, ErrorClass) => {
    const fetchMock = mockFetch().mockResolvedValue(new Response('<html>Upstream failure</html>', { status }));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1');

    await expect(request).rejects.toBeInstanceOf(ErrorClass);
    await expect(request).rejects.toMatchObject({ status, code: null, responseBody: '<html>Upstream failure</html>' });
  });

  it('preserves unknown future API codes and top-level messages', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({ code: 'NEW_FUTURE_CODE', message: 'A future error', details: { reason: 7 } }, 418));
    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1')).rejects.toMatchObject({ status: 418, code: 'NEW_FUTURE_CODE', message: 'A future error', details: { reason: 7 } });
  });

  it('exposes available and required credit counts', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({
      error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits', details: { credits_available: 3, credits_required: 7 } },
    }, 402));
    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1')).rejects.toMatchObject({ creditsAvailable: 3, creditsRequired: 7 });
  });

  it('exposes Laravel validation errors from the top-level errors object', async () => {
    const errors = { data: ['At least one row is required.'], 'data.0.Name': ['The Name field is required.'] };
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({ message: 'The given data was invalid.', errors }, 422));

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1')).rejects.toMatchObject({ errors });
  });

  it('exposes nested validation errors and ignores malformed entries', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({ error: {
      code: 'VALIDATION_FAILED', message: 'Invalid request', details: { errors: { format: ['Only zip is supported.'], invalid: 2 } },
    } }, 422));

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1')).rejects.toMatchObject({ errors: { format: ['Only zip is supported.'] } });
  });

  it.each([
    ['12', 12], ['nonsense', null], ['-1', null], ['', null],
  ])('parses Retry-After %j as %s seconds', async (value, expected) => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({ message: 'Too many requests.' }, 429, { 'retry-after': value }));

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1')).rejects.toMatchObject({ retryAfter: expected });
  });

  it('parses a future Retry-After HTTP date in seconds', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 4, 12));
    const future = new Date(Date.now() + 60_000).toUTCString();
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse({ message: 'Too many requests.' }, 429, { 'retry-after': future }));
    try {
      await new Trydoku({ apiKey: 'key', fetch: fetchMock }).batches.get('batch-1');
      expect.unreachable('Expected an API error.');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      if (!(error instanceof RateLimitError)) throw error;
      expect(error.retryAfter).toBe(60);
    }
  });

  it('reports zero delay for a past Retry-After date and null when the header is absent', async () => {
    const fetchMock = mockFetch()
      .mockResolvedValueOnce(jsonResponse({ message: 'Rate limited' }, 429, { 'retry-after': 'Mon, 01 Jan 2001 00:00:00 GMT' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Rate limited' }, 429));
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });

    await expect(client.batches.get('batch-1')).rejects.toMatchObject({ retryAfter: 0 });
    await expect(client.batches.get('batch-1')).rejects.toMatchObject({ retryAfter: null });
  });
});
