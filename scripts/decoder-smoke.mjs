// Conformance check for the CBOR decoder candidate, run in a real browser
// through the path OrdJS actually uses.
//
// It serves vendor/cbor2-decoder.js as an inscription would be served, points
// OrdJS.decoderUrl at it, and decodes the RFC 8949 Appendix A vectors inside the
// page via getDecodedMetadata — so what is measured is the decoder as loaded
// recursively, not an import in Node.
//
// Usage: node scripts/decoder-smoke.mjs [path-to-decoder.js]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const LIB_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0';
const DECODER_PATH = '/content/deadbeefi0';

const decoderPath = process.argv[2] ?? fileURLToPath(new URL('../vendor/cbor2-decoder.js', import.meta.url));
const decoder = await readFile(decoderPath, 'utf8');
const library = await readFile(new URL('../src/content/OrdJS.js', import.meta.url), 'utf8');
const suite = JSON.parse(await readFile(new URL('../test/fixtures/rfc8949-appendix-a.json', import.meta.url), 'utf8'));

const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><script src="/content/${LIB_ID}"></script>`);
    return;
  }
  if (req.url === `/content/${LIB_ID}`) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(library);
    return;
  }
  if (req.url === DECODER_PATH) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(decoder);
    return;
  }
  const metadata = req.url.match(/^\/r\/metadata\/([0-9a-f]+)$/);
  if (metadata) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(metadata[1]));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
let report;
try {
  const page = await browser.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'load' });

  report = await page.evaluate(async ({ decoderPath, suite }) => {
    OrdJS.decoderUrl = decoderPath;
    const ord = new OrdJS('');

    // JSON cannot express the exact expectation for 64-bit vectors, so those are
    // compared against decimal strings instead of lossy numbers.
    const canon = (value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Uint8Array) return 'bytes:' + [...value].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Map) return canon(Object.fromEntries([...value].map(([k, v]) => [String(canon(k)), v])));
      if (Array.isArray(value)) return value.map(canon);
      if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) out[key] = canon(value[key]);
        return out;
      }
      if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
      return value;
    };

    const failures = [];
    let passed = 0;
    for (const vector of suite.vectors) {
      const override = suite.exact_overrides[vector.hex];
      let got;
      try {
        got = await ord.getDecodedMetadata(vector.hex);
      } catch (error) {
        failures.push({ hex: vector.hex, got: `THROW ${error.message}` });
        continue;
      }
      const want = JSON.stringify(override ?? canon(vector.decoded));
      const actual = JSON.stringify(canon(got));
      if (actual === want) passed += 1;
      else failures.push({ hex: vector.hex, want, got: actual });
    }

    // The behaviours the current inscribed decoder gets wrong.
    const regressions = {
      // 9007199254740993 must not round to ...992
      bigint: String(canon(await ord.getDecodedMetadata('1b0020000000000001'))),
      // Map with numeric key 1 and string key "1": both must survive. canon() is
      // deliberately not used here — it stringifies keys, which would collapse the
      // two exactly like the defect under test and make this check pass on a broken
      // decoder.
      mixedKeys: await ord.getDecodedMetadata('a201616161316162').then((m) => (m instanceof Map
        ? `Map(${m.size}) ${[...m].map(([k, v]) => `${typeof k}:${String(k)}=${v}`).join('|')}`
        : `not-a-map ${JSON.stringify(m)}`)),
      // __proto__ as a data key must not reach the prototype
      protoIsOwnKey: Object.keys(await ord.getDecodedMetadata('a1695f5f70726f746f5f5fa1617801')).join(','),
      protoClean: Object.getPrototypeOf(await ord.getDecodedMetadata('a1695f5f70726f746f5f5fa1617801')) === Object.prototype,
      // ordinary string-keyed metadata must still decode to a plain object
      plainObject: JSON.stringify(await ord.getDecodedMetadata('a26161016162 02'.replace(' ', '')))
    };

    return { total: suite.vectors.length, passed, failures, regressions, decoderLoads: document.querySelectorAll(`script[src="${decoderPath}"]`).length };
  }, { decoderPath: DECODER_PATH, suite });
} finally {
  await browser.close();
  server.close();
}

const problems = [...report.failures.map((f) => `vector ${f.hex}: want ${f.want}, got ${f.got}`)];
const r = report.regressions;
if (r.bigint !== '9007199254740993') problems.push(`uint64 precision: ${r.bigint}`);
if (r.mixedKeys !== 'Map(2) number:1=a|string:1=b') problems.push(`mixed keys lost: ${r.mixedKeys}`);
if (r.protoIsOwnKey !== '__proto__') problems.push(`__proto__ not an own key: ${r.protoIsOwnKey}`);
if (r.protoClean !== true) problems.push('prototype was mutated by a __proto__ key');
if (r.plainObject !== '{"a":1,"b":2}') problems.push(`string-keyed map is not a plain object: ${r.plainObject}`);
if (report.decoderLoads !== 1) problems.push(`decoder loaded ${report.decoderLoads} times`);

console.log(`RFC 8949 Appendix A: ${report.passed}/${report.total} vectors decoded correctly in Chromium`);
console.log(`regressions fixed vs the inscribed decoder: ${JSON.stringify(r, null, 2)}`);
if (problems.length > 0) {
  console.error('decoder smoke FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`decoder smoke ok (${decoderPath})`);
