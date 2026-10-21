// Navisworks search-set XML is UTF-8 (the clone writes it so, as Navisworks does): set names with an em dash or in
// Arabic come back as written, so link_by_rules set_name links every activity (it linked 1 of 19 on Aurora when the
// file was read as latin1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { xmlText } from '../core/bim/read4d.ts';

const FX = join(import.meta.dirname, 'fixtures', '4d');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};
const ACTS = [['B1W', 'Basement Walls (B1 — perimeter RC)', 'Level 1', 'IfcWall'], ['L2S', 'بلاطة الطابق الثاني', 'Level 2', 'IfcSlab'], ['L2W', 'Level 2 walls', 'Level 2', 'IfcWall']] as const;
async function project(id: string, model: string, link: boolean) {
  const np = (await call('new_project', { id, start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  await call('edit', { handle: h, owner_key, operations: ACTS.map(([a, n]) => ({ op: 'add_activity', id: a, name: n, duration_days: 5 })) });
  await call('schedule', { handle: h, owner_key });
  await call('open_model', { handle: h, owner_key, path: model, geometry: false });
  if (link) await call('link_by_rules', { handle: h, owner_key, rules: ACTS.map(([a, , storey, cls]) => ({ type: 'scope', activity: a, storey, class: cls })) });
  return { h, owner_key };
}

test('XML text by its BOM, else its declaration, else UTF-8', () => {
  const s = 'Basement Walls (B1 — perimeter RC) بلاطة';
  const enc = new TextEncoder();
  assert.equal(xmlText(enc.encode(`<?xml version="1.0" encoding="UTF-8"?><x>${s}</x>`)), `<?xml version="1.0" encoding="UTF-8"?><x>${s}</x>`);
  assert.equal(xmlText(enc.encode(`<x>${s}</x>`)), `<x>${s}</x>`, 'no declaration: UTF-8');
  assert.equal(xmlText(Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode(`<x>${s}</x>`)])), `<x>${s}</x>`, 'BOM');
  const le = Buffer.from(`<x>${s}</x>`, 'utf16le');
  assert.equal(xmlText(Uint8Array.from([0xff, 0xfe, ...le])), `<x>${s}</x>`, 'UTF-16 with its BOM');
  assert.equal(xmlText(Uint8Array.from(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><x>caf\xe9</x>', 'latin1'))), '<?xml version="1.0" encoding="ISO-8859-1"?><x>café</x>', 'the declared encoding');
});

test('export_4d navisworks -> import_4d: an em dash and an Arabic set name come back as written; set_name links every activity', async () => {
  const { h } = await project('UTF', join(FX, 'Duplex_A_20110907.ifc'), true);
  const out = mkdtempSync(join(tmpdir(), 'p6-utf8-'));
  const nw = await call('export_4d', { handle: h, target: 'navisworks', path: join(out, 'nw') });
  assert.equal(nw.err, false, JSON.stringify(nw.d).slice(0, 300));
  const sets = nw.d.written.find((f: string) => f.endsWith('-sets.xml')), tagged = nw.d.written.find((f: string) => f.endsWith('-4D.ifc'));
  assert.match(readFileSync(sets, 'utf8'), /B1 — perimeter RC/);
  const { h: h2, owner_key: k2 } = await project('UTF2', tagged, false);
  const s = await call('import_4d', { handle: h2, owner_key: k2, path: sets });
  assert.equal(s.err, false, JSON.stringify(s.d).slice(0, 300));
  assert.deepEqual(s.d.sets.map((x: { name: string }) => x.name).sort(), ACTS.map(([, n]) => n).sort(), 'every set name as written');
  const l = await call('link_by_rules', { handle: h2, owner_key: k2, rules: [{ type: 'set_name' }] });
  assert.equal(l.err, false, JSON.stringify(l.d).slice(0, 300));
  const st = await call('link_status', { handle: h2 });
  assert.deepEqual(st.d.activities_without_elements, [], 'every activity linked through its set');
  assert.ok(st.d.links >= ACTS.length);
  // a set file with a BOM reads the same
  const bom = join(out, 'bom.xml');
  writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(sets)]));
  const sb = await call('import_4d', { handle: h2, owner_key: k2, path: bom });
  assert.deepEqual(sb.d.sets.map((x: { name: string }) => x.name).sort(), ACTS.map(([, n]) => n).sort());
});
