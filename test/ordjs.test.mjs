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

// ord answers a failure with a plain-text explanation, e.g.
// "inscription on sat 1 not found" (verified against mainnet ordinals.com).
const failure = (status, message) => async () => ({
  ok: false,
  status,
  text: async () => message
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

// Routes verified against mainnet ordinals.com before these wrappers were added:
// /r/inscription/<id>, /r/parents/<id>[/<page>] (paginates with page_index),
// /r/children/<id>/inscriptions[/<page>] (paginates with page),
// /r/undelegated-content/<id>, /r/blockinfo/<height|hash>.
//
// This test can only prove string construction; it cannot prove a route exists.
// 'latest' was documented here until a live probe returned 400 ("invalid digit
// found in string"), so the height and hash forms are what is pinned.
test('endpoint wrappers build their documented routes', async () => {
  const { OrdJS, calls } = load({ body: json({ ok: true }) });
  const ord = new OrdJS('');
  const hash = '0000000000000000000320283a032748cef8227873ff4872689bf23f1cda83a5'; // real block 840000 hash, 64 hex chars

  await ord.getInscription('abci0');
  await ord.getParents('abci0');
  await ord.getParents('abci0', 0);
  await ord.getChildrenInscriptions('abci0');
  await ord.getChildrenInscriptions('abci0', 2);
  await ord.getBlockInfo(840000);
  await ord.getBlockInfo(hash);

  assert.deepEqual(calls, [
    '/r/inscription/abci0',
    '/r/parents/abci0',
    '/r/parents/abci0/0',
    '/r/children/abci0/inscriptions',
    '/r/children/abci0/inscriptions/2',
    '/r/blockinfo/840000',
    `/r/blockinfo/${hash}`
  ]);
});

test('undelegated content returns own bytes and does not follow the delegate', async () => {
  const own = Uint8Array.from([9, 8, 7]);
  const delegated = Uint8Array.from([1, 1, 1]);
  const { OrdJS, calls } = load({
    body: (url) => (url.startsWith('/r/undelegated-content/') ? binary(own)() : binary(delegated)())
  });
  const ord = new OrdJS('');

  const undelegated = await ord.getUndelegatedContent('abci0');
  const followed = await ord.getInscriptionContent('abci0');

  assert.equal(undelegated.base64, Buffer.from(own).toString('base64'));
  assert.equal(followed.base64, Buffer.from(delegated).toString('base64'));
  assert.deepEqual(calls, ['/r/undelegated-content/abci0', '/content/abci0']);
});

test('indexed sat content is fetched in one request', async () => {
  const bytes = Uint8Array.from([4, 5, 6]);
  const { OrdJS, calls } = load({ body: binary(bytes) });
  const ord = new OrdJS('');

  const latest = await ord.getSatInscriptionContent(1469077634181728);
  const first = await ord.getSatInscriptionContent(1469077634181728, 0);

  assert.equal(latest.base64, Buffer.from(bytes).toString('base64'));
  assert.equal(first.base64, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(calls, [
    '/r/sat/1469077634181728/at/-1/content',
    '/r/sat/1469077634181728/at/0/content'
  ]);
});

test("a failure carries ord's own explanation, the status and the endpoint", async () => {
  const { OrdJS } = load({ body: failure(404, 'inscription on sat 1 not found\n') });
  const ord = new OrdJS('');

  const error = await ord.getSatInscriptionContent(1, 0).then(() => null, (e) => e);
  assert.match(error.message, /404/);
  assert.match(error.message, /\/r\/sat\/1\/at\/0\/content/);
  assert.match(error.message, /inscription on sat 1 not found/);
  assert.equal(error.status, 404);

  const jsonError = await ord.getMetadata('abci0').then(() => null, (e) => e);
  assert.match(jsonError.message, /OrdJS 404 \/r\/metadata\/abci0: inscription on sat 1 not found/);
  assert.equal(jsonError.status, 404);
});

test('an unreadable error body still produces a usable error', async () => {
  const { OrdJS } = load({
    body: async () => ({ ok: false, status: 500, text: async () => { throw new Error('stream closed'); } })
  });

  const error = await new OrdJS('').getBlockheight().then(() => null, (e) => e);
  assert.match(error.message, /OrdJS 500 \/r\/blockheight/);
  assert.equal(error.status, 500);
});
