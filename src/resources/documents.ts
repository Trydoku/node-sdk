import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { HttpClient } from '../http.js';
import { Batch, GenerateRequest } from '../types/index.js';
import { normalizeIdempotencyKey, validateGenerateOptions } from '../types/generate-request.js';
import type { GenerateFileOptions, GenerateOptions, GenerateSingleOptions, RequestOptions } from '../types/index.js';

const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;

export class Documents {
  /** @internal Use Trydoku.documents to obtain this resource. */
  constructor(private readonly http: HttpClient) {}

  /** One row creates one document; up to 500 rows create a single batch. */
  async generate(options: GenerateOptions, requestOptions: RequestOptions = {}): Promise<Batch> {
    const payload = validateGenerateOptions(options);
    const key = normalizeIdempotencyKey(options.idempotencyKey);
    return this.http.json('POST', 'generate', Batch.fromApiResponse, payload, requestOptions,
      key === null ? {} : { 'Idempotency-Key': key });
  }

  /** A single document still uses the asynchronous batch API. */
  async generateSingle(options: GenerateSingleOptions, requestOptions: RequestOptions = {}): Promise<Batch> {
    return this.generate({ ...options, data: [options.data] }, requestOptions);
  }

  /** Send a local DOCX to the generation endpoint as template_base64. */
  async generateFromFile(
    filePath: string,
    options: GenerateFileOptions,
    requestOptions: RequestOptions = {},
  ): Promise<Batch> {
    requestOptions.signal?.throwIfAborted();
    if (typeof filePath !== 'string' || extname(filePath).toLowerCase() !== '.docx') {
      throw new TypeError('The template file must have a .docx extension.');
    }
    // Validate rows and local options before touching a potentially large file.
    validateGenerateOptions({ ...options, templateBase64: 'validation-placeholder' });
    const info = await stat(filePath);
    requestOptions.signal?.throwIfAborted();
    if (!info.isFile() || info.size < 1 || info.size > MAX_TEMPLATE_BYTES) {
      throw new TypeError('The DOCX template must be a non-empty file no larger than 10 MiB.');
    }
    const file = await readFile(filePath, requestOptions.signal ? { signal: requestOptions.signal } : {})
      .catch((cause: unknown) => {
        requestOptions.signal?.throwIfAborted();
        throw cause;
      });
    requestOptions.signal?.throwIfAborted();
    if (file.length < 1 || file.length > MAX_TEMPLATE_BYTES) {
      throw new TypeError('The DOCX template must be a non-empty file no larger than 10 MiB.');
    }
    return this.generate({ ...options, templateBase64: file.toString('base64') }, requestOptions);
  }

  async generateFromRequest(request: GenerateRequest, options: RequestOptions = {}): Promise<Batch> {
    return this.generate(request.toOptions(), options);
  }
}
