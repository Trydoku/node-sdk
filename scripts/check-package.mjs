import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'trydoku-package-'));

function run(executable, args, cwd = root) {
  try {
    return execFileSync(executable, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error && typeof error === 'object') {
      if ('stdout' in error && error.stdout) process.stderr.write(String(error.stdout));
      if ('stderr' in error && error.stderr) process.stderr.write(String(error.stderr));
    }
    throw error;
  }
}

const runtimeChecks = `
const baseUrl = 'https://sdk-package.example.invalid/api/v1';
const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
const requests = [];
const fixture = {
  data: {
    id: 'packed-consumer-batch',
    status: 'completed',
    setup_status: 'ready',
    total_items: 1,
    processed_items: 1,
    failed_items: 0,
    created_at: '2026-10-04T12:00:00.000000Z',
    updated_at: '2026-10-04T12:00:01.000000Z',
    links: { self: baseUrl + '/batches/packed-consumer-batch', zip: baseUrl + '/batches/packed-consumer-batch/zip' },
    items: [{ row_index: 0, status: 'completed', download_url: 'https://files.example.invalid/document.docx', error: null }],
  },
};
async function mockFetch(input, init) {
  requests.push(String(input));
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer packed-test-key');
  assert.equal(init.redirect, 'error');
  if (String(input) === baseUrl + '/generate') {
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
    assert.equal(new Headers(init.headers).get('Idempotency-Key'), 'packed-consumer');
    assert.deepEqual(JSON.parse(init.body), { data: [{ Name: 'Ada' }], template_uuid: 'stored-template', format: 'zip' });
    return new Response(JSON.stringify(fixture), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(input) === baseUrl + '/batches/packed-consumer-batch/zip') {
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/zip' } });
  }
  throw new Error('Unexpected mock request: ' + input);
}
async function check() {
  assert.equal(Trydoku, NamedTrydoku);
  const client = new Trydoku({ apiKey: 'packed-test-key', baseUrl, fetch: mockFetch });
  const request = GenerateRequest.create()
    .withTemplateUuid('stored-template')
    .withData([{ Name: 'Ada' }])
    .withFormat('zip')
    .withIdempotencyKey('packed-consumer');
  const batch = await client.documents.generateFromRequest(request);
  assert(batch instanceof Batch);
  assert.equal(batch.id, 'packed-consumer-batch');
  assert.equal(batch.items[0].rowIndex, 0);
  assert(batch.items[0].isCompleted());
  assert(batch.isCompleted());
  assert(batch.isTerminal());
  const downloaded = await client.batches.downloadZip(batch.id);
  assert(Buffer.isBuffer(downloaded));
  assert.deepEqual(downloaded, bytes);
  assert.equal(requests.length, 2);
}
async function checkNativeFetch() {
  const nativeRequests = [];
  let handlerError;
  const server = createServer(async (request, response) => {
    try {
      nativeRequests.push(request.method + ' ' + request.url);
      assert.equal(request.headers.authorization, 'Bearer native-test-key');
      if (request.method === 'POST' && request.url === '/api/v1/generate') {
        assert.equal(request.headers['content-type'], 'application/json');
        assert.equal(request.headers['idempotency-key'], 'native-consumer');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
          data: [{ Name: 'Ada' }], template_uuid: 'stored-template', format: 'zip',
        });
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(fixture));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/v1/batches/packed-consumer-batch') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(fixture));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/v1/batches/packed-consumer-batch/zip') {
        response.writeHead(200, { 'Content-Type': 'application/zip' });
        response.end(bytes);
        return;
      }
      throw new Error('Unexpected native request: ' + request.method + ' ' + request.url);
    } catch (error) {
      handlerError = error;
      response.writeHead(500);
      response.end('Local package verification failed.');
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const nativeClient = new Trydoku({
      apiKey: 'native-test-key',
      baseUrl: 'http://127.0.0.1:' + address.port + '/api/v1',
      timeoutMs: 2000,
    });
    const generated = await nativeClient.documents.generate({
      templateUuid: 'stored-template', data: [{ Name: 'Ada' }], format: 'zip', idempotencyKey: 'native-consumer',
    });
    assert(generated instanceof Batch);
    assert.equal(generated.id, fixture.data.id);
    const status = await nativeClient.batches.get(generated.id);
    assert(status.isCompleted());
    const downloaded = await nativeClient.batches.downloadZip(generated.id);
    assert(Buffer.isBuffer(downloaded));
    assert.deepEqual(downloaded, bytes);
    assert.deepEqual(nativeRequests, [
      'POST /api/v1/generate',
      'GET /api/v1/batches/packed-consumer-batch',
      'GET /api/v1/batches/packed-consumer-batch/zip',
    ]);
    if (handlerError) throw handlerError;
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections?.();
    });
  }
}
`;

