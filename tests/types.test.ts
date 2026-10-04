import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  Batch, BatchItem, BatchLinks, GenerateRequest, Trydoku,
  type DataRow, type GenerateOptions, type GenerateSingleOptions, type JsonValue,
} from '../src/index.ts';
import { batchEnvelope } from './helpers.ts';

describe('batch DTOs', () => {
  it('maps envelope fields and retains ISO timestamps as strings', () => {
    const batch = Batch.fromApiResponse(batchEnvelope({
      updated_at: '2026-07-16T18:20:05.000000Z',
      items: [{ row_index: 0, status: 'completed', download_url: 'https://example.com/0.docx', error: null }],
    }, 'FUTURE_INFO_CODE'));

    expect(batch.id).toBe('batch-1');
    expect(batch.setupStatus).toBe('ready');
    expect(batch.totalItems).toBe(2);
    expect(batch.processedItems).toBe(0);
    expect(batch.failedItems).toBe(0);
    expect(batch.createdAt).toBe('2026-07-16T18:20:00.000000Z');
    expect(batch.updatedAt).toBe('2026-07-16T18:20:05.000000Z');
    expect(batch.links).toBeInstanceOf(BatchLinks);
    expect(batch.links.self).toBe('https://www.trydoku.com/api/v1/batches/batch-1');
    expect(batch.links.zip).toBeNull();
    expect(batch.code).toBe('FUTURE_INFO_CODE');
    expect(batch.items[0]?.rowIndex).toBe(0);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.items)).toBe(true);
    expect(Object.isFrozen(batch.links)).toBe(true);
  });

  it('supports absent optional setup/timestamp/item fields and empty optional links', () => {
    const batch = Batch.fromArray({ id: 'batch', status: 'processing', total_items: 1, processed_items: 0, failed_items: 0, links: { self: '/batches/batch', zip: '' } });

    expect(batch.setupStatus).toBe('');
    expect(batch.createdAt).toBeNull();
    expect(batch.updatedAt).toBeNull();
    expect(batch.items).toEqual([]);
    expect(batch.code).toBeNull();
    expect(batch.links.zip).toBeNull();
  });

  it('reports row success and failure independently', () => {
    const completed = BatchItem.fromArray({ row_index: 0, status: 'completed' });
    const failed = BatchItem.fromArray({ row_index: 1, status: 'failed', error: 'Failed row' });
    const pending = BatchItem.fromArray({ row_index: 2, status: 'processing' });

    expect(completed.isCompleted()).toBe(true);
    expect(completed.isFailed()).toBe(false);
    expect(failed.isCompleted()).toBe(false);
    expect(failed.isFailed()).toBe(true);
    expect(pending.isCompleted()).toBe(false);
    expect(pending.isFailed()).toBe(false);
  });

  it.each(['pending', 'setup_pending'])('recognizes %s setup without an envelope code', (setup_status) => {
    const batch = Batch.fromApiResponse(batchEnvelope({ setup_status }));
    expect(batch.isSetupPending()).toBe(true);
    expect(batch.isSetupFailed()).toBe(false);
    expect(batch.isTerminal()).toBe(false);
  });

  it.each(['failed', 'setup_failed'])('recognizes %s setup as terminal', (setup_status) => {
    const batch = Batch.fromApiResponse(batchEnvelope({ setup_status }));
    expect(batch.isSetupFailed()).toBe(true);
    expect(batch.isTerminal()).toBe(true);
  });

  it('recognizes setup pending/failed codes independently of setup_status', () => {
    expect(Batch.fromApiResponse(batchEnvelope({}, 'GENERATION_SETUP_PENDING')).isSetupPending()).toBe(true);
    expect(Batch.fromApiResponse(batchEnvelope({}, 'GENERATION_SETUP_FAILED')).isSetupFailed()).toBe(true);
  });

  it('distinguishes processing, row failures, completion, terminal failures, and future statuses', () => {
    const processing = Batch.fromApiResponse(batchEnvelope({ failed_items: 1 }));
    const completed = Batch.fromApiResponse(batchEnvelope({ status: 'completed' }));
    const failed = Batch.fromApiResponse(batchEnvelope({ status: 'failed' }));
    const future = Batch.fromApiResponse(batchEnvelope({ status: 'queued' }));

    expect(processing.isProcessing()).toBe(true);
    expect(processing.hasFailed()).toBe(true);
    expect(processing.isTerminal()).toBe(false);
    expect(completed.isCompleted()).toBe(true);
    expect(completed.isTerminal()).toBe(true);
    expect(failed.isCompleted()).toBe(false);
    expect(failed.isTerminal()).toBe(true);
    expect(future.isProcessing()).toBe(false);
    expect(future.isTerminal()).toBe(false);
  });

  it.each([null, [], { data: null }, { data: [] }, { data: batchEnvelope().data, code: 42 }])('rejects malformed envelopes (%j)', (value) => {
    expect(() => Batch.fromApiResponse(value)).toThrow(TypeError);
  });
});

