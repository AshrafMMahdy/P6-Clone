// WHIQ 4L-13 (2026-11-05): least work lost. A failed call says the earlier calls are kept (only it is redone); a job forgotten
// by a restart says to read the project before starting a changing tool again; the save at exit keeps the 4D links beside its XER.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FX = join(import.meta.dirname, 'fixtures', '4d');
const call = async (name: string, args: Record<string, unknown>) => {
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool(name, args);
  return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any };
};

test('a failed call on an open project says the earlier calls are kept and only it is redone', async () => {
  const np = (await call('new_project', { id: 'KEEP', start: '2026-03-02' })).d;
  const h = np.handle, owner_key = np.owner_key;
  assert.equal((await call('edit', { handle: h, owner_key, operations: [{ op: 'add_activity', id: 'A1', name: 'Piling', duration_days: 5 }] })).err, false);
  const bad = await call('edit', { handle: h, owner_key, operations: [{ op: 'add_relationship', pred: 'A1', succ: 'NOPE' }] });
  assert.equal(bad.err, true);
  assert.match(String(bad.d.error.project_state), /earlier calls on this project are kept/);
  const open = (await call('list_open', {})).d.open.find((o: any) => o.handle === h);
  assert.ok(open && open.changes >= 1, 'the first edit is still there');
  await call('close', { handle: h, owner_key, discard: true });
});

test('a job the server no longer knows says to read the project before starting a changing tool again', async () => {
  const r = await call('job_status', { job_id: 'job-gone-after-restart' });
  assert.equal(r.err, true);
  assert.equal(r.d.error.code, 'unknown_job');
  assert.match(String(r.d.error.hint), /list_open and read the project .* BEFORE starting a changing tool again/);
  assert.equal(r.d.error.project_state, undefined, 'no project is named: no "kept" note');
});

test('the save at exit writes the 4D links beside its .recovered XER', async () => {
  const { setRoots } = await import('../mcp/runtime.ts');
  const { saveUnsavedAtExit } = await import('../mcp/server.ts');
  const out = mkdtempSync(join(tmpdir(), 'p6-exit-4d-'));
  setRoots(FX, out);
  try {
    const np = (await call('new_project', { id: 'EXIT4D', start: '2026-03-02' })).d;
    const h = np.handle, owner_key = np.owner_key;
    await call('edit', { handle: h, owner_key, operations: [{ op: 'add_activity', id: 'L1W', name: 'Level 1 walls', duration_days: 10 }] });
    const om = await call('open_model', { handle: h, owner_key, path: 'Duplex_A_20110907.ifc' });
    assert.equal(om.err, false, JSON.stringify(om.d));
    const ln = await call('link_by_rules', { handle: h, owner_key, rules: [{ type: 'scope', activity: 'L1W', storey: 'Level 1', class: 'IfcWall' }] });
    assert.equal(ln.err, false, JSON.stringify(ln.d));
    const saved = saveUnsavedAtExit('test').filter((f) => f.includes('EXIT4D'));
    assert.equal(saved.length, 1, readdirSync(out).join(','));
    assert.ok(existsSync(`${saved[0]}.4d.json`), `${saved[0]}.4d.json beside it: ${readdirSync(out).join(',')}`);
    await call('close', { handle: h, owner_key, discard: true });
  } finally { setRoots(null, null); }
});
