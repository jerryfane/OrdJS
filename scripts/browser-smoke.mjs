// Real-browser smoke test for the inscription path.
//
// Serves a stub ord server, loads the library the way an inscription does —
// <script src="/content/<library-id>"> on the same origin — and drives the public
// API from inside the page. This is the part a unit test cannot cover: the
// recursive script load, the real fetch/btoa/document, and the decoder inscription
// being pulled in lazily by a second <script> tag.
//
// Usage: node scripts/browser-smoke.mjs [path-to-library.js]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const LIB_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0';
const DECODER_ID = 'a9f6a9b050af3de1a4ce714978c1f2231ba731f1f46731a16d0e411f89308566i0';
const IMAGE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbi0';
const EMPTY_SAT = 100;
const FULL_SAT = 200;

const libPath = process.argv[2] ?? fileURLToPath(new URL('../src/content/OrdJS.js', import.meta.url));
const library = await readFile(libPath, 'utf8');

// 1 MiB of deterministic bytes: the payload that used to blow the call stack.
const bigContent = Buffer.from(Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 256));

// A stand-in for the inscribed CBOR decoder. The smoke test asserts that it is
// fetched exactly once and only when decoded metadata is requested; decoder
// correctness itself is a separate concern.
const decoderScript = `globalThis.CBOR = { decode: (buf) => ({ bytes: [...new Uint8Array(buf)] }) };
globalThis.__decoderLoads = (globalThis.__decoderLoads ?? 0) + 1;`;

const routes = new Map([
  [`/content/${LIB_ID}`, { type: 'text/javascript', body: Buffer.from(library) }],
  [`/content/${DECODER_ID}`, { type: 'text/javascript', body: Buffer.from(decoderScript) }],
  [`/content/${IMAGE_ID}`, { type: 'image/png', body: bigContent }],
  [`/r/blockheight`, { type: 'application/json', body: Buffer.from('850000') }],
  [`/r/sat/${EMPTY_SAT}/at/-1`, { type: 'application/json', body: Buffer.from('{"id":null}') }],
  [`/r/sat/${FULL_SAT}/at/-1`, { type: 'application/json', body: Buffer.from(`{"id":"${IMAGE_ID}"}`) }],
  [`/r/sat/${FULL_SAT}/at/0`, { type: 'application/json', body: Buffer.from(`{"id":"${IMAGE_ID}"}`) }],
  [`/r/sat/${FULL_SAT}/0`, { type: 'application/json', body: Buffer.from('{"ids":[],"more":false,"page":0}') }],
  [`/r/metadata/${IMAGE_ID}`, { type: 'application/json', body: Buffer.from('"0102"') }],
]);

const requested = [];
const server = createServer((req, res) => {
  requested.push(req.url);
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><script src="/content/${LIB_ID}"></script>`);
    return;
  }
  const route = routes.get(req.url);
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': route.type });
  res.end(route.body);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const failures = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
  await page.goto(`${origin}/`, { waitUntil: 'load' });

  const loaded = await page.evaluate(() => typeof OrdJS);
  if (loaded !== 'function') {
    throw new Error(`library did not define OrdJS through the recursive script path (typeof ${loaded})`);
  }

  const result = await page.evaluate(async (ids) => {
    const ord = new OrdJS('');
    const out = {};
    out.blockheight = await ord.getBlockheight();
    out.emptySat = await ord.getSatLastInscriptionContent(ids.emptySat);

    const content = await ord.getSatLastInscriptionContent(ids.fullSat);
    out.mime = content.mime;
    const bytes = Uint8Array.from(atob(content.base64), (c) => c.charCodeAt(0));
    out.length = bytes.length;
    out.exact = bytes.every((b, i) => b === i % 256);

    out.decoderBefore = globalThis.__decoderLoads ?? 0;
    const [a, b] = await Promise.all([
      ord.getDecodedMetadata(ids.imageId),
      ord.getDecodedMetadata(ids.imageId)
    ]);
    out.decoded = [a.bytes, b.bytes];
    out.decoderAfter = globalThis.__decoderLoads ?? 0;
    out.scriptTags = document.querySelectorAll('script[src^="/content/"]').length;
    return out;
  }, { emptySat: EMPTY_SAT, fullSat: FULL_SAT, imageId: IMAGE_ID });

  const check = (name, ok, detail) => {
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  check('blockheight', result.blockheight === 850000, `got ${result.blockheight}`);
  check('empty sat resolves null', result.emptySat === null, `got ${JSON.stringify(result.emptySat)}`);
  check('mime preserved', result.mime?.startsWith('image/png'), `got ${result.mime}`);
  check('1 MiB length', result.length === 1024 * 1024, `got ${result.length}`);
  check('1 MiB bytes exact', result.exact === true, 'content did not round-trip');
  check('decoder not loaded early', result.decoderBefore === 0, `loaded ${result.decoderBefore} times before use`);
  check('decoder loaded once', result.decoderAfter === 1, `loaded ${result.decoderAfter} times`);
  check('decoded metadata', JSON.stringify(result.decoded) === JSON.stringify([[1, 2], [1, 2]]),
    JSON.stringify(result.decoded));
  check('no /content/null request', !requested.includes('/content/null'), 'library requested /content/null');
  check('recursive script tags', result.scriptTags === 2, `found ${result.scriptTags}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length > 0) {
  console.error('browser smoke FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`browser smoke ok (${libPath})`);
