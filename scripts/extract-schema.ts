// Extract per-version field-list variants and table order from real P6 sample exports.
// Usage: node scripts/extract-schema.ts  -> writes core/xer/schema-observed.json
//
// Note: the field layout follows the P6 build that wrote the file, not the ERMHDR label
// (e.g. a modern P6 exporting "6.2" format still writes location_id). So each version keeps
// every distinct layout seen, with its source files.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseXer } from '../core/xer/parse.ts';
import { realSamples } from '../tests/helpers.ts';

type Variant = { fields: string[]; sources: string[] };
const versions: Record<string, Record<string, Variant[]>> = {};
const orders: string[][] = [];
const versionOrders: Record<string, string[][]> = {};

for (const s of realSamples()) {
  const { db } = parseXer(s.bytes);
  const v = db.header!.version;
  const vt = (versions[v] ??= {});
  orders.push(Object.keys(db.tables));
  (versionOrders[v] ??= []).push(Object.keys(db.tables));
  for (const t of Object.values(db.tables)) {
    const list = (vt[t.name] ??= []);
    const hit = list.find((x) => x.fields.join() === t.fields.join());
    if (hit) hit.sources.push(s.name);
    else list.push({ fields: t.fields, sources: [s.name] });
  }
}

function merge(orders: string[][]): string[] {
  const after = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const o of orders) {
    o.forEach((t, i) => {
      all.add(t);
      for (let j = i + 1; j < o.length; j++) {
        if (!after.has(t)) after.set(t, new Set());
        after.get(t)!.add(o[j]);
      }
    });
  }
  const out: string[] = [];
  const remaining = new Set(all);
  while (remaining.size) {
    const cand = [...remaining].filter((t) => ![...remaining].some((u) => u !== t && after.get(u)?.has(t) && !after.get(t)?.has(u)));
    const pick = (cand.length ? cand : [...remaining]).sort()[0];
    out.push(pick);
    remaining.delete(pick);
  }
  return out;
}
// Global merged order (used for tables a version never showed) and per-version orders.
const tableOrder = merge(orders);
const tableOrders = Object.fromEntries(Object.entries(versionOrders).map(([v, o]) => [v, merge(o)]));

writeFileSync(join(import.meta.dirname, '..', 'core', 'xer', 'schema-observed.json'), JSON.stringify({ versions, tableOrder, tableOrders }) + '\n');
console.log('versions:', Object.keys(versions).join(', '));
for (const [v, ts] of Object.entries(versions)) {
  for (const [t, vs] of Object.entries(ts)) if (vs.length > 1) console.log(`  ${v} ${t}: ${vs.map((x) => x.fields.length).join(' / ')} fields`);
}
