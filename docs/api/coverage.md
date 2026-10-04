# Verified API coverage

Verified on **2026-10-04** against the [public OpenAPI specification](https://www.trydoku.com/docs/api/api.json), the PHP SDK, and the Laravel runtime sources listed in [README.md](README.md). No API token or live generation request was used.

## Customer API

All three operations use bearer authentication, require a verified account, and operate on the authenticated user's resources. The base URL is `https://www.trydoku.com/api/v1`.

| Method | Path | Required token ability | Behavior |
| --- | --- | --- | --- |
| POST | `/generate` | `documents:generate` | Generate one document per JSON row; returns an asynchronous batch. |
| GET | `/batches/{batchId}` | `batches:read` | Read batch status, counters, and links. |
| GET | `/batches/{batchId}/zip` | `batches:download` | Download available completed DOCX documents as ZIP. |

These are also the complete HTTP operation surface of the existing PHP SDK. Single generation is a batch containing one row; batch generation uses the same endpoint with multiple rows.

## Generation request

`POST /generate` accepts JSON with exactly one of `template_uuid` or `template_base64`:

| Field | Shape and server constraints |
| --- | --- |
| `template_uuid` | UUID of a stored template owned by the user. |
| `template_base64` | Strict padded Base64 of a non-macro DOCX OPC package, at most 10 MiB decoded. The server creates an internal template for generation and returns a batch. |
| `data` | 1–500 object rows, or dense indexed rows paired with `variables`. Empty-only rows are removed; `0` and `false` count as values. |
| `variables` | For indexed rows: 1–100 unique names, at most 128 UTF-8 bytes each. |
| `variable_mapping` | Optional source-field-to-placeholder object, at most 100 unique targets. |
| `format` | `"zip"` or omitted/null. DOCX/PDF are not accepted generation format selectors. |

Additional server boundaries: raw request body at most 20 MiB; canonical data at most 5 MiB; 50,000 data nodes; three row nesting levels; 50,000 UTF-8 bytes per string. Content encoding must be absent or `identity`.

The optional `Idempotency-Key` header accepts 1–255 characters matching `[A-Za-z0-9._-]`; blank values are treated as absent. Successful responses are replayed for 24 hours for the same user, key, and request body. A reservation still in progress returns 409 `IDEMPOTENCY_IN_PROGRESS`; reusing the key with a different body returns 422 `IDEMPOTENCY_KEY_CONFLICT`. Retry an in-progress operation using its original key.

## Batch responses and polling

Successful JSON responses use `{ "data": { ...batch } }`. The batch fields are:

```ts
interface ApiBatchPayload {
  id: string;
  status: string;
  setup_status: string;
  total_items: number;
  processed_items: number;
  failed_items: number;
  created_at: string | null;
  updated_at: string | null;
  links: { self: string; zip: string | null };
  items?: Array<{
    row_index: number;
    status: string;
    download_url: string | null;
    error: string | null;
  }>;
}
```

Observed batch statuses in the server code are `pending`, `processing`, `completed`, and `failed`; row statuses are `queued`, `processing`, `completed`, and `failed`. Setup states are `setup_pending`, `ready`, and `setup_failed`. The generated OpenAPI uses open string fields rather than closed enums, so clients should preserve unrecognized future values.

Generation normally returns HTTP 201. A committed batch awaiting setup returns HTTP 202 with top-level `code: "GENERATION_SETUP_PENDING"`, `Location`, and `Retry-After: 5`. An unrecoverable setup failure returns HTTP 503 `GENERATION_SETUP_FAILED`; credits are refunded by the backend. Polling must recognize the raw `setup_pending` state even when the top-level code is absent. It should stop on `status: "completed"`, `status: "failed"`, or `setup_status: "setup_failed"`, and continue while setup is pending.

`items` is optional: the resource includes rows only when the ORM relationship is loaded. The current GET controller does not explicitly load it. Missing rows must therefore be treated as an empty list, without assuming that the batch has no documents. A completed batch can contain failed rows; compare `failed_items` before treating an archive as complete.

## Downloads

The supported token-authenticated download is the ZIP endpoint. The archive builder stores available completed documents as `.docx` entries under `trydoku.com_results/`, with names based on the one-based row index and sanitized template name. Combined entry size is limited to 50 MiB. Failed rows and missing files are skipped. No available output produces HTTP 409 `BATCH_FILES_MISSING`; an unfinished batch produces HTTP 400 `BATCH_NOT_READY`.

The API resource's individual `download_url` points to `/api/batch/items/{hashedBatchItemId}/docx`, a session-authenticated web route. The PDF counterpart is likewise a session route. Bearer tokens do not grant access to either route. The current API ZIP contains DOCX files only.

## Errors

The runtime generally emits:

```json
{
  "error": { "code": "VALIDATION_FAILED", "message": "The given data was invalid.", "details": {} },
  "message": "The given data was invalid.",
  "errors": { "data": ["Validation message"] }
}
```

`errors` is present for field validation. Insufficient-credit responses additionally include `credits_available` and `credits_required` both at the top level and within `error.details`. Setup failure may provide only the nested error. Clients should preserve the exact status, code, body, details, and useful headers, and handle non-JSON proxy error responses.

| HTTP | Verified API codes |
| --- | --- |
| 400 | `BATCH_NOT_READY` |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| 402 | `INSUFFICIENT_CREDITS` |
| 403 | `FORBIDDEN`, `INSUFFICIENT_TOKEN_ABILITY` |
| 404 | `RESOURCE_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `IDEMPOTENCY_IN_PROGRESS`, `BATCH_FILES_MISSING` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_CONTENT_ENCODING` |
| 422 | `VALIDATION_FAILED`, `EMPTY_DATA_ROWS`, `IDEMPOTENCY_KEY_CONFLICT` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_SERVER_ERROR` |
| 503 | `GENERATION_SETUP_FAILED` |

## OpenAPI discrepancies

The snapshot is retained unchanged as source evidence. A few generated schema details are incomplete or conflict with runtime behavior:

- `GenerateDocumentRequest.data.items` says `string`, while the controller annotation and canonicalizer accept object/indexed rows. The request uses `allOf` and also includes the annotation describing object rows. The SDK follows the runtime row contract.
- The generated schema does not encode mutual exclusion of the two template sources; the FormRequest enforces it.
- Some generated error schemas mark `error.details` as a string even though the runtime returns an object. The SDK treats error details as structured unknown data.
- Shared authentication responses do not enumerate all middleware error codes and response statuses. The runtime renderer and API tests supplement the snapshot.
- PHP polling recognizes `pending`/`failed` setup values, but the backend emits `setup_pending`/`setup_failed`. The Node client recognizes both forms.

## SDK scope

The Node SDK covers the same three authenticated operations as the PHP SDK, with convenience methods for single rows, local DOCX files, request builders, and polling. Template management, standalone variable validation, account/profile or credit-balance reads, individual downloads, and PDF output have no public bearer-authenticated v1 operation. Session-authenticated web routes are separate from this SDK contract.
