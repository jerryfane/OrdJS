// Fee estimate built from the ACTUAL inscription structure, not a bytes/4 guess.
//
// Assembles the real ord envelope — OP_FALSE OP_IF "ord" OP_1 <content-type> OP_0
// <body in 520-byte pushes> OP_ENDIF — measures the tapscript, builds the reveal
// witness (signature, script, control block) and a standard commit transaction,
// then computes weight and virtual size the way a node does.
//
// Exact arithmetic over the real serialised structures, still NOT a wallet
// dry-run: a real `ord wallet inscribe` picks specific inputs, change and postage,
// which move the commit side. The CLI and its known-answer checks live in
// scripts/fee-estimate.mjs.

// Bitcoin script push encoding: this is where "bytes ÷ 4" quietly loses accuracy.
export function pushSize(dataLength) {
  if (dataLength === 0) return 1;                     // OP_0
  if (dataLength <= 75) return 1 + dataLength;        // direct push
  if (dataLength <= 255) return 2 + dataLength;       // OP_PUSHDATA1
  if (dataLength <= 65535) return 3 + dataLength;     // OP_PUSHDATA2
  return 5 + dataLength;                              // OP_PUSHDATA4
}

export function varIntSize(n) {
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
export function envelopeSize(bodyBytes, contentType) {
  const CHUNK = 520;
  let size = 0;
  size += 1;                              // OP_FALSE
  size += 1;                              // OP_IF
  size += pushSize(3);                    // "ord"
  size += pushSize(1);                    // content-type tag, pushed as data
  size += pushSize(new TextEncoder().encode(contentType).length);
  size += pushSize(0);                    // body tag: empty slice -> OP_0
  for (let offset = 0; offset < bodyBytes; offset += CHUNK) {
    size += pushSize(Math.min(CHUNK, bodyBytes - offset));
  }
  size += 1;                              // OP_ENDIF
  return size;
}

export function revealTransaction(bodyBytes, contentType) {
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

export function commitTransaction() {
  // One P2TR input, two P2TR outputs (reveal address + change): the ordinary
  // shape a wallet produces. Key-path spend, so the witness is one signature.
  const base = 4 + 1 + (32 + 4 + 1 + 4) + 1 + 2 * (8 + 1 + 34) + 4;
  const witness = 1 + varIntSize(64) + 64;
  const weight = base * 4 + (2 + witness);
  return { weight, vsize: Math.ceil(weight / 4) };
}

// Virtual size of one inscription (reveal + standard commit) for a body of `bodyBytes`.
export function estimateInscription({ bodyBytes, contentType }) {
  const reveal = revealTransaction(bodyBytes, contentType);
  const commit = commitTransaction();
  return {
    bodyBytes,
    contentType,
    tapscriptBytes: reveal.script,
    revealWeight: reveal.weight,
    revealVb: reveal.vsize,
    commitVb: commit.vsize,
    totalVb: reveal.vsize + commit.vsize,
  };
}

export function satsAt(totalVb, rate) {
  return totalVb * rate;
}
