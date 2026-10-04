import type { DataRow, GenerateOptions, JsonObject, JsonValue } from './index.js';

function plainObject(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${description} must be a plain JSON object.`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${description} cannot contain symbol keys.`);
  }
  return value as Record<string, unknown>;
}

function copyJson(value: unknown, path: string, ancestors: Set<object> = new Set()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain finite JSON numbers.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} must contain only JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} cannot contain circular references.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path} cannot contain sparse arrays.`);
        }
        result.push(copyJson(value[index] as unknown, `${path}[${index}]`, ancestors));
      }
      return Object.freeze(result);
    }

    const source = plainObject(value, path);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(source)) {
      Object.defineProperty(result, key, {
        value: copyJson(source[key], `${path}.${key}`, ancestors),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function copyRows(value: unknown, requireRows: boolean): readonly DataRow[] {
  if (!Array.isArray(value) || value.length > 500 || (requireRows && value.length === 0)) {
    throw new TypeError('data must contain between 1 and 500 document rows.');
  }
  const result: DataRow[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError('data cannot contain sparse arrays.');
    }
    const row = copyJson(value[index] as unknown, `data[${index}]`);
    if (typeof row !== 'object' || row === null) {
      throw new TypeError(`data[${index}] must be a JSON object or a list.`);
    }
    result.push(row);
  }
  return Object.freeze(result);
}

function copyVariables(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('variables must be a list of strings.');
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const variable: unknown = value[index];
    if (!Object.hasOwn(value, index) || typeof variable !== 'string') {
      throw new TypeError('variables must be a list of strings.');
    }
    result.push(variable);
  }
  return Object.freeze(result);
}

function copyMapping(value: unknown): Readonly<Record<string, string>> {
  const source = plainObject(value, 'variableMapping');
  const result: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    const placeholder = source[key];
    if (typeof placeholder !== 'string') {
      throw new TypeError('variableMapping must map string keys to string values.');
    }
    Object.defineProperty(result, key, { value: placeholder, enumerable: true });
  }
  return Object.freeze(result);
}

function templateSource(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a nonblank string.`);
  }
  return value;
}

/** @internal Normalize the header independently of the JSON payload. */
export function normalizeIdempotencyKey(key: unknown = undefined): string | null {
  if (key === undefined || key === null) {
    return null;
  }
  if (typeof key !== 'string') {
    throw new TypeError('Idempotency-Key must be a string or null.');
  }
  const normalized = key.trim();
  if (normalized === '') {
    return null;
  }
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(normalized)) {
    throw new TypeError('Idempotency-Key must be 1–255 characters of A-Z, a-z, 0-9, ".", "_" or "-".');
  }
  return normalized;
}

/** @internal Validate request shape and map options to API field names. */
export function validateGenerateOptions(options: GenerateOptions): JsonObject {
  const source = plainObject(options, 'Generation options');
  const hasUuid = source['templateUuid'] !== undefined;
  const hasBase64 = source['templateBase64'] !== undefined;
  if (hasUuid === hasBase64) {
    throw new TypeError('Exactly one of templateUuid or templateBase64 must be provided.');
  }

  const payload: Record<string, JsonValue> = {
    data: copyRows(source['data'], true),
  };
  if (hasUuid) {
    payload['template_uuid'] = templateSource(source['templateUuid'], 'templateUuid');
  } else {
    payload['template_base64'] = templateSource(source['templateBase64'], 'templateBase64');
  }
  if (source['variables'] !== undefined) {
    payload['variables'] = copyVariables(source['variables']);
  }
  if (source['variableMapping'] !== undefined) {
    payload['variable_mapping'] = copyMapping(source['variableMapping']);
  }
  if (source['format'] !== undefined) {
    if (source['format'] !== 'zip') {
      throw new TypeError('format must be "zip".');
    }
    payload['format'] = 'zip';
  }
  normalizeIdempotencyKey(source['idempotencyKey']);
  return Object.freeze(payload);
}

interface BuilderState {
  readonly templateUuid: string | null;
  readonly templateBase64: string | null;
  readonly data: readonly DataRow[];
  readonly variables: readonly string[] | null;
  readonly variableMapping: Readonly<Record<string, string>> | null;
  readonly format: 'zip' | null;
  readonly key: string | null;
}

/** An immutable fluent builder for generation requests. */
export class GenerateRequest {
  private constructor(private readonly state: BuilderState) {
    Object.freeze(state);
    Object.freeze(this);
  }

  static create(): GenerateRequest {
    return new GenerateRequest({
      templateUuid: null,
      templateBase64: null,
      data: Object.freeze([]),
      variables: null,
      variableMapping: null,
      format: null,
      key: null,
    });
  }

  private withState(patch: Partial<BuilderState>): GenerateRequest {
    return new GenerateRequest({ ...this.state, ...patch });
  }

  withTemplateUuid(uuid: string): GenerateRequest {
    if (typeof uuid !== 'string') {
      throw new TypeError('templateUuid must be a string.');
    }
    return this.withState({ templateUuid: uuid, templateBase64: null });
  }

  withTemplateBase64(base64: string): GenerateRequest {
    if (typeof base64 !== 'string') {
      throw new TypeError('templateBase64 must be a string.');
    }
    return this.withState({ templateBase64: base64, templateUuid: null });
  }

  withData(data: readonly DataRow[]): GenerateRequest {
    return this.withState({ data: copyRows(data, false) });
  }

  withVariables(variables: readonly string[]): GenerateRequest {
    return this.withState({ variables: copyVariables(variables) });
  }

  withVariableMapping(mapping: Readonly<Record<string, string>>): GenerateRequest {
    return this.withState({ variableMapping: copyMapping(mapping) });
  }

  withFormat(format: 'zip'): GenerateRequest {
    if (format !== 'zip') {
      throw new TypeError('format must be "zip".');
    }
    return this.withState({ format });
  }

  withIdempotencyKey(key: string | null): GenerateRequest {
    return this.withState({ key: normalizeIdempotencyKey(key) });
  }

  hasTemplate(): boolean {
    return (
      (this.state.templateUuid !== null && this.state.templateUuid.trim() !== '') ||
      (this.state.templateBase64 !== null && this.state.templateBase64.trim() !== '')
    );
  }

  idempotencyKey(): string | null {
    return this.state.key;
  }

  toOptions(): GenerateOptions {
    const { templateUuid, templateBase64, data, variables, variableMapping, format, key } = this.state;
    const common = {
      data,
      ...(variables === null ? {} : { variables }),
      ...(variableMapping === null ? {} : { variableMapping }),
      ...(format === null ? {} : { format }),
      ...(key === null ? {} : { idempotencyKey: key }),
    };
    let options: GenerateOptions;
    if (templateUuid !== null) {
      options = { templateUuid, ...common };
    } else if (templateBase64 !== null) {
      options = { templateBase64, ...common };
    } else {
      throw new TypeError('Exactly one of templateUuid or templateBase64 must be provided.');
    }
    validateGenerateOptions(options);
    return Object.freeze(options);
  }

  /** Idempotency-Key is deliberately omitted because it is an HTTP header. */
  toJSON(): JsonObject {
    return validateGenerateOptions(this.toOptions());
  }
}