describe('GenerateRequest', () => {
  it('creates an empty builder and requires a complete request before serialization', () => {
    const request = GenerateRequest.create();
    expect(request.hasTemplate()).toBe(false);
    expect(request.idempotencyKey()).toBeNull();
    expect(() => request.toOptions()).toThrow(TypeError);
    expect(() => request.toJSON()).toThrow(TypeError);
  });

  it('supports every builder method and serializes snake-case fields without the idempotency key', () => {
    const request = GenerateRequest.create()
      .withTemplateUuid('uuid')
      .withData([{ Source: 'Alice' }])
      .withVariables(['Name'])
      .withVariableMapping({ Source: 'Name' })
      .withFormat('zip')
      .withIdempotencyKey(' request-123 ');

    expect(request.hasTemplate()).toBe(true);
    expect(request.idempotencyKey()).toBe('request-123');
    expect(request.toJSON()).toEqual({ template_uuid: 'uuid', data: [{ Source: 'Alice' }], variables: ['Name'], variable_mapping: { Source: 'Name' }, format: 'zip' });
    expect(request.toOptions()).toEqual({ templateUuid: 'uuid', data: [{ Source: 'Alice' }], variables: ['Name'], variableMapping: { Source: 'Name' }, format: 'zip', idempotencyKey: 'request-123' });
    expect(JSON.parse(JSON.stringify(request)) as unknown).toEqual(request.toJSON());
  });

  it('immutably replaces either template source and keeps earlier builders independent', () => {
    const empty = GenerateRequest.create();
    const uuid = empty.withTemplateUuid('uuid').withData([{}]);
    const base64 = uuid.withTemplateBase64('UEsDBAoAAAA=');
    const replaced = base64.withTemplateUuid('new-uuid');

    expect(empty.hasTemplate()).toBe(false);
    expect(uuid.toJSON()).toEqual({ template_uuid: 'uuid', data: [{}] });
    expect(base64.toJSON()).toEqual({ template_base64: 'UEsDBAoAAAA=', data: [{}] });
    expect(replaced.toJSON()).toEqual({ template_uuid: 'new-uuid', data: [{}] });
  });

  it('copies caller data, variables, and mappings so later mutation cannot change a request', () => {
    const data = [{ Name: 'Alice', details: { city: 'Prague' } }];
    const variables = ['Name'];
    const mapping = { Name: 'Client_Name' };
    const request = GenerateRequest.create().withTemplateUuid('uuid').withData(data).withVariables(variables).withVariableMapping(mapping);
    data[0]!.Name = 'Bob';
    data[0]!.details.city = 'Bratislava';
    variables.push('Unexpected');
    mapping.Name = 'Different';

    expect(request.toJSON()).toEqual({ template_uuid: 'uuid', data: [{ Name: 'Alice', details: { city: 'Prague' } }], variables: ['Name'], variable_mapping: { Name: 'Client_Name' } });
  });

  it('safely preserves a JSON __proto__ field as data', () => {
    const row = JSON.parse('{"__proto__":{"polluted":true},"Name":"Alice"}') as DataRow;
    const payload = GenerateRequest.create().withTemplateUuid('uuid').withData([row]).toJSON();
    const decoded = JSON.parse(JSON.stringify(payload)) as unknown;
    expect(decoded).toEqual({ template_uuid: 'uuid', data: [JSON.parse('{"__proto__":{"polluted":true},"Name":"Alice"}') as unknown] });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('treats blank idempotency keys as absent and allows clearing a previous key', () => {
    const request = GenerateRequest.create().withTemplateUuid('uuid').withData([{}]).withIdempotencyKey('request');
    expect(request.withIdempotencyKey('  ').idempotencyKey()).toBeNull();
    expect(request.withIdempotencyKey(null).idempotencyKey()).toBeNull();
    expect(request.withIdempotencyKey(null).toOptions()).not.toHaveProperty('idempotencyKey');
  });

  it('rejects invalid keys, incomplete data, and blank template sources', () => {
    expect(() => GenerateRequest.create().withIdempotencyKey('invalid key')).toThrow(TypeError);
    expect(() => GenerateRequest.create().withTemplateUuid('uuid').toJSON()).toThrow(TypeError);
    const request = GenerateRequest.create().withTemplateUuid('   ').withData([{}]);
    expect(request.hasTemplate()).toBe(false);
    expect(() => request.toJSON()).toThrow(TypeError);
  });
});

describe('public TypeScript contracts', () => {
  it('accepts JSON rows and enforces template source, output format, and JSON types at compile time', () => {
    // This function is typechecked by `tsc` but never performs HTTP requests.
    function typechecks(client: Trydoku): void {
      const json: JsonValue = { array: [1, true, null, { name: 'Alice' }] };
      const uuid: GenerateOptions = { templateUuid: 'uuid', data: [{ nested: json }], format: 'zip' };
      const base64: GenerateOptions = { templateBase64: 'UEsDBAoAAAA=', data: [['Alice', 42]] };
      const single: GenerateSingleOptions = { templateUuid: 'uuid', data: { Name: 'Alice' } };
      void client.documents.generate(uuid);
      void client.documents.generate(base64);
      void client.documents.generateSingle(single);
      // @ts-expect-error One template source is required.
      const missing: GenerateOptions = { data: [{}] };
      // @ts-expect-error A UUID and base64 cannot be combined.
      const conflicting: GenerateOptions = { templateUuid: 'uuid', templateBase64: 'base64', data: [{}] };
      // @ts-expect-error The v1 API only supports ZIP.
      const format: GenerateOptions = { templateUuid: 'uuid', data: [{}], format: 'pdf' };
      // @ts-expect-error Dates are not JSON values.
      const date: JsonValue = new Date();
      // @ts-expect-error Undefined values cannot be serialized faithfully as JSON.
      const undefinedValue: JsonValue = undefined;
      // @ts-expect-error BigInt cannot be represented by JSON.
      const bigint: JsonValue = 1n;
      // @ts-expect-error A batch row must be an object or array.
      const primitiveRow: GenerateOptions = { templateUuid: 'uuid', data: [12] };
      void [missing, conflicting, format, date, undefinedValue, bigint, primitiveRow];
    }
    expectTypeOf(typechecks).toBeFunction();
  });
});
