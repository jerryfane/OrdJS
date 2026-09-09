// Conformance check for the CBOR decoder candidate, run in a real browser
// through the path OrdJS actually uses.
//
// It serves vendor/cbor2-decoder.js exactly where the library asks for its decoder,
// serves it at the decoder's real /content/<id> path, and decodes the RFC 8949
// page via getDecodedMetadata — so what is measured is the decoder as loaded
// recursively, not an import in Node.
//
// Usage: node scripts/decoder-smoke.mjs [path-to-decoder.js]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const LIB_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0';
// The library asks for its decoder at this hard-coded inscription path. Serving
// the candidate there is what lets a replacement be tested without spending a
// single inscribed byte on a test hook.
const DECODER_PATH = '/content/a9f6a9b050af3de1a4ce714978c1f2231ba731f1f46731a16d0e411f89308566i0';

const argv = process.argv.slice(2);
const libraryPath = argv.includes('--library')
  ? argv[argv.indexOf('--library') + 1]
  : fileURLToPath(new URL('../src/content/OrdJS.js', import.meta.url));
const decoderPath = argv.find((arg) => arg.endsWith('.js') && arg !== libraryPath)
  ?? fileURLToPath(new URL('../vendor/cbor2-decoder.js', import.meta.url));
const decoder = await readFile(decoderPath, 'utf8');
const library = await readFile(libraryPath, 'utf8');
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

    // Shape changes a consumer of the CURRENT decoder would absorb. These are not
    // failures — the candidate is correct here — but they are migration cost, and
    // the RFC fixture cannot show them because upstream lists these vectors as
    // diagnostic-only. Recorded so the README cannot understate the migration.
    const describe = (value) => {
      if (value instanceof Map) return `Map(${value.size})`;
      if (value instanceof Date) return 'Date';
      if (value instanceof URL) return 'URL';
      if (value instanceof Uint8Array) return 'Uint8Array';
      if (value && typeof value === 'object') {
        // The library under test may be minified, so a constructor name is not a
        // stable label. Describe the shape instead.
        const keys = Object.keys(value);
        if (keys.includes('tag') || keys.includes('contents')) return `tag wrapper {${keys.join(',')}}`;
        return `object {${keys.join(',')}}`;
      }
      return typeof value;
    };
    // Shape alone is not enough: a decoder that returns Invalid Date for every
    // date, or rewrites a URI to an attacker's host, has the RIGHT SHAPE and the
    // wrong value. Each probe therefore records what the value actually is.
    const value = (decoded) => {
      if (decoded instanceof Date) return `Date(${decoded.toISOString?.() ?? 'Invalid'})`;
      if (decoded instanceof URL) return `URL(${decoded.href})`;
      if (decoded instanceof Uint8Array) return `bytes(${[...decoded].join(',')})`;
      if (decoded instanceof Map) return `Map(${[...decoded].map(([k, v]) => `${typeof k}:${String(k)}=${JSON.stringify(v)}`).join('|')})`;
      if (decoded && typeof decoded === 'object') return `object(${JSON.stringify(decoded, (k, v) => (v instanceof Uint8Array ? [...v] : v))})`;
      return JSON.stringify(decoded);
    };
    const migration = {};
    for (const [label, hex] of [
      ['integer-keyed map {1:2,3:4}', 'a201020304'],
      ['tag 0 date string', 'c074323031332d30332d32315432303a30343a30305a'],
      ['tag 1 epoch', 'c11a514b67b0'],
      ['tag 23 expected-base16', 'd74401020304'],
      ['tag 24 encoded-cbor', 'd818456449455446'],
      ['tag 32 URI', 'd82076687474703a2f2f7777772e6578616d706c652e636f6d'],
      ['byte string', '4401020304'],
      ['string-keyed map {a:1,b:2}', 'a2616101616202']
    ]) {
      try {
        const decoded = await ord.getDecodedMetadata(hex);
        migration[label] = `${describe(decoded)} = ${value(decoded)}`;
      } catch (error) {
        migration[label] = `THROW ${error.message}`;
      }
    }

    return { total: suite.vectors.length, passed, failures, regressions, migration, decoderLoads: document.querySelectorAll(`script[src="${decoderPath}"]`).length };
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

// The migration probes are also correctness probes: a decoder can hold the right
// SHAPE and the wrong VALUE. An Invalid Date, or a URI silently rewritten to
// another host, would otherwise be published as an acceptable migration.
const expectedValues = {
  'integer-keyed map {1:2,3:4}': 'Map(2) = Map(number:1=2|number:3=4)',
  'tag 0 date string': 'Date = Date(2013-03-21T20:04:00.000Z)',
  'tag 1 epoch': 'Date = Date(2013-03-21T20:04:00.000Z)',
  'tag 32 URI': 'URL = URL(http://www.example.com/)',
  'byte string': 'Uint8Array = bytes(1,2,3,4)',
  'string-keyed map {a:1,b:2}': 'object {a,b} = object({"a":1,"b":2})'
};
for (const [label, expected] of Object.entries(expectedValues)) {
  if (report.migration[label] !== expected) {
    problems.push(`migration ${label}: expected ${expected}, got ${report.migration[label]}`);
  }
}

console.log(`RFC 8949 Appendix A: ${report.passed}/${report.total} vectors decoded correctly in Chromium`);
console.log(`  (${report.total} of the 82 upstream entries carry a decoded value; the other 23 are diagnostic-only`);
console.log('   and include the tag and integer-keyed-map cases listed under migration below)');
console.log(`regressions fixed vs the inscribed decoder: ${JSON.stringify(r, null, 2)}`);
console.log(`migration shape changes vs the inscribed decoder: ${JSON.stringify(report.migration, null, 2)}`);
if (problems.length > 0) {
  console.error('decoder smoke FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`decoder smoke ok (${decoderPath})`);
