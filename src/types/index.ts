/** Values that can be represented faithfully in a JSON request. */
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** A named object row, or a positional row used with `variables`. */
export type DataRow = JsonObject | readonly JsonValue[];

/** Exactly one template source must be selected. */
export type TemplateSource =
  | { readonly templateUuid: string; readonly templateBase64?: never }
  | { readonly templateBase64: string; readonly templateUuid?: never };

export interface GenerateFileOptions {
  readonly data: readonly DataRow[];
  readonly variables?: readonly string[];
  readonly variableMapping?: Readonly<Record<string, string>>;
  readonly format?: 'zip';
  readonly idempotencyKey?: string | null;
}

export type GenerateOptions = TemplateSource & GenerateFileOptions;

export type GenerateSingleOptions = TemplateSource &
  Omit<GenerateFileOptions, 'data'> & {
    readonly data: DataRow;
  };

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface WaitOptions extends RequestOptions {
  /** Maximum number of status requests, including the first request. */
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
}

export interface TrydokuOptions {
  readonly apiKey: string;
  /** Defaults to the official TRYDOKU v1 API. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Supply a compatible fetch implementation, for example when testing. */
  readonly fetch?: typeof globalThis.fetch;
}

export { Batch, BatchItem, BatchLinks } from './batch.js';
export { GenerateRequest } from './generate-request.js';
