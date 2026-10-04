import type { Batch } from './types/batch.js';

export interface ApiErrorOptions {
  readonly status?: number | null;
  readonly code?: string | null;
  readonly responseBody?: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly headers?: Headers;
  readonly cause?: unknown;
}

/** API rejection or an invalid successful response. `code` is preserved verbatim. */
export class TrydokuApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly responseBody: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly headers: Headers;

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.responseBody = options.responseBody ?? null;
    this.details = options.details ?? {};
    this.headers = new Headers(options.headers);
  }
}

export class AuthenticationError extends TrydokuApiError {}
export class AuthorizationError extends TrydokuApiError {}
export class NotFoundError extends TrydokuApiError {}
export class ConflictError extends TrydokuApiError {}
export class BatchFilesMissingError extends ConflictError {}
export class IdempotencyKeyConflictError extends TrydokuApiError {}
export class PayloadTooLargeError extends TrydokuApiError {}
export class UnsupportedMediaTypeError extends TrydokuApiError {}
export class BatchNotReadyError extends TrydokuApiError {}
export class GenerationSetupFailedError extends TrydokuApiError {}

export class InsufficientCreditsError extends TrydokuApiError {
  readonly creditsAvailable: number | null;
  readonly creditsRequired: number | null;

  constructor(message: string, options: ApiErrorOptions & {
    readonly creditsAvailable?: number | null;
    readonly creditsRequired?: number | null;
  } = {}) {
    super(message, options);
    this.creditsAvailable = options.creditsAvailable ?? null;
    this.creditsRequired = options.creditsRequired ?? null;
  }
}

export class ValidationError extends TrydokuApiError {
  readonly errors: Readonly<Record<string, readonly string[]>>;

  constructor(message: string, options: ApiErrorOptions & {
    readonly errors?: Readonly<Record<string, readonly string[]>>;
  } = {}) {
    super(message, options);
    this.errors = options.errors ?? {};
  }
}

export class RateLimitError extends TrydokuApiError {
  /** Retry-After in seconds; null when the server omitted a valid value. */
  readonly retryAfter: number | null;

  constructor(message: string, options: ApiErrorOptions & {
    readonly retryAfter?: number | null;
  } = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter ?? null;
  }
}

export class TrydokuTransportError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class RequestTimeoutError extends TrydokuTransportError {
  constructor(readonly timeoutMs: number, options: ErrorOptions = {}) {
    super(`The TRYDOKU request timed out after ${timeoutMs} ms.`, options);
  }
}

export class PollingTimeoutError extends TrydokuApiError {
  constructor(
    readonly batchId: string,
    readonly maxAttempts: number,
    readonly lastBatch: Batch,
  ) {
    super(`Batch ${batchId} did not complete within ${maxAttempts} polling attempts.`);
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function validationErrors(value: unknown): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(Object.entries(record(value))
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([key, messages]) => [key, messages.filter((entry): entry is string => typeof entry === 'string')]));
}

function retryAfter(headers: Headers): number | null {
  const value = headers.get('retry-after');
  if (value === null) return null;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  // HTTP dates have a named month. Date.parse also accepts invalid header
  // values such as "-1" as calendar dates, which must not become retry delays.
  if (!/[A-Za-z]{3}/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

/** @internal Map errors by status even if an upstream proxy returns HTML. */
export function createApiError(response: Response, responseBody: string): TrydokuApiError {
  let decoded: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(responseBody);
    decoded = record(value);
  } catch {
    // Preserve non-JSON bodies and classify by the actual HTTP status.
  }
  const error = record(decoded['error']);
  const details = record(error['details'] ?? decoded['details']);
  const codeValue = error['code'] ?? decoded['code'];
  const code = typeof codeValue === 'string' ? codeValue : null;
  const message = typeof decoded['message'] === 'string' ? decoded['message']
    : typeof error['message'] === 'string' ? error['message'] : `HTTP ${response.status} error`;
  const options: ApiErrorOptions = {
    status: response.status, code, responseBody, details, headers: response.headers,
  };
  switch (response.status) {
    case 401: return new AuthenticationError(message, options);
    case 402: return new InsufficientCreditsError(message, {
      ...options,
      creditsAvailable: numeric(decoded['credits_available'] ?? details['credits_available']),
      creditsRequired: numeric(decoded['credits_required'] ?? details['credits_required']),
    });
    case 403: return new AuthorizationError(message, options);
    case 404: return new NotFoundError(message, options);
    case 409: return code === 'BATCH_FILES_MISSING'
      ? new BatchFilesMissingError(message, options) : new ConflictError(message, options);
    case 413: return new PayloadTooLargeError(message, options);
    case 415: return new UnsupportedMediaTypeError(message, options);
    case 422: return code === 'IDEMPOTENCY_KEY_CONFLICT'
      ? new IdempotencyKeyConflictError(message, options)
      : new ValidationError(message, { ...options, errors: validationErrors(decoded['errors'] ?? details['errors']) });
    case 429: return new RateLimitError(message, { ...options, retryAfter: retryAfter(response.headers) });
    case 400: return code === 'BATCH_NOT_READY'
      ? new BatchNotReadyError(message, options) : new TrydokuApiError(message, options);
    case 503: return code === 'GENERATION_SETUP_FAILED'
      ? new GenerationSetupFailedError(message, options) : new TrydokuApiError(message, options);
    default: return new TrydokuApiError(message, options);
  }
}
