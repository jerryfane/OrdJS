// Release gate: everything that must pass before bytes are inscribed.
//
// Inscribing is irreversible and costs money, so this runs the checks that a
// unit test alone does not cover, and prints the byte accounting a release
// record needs.
//
//   node scripts/gate.mjs            full gate (needs bun + playwright chromium)
//   node scripts/gate.mjs --no-browser   skip only the real-browser stage
//
// Stages:
//   1. unit tests against the readable source
//   2. minify with a pinned, recorded configuration
//   3. unit tests again against the MINIFIED artifact (the thing that ships)
//   4. byte budget: the artifact must not exceed the live inscription body
//   5. real browser: recursive /content/<id> load, 1 MiB round-trip, lazy decoder
//   6. release record: sizes, hashes, dependency inscription IDs

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'src/content/OrdJS.js');
const withBrowser = !process.argv.includes('--no-browser');

// The body of the live v0.1.2 inscription. A release must not grow past what is
// already on chain without a deliberate decision.
const BUDGET_BYTES = 3911;

// Minifier configuration is part of the release record: a different config
// produces a different artifact from identical source.
const MINIFY = ['build', '--no-bundle', '--minify-syntax', '--minify-whitespace', '--target=browser'];

const steps = [];
function run(name, command, args, options = {}) {
  process.stdout.write(`\n=== ${name}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  const ok = result.status === 0;
  steps.push({ name, ok });
  if (!ok && result.error) console.error(String(result.error.message));
  return ok;
}

run('unit tests (source)', 'node', ['--test', 'test/ordjs.test.mjs']);

const work = mkdtempSync(join(tmpdir(), 'ordjs-gate-'));
const minified = join(work, 'OrdJS.min.js');
const minifiedOk = run('minify', 'bun', [...MINIFY, source, '--outfile', minified]);

let bytes = null;
if (minifiedOk && existsSync(minified)) {
  const artifact = readFileSync(minified);
  bytes = artifact.length;

  // Run the same suite against the minified artifact by swapping it in for the
  // source the tests read. A minifier that breaks behaviour must fail here.
  const mirror = join(work, 'repo');
  cpSync(root, mirror, {
    recursive: true,
    filter: (path) => !path.includes('/.git/') && !path.endsWith('/.git')
  });
  writeFileSync(join(mirror, 'src/content/OrdJS.js'), artifact);
  run('unit tests (minified artifact)', 'node', ['--test', 'test/ordjs.test.mjs'], { cwd: mirror });

  const withinBudget = bytes <= BUDGET_BYTES;
  steps.push({ name: `byte budget (${bytes} <= ${BUDGET_BYTES})`, ok: withinBudget });
  process.stdout.write(`\n=== byte budget\n${bytes} B minified, budget ${BUDGET_BYTES} B, ` +
    `${withinBudget ? `${BUDGET_BYTES - bytes} B of headroom` : `${bytes - BUDGET_BYTES} B OVER`}\n`);

  if (withBrowser) {
    run('browser smoke (minified artifact, chromium/firefox/webkit)', 'node',
      ['scripts/browser-smoke.mjs', minified, '--engine', 'all']);
    // The decoder candidate is a separate inscription, so it is gated separately:
    // RFC 8949 Appendix A decoded in Chromium through OrdJS.decoderUrl.
    if (existsSync(join(root, 'vendor/cbor2-decoder.js'))) {
      run('decoder candidate conformance', 'node', ['scripts/decoder-smoke.mjs']);
    }
  } else {
    process.stdout.write('\n=== browser smoke\nSKIPPED (--no-browser): the inscription path is unverified\n');
  }

  run('fee estimate', 'node', ['scripts/fee-estimate.mjs', '--rate', '1', '--rate', '5', minified]);

  const sha256 = createHash('sha256').update(artifact).digest('hex');
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
  const dependencies = [...readFileSync(source, 'utf8').matchAll(/[0-9a-f]{64}i\d+/g)].map((m) => m[0]);

  process.stdout.write('\n=== release record\n');
  process.stdout.write(JSON.stringify({
    commit,
    source_bytes: readFileSync(source).length,
    artifact_bytes: bytes,
    artifact_sha256: sha256,
    minifier: `bun ${spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout?.trim()} ${MINIFY.join(' ')}`,
    dependency_inscriptions: dependencies,
    live_inscription_body_bytes: BUDGET_BYTES
  }, null, 2) + '\n');
  process.stdout.write('\nNot covered by this gate, and required before inscribing: a real ord server ' +
    '(indexed and non-indexed), Firefox and WebKit, and a commit/reveal fee dry-run at the chosen rate.\n');
}

const failed = steps.filter((step) => !step.ok);
process.stdout.write('\n=== gate summary\n');
for (const step of steps) process.stdout.write(`${step.ok ? 'pass' : 'FAIL'}  ${step.name}\n`);
if (failed.length > 0) {
  process.stdout.write(`\n${failed.length} stage(s) failed; do not inscribe.\n`);
  process.exit(1);
}
process.stdout.write('\nAll gate stages passed.\n');