const typeChecks = `
import Trydoku, {
  Trydoku as NamedTrydoku,
  Batch,
  GenerateRequest,
  type GenerateOptions,
  type JsonObject,
  type RequestOptions,
} from '@trydoku/node';
import type { Buffer } from 'node:buffer';

const clientClass: typeof NamedTrydoku = Trydoku;
const fetcher: typeof globalThis.fetch = async (_input, _init) =>
  new Response('{}', { status: 200 });
const client = new clientClass({ apiKey: 'typecheck-key', fetch: fetcher });
const options: GenerateOptions = {
  templateUuid: 'stored-template',
  data: [{ Name: 'Ada', nested: [1, true, null, { value: 'JSON' }] }],
  format: 'zip',
};
const requestOptions: RequestOptions = { signal: new AbortController().signal, timeoutMs: 1000 };
const generated: Promise<Batch> = client.documents.generate(options, requestOptions);
const single: Promise<Batch> = client.documents.generateSingle({ templateBase64: 'base64', data: { Name: 'Ada' } });
const fromFile: Promise<Batch> = client.documents.generateFromFile('template.docx', { data: [['Ada']], variables: ['Name'] });
const request = GenerateRequest.create().withTemplateUuid('stored-template').withData([{ Name: 'Ada' }]);
const payload: JsonObject = request.toJSON();
const fromBuilder: Promise<Batch> = client.documents.generateFromRequest(request);
const status: Promise<Batch> = client.batches.get('batch-id');
const waited: Promise<Batch> = client.batches.waitForCompletion('batch-id', { maxAttempts: 2, intervalMs: 0 });
const downloaded: Promise<Buffer> = client.batches.downloadZip('batch-id');

// @ts-expect-error The two template sources are mutually exclusive.
const twoSources: GenerateOptions = { templateUuid: 'id', templateBase64: 'base64', data: [{}] };
// @ts-expect-error A template source is required.
const missingSource: GenerateOptions = { data: [{}] };
// @ts-expect-error The API supports only ZIP generation output.
const unsupportedFormat: GenerateOptions = { templateUuid: 'id', data: [{}], format: 'pdf' };
// @ts-expect-error Document rows must be objects or positional lists.
const primitiveRow: GenerateOptions = { templateUuid: 'id', data: ['Ada'] };
// @ts-expect-error Undefined cannot be represented as a JSON value.
const invalidJson: GenerateOptions = { templateUuid: 'id', data: [{ Name: undefined }] };

void [generated, single, fromFile, fromBuilder, status, waited, downloaded, payload];
void [twoSources, missingSource, unsupportedFormat, primitiveRow, invalidJson];
`;

