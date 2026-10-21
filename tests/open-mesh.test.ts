// An open mesh (a surface, a railing's open profile, a fitting open at its ends) encloses no volume, so it gives no
// derived volume; a closed one keeps it, and a seam tessellated a little differently on either side does not count as
// a hole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

test('Duplex: walls, slabs and windows keep their derived volumes; the open railings give none', { timeout: 300_000 }, async () => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const call = async (name: string, args: Record<string, unknown>) => toolResult((await callTool(name, args)).out, false).structuredContent as any;
  const o = await call('open_model', { path: join(import.meta.dirname, 'fixtures', '4d', 'Duplex_A_20110907.ifc') });
  assert.ok(o.meshed_without_volume > 0 && o.meshed_without_volume < 20, JSON.stringify(o.meshed_without_volume));
  /** the derived volumes of a class's elements (element_info in small batches: its answer is the full record) */
  const vol = async (cls: string) => {
    const els = (await call('list_elements', { handle: o.handle, class: cls, limit: 1000 })).elements.filter((e: any) => e.class === cls), out: (number | null)[] = [];
    for (let k = 0; k < els.length; k += 20) out.push(...(await call('element_info', { handle: o.handle, guids: els.slice(k, k + 20).map((e: any) => e.guid) })).elements.map((e: any) => e.derivedVolumeM3));
    return out;
  };
  for (const cls of ['IfcWallStandardCase', 'IfcSlab', 'IfcWindow']) { const v = await vol(cls); assert.ok(v.length && v.every((x) => x !== null && x > 0), `${cls}: ${v}`); }
  const rail = await vol('IfcRailing');
  assert.ok(rail.length && rail.every((x) => x === null), `IfcRailing: ${rail}`);
  await call('close', { handle: o.handle, owner_key: o.owner_key, discard: true });
});
