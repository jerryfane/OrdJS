// Builds the CBOR decoder candidate that OrdJS would load recursively.
//
// The output is a browser classic script that defines a global `CBOR` with the
// same `decode(ArrayBuffer)` shape the current inscription exposes, so pointing
// OrdJS at it is a one-line change. It is written to vendor/ so the exact bytes
// that would be inscribed can be reviewed, served locally, and hashed — the
// artifact is the proposal, not the package name.
//
//   node scripts/build-decoder.mjs
//
// Requires bun for bundling. The MIT notice of the bundled source is retained in
// the artifact: a licence notice is not optional, and it counts toward inscribed
// bytes.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'cbor2';
const VERSION = '2.3.0';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'vendor');
const outFile = join(outDir, 'cbor2-decoder.js');
const manifestFile = join(outDir, 'cbor2-decoder.json');

const work = mkdtempSync(join(tmpdir(), 'ordjs-decoder-'));
writeFileSync(join(work, 'package.json'), JSON.stringify({
  name: 'decoder-build', private: true, dependencies: { [PACKAGE]: VERSION }
}));

const install = spawnSync('bun', ['install', '--no-save'], { cwd: work, stdio: 'inherit' });
if (install.status !== 0) throw new Error('bun install failed');

// A classic script, not a module: an inscription is loaded with <script src=...>.
// The wrapper accepts an ArrayBuffer and returns plain data, matching the decode
// contract OrdJS already calls.
writeFileSync(join(work, 'entry.js'), `import { decode } from '${PACKAGE}';
globalThis.CBOR = {
  decode(buffer, options) {
    return decode(new Uint8Array(buffer), options);
  }
};
`);

const build = spawnSync('bun', [
  'build', '--minify-syntax', '--minify-whitespace', '--target=browser',
  'entry.js', '--outfile', 'decoder.js'
], { cwd: work, stdio: 'inherit' });
if (build.status !== 0) throw new Error('bun build failed');

const licence = readFileSync(join(work, 'node_modules', PACKAGE, 'LICENSE.md'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => ` * ${line}`.trimEnd())
  .join('\n');

const header = `/*!
 * CBOR decoder for OrdJS — bundled from ${PACKAGE}@${VERSION} (decode only).
 * Exposes globalThis.CBOR.decode(ArrayBuffer).
 *
${licence}
 */
`;

const artifact = header + readFileSync(join(work, 'decoder.js'), 'utf8');
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, artifact);

const bytes = Buffer.byteLength(artifact);
const manifest = {
  source: `${PACKAGE}@${VERSION}`,
  license: 'MIT',
  homepage: 'https://github.com/hildjj/cbor2',
  global: 'CBOR.decode(ArrayBuffer)',
  bytes,
  sha256: createHash('sha256').update(artifact).digest('hex'),
  builder: `bun ${spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout?.trim()} build --minify-syntax --minify-whitespace --target=browser`,
  inscription_id: null,
  note: 'Not inscribed. The library loads its decoder from the fixed /content/<id> path with no configuration hook, so to try this candidate serve it at that path, as scripts/decoder-smoke.mjs does.'
};
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

console.log(`${outFile}\n${JSON.stringify(manifest, null, 2)}`);
