// Verifies vendor/cbor2-decoder.json against the file it describes.
//
// The manifest exists so the exact bytes of a proposed inscription can be
// reviewed and hashed. If the artifact can drift from its recorded size and
// sha256 without anything failing, the manifest is decoration and the "these are
// the bytes we would inscribe" claim is unbacked.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const artifactPath = fileURLToPath(new URL('../vendor/cbor2-decoder.js', import.meta.url));
const manifestPath = fileURLToPath(new URL('../vendor/cbor2-decoder.json', import.meta.url));

for (const path of [artifactPath, manifestPath]) {
  if (!existsSync(path)) {
    console.error(`missing: ${path}`);
    process.exit(1);
  }
}

const artifact = readFileSync(artifactPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sha256 = createHash('sha256').update(artifact).digest('hex');

const problems = [];
if (manifest.bytes !== artifact.length) {
  problems.push(`bytes: manifest ${manifest.bytes}, artifact ${artifact.length}`);
}
if (manifest.sha256 !== sha256) {
  problems.push(`sha256: manifest ${manifest.sha256}, artifact ${sha256}`);
}
// The licence notice is not optional and is part of the inscribed bytes.
if (!artifact.toString('utf8', 0, 2048).includes('MIT')) {
  problems.push('the artifact does not carry its MIT notice in the header');
}
// A recorded inscription ID would mean the candidate is live; until then the
// manifest must say so rather than implying deployment.
if (manifest.inscription_id !== null && !/^[0-9a-f]{64}i\d+$/.test(manifest.inscription_id ?? '')) {
  problems.push(`inscription_id must be null or a real inscription ID, got ${JSON.stringify(manifest.inscription_id)}`);
}

if (problems.length > 0) {
  console.error('decoder manifest does NOT match its artifact');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`decoder manifest ok: ${manifest.bytes} B, sha256 ${sha256}, inscription_id ${JSON.stringify(manifest.inscription_id)}`);
