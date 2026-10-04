import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Trydoku, Batch, GenerateRequest, TrydokuApiError, type GenerateOptions } from '../src/index.ts';
import { batchEnvelope, jsonResponse, mockFetch, requestBody, requestHeaders } from './helpers.ts';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryFile(name: string, content: Uint8Array = Buffer.from('DOCX template bytes')): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'trydoku-sdk-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}

describe('documents', () => {
  it('generates a batch using a template UUID and maps options to the API wire names', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope(), 201));
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });

    const batch = await client.documents.generate({
      templateUuid: 'template-uuid',
      data: [{ client_name: 'Acme', amount: 123.45 }, { client_name: 'Globex', amount: 50 }],
      variables: ['Client_Name', 'Amount'],
      variableMapping: { client_name: 'Client_Name', amount: 'Amount' },
      format: 'zip',
      idempotencyKey: ' invoice-2026-10-01 ',
    });

    expect(batch).toBeInstanceOf(Batch);
    expect(batch.id).toBe('batch-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://www.trydoku.com/api/v1/generate');
    expect(init?.method).toBe('POST');
    expect(requestHeaders(init).get('content-type')).toBe('application/json');
    expect(requestHeaders(init).get('idempotency-key')).toBe('invoice-2026-10-01');
    expect(requestBody(init)).toEqual({
      template_uuid: 'template-uuid',
      data: [{ client_name: 'Acme', amount: 123.45 }, { client_name: 'Globex', amount: 50 }],
      variables: ['Client_Name', 'Amount'],
      variable_mapping: { client_name: 'Client_Name', amount: 'Amount' },
      format: 'zip',
    });
  });

  it('generates from a base64 template with positional rows and nested JSON values', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope(), 201));
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });
    const data = [['Acme', 12, true, null, { nested: ['one', 'two'] }]] as const;

    await client.documents.generate({ templateBase64: 'UEsDBAoAAAA=', data });

    expect(requestBody(fetchMock.mock.calls[0]![1])).toEqual({ template_base64: 'UEsDBAoAAAA=', data });
    expect(requestHeaders(fetchMock.mock.calls[0]![1]).has('idempotency-key')).toBe(false);
  });

  it('wraps a single object row into a one-row batch', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope({ total_items: 1 }), 201));
    const batch = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateSingle({ templateUuid: 'uuid', data: { Name: 'Alice' } });

    expect(batch.totalItems).toBe(1);
    expect(requestBody(fetchMock.mock.calls[0]![1])).toEqual({ template_uuid: 'uuid', data: [{ Name: 'Alice' }] });
  });

  it('wraps a single positional row without flattening or splitting its values', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope(), 201));
    await new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateSingle({ templateUuid: 'uuid', data: ['Alice', 42], variables: ['Name', 'Age'] });

    expect(requestBody(fetchMock.mock.calls[0]![1])).toEqual({ template_uuid: 'uuid', data: [['Alice', 42]], variables: ['Name', 'Age'] });
  });

  it('generates from the fluent builder with the same idempotency header', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope(), 201));
    const request = GenerateRequest.create().withTemplateUuid('uuid').withData([{ Name: 'Alice' }]).withIdempotencyKey('req-123');

    await new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateFromRequest(request);

    expect(requestBody(fetchMock.mock.calls[0]![1])).toEqual(request.toJSON());
    expect(requestHeaders(fetchMock.mock.calls[0]![1]).get('idempotency-key')).toBe('req-123');
  });

  it('reads a DOCX file and submits its exact base64 bytes in JSON', async () => {
    const bytes = Uint8Array.of(0, 1, 127, 128, 254, 255, 80, 75);
    const path = await temporaryFile('template.docx', bytes);
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope(), 201));

    await new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateFromFile(path, { data: [{ Name: 'Alice' }], format: 'zip', idempotencyKey: 'file-request' });

    expect(requestBody(fetchMock.mock.calls[0]![1])).toEqual({ template_base64: Buffer.from(bytes).toString('base64'), data: [{ Name: 'Alice' }], format: 'zip' });
    expect(requestHeaders(fetchMock.mock.calls[0]![1]).get('idempotency-key')).toBe('file-request');
  });

  it('rejects unsupported file extensions before fetching', async () => {
    const path = await temporaryFile('template.pdf');
    const fetchMock = mockFetch();

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateFromFile(path, { data: [{}] })).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a template exceeding 10 MiB before fetching', async () => {
    const path = await temporaryFile('large.docx');
    await truncate(path, 10 * 1024 * 1024 + 1);
    const fetchMock = mockFetch();

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateFromFile(path, { data: [{}] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unreadable files without making an HTTP request', async () => {
    const path = await temporaryFile('missing.docx');
    await rm(path);
    const fetchMock = mockFetch();

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateFromFile(path, { data: [{}] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes HTTP 202 setup-pending state and its code', async () => {
    const fetchMock = mockFetch().mockResolvedValue(jsonResponse(batchEnvelope({ setup_status: 'setup_pending' }, 'GENERATION_SETUP_PENDING'), 202));
    const batch = await new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generate({ templateUuid: 'uuid', data: [{}] });

    expect(batch.code).toBe('GENERATION_SETUP_PENDING');
    expect(batch.isSetupPending()).toBe(true);
    expect(batch.isTerminal()).toBe(false);
  });

  it.each([
    { data: [{}] },
    { templateUuid: 'uuid', templateBase64: 'base64', data: [{}] },
    { templateUuid: '   ', data: [{}] },
    { templateBase64: '', data: [{}] },
    { templateUuid: 'uuid', data: [] },
    { templateUuid: 'uuid', data: Array.from({ length: 501 }, () => ({})) },
    { templateUuid: 'uuid', data: ['not a row'] },
    { templateUuid: 'uuid', data: [{ amount: Number.NaN }] },
    { templateUuid: 'uuid', data: [{ amount: Number.POSITIVE_INFINITY }] },
    { templateUuid: 'uuid', data: [{ created: new Date() }] },
    { templateUuid: 'uuid', data: [{ ignored: undefined }] },
    { templateUuid: 'uuid', data: [{ value: 12n }] },
    { templateUuid: 'uuid', data: [{}], variables: [12] },
    { templateUuid: 'uuid', data: [{}], variableMapping: { Name: 12 } },
    { templateUuid: 'uuid', data: [{}], format: 'pdf' },
    { templateUuid: 'uuid', data: [{}], idempotencyKey: 'invalid key!' },
    { templateUuid: 'uuid', data: [{}], idempotencyKey: 'x'.repeat(256) },
  ])('rejects invalid generation options before fetching (case %#)', async (options) => {
    const fetchMock = mockFetch();

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generate(options as unknown as GenerateOptions)).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects circular JSON, sparse rows, and sparse nested arrays locally', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const sparseRows: unknown[] = [];
    sparseRows.length = 1;
    const sparseValues: unknown[] = [];
    sparseValues.length = 1;
    const fetchMock = mockFetch();
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });

    for (const data of [[circular], sparseRows, [{ values: sparseValues }]]) {
      await expect(client.documents.generate({ templateUuid: 'uuid', data } as unknown as GenerateOptions)).rejects.toBeInstanceOf(TypeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['not json', '{"ok":true}', '{"data":null}', '{"data":{"id":"incomplete"}}'])('rejects malformed successful responses and keeps HTTP status/body (%s)', async (body) => {
    const fetchMock = mockFetch().mockResolvedValue(new Response(body, { status: 201 }));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generate({ templateUuid: 'uuid', data: [{}] });

    await expect(request).rejects.toBeInstanceOf(TrydokuApiError);
    await expect(request).rejects.toMatchObject({ status: 201, responseBody: body });
  });

  it('passes request-level abort options through generateSingle and generateFromRequest', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled');
    controller.abort(reason);
    const fetchMock = mockFetch();
    const client = new Trydoku({ apiKey: 'key', fetch: fetchMock });

    await expect(client.documents.generateSingle({ templateUuid: 'uuid', data: {} }, { signal: controller.signal })).rejects.toBe(reason);
    await expect(client.documents.generateFromRequest(GenerateRequest.create().withTemplateUuid('uuid').withData([{}]), { signal: controller.signal })).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
