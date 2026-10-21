#!/usr/bin/env node
/**
 * IFC chunker — runs in its OWN process (spawned by parse.ts) for models too big for web-ifc's 4 GB WebAssembly memory.
 * One streaming pass over the bytes records, for every DATA entity, where its statement lies in the file and which
 * entities it references. Then the products are cut into chunks: each chunk is a valid IFC holding the header, a batch
 * of products, everything they reference (placements, shapes, profiles, maps, contexts, units), and the opening
 * elements cut into them (IfcRelVoidsElement, so walls keep their holes). Express ids stay as in the source, so the
 * geometry of every chunk maps back to the index. Each chunk goes to the geometry worker on its own.
 * Usage: node geomChunk.mjs <ifc> <outDir> <productIdsFile> <targetBytes>
 * Writes <outDir>/chunk-N.ifc and <outDir>/chunks.json ({ chunks: [{ file, products, bytes }], entities }).
 */
import { closeSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const [ifcPath, outDir, productsFile, targetArg] = process.argv.slice(2);
if (!ifcPath || !outDir || !productsFile) { console.error('usage: geomChunk.mjs <ifc> <outDir> <productIdsFile> <targetBytes>'); process.exit(2); }
const target = Math.max(1 << 16, Number(targetArg) || 300 * 1048576);

// ── growable typed arrays, indexed by express id ──────────────────────────────────────────────────────────────
let cap = 1 << 20;
let off = new Float64Array(cap), len = new Uint32Array(cap), refAt = new Float64Array(cap), refN = new Uint32Array(cap);
const grow = (id) => {
  if (id < cap) return;
  let c = cap; while (c <= id) c *= 2;
  const g = (A, a) => { const b = new A(c); b.set(a); return b; };
  off = g(Float64Array, off); len = g(Uint32Array, len); refAt = g(Float64Array, refAt); refN = g(Uint32Array, refN); cap = c;
};
let refs = new Int32Array(1 << 22), nRefs = 0;
const pushRef = (r) => { if (nRefs === refs.length) { const b = new Int32Array(refs.length * 2); b.set(refs); refs = b; } refs[nRefs++] = r; };
const voids = new Map(); // building element -> IfcRelVoidsElement ids
let maxId = 0, entities = 0, headerEnd = 0, project = 0;

// ── pass: statements by byte offset (strings and comments respected) ──────────────────────────────────────────
const fd = openSync(ifcPath, 'r');
const BLOCK = 64 << 20;
const buf = Buffer.alloc(BLOCK);
let base = 0, inString = false, inComment = false, inData = false, stmtStart = 0;
let carry = Buffer.alloc(0); // the unfinished statement from the previous block
for (;;) {
  const n = readSync(fd, buf, 0, BLOCK, base + carry.length);
  if (n <= 0) break;
  const text = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
  const at0 = base; // file offset of text[0]
  let i = carry.length, start = stmtStart - at0;
  while (i < text.length) {
    const c = text[i];
    if (inComment) { if (c === 42 && text[i + 1] === 47) { inComment = false; i += 2; } else i++; continue; }
    if (inString) { if (c === 39) inString = false; i++; continue; }
    if (c === 47 && text[i + 1] === 42) { inComment = true; i += 2; continue; }
    if (c === 39) { inString = true; i++; continue; }
    if (c === 59) {
      const s = text.subarray(start, i + 1);
      if (!inData) {
        if (/^\s*DATA\s*;$/.test(s.toString('latin1'))) { inData = true; headerEnd = at0 + i + 1; }
      } else record(s, at0 + start);
      start = i + 1;
    }
    i++;
  }
  // keep the unfinished tail for the next block
  carry = Buffer.from(text.subarray(start));
  base = at0 + start;
  stmtStart = base;
}
closeSync(fd);

function record(s, at) {
  let i = 0;
  while (i < s.length && (s[i] === 32 || s[i] === 10 || s[i] === 13 || s[i] === 9)) i++;
  if (s[i] !== 35) return; // '#'
  let id = 0, j = i + 1;
  while (j < s.length && s[j] >= 48 && s[j] <= 57) id = id * 10 + (s[j++] - 48);
  const eq = s.indexOf(61, j); // '='
  const paren = s.indexOf(40, eq);
  if (eq < 0 || paren < 0) return;
  const type = s.subarray(eq + 1, paren).toString('latin1').trim();
  grow(id);
  off[id] = at + i; len[id] = s.length - i; refAt[id] = nRefs;
  let str = false, cmt = false;
  for (let k = paren; k < s.length; k++) {
    const c = s[k];
    if (cmt) { if (c === 42 && s[k + 1] === 47) { cmt = false; k++; } continue; }
    if (str) { if (c === 39) str = false; continue; }
    if (c === 47 && s[k + 1] === 42) { cmt = true; k++; continue; }
    if (c === 39) { str = true; continue; }
    if (c === 35) { let r = 0, m = k + 1; while (m < s.length && s[m] >= 48 && s[m] <= 57) r = r * 10 + (s[m++] - 48); if (m > k + 1) pushRef(r); k = m - 1; }
  }
  refN[id] = nRefs - refAt[id];
  // RelatingBuildingElement and RelatedOpeningElement are its last two references (OwnerHistory may be $)
  if (type === 'IFCRELVOIDSELEMENT' && refN[id] >= 2) { const el = refs[refAt[id] + refN[id] - 2]; (voids.get(el) ?? voids.set(el, []).get(el)).push(id); }
  if (type === 'IFCPROJECT') project = id;
  if (id > maxId) maxId = id;
  entities++;
}

// ── chunks: products in batches, each with its closure; the project's closure (units, contexts) in every chunk ─
const products = JSON.parse(readFileSync(productsFile, 'utf8')).filter((p) => p > 0 && p <= maxId && len[p] > 0);
const stamp = new Uint32Array(maxId + 1);
const stack = [];
let chunkNo = 0;
const closure = (root, into) => {
  let bytes = 0;
  stack.push(root);
  while (stack.length) {
    const id = stack.pop();
    if (id <= 0 || id > maxId || stamp[id] === chunkNo || !len[id]) continue;
    stamp[id] = chunkNo; into.push(id); bytes += len[id] + 1;
    for (let k = refAt[id], e = refAt[id] + refN[id]; k < e; k++) stack.push(refs[k]);
  }
  return bytes;
};
const header = (() => { const f = openSync(ifcPath, 'r'); const b = Buffer.alloc(headerEnd); readSync(f, b, 0, headerEnd, 0); closeSync(f); return b; })();
const src = openSync(ifcPath, 'r');
const out = [];
const write = (ids, nProducts) => {
  const file = join(outDir, `chunk-${out.length}.ifc`);
  const o = openSync(file, 'w');
  let bytes = 0;
  try {
    writeSync(o, header); writeSync(o, '\n'); bytes += header.length + 1;
    ids.sort((a, b) => off[a] - off[b]);
    // statements in file order, read through a 16 MB window (one read for many neighbours)
    let win = Buffer.alloc(0), winAt = -1;
    for (const id of ids) {
      if (winAt < 0 || off[id] < winAt || off[id] + len[id] > winAt + win.length) {
        win = Buffer.alloc(Math.max(16 << 20, len[id])); winAt = off[id];
        win = win.subarray(0, readSync(src, win, 0, win.length, winAt));
      }
      writeSync(o, win.subarray(off[id] - winAt, off[id] - winAt + len[id])); writeSync(o, '\n'); bytes += len[id] + 1;
    }
    writeSync(o, 'ENDSEC;\nEND-ISO-10303-21;\n');
  } finally { closeSync(o); }
  out.push({ file, products: nProducts, bytes });
};
let ids = [], size = 0, inChunk = 0;
const begin = () => { chunkNo++; ids = []; inChunk = 0; size = project ? closure(project, ids) : 0; };
begin();
for (const p of products) {
  if (inChunk && size >= target) { write(ids, inChunk); begin(); }
  size += closure(p, ids);
  for (const r of voids.get(p) ?? []) size += closure(r, ids);
  inChunk++;
}
if (inChunk) write(ids, inChunk);
closeSync(src);
writeFileSync(join(outDir, 'chunks.json'), JSON.stringify({ chunks: out, entities }));
console.log(`[geomChunk] ${entities} entities, ${products.length} products in ${out.length} chunks`);
process.exit(0);