try {
  // Bypass lifecycle hooks to avoid recursion. A publish preview inherits
  // dry-run mode, but this check needs a real local archive to test consumers.
  const packArguments = ['pack', '--ignore-scripts', '--dry-run=false', '--json', '--pack-destination', temporaryRoot];
  const npmCli = process.env.npm_execpath;
  const packedOutput = npmCli?.endsWith('.js')
    ? run(process.execPath, [npmCli, ...packArguments])
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', packArguments);
  const packed = JSON.parse(packedOutput);
  assert(Array.isArray(packed) && packed.length === 1, 'npm pack must produce one local package.');
  const archive = join(temporaryRoot, packed[0].filename);
  const fileNames = new Set(packed[0].files.map((file) => file.path));
  assert.deepEqual([...fileNames].sort(), [
    'LICENSE', 'README.md', 'package.json',
    'dist/index.js', 'dist/index.js.map', 'dist/index.d.ts',
    'dist/index.cjs', 'dist/index.cjs.map', 'dist/index.d.cts',
  ].sort(), 'The npm archive must contain only the build, README, license and manifest.');

  const unpacked = join(temporaryRoot, 'unpacked');
  const consumer = join(temporaryRoot, 'consumer');
  await mkdir(unpacked);
  await mkdir(join(consumer, 'node_modules', '@trydoku'), { recursive: true });
  await mkdir(join(consumer, 'node_modules', '@types'), { recursive: true });
  await symlink(join(root, 'node_modules', '@types', 'node18'), join(consumer, 'node_modules', '@types', 'node'), 'junction');
  run('tar', ['-xzf', archive, '-C', unpacked]);
  const packedPackage = join(unpacked, 'package');
  await symlink(packedPackage, join(consumer, 'node_modules', '@trydoku', 'node'), 'junction');
  const manifest = JSON.parse(await readFile(join(packedPackage, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@trydoku/node');
  for (const dependencyField of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(Object.keys(manifest[dependencyField] ?? {}).length, 0, `${dependencyField} must remain empty.`);
  }
  assert.equal(manifest.main, './dist/index.cjs');
  assert.equal(manifest.module, './dist/index.js');
  assert.equal(manifest.types, './dist/index.d.ts');
  assert.deepEqual(manifest.exports['.'], {
    import: { types: './dist/index.d.ts', default: './dist/index.js' },
    require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
  });

  await writeFile(join(consumer, 'esm.mjs'), `
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import Trydoku, { Trydoku as NamedTrydoku, Batch, GenerateRequest } from '@trydoku/node';
${runtimeChecks}
await check();
await checkNativeFetch();
`);
  await writeFile(join(consumer, 'commonjs.cjs'), `
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { createServer } = require('node:http');
const { default: Trydoku, Trydoku: NamedTrydoku, Batch, GenerateRequest } = require('@trydoku/node');
${runtimeChecks}
check().then(checkNativeFetch).catch((error) => { console.error(error); process.exitCode = 1; });
`);
  run(process.execPath, [join(consumer, 'esm.mjs')], consumer);
  run(process.execPath, [join(consumer, 'commonjs.cjs')], consumer);

  await writeFile(join(consumer, 'esm.mts'), typeChecks);
  await writeFile(join(consumer, 'commonjs.cts'), `${typeChecks}
import sdk = require('@trydoku/node');
const requireDefault: typeof NamedTrydoku = sdk.default;
const requireNamed: typeof NamedTrydoku = sdk.Trydoku;
void [requireDefault, requireNamed];
`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      skipLibCheck: false,
      esModuleInterop: true,
      types: ['node'],
      typeRoots: [join(consumer, 'node_modules', '@types')],
    },
    files: ['esm.mts', 'commonjs.cts'],
  }, null, 2));
  const compilerPackage = JSON.parse(await readFile(join(root, 'node_modules', 'typescript', 'package.json'), 'utf8'));
  const nodeTypesPackage = JSON.parse(await readFile(join(root, 'node_modules', '@types', 'node18', 'package.json'), 'utf8'));
  assert.match(compilerPackage.version, /^5\.9\./, 'Package consumers must be checked with TypeScript 5.9.');
  assert.match(nodeTypesPackage.version, /^18\./, 'Package consumers must be checked with Node.js 18 typings.');
  const checkedFiles = run(process.execPath, [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', join(consumer, 'tsconfig.json'), '--listFiles',
  ], consumer).split(/\r?\n/).filter(Boolean).map((path) => resolve(path));
  const modernNodeTypes = join(root, 'node_modules', '@types', 'node');
  assert(!checkedFiles.some((path) => path.startsWith(modernNodeTypes + sep)),
    'Modern development Node typings must not enter the Node.js 18 consumer check.');
  const permittedNodeTypes = [join(root, 'node_modules', '@types', 'node18'), join(consumer, 'node_modules', '@types', 'node')];
  assert(checkedFiles.some((path) => permittedNodeTypes.some((prefix) => path.startsWith(prefix + sep))),
    'The consumer check must load the isolated Node.js 18 typings.');
  console.log(`Packed ESM/CommonJS consumers, native fetch and Node-only TypeScript declarations passed on ${process.version}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
