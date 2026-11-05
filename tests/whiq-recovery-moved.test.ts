// WHIQ 4L-13 (2026-11-05): a recovery folder the host moved (the platform keeps a dead process's recovery files and copies them
// into the next process's root) is adopted from where it now is — its index holds the paths of where it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('a moved recovery folder is adopted from its new place (paths in its index rewritten by the owner folder name)', async () => {
  const root1 = mkdtempSync(join(tmpdir(), 'p6-rec-a-'));
  const root2 = mkdtempSync(join(tmpdir(), 'p6-rec-b-'));
  const rt = await import('../mcp/runtime.ts');
  const { callTool, toolResult } = await import('../mcp/server.ts');
  rt.setRoot(root1);
  const np = toolResult((await callTool('new_project', { id: 'MOVED', start: '2026-03-02' })).out, false).structuredContent as any;
  await callTool('edit', { handle: np.handle, owner_key: np.owner_key, operations: [{ op: 'add_activity', id: 'M1', name: 'Kept across the move', duration_days: 3 }] });
  rt.checkpointAll();
  // the host moves it: copied into another process's root; its owner is gone
  cpSync(join(root1, '.p6clone-recovery'), join(root2, '.p6clone-recovery'), { recursive: true });
  rmSync(join(root1, '.p6clone-recovery'), { recursive: true, force: true });   // moved, not copied: the old place is gone
  for (const d of readdirSync(join(root2, '.p6clone-recovery'))) {
    const lock = join(root2, '.p6clone-recovery', d, 'owner.json');
    try { const o = JSON.parse(readFileSync(lock, 'utf8')); writeFileSync(lock, JSON.stringify({ ...o, pid: 4194000, started: null })); } catch { /* not an owner folder */ }
  }
  const script = `const rt = await import(${JSON.stringify(new URL('../mcp/runtime.ts', import.meta.url).pathname)}); rt.setRoot(${JSON.stringify(root2)}); console.log(JSON.stringify(rt.adoptRecovery()));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: process.env });
  const took = JSON.parse((r.stdout.trim().split('\n').pop()) || '[]') as string[];
  assert.ok(took.includes(np.handle), `adopted from the moved folder: ${r.stdout} ${r.stderr.slice(0, 400)}`);
  rt.setRoot(null);
});
