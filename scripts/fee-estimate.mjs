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
function envelopeSize(bodyBytes, contentType) {
  const CHUNK = 520;
  let size = 0;
  size += 1;                              // OP_FALSE
  size += 1;                              // OP_IF
  size += pushSize(3);                    // "ord"
  size += 1;                              // OP_1 (content-type tag)
  size += pushSize(Buffer.byteLength(contentType));
  size += 1;                              // OP_0 (body tag)
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
  const contentType = file.endsWith('.js') ? 'text/javascript;charset=utf-8' : 'application/octet-stream';
  const reveal = revealTransaction(body.length, contentType);
  const totalVB = reveal.vsize + commit.vsize;
  rows.push({
    file: file.replace(root, ''),
    body_bytes: body.length,
    tapscript_bytes: reveal.script,
    reveal_weight: reveal.weight,
    reveal_vB: reveal.vsize,
    commit_vB: commit.vsize,
    total_vB: totalVB,
    sats: Object.fromEntries(rates.map((rate) => [`${rate}_sat_vB`, totalVB * rate]))
  });
}

console.log(JSON.stringify({
  method: 'exact serialisation of the ord envelope, tapscript, reveal witness and a standard commit tx',
  not_included: ['wallet input selection', 'change and postage values', 'parent/child or metadata fields', 'sat selection'],
  commit_assumption: '1 P2TR input, 2 P2TR outputs, key-path spend',
  results: rows
}, null, 2));
