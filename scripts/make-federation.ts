// A federated Navisworks model for scale tests: an .nwf listing N copies of a real model, the copies beside it (no public
// federation that large has a licence that allows it, so one is made of a real sample).
// Usage: node scripts/make-federation.ts <model.nwd|.nwc> <copies> <out folder>
// Writes <out>/federation.nwf and <out>/part-NNN.<ext>; prints the total size.
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const [model, n, out] = process.argv.slice(2);
if (!model || !n || !out) { console.error('usage: node scripts/make-federation.ts <model.nwd|.nwc> <copies> <out folder>'); process.exit(2); }
mkdirSync(out, { recursive: true });
const ext = extname(model), names: string[] = [];
let total = 0;
for (let k = 1; k <= Number(n); k++) {
  const name = `part-${String(k).padStart(3, '0')}${ext}`;
  copyFileSync(model, join(out, name));
  names.push(name); total += statSync(model).size;
}
// the container (nwd/container.ts): a header line, the sections, the table of contents line, 7 zero bytes, the table
// (zlib), the header line again. One section: LcOpXRefTable, the list of the models as JSON
const HEAD = '#LcUStream-V1.1 binary double release C lichunk-008\n';
const xref = deflateSync(Buffer.from(`{"Table":[${names.map((x) => JSON.stringify({ OriginalPath: `C:\\models\\${x}` })).join(',')}]}`));
const name = Buffer.from('LcOpXRefTable'), pad = Buffer.alloc((4 - (name.length % 4)) % 4);
const entry = Buffer.alloc(4); entry.writeUInt32LE(name.length);
const version = Buffer.alloc(4); version.writeUInt32LE(1);
let toc = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 0, 0, 0]), entry, name, pad, version]);
toc = Buffer.concat([toc, Buffer.alloc((8 - (toc.length % 8)) % 8)]);
const where = Buffer.alloc(24); where.writeBigUInt64LE(BigInt(HEAD.length), 0); where.writeBigUInt64LE(BigInt(xref.length), 8);
toc = Buffer.concat([toc, where]);
const file = Buffer.concat([Buffer.from(HEAD), xref, Buffer.from('#LcUStream-V1.1 binary double release utf8 navisworks:448 lizlib\n'), Buffer.alloc(7), deflateSync(toc), Buffer.from(HEAD)]);
writeFileSync(join(out, 'federation.nwf'), file);
console.log(`${join(out, 'federation.nwf')}: ${n} copies of ${basename(model)}, ${Math.round(total / 1048576)} MB of models`);
