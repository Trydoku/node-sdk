# TRYDOKU Node.js SDK

Official Node.js and TypeScript client for the [TRYDOKU document generation API](https://www.trydoku.com/docs/api), with the same API operations as the PHP SDK. Generate documents from a stored Word template or a local DOCX, check their batch status, and download the generated DOCX files as a ZIP.

- Node.js 18 or newer; native `fetch`, no runtime dependencies.
- Strict TypeScript with generated declarations for ESM and CommonJS.
- Typed API errors, immutable responses, idempotency, per-request timeout and cancellation.

## Installation

```bash
npm install @trydoku/node
```

Requires Node.js 18 or newer. Create an API key under **Account Settings → API Keys** at [trydoku.com](https://www.trydoku.com) and set `TRYDOKU_API_KEY` in your server environment. The full generation flow requires the token abilities `documents:generate`, `batches:read`, and `batches:download`, and a verified account email.

## Quick start: TypeScript / ESM

```ts
import { writeFile } from 'node:fs/promises';
import Trydoku from '@trydoku/node';

const apiKey = process.env.TRYDOKU_API_KEY;
if (!apiKey) throw new Error('Set TRYDOKU_API_KEY');

const client = new Trydoku({ apiKey });
const started = await client.documents.generate({
  templateUuid: 'e81d77a2-f674-4b53-a8ee-bf350284e311',
  data: [
    { Client_Name: 'Acme Corporation', Invoice_Number: 'INV-001' },
    { Client_Name: 'Globex Industries', Invoice_Number: 'INV-002' },
  ],
  idempotencyKey: 'invoice-batch-001',
});

const batch = await client.batches.waitForCompletion(started.id);
if (!batch.isCompleted() || batch.hasFailed()) {
  throw new Error(`Batch ${batch.id}: ${batch.status}, ${batch.failedItems} failed rows`);
}

await writeFile('documents.zip', await client.batches.downloadZip(batch.id));
```

One `data` row creates one document. Both single and batch generation are asynchronous. A completed batch can contain failed rows; always inspect `hasFailed()` before treating a download as complete.

## Quick start: JavaScript / CommonJS

```js
const { writeFile } = require('node:fs/promises');
const { Trydoku } = require('@trydoku/node');

async function main() {
  const apiKey = process.env.TRYDOKU_API_KEY;
  if (!apiKey) throw new Error('Set TRYDOKU_API_KEY');
  const client = new Trydoku({ apiKey });

  const started = await client.documents.generateSingle({
    templateUuid: 'e81d77a2-f674-4b53-a8ee-bf350284e311',
    data: { Client_Name: 'Acme Corporation' },
  });
  const batch = await client.batches.waitForCompletion(started.id);
  if (!batch.isCompleted() || batch.hasFailed()) {
    throw new Error(`Generation finished with status ${batch.status}`);
  }
  await writeFile('document.zip', await client.batches.downloadZip(batch.id));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

JavaScript ESM uses the same imports and methods as the TypeScript example.

## API overview

| Method | Parameters | Returns |
| --- | --- | --- |
| `documents.generate` | `GenerateOptions`, optional `RequestOptions` | `Promise<Batch>` |
| `documents.generateSingle` | `GenerateSingleOptions`, optional `RequestOptions` | `Promise<Batch>` |
| `documents.generateFromFile` | DOCX path, `GenerateFileOptions`, optional `RequestOptions` | `Promise<Batch>` |
| `documents.generateFromRequest` | `GenerateRequest`, optional `RequestOptions` | `Promise<Batch>` |
| `batches.get` | Batch ID, optional `RequestOptions` | `Promise<Batch>` |
| `batches.waitForCompletion` | Batch ID, optional `WaitOptions` | `Promise<Batch>` |
| `batches.downloadZip` | Batch ID, optional `RequestOptions` | `Promise<Buffer>` |

Options, JSON types, DTOs, and error classes are exported from `@trydoku/node`.

## Client configuration

```ts
const client = new Trydoku({
  apiKey: 'YOUR_API_KEY',
  baseUrl: 'https://www.trydoku.com/api/v1', // includes /api/v1
  timeoutMs: 60_000,                       // default; includes response body download
  fetch: globalThis.fetch,                // optional custom fetch implementation
});
```

`timeoutMs` must be an integer from 1 to 2,147,483,647. Each method accepts request options as its last argument; a per-request timeout overrides the client default. Requests reject redirects and never retry automatically. Use the final API URL as `baseUrl`.

## Generation

Select exactly one of `templateUuid` and `templateBase64`. TypeScript enforces this choice, and JavaScript calls are validated before HTTP. Send 1–500 JSON object rows or indexed list rows; indexed rows need `variables`. Dates, functions, `undefined`, circular objects, and non-finite numbers are rejected locally; encode dates as strings.

```ts
// A local file: nonempty .docx, at most 10 MiB. The server validates DOCX contents.
const batch = await client.documents.generateFromFile('./invoice.docx', {
  data: [{ Client_Name: 'Acme Corporation', Amount_Due: 1250 }],
  idempotencyKey: 'local-invoice-001',
});
```

Or provide Base64 directly:

```ts
import { readFile } from 'node:fs/promises';

const batch = await client.documents.generate({
  templateBase64: (await readFile('./invoice.docx')).toString('base64'),
  data: [{ Client_Name: 'Acme Corporation' }],
});
```

Map source fields to placeholders:

```ts
await client.documents.generate({
  templateUuid: 'e81d77a2-f674-4b53-a8ee-bf350284e311',
  data: [{ client: 'Acme Corporation', amount: 1250 }],
  variableMapping: { client: 'Client_Name', amount: 'Amount_Due' },
  format: 'zip', // the only supported format
});
```

Indexed rows:

```ts
await client.documents.generate({
  templateUuid: 'e81d77a2-f674-4b53-a8ee-bf350284e311',
  variables: ['Client_Name', 'Amount_Due'],
  data: [['Acme Corporation', 1250], ['Globex Industries', 3400]],
});
```

TRYDOKU validates template contents, schemas, mappings, and server limits during generation. Failures throw `ValidationError` with field paths such as `data.0.invoice_date`. The SDK checks the request shape locally; the [API reference](https://www.trydoku.com/docs/api/reference) describes the server contract.

## Immutable request builder

```ts
import { GenerateRequest } from '@trydoku/node';

const base = GenerateRequest.create()
  .withTemplateUuid('e81d77a2-f674-4b53-a8ee-bf350284e311')
  .withFormat('zip');
const request = base
  .withData([{ Client_Name: 'Acme Corporation' }])
  .withIdempotencyKey('invoice-001');

const batch = await client.documents.generateFromRequest(request);
```

Every setter returns a new builder and copies supplied data. Setting a UUID replaces the Base64 source and vice versa. `withVariables()` and `withVariableMapping()` support the same options as `generate()`. `toOptions()` and `toJSON()` require a complete valid request; `toJSON()` uses the API's snake_case names and omits the idempotency key.

## Idempotency

`idempotencyKey` becomes the `Idempotency-Key` header. Keys are trimmed and must contain 1–255 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, or `-`; blank values omit the header. The API replays successful 2xx responses for 24 hours for the same user, key, and body.

For HTTP 409 `IDEMPOTENCY_IN_PROGRESS`, retry the **same key and body**. A new key can duplicate a request that is still running. Reusing a key with a different body produces HTTP 422 `IDEMPOTENCY_KEY_CONFLICT`. The SDK leaves retry timing to the caller; `RateLimitError.retryAfter` exposes the server's delay in seconds.

## Status, polling and downloads

```ts
const current = await client.batches.get(batch.id);
console.log(current.status, current.setupStatus, current.processedItems);

const finished = await client.batches.waitForCompletion(batch.id, {
  maxAttempts: 30, // total status requests, including the first
  intervalMs: 2000,
  timeoutMs: 15_000, // timeout for each status request
});
```

Polling continues through `GENERATION_SETUP_PENDING` and `setup_pending`, including GET responses without the top-level code. It stops on batch completion, batch failure, or `setup_failed`. A failed row does not stop other rows from processing. Exhausting attempts throws `PollingTimeoutError` with `lastBatch`. No delay occurs after the final request.

Batch DTOs expose camelCase fields, ISO timestamp strings or `null`, immutable `links`/`items`, and helpers `isCompleted()`, `isProcessing()`, `isSetupPending()`, `isSetupFailed()`, `isTerminal()`, and `hasFailed()`. Items, when returned, expose `rowIndex`, `status`, `downloadUrl`, `error`, `isCompleted()` and `isFailed()`. The API may omit items; the SDK represents missing items as an empty array.

`downloadZip(id)` returns a `Buffer` without text conversion. Before completion it throws `BatchNotReadyError`. A completed batch with no remaining files throws `BatchFilesMissingError`. Archives include available successful DOCX rows; generated files are temporary, so download them promptly.

## Cancellation

```ts
const controller = new AbortController();
const pending = client.batches.waitForCompletion(batch.id, {
  signal: controller.signal,
  intervalMs: 2000,
});
controller.abort(new Error('Cancelled by application'));
await pending; // rejects with that same reason
```

Request signals cancel in-flight HTTP and polling delays. Caller cancellation preserves the signal's reason. A request timeout throws `RequestTimeoutError`. Other HTTP transport failures throw `TrydokuTransportError` with the original `cause`; local validation errors use `TypeError`, and filesystem errors retain their original type.

## Errors

```ts
import {
  TrydokuApiError, AuthenticationError, InsufficientCreditsError,
  ValidationError, RateLimitError,
} from '@trydoku/node';

try {
  await client.documents.generateSingle({
    templateUuid: 'e81d77a2-f674-4b53-a8ee-bf350284e311',
    data: { Client_Name: 'Acme Corporation' },
  });
} catch (error: unknown) {
  if (error instanceof AuthenticationError) {
    console.error('Check the API key:', error.code);
  } else if (error instanceof InsufficientCreditsError) {
    console.error(error.creditsAvailable, error.creditsRequired);
  } else if (error instanceof ValidationError) {
    console.error(error.errors);
  } else if (error instanceof RateLimitError) {
    console.error('Retry after', error.retryAfter, 'seconds');
  } else if (error instanceof TrydokuApiError) {
    console.error(error.status, error.code, error.message);
  } else {
    throw error;
  }
}
```

| Class | HTTP | Meaning |
| --- | --- | --- |
| `AuthenticationError` | 401 | Invalid/missing token or `TOKEN_EXPIRED` |
| `InsufficientCreditsError` | 402 | Not enough credits; available/required counts |
| `AuthorizationError` | 403 | Forbidden, unverified account or missing token ability |
| `NotFoundError` | 404 | Resource not found |
| `BatchNotReadyError` | 400 | `BATCH_NOT_READY` |
| `ConflictError` | 409 | Idempotency reservation in progress or other conflict |
| `BatchFilesMissingError` | 409 | `BATCH_FILES_MISSING` |
| `PayloadTooLargeError` | 413 | Payload exceeds the API boundary |
| `UnsupportedMediaTypeError` | 415 | Unsupported content encoding |
| `ValidationError` | 422 | Invalid input/schema, including `EMPTY_DATA_ROWS` |
| `IdempotencyKeyConflictError` | 422 | `IDEMPOTENCY_KEY_CONFLICT` |
| `RateLimitError` | 429 | Rate limited; optional `retryAfter` in seconds |
| `GenerationSetupFailedError` | 503 | `GENERATION_SETUP_FAILED`; API refunds credits |
| `TrydokuApiError` | Other | Unmapped API error or malformed successful response |

API errors retain `status`, the exact machine-readable `code` (or `null`), `details`, response `headers`, and raw `responseBody`. Malformed successful responses retain the actual success status/body. `PollingTimeoutError` has no HTTP status and exposes `batchId`, `maxAttempts`, and `lastBatch`.

## Supported API scope

The SDK covers the public v1 generation, batch status, and ZIP download endpoints used by the PHP SDK. `generateFromFile()` sends DOCX bytes as Base64 JSON; the server creates an internal template for generation and returns a batch. The current token-authenticated API provides DOCX output in ZIP archives. Template management, standalone variable validation, profile or credit-balance reads, individual downloads, and PDF output are outside this API's current scope. Item download URLs require a web session; use `batches.downloadZip()` with an API key.

## Development

Use Node.js 24 for development and Vitest. The SDK runtime supports Node.js 18+.

```bash
npm ci
npm run check         # strict source/test types, unit tests, ESM/CJS build, tarball consumer checks
npm run test:coverage
npm run test:watch
```

Tests mock HTTP, use temporary files for file-generation helpers, and verify polling and cancellation. The package checker tests the actual npm tarball with ESM/CommonJS runtime consumers, native fetch against a local HTTP server, and TypeScript consumers using Node 18 typings without DOM libraries. CI runs Vitest/build on Node 24 and checks the packed SDK on Node 18, 20, 22 and 24. No credentials or production calls are needed.

The repository's `docs/api/` directory contains the OpenAPI snapshot and API contract notes used to verify PHP parity.

For a release, verify the publish preview from this directory:

```bash
npm publish --dry-run
```

`prepublishOnly` runs the full check before publishing. `prepack` rebuilds the ESM/CJS output and declarations. The archive contains only `dist/`, `README.md`, `LICENSE`, and `package.json`. Publish with `npm publish` from an npm account allowed to publish under `@trydoku`.

## License and support

[MIT](LICENSE). Documentation: [trydoku.com/docs/api](https://www.trydoku.com/docs/api). Security reports: [support@trydoku.com](mailto:support@trydoku.com).
