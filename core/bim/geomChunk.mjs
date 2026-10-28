#!/usr/bin/env node
/**
 * IFC chunker — runs in its OWN process (spawned by parse.ts) for models too big for web-ifc's 4 GB WebAssembly memory.
 * One streaming pass over the bytes records, for every DATA entity, where its statement lies in the file. Then the products are cut into chunks: each chunk is a valid IFC holding the header, a batch
 * of products, everything they reference (placements, shapes, profiles, maps, contexts, units), and the opening
 * elements cut into them (IfcRelVoidsElement, so walls keep their holes). Express ids stay as in the source, so the
 * geometry of every chunk maps back to the index. Each chunk goes to the geometry worker on its own.
 * Memory: 8 bytes per entity of the model (where its statement is, how long, the chunk it was last put in), whatever
 * the chunk size: the references are read again from the statements (through a few windows of the file) as the
 * chunks are cut, not kept for every entity (they were most of a big model's memory, beside the server's index).
 * Usage: node geomChunk.mjs <ifc> <outDir> <products.bin (sorted uint32 express ids)> <targetBytes>
 * Writes <outDir>/chunk-N.ifc and <outDir>/chunks.json ({ chunks: [{ file, products, bytes }], entities }).
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { progress, startHeartbeat } from './heartbeat.mjs';

startHeartbeat(); // the parent's liveness watch (no time limit)

const [ifcPath, outDir, productsFile, targetArg] = process.argv.slice(2);
if (!ifcPath || !outDir || !productsFile) { console.error('usage: geomChunk.mjs <ifc> <outDir> <productIdsFile> <targetBytes>'); process.exit(2); }
const target = Math.max(1 << 16, Number(targetArg) || 300 * 1048576);

// ── growable typed arrays, indexed by express id: where the statement starts (uint32 for files under 4 GB) and its
// length (uint16, longer ones in a map: a relationship listing a million elements) ──────────────────────────────────
const fileSize = (() => { const f = openSync(ifcPath, 'r'); try { return fstatSync(f).size; } finally { closeSync(f); } })();
const Off = fileSize >= 2 ** 32 ? Float64Array : Uint32Array;
let cap = 1 << 20;
let off = new Off(cap), len = new Uint16Array(cap);
const longLen = new Map();
const lenOf = (id) => (len[id] === 0xffff ? longLen.get(id) : len[id]);
const grow = (id) => {
  if (id < cap) return;
  let c = cap; while (c <= id) c = Math.ceil(c * 1.5);
  const g = (A, a) => { const b = new A(c); b.set(a); return b; };
  off = g(Off, off); len = g(Uint16Array, len); cap = c;
};
/** The express ids a statement references (#123), strings and comments skipped, from position `from`. */
function refsIn(s, from, into) {
  let str = false, cmt = false;
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (cmt) { if (c === 42 && s[k + 1] === 47) { cmt = false; k++; } continue; }
    if (str) { if (c === 39) str = false; continue; }
    if (c === 47 && s[k + 1] === 42) { cmt = true; k++; continue; }
    if (c === 39) { str = true; continue; }
    if (c === 35) { let r = 0, m = k + 1; while (m < s.length && s[m] >= 48 && s[m] <= 57) r = r * 10 + (s[m++] - 48); if (m > k + 1) into.push(r); k = m - 1; }
  }
  return into;
}
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
  const L = s.length - i;
  off[id] = at + i;
  if (L < 0xffff) len[id] = L; else { len[id] = 0xffff; longLen.set(id, L); }
  // RelatingBuildingElement and RelatedOpeningElement are its last two references (OwnerHistory may be $)
  if (type === 'IFCRELVOIDSELEMENT') { const r = refsIn(s, paren, []); if (r.length >= 2) { const el = r[r.length - 2]; (voids.get(el) ?? voids.set(el, []).get(el)).push(id); } }
  if (type === 'IFCPROJECT') project = id;
  if (id > maxId) maxId = id;
  entities++;
}

// ── chunks: products in batches, each with its closure; the project's closure (units, contexts) in every chunk ─
const pb = readFileSync(productsFile);
const products = [...new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4)].filter((p) => p > 0 && p <= maxId && len[p] > 0);
const stamp = new Uint16Array(maxId + 1); // the chunk an entity was last put in (at most 65,535 chunks)
const stack = [];
let chunkNo = 0;
// statements read again for their references, through four 8 MB windows (least recently used goes): a product's
// shapes and placements lie near it, the shared definitions (contexts, units, owner) near the file's start
const src = openSync(ifcPath, 'r');
const wins = [];
function statement(id) {
  const at = off[id], L = lenOf(id);
  let w = wins.find((x) => at >= x.at && at + L <= x.at + x.buf.length);
  if (!w) {
    const buf = Buffer.alloc(Math.max(8 << 20, L));
    w = { at, buf: buf.subarray(0, readSync(src, buf, 0, buf.length, at)) };
    wins.unshift(w); if (wins.length > 4) wins.pop();
  } else if (wins[0] !== w) { wins.splice(wins.indexOf(w), 1); wins.unshift(w); }
  return w.buf.subarray(at - w.at, at - w.at + L);
}
const scratch = [];
const closure = (root, into) => {
  let bytes = 0;
  stack.push(root);
  while (stack.length) {
    const id = stack.pop();
    if (id <= 0 || id > maxId || stamp[id] === chunkNo || !len[id]) continue;
    stamp[id] = chunkNo; into.push(id); bytes += lenOf(id) + 1;
    const s = statement(id);
    scratch.length = 0;
    for (const r of refsIn(s, s.indexOf(40), scratch)) stack.push(r);
  }
  return bytes;
};
const header = (() => { const f = openSync(ifcPath, 'r'); const b = Buffer.alloc(headerEnd); readSync(f, b, 0, headerEnd, 0); closeSync(f); return b; })();
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
      const L = lenOf(id);
      if (winAt < 0 || off[id] < winAt || off[id] + L > winAt + win.length) {
        win = Buffer.alloc(Math.max(16 << 20, L)); winAt = off[id];
        win = win.subarray(0, readSync(src, win, 0, win.length, winAt));
      }
      writeSync(o, win.subarray(off[id] - winAt, off[id] - winAt + L)); writeSync(o, '\n'); bytes += L + 1;
    }
    writeSync(o, 'ENDSEC;\nEND-ISO-10303-21;\n');
  } finally { closeSync(o); }
  out.push({ file, products: nProducts, bytes });
};
let ids = [], size = 0, inChunk = 0;
const begin = () => { if (++chunkNo > 65535) { console.error('more than 65,535 chunks: raise the chunk size'); process.exit(3); } ids = []; inChunk = 0; size = project ? closure(project, ids) : 0; };
begin();
let doneProducts = 0;
for (const p of products) {
  if (inChunk && size >= target) { write(ids, inChunk); begin(); }
  size += closure(p, ids);
  for (const r of voids.get(p) ?? []) size += closure(r, ids);
  inChunk++; progress(++doneProducts);
}
if (inChunk) write(ids, inChunk);
closeSync(src);
writeFileSync(join(outDir, 'chunks.json'), JSON.stringify({ chunks: out, entities }));
console.log(`[geomChunk] ${entities} entities, ${products.length} products in ${out.length} chunks, peak rss ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
process.exit(0);
