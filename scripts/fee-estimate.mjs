// CLI for the fee estimate in scripts/fee.mjs (exact ord envelope, tapscript,
// reveal witness and a standard commit tx), plus its known-answer checks.
//
//   node scripts/fee-estimate.mjs [--rate 1] [--rate 5] [file ...]
//
// This is exact arithmetic over the real serialised structures. It is still NOT a
// wallet dry-run: a real `ord wallet inscribe` picks specific inputs, change and
// postage, which move the commit side. Treat the reveal figure as tight and the
// commit figure as a standard-shape approximation.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commitTransaction, envelopeSize, estimateInscription, pushSize, revealTransaction, satsAt } from './fee.mjs';

const args = process.argv.slice(2);
const rates = [];
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--rate') { rates.push(Number(args[i + 1])); i += 1; continue; }
  files.push(args[i]);
}
if (rates.length === 0) rates.push(1, 5, 10);

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = files.length > 0 ? files : [
  `${root}/vendor/cbor2-decoder.js`
];

const commit = commitTransaction();
const rows = [];
for (const file of targets) {
  if (!existsSync(file)) {
    console.error(`skipped, not found: ${file}`);
    continue;
  }
  const body = readFileSync(file);
  // ord's media table maps js/mjs to "text/javascript" with no charset parameter;
  // the live sibling inscription reports exactly that content type.
  const contentType = file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
  const estimate = estimateInscription({ bodyBytes: body.length, contentType });
  rows.push({
    file: file.replace(root, ''),
    body_bytes: estimate.bodyBytes,
    content_type: estimate.contentType,
    tapscript_bytes: estimate.tapscriptBytes,
    reveal_weight: estimate.revealWeight,
    reveal_vB: estimate.revealVb,
    commit_vB: estimate.commitVb,
    total_vB: estimate.totalVb,
    sats: Object.fromEntries(rates.map((rate) => [`${rate}_sat_vB`, satsAt(estimate.totalVb, rate)]))
  });
}

// A stage that only prints cannot fail, and a fee figure nobody can falsify is
// worse than no figure. These invariants are derived independently of the
// functions above, so a corrupted pushSize or envelope walk is caught rather
// than published as a smaller number.
const violations = [];
for (const row of rows) {
  const body = row.body_bytes;
  const chunks = Math.ceil(body / 520);
  // Independent lower bound: the body itself, its push prefixes (3 bytes per
  // 520-byte chunk), the 34-byte key-path prefix and the smallest possible
  // envelope header.
  const floor = body + chunks * 3 + 34 + 8;
  if (row.tapscript_bytes < floor) {
    violations.push(`${row.file}: tapscript ${row.tapscript_bytes} B is below the ${floor} B floor for a ${body} B body`);
  }
  // The witness is weight 1 per byte, so the reveal can never be cheaper than a
  // quarter of the script it carries.
  if (row.reveal_vB < Math.ceil(row.tapscript_bytes / 4)) {
    violations.push(`${row.file}: reveal ${row.reveal_vB} vB is below tapscript/4`);
  }
  // BIP 141: vsize is weight/4 rounded up. Recomputed here from the reported
  // weight rather than restated, so a corrupted weight or vsize is caught.
  if (row.reveal_vB !== Math.ceil(row.reveal_weight / 4)) {
    violations.push(`${row.file}: reveal ${row.reveal_vB} vB is not ceil(${row.reveal_weight} weight / 4)`);
  }
  // The witness carries the whole body at 1 weight unit per byte, and the
  // non-witness part is weighted x4, so the reveal weight has a hard floor.
  if (row.reveal_weight < body + 4 * 60) {
    violations.push(`${row.file}: reveal weight ${row.reveal_weight} is below the floor for a ${body} B body`);
  }
  if (row.total_vB !== row.reveal_vB + row.commit_vB) {
    violations.push(`${row.file}: total is not reveal + commit`);
  }
  // ord's own media table decides this string, and its length lands in the
  // envelope. A charset parameter nobody inscribes would silently inflate every
  // figure, so the mapping is pinned rather than trusted.
  if (row.file.endsWith('.js') && row.content_type !== 'text/javascript') {
    violations.push(`${row.file}: modelled as ${row.content_type}, but ord inscribes .js as text/javascript`);
  }
}
// Known-answer check on the push encoder itself, independent of any artifact.
for (const [length, expected] of [[0, 1], [1, 2], [75, 76], [76, 78], [255, 257], [256, 259], [520, 523]]) {
  if (pushSize(length) !== expected) {
    violations.push(`pushSize(${length}) = ${pushSize(length)}, expected ${expected}`);
  }
}

// GROUND TRUTH. A floor can only catch a large error; these numbers come from the
// real reveal transaction of the live OrdJS v0.1.2 inscription
// (4123e324aa3508ae7021a43a1dfc2d9d83fc35029d092877c57234f729068526i0, reveal txid
// 4123e324..., witness items 64 / 3995 / 33 bytes, weight 4476), whose body is
// 3911 bytes of text/javascript. If this model of the envelope drifts by even one
// byte — a mis-sized tag, a wrong chunk size, a charset added to the content type
// — these equalities fail. That is what makes the stage falsifiable rather than
// merely bounded.
const LIVE = { body: 3911, contentType: 'text/javascript', tapscript: 3995, weight: 4476, vsize: 1119 };
const modelled = revealTransaction(LIVE.body, LIVE.contentType);
if (modelled.script !== LIVE.tapscript) {
  violations.push(`known answer: tapscript for the live v0.1.2 body is ${modelled.script} B, on-chain it is ${LIVE.tapscript} B`);
}
if (modelled.weight !== LIVE.weight) {
  violations.push(`known answer: reveal weight for the live v0.1.2 body is ${modelled.weight}, on-chain it is ${LIVE.weight}`);
}
if (modelled.vsize !== LIVE.vsize) {
  violations.push(`known answer: reveal vsize for the live v0.1.2 body is ${modelled.vsize}, expected ${LIVE.vsize}`);
}
// The commit side was previously unconstrained: a collapsed commit understated the
// total by 10% and every stage still passed. Pin its exact serialised size.
if (commit.vsize !== 154 || commit.weight !== 616) {
  violations.push(`commit tx is ${commit.vsize} vB / ${commit.weight} wu, expected 154 vB / 616 wu for 1 P2TR in, 2 P2TR out`);
}

// Body chunking: the 521st byte must start a SECOND push, costing its own
// 1-byte prefix plus the byte itself, i.e. exactly pushSize(1) = 2 more bytes.
// A single oversized push (CHUNK raised above 520) makes this 1.
const oneChunk = envelopeSize(520, 'text/plain');
const twoChunks = envelopeSize(521, 'text/plain');
if (twoChunks - oneChunk !== 2) {
  violations.push(`chunking: crossing 520 bytes changed the envelope by ${twoChunks - oneChunk} B, expected 2 (a second push: 1-byte prefix + 1 byte)`);
}

console.log(JSON.stringify({
  method: 'exact serialisation of the ord envelope, tapscript, reveal witness and a standard commit tx',
  not_included: ['wallet input selection', 'change and postage values', 'parent/child or metadata fields', 'sat selection'],
  commit_assumption: '1 P2TR input, 2 P2TR outputs, key-path spend',
  results: rows
}, null, 2));

if (violations.length > 0) {
  console.error('fee estimate FAILED its own invariants');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
if (rows.length === 0) {
  console.error('fee estimate FAILED: no artifact was measured');
  process.exit(1);
}
