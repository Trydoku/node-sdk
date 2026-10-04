export { Trydoku, Trydoku as default } from './client.js';
export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from './http.js';
export type { Documents } from './resources/documents.js';
export type { Batches } from './resources/batches.js';
export * from './types/index.js';
export {
  TrydokuApiError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  InsufficientCreditsError,
  ValidationError,
  IdempotencyKeyConflictError,
  ConflictError,
  BatchFilesMissingError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  RateLimitError,
  BatchNotReadyError,
  GenerationSetupFailedError,
  TrydokuTransportError,
  RequestTimeoutError,
  PollingTimeoutError,
} from './errors.js';
export type { ApiErrorOptions } from './errors.js';
