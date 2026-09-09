// Dependency-free regression tests for the browser library.
// Run with: node --test
//
// OrdJS.js is a classic script, so it is evaluated with the browser globals it
// uses stubbed out. These tests exercise the recursive-endpoint routes, the
// empty-sat result, base64 conversion of large content and decoder loading.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = await readFile(fileURLToPath(new URL('../src/content/OrdJS.js', import.meta.url)), 'utf8');

function load({ body, script } = {}) {
  const calls = [];
  const scripts = [];
  const fetchStub = async (url) => {
    calls.push(url);
    return body(url);
  };
  const documentStub = {
    createElement: () => ({}),
    head: {
      appendChild(element) {
        scripts.push(element.src);
        // script may be a function so a test can change the outcome between loads.
        const outcome = typeof script === 'function' ? script() : script;
        queueMicrotask(() => (outcome === 'fail' ? element.onerror(new Error('load failed')) : element.onload()));
      }
    }
  };
  // Node-only globals are shadowed with undefined so the inscribed source cannot
  // silently depend on something a browser does not have (Buffer is the one that
  // matters: the base version used it and it must never come back).
  const factory = new Function(
    'fetch', 'document', 'btoa', 'CBOR', 'window', 'Buffer', 'process', 'require', 'global',
    `${source}\nreturn OrdJS;`
  );
  const Ctor = factory(
    fetchStub,
    documentStub,
    (binary) => globalThis.Buffer.from(binary, 'binary').toString('base64'),
    { decode: (buffer) => ({ decoded: [...new Uint8Array(buffer)] }) },
    { location: { pathname: '/content/abci0' } },
    undefined,
    undefined,
    undefined,
    undefined
  );
  return { OrdJS: Ctor, calls, scripts };
}

const json = (value) => async () => ({ ok: true, json: async () => value });

const binary = (bytes) => async () => ({
  ok: true,
  headers: { get: () => 'application/octet-stream' },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
});

test('numeric index and page select their exact sat routes', async () => {
  const { OrdJS, calls } = load({ body: json({ ok: true }) });
  const ord = new OrdJS('');

  await ord.getSatInscriptions(123, '', 0);
  await ord.getSatInscriptions(123, '', -1);
  await ord.getSatInscriptions(123, 0);
  await ord.getSatInscriptions(123);

  assert.deepEqual(calls, ['/r/sat/123/at/0', '/r/sat/123/at/-1', '/r/sat/123/0', '/r/sat/123']);
});

test('page and index together are rejected before any request', async () => {
  const { OrdJS, calls } = load({ body: json({ ok: true }) });
  const ord = new OrdJS('');

  await assert.rejects(ord.getSatInscriptions(123, 2, -1), /Provide either page or index/);
  assert.deepEqual(calls, []);
});

test('an empty sat resolves to null after a single request', async () => {
  const { OrdJS, calls } = load({ body: json({ id: null }) });
  const ord = new OrdJS('');

  assert.equal(await ord.getSatLastInscriptionContent(1), null);
  assert.deepEqual(calls, ['/r/sat/1/at/-1']);
});

test('a populated sat still fetches its content', async () => {
  const payload = Uint8Array.from([1, 2, 3]);
  const { OrdJS, calls } = load({
    body: (url) => (url.startsWith('/r/') ? json({ id: 'abci0' })() : binary(payload)())
  });
  const ord = new OrdJS('');

  const content = await ord.getSatLastInscriptionContent(1);
  assert.equal(content.base64, Buffer.from(payload).toString('base64'));
  assert.deepEqual(calls, ['/r/sat/1/at/-1', '/content/abci0']);
});

test('content of any size round-trips exactly', async () => {
  for (const size of [0, 1, 2, 3, 1024 * 1024]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256);
    const { OrdJS } = load({ body: binary(bytes) });

    const content = await new OrdJS('').getInscriptionContent('abci0');
    assert.equal(content.mime, 'application/octet-stream');
    assert.deepEqual(Buffer.from(content.base64, 'base64'), Buffer.from(bytes), `size ${size}`);
  }
});

test('concurrent decoded metadata loads the decoder once', async () => {
  const { OrdJS, scripts } = load({ body: json('0102') });
  const ord = new OrdJS('');

  const [first, second] = await Promise.all([
    ord.getDecodedMetadata('abci0'),
    ord.getDecodedMetadata('abci0')
  ]);

  assert.deepEqual(first, { decoded: [1, 2] });
  assert.deepEqual(second, { decoded: [1, 2] });
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^\/content\/a9f6a9b0/);
});

test('non-metadata methods work when decoder loading fails', async () => {
  const { OrdJS, scripts } = load({ body: json(42), script: 'fail' });
  const ord = new OrdJS('');

  assert.equal(await ord.getBlockheight(), 42);
  assert.deepEqual(scripts, []);
  await assert.rejects(ord.getDecodedMetadata('abci0'));
});

test('malformed metadata hex is rejected without loading the decoder', async () => {
  const { OrdJS, scripts } = load({ body: json('zz') });
  await assert.rejects(new OrdJS('').getDecodedMetadata('abci0'), /not a hex string/);
  assert.deepEqual(scripts, []);
});

test('a failed decoder load can be retried', async () => {
  let mode = 'fail';
  const { OrdJS, scripts } = load({ body: json('01'), script: () => mode });
  const ord = new OrdJS('');

  await assert.rejects(ord.getDecodedMetadata('abci0'));
  mode = 'ok';
  assert.deepEqual(await ord.getDecodedMetadata('abci0'), { decoded: [1] });
  assert.equal(scripts.length, 2);
});

test('NaN path segments fall back instead of reaching the server', async () => {
  const { OrdJS, calls } = load({ body: json({ ok: true }) });
  const ord = new OrdJS('');

  await ord.getSatInscriptions(9, Number('nope'));
  await ord.getSatInscriptions(9, '', Number('nope'));
  await ord.getChildren('abci0', Number('nope'));

  assert.deepEqual(calls, ['/r/sat/9', '/r/sat/9', '/r/children/abci0']);
});
