// Fee estimate built from the ACTUAL inscription structure, not a bytes/4 guess.
//
// It assembles the real ord envelope for a given artifact — OP_FALSE OP_IF "ord"
// OP_1 <content-type> OP_0 <body in 520-byte pushes> OP_ENDIF — measures the
// tapscript, builds the reveal witness (signature, script, control block) and a
// standard commit transaction, then computes weight and virtual size the way a
// node does.
//
//   node scripts/fee-estimate.mjs [--rate 1] [--rate 5] [file ...]
//
// This is exact arithmetic over the real serialised structures. It is still NOT a
// wallet dry-run: a real `ord wallet inscribe` picks specific inputs, change and
// postage, which move the commit side. Treat the reveal figure as tight and the
// commit figure as a standard-shape approximation.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// Bitcoin script push encoding: this is where "bytes ÷ 4" quietly loses accuracy.
function pushSize(dataLength) {
  if (dataLength === 0) return 1;                     // OP_0
  if (dataLength <= 75) return 1 + dataLength;        // direct push
  if (dataLength <= 255) return 2 + dataLength;       // OP_PUSHDATA1
  if (dataLength <= 65535) return 3 + dataLength;     // OP_PUSHDATA2
  return 5 + dataLength;                              // OP_PUSHDATA4
}

function varIntSize(n) {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

// ord envelope, per the inscription spec: body is split into pushes of at most
// 520 bytes because that is the maximum a single push can carry.
//
// Both tags are DATA PUSHES, not opcodes: ord's Tag::append calls
// push_slice(tag.bytes()), so the content-type tag [1] serialises as 0x01 0x01
// (2 bytes) while the body tag is a zero-length slice and serialises as OP_0
// (1 byte). Counting the content-type tag as a single OP_1 understates the
// envelope, which is exactly the kind of error a "bytes / 4" estimate hides.
function envelopeSize(bodyBytes, contentType) {
  const CHUNK = 520;
  let size = 0;
  size += 1;                              // OP_FALSE
  size += 1;                              // OP_IF
  size += pushSize(3);                    // "ord"
  size += pushSize(1);                    // content-type tag, pushed as data
  size += pushSize(Buffer.byteLength(contentType));
  size += pushSize(0);                    // body tag: empty slice -> OP_0
  for (let offset = 0; offset < bodyBytes; offset += CHUNK) {
    size += pushSize(Math.min(CHUNK, bodyBytes - offset));
  }
  size += 1;                              // OP_ENDIF
  return size;
}

function revealTransaction(bodyBytes, contentType) {
  // Tapscript: <32-byte internal key> OP_CHECKSIG, then the envelope.
  const script = pushSize(32) + 1 + envelopeSize(bodyBytes, contentType);

  // Non-witness part: version, input count, outpoint+empty scriptSig+sequence,
  // output count, one P2TR output, locktime.
  const base = 4 + 1 + (32 + 4 + 1 + 4) + 1 + (8 + 1 + 34) + 4;

  // Witness: item count, 64-byte Schnorr signature, the script, a control block
  // for a single-leaf tree (1 + 32).
  const witness = 1
    + varIntSize(64) + 64
    + varIntSize(script) + script
    + varIntSize(33) + 33;

  // Segwit marker and flag are witness-weighted.
  const weight = base * 4 + (2 + witness);
  return { script, base, witness, weight, vsize: Math.ceil(weight / 4) };
}

function commitTransaction() {
  // One P2TR input, two P2TR outputs (reveal address + change): the ordinary
  // shape a wallet produces. Key-path spend, so the witness is one signature.
  const base = 4 + 1 + (32 + 4 + 1 + 4) + 1 + 2 * (8 + 1 + 34) + 4;
  const witness = 1 + varIntSize(64) + 64;
  const weight = base * 4 + (2 + witness);
  return { weight, vsize: Math.ceil(weight / 4) };
}

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
  const reveal = revealTransaction(body.length, contentType);
  const totalVB = reveal.vsize + commit.vsize;
  rows.push({
    file: file.replace(root, ''),
    body_bytes: body.length,
    content_type: contentType,
    tapscript_bytes: reveal.script,
    reveal_weight: reveal.weight,
    reveal_vB: reveal.vsize,
    commit_vB: commit.vsize,
    total_vB: totalVB,
    sats: Object.fromEntries(rates.map((rate) => [`${rate}_sat_vB`, totalVB * rate]))
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
