// update_pobs: the performing organisations (POBS: pobs_name, pobs_descr, pobs_manager), which update_obs does not
// reach. Over a real MCP stdio server: the op is in tools/list, renames and clears every POBS row of a real file
// (clear_descriptions blanks pobs_descr), the saved XER re-opens strictly and validates, the old values are gone from
// the file, the root row keeps its place, and undo brings everything back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SAMPLES_DIR } from './helpers.ts';

const SERVER = join(import.meta.dirname, '..', 'mcp', 'server.ts');

function client() {
  const tmp = mkdtempSync(join(tmpdir(), 'p6pobs-tmp-'));
  const p = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c: string) => { buf += c; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const exited = new Promise((res) => p.on('exit', res));
  const rpc = (method: string, params?: unknown) => new Promise<any>((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name: string, args: Record<string, unknown> = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { isError: r.result.isError, data: r.result.structuredContent }; };
  return { rpc, tool, close: async () => { p.stdin.end(); await exited; rmSync(tmp, { recursive: true, force: true }); } };
}

test('MCP: update_pobs renames and clears every performing organisation; saved, re-opened strictly, undone', { timeout: 120_000 }, async () => {
  const c = client();
  const dir = mkdtempSync(join(tmpdir(), 'p6pobs-'));
  try {
    await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    // visible over MCP: the edit tool's description (its operation guide) names the op
    const edit = (await c.rpc('tools/list')).result.tools.find((t: { name: string }) => t.name === 'edit');
    assert.match(edit.description, /update_pobs: \[pobs_id\] or \[name\]/);
    assert.match(edit.description, /pobs_descr/);

    const o = (await c.tool('open_file', { path: join(SAMPLES_DIR, 'el ezz warehouse.xer') })).data;
    const h = o.handle, k = o.owner_key;
    const list = async (h2 = h) => (await c.tool('list_dictionaries', { handle: h2, only: 'pobs' })).data.pobs as { pobs_id: string; name: string; parent: string | null; description?: string; manager?: string }[];
    const before = await list();
    assert.ok(before.length > 2, 'the file has POBS rows');
    const root = before.find((r) => r.parent == null)!;
    assert.equal(root.name, 'POBS_Root');
    assert.ok(before.every((r) => r.description), 'every row carries a description');

    // unknown row, duplicate name and an empty new name are refused
    const miss = await c.tool('edit', { handle: h, owner_key: k, operations: [{ op: 'update_pobs', name: 'Nobody' }] });
    assert.equal(miss.isError, true);
    assert.match(miss.data.error.message, /No POBS row "Nobody"/);
    const dup = await c.tool('edit', { handle: h, owner_key: k, operations: [{ op: 'update_pobs', name: before[1].name, new_name: before[2].name }] });
    assert.match(dup.data.error.message, /already exists/);
    assert.equal((await c.tool('edit', { handle: h, owner_key: k, operations: [{ op: 'update_pobs', pobs_id: root.pobs_id, new_name: ' ' }] })).isError, true);
    assert.deepEqual(await list(), before, 'refused edits change nothing');

    // rename every row (the root too) by pobs_id and by name, set a manager, then clear every description
    const ops = before.map((r, i) => i % 2 ? { op: 'update_pobs', pobs_id: r.pobs_id, new_name: `Org ${i}`, manager: 'Someone' } : { op: 'update_pobs', name: r.name, new_name: i === 0 ? 'ROOT' : `Org ${i}` });
    const ed = await c.tool('edit', { handle: h, owner_key: k, operations: [...ops, { op: 'clear_descriptions' }] });
    assert.equal(ed.isError, false, JSON.stringify(ed.data));
    assert.equal(ed.data.results[0].was, before[0].name);
    assert.equal(ed.data.results[ops.length].cleared.POBS, before.length);
    const after = await list();
    assert.deepEqual(after.map((r) => r.pobs_id), before.map((r) => r.pobs_id));
    assert.ok(after.every((r, i) => r.name === (i === 0 ? 'ROOT' : `Org ${i}`) && !r.description));
    assert.equal(after.find((r) => r.pobs_id === root.pobs_id)!.parent, null, 'the root row keeps no parent');

    // saved, re-opened as strictly as P6 would, valid; no original value left in the file
    const path = join(dir, 'pobs.xer');
    assert.equal((await c.tool('save', { handle: h, owner_key: k, path })).isError, false);
    const re = (await c.tool('open_file', { path })).data;
    const v = (await c.tool('validate', { handle: re.handle })).data;
    assert.deepEqual([v.counts?.fatal ?? 0, v.counts?.error ?? 0], [0, 0], JSON.stringify(v).slice(0, 500));
    const reRows = await list(re.handle);
    assert.deepEqual(reRows.map((r) => [r.pobs_id, r.name, r.parent]), after.map((r) => [r.pobs_id, r.name, r.parent]));
    assert.ok(reRows.every((r) => !r.description));
    assert.equal(reRows.filter((r) => r.manager === 'Someone').length, after.filter((_, i) => i % 2).length);
    const text = readFileSync(path, 'latin1');
    const pobsBlock = text.slice(text.indexOf('%T\tPOBS'), text.indexOf('%T', text.indexOf('%T\tPOBS') + 5));
    for (const r of before) assert.ok(!pobsBlock.includes(`\t${r.name}\t`), `${r.name} gone from POBS`);
    assert.ok(!pobsBlock.includes('Performing Organization'), 'the descriptions are gone');

    // undo restores the names and descriptions in one step
    assert.equal((await c.tool('undo', { handle: h })).isError, false);
    assert.deepEqual(await list(), before);
    // nothing left unsaved for the server to write beside the sample on exit
    assert.equal((await c.tool('close', { handle: h, owner_key: k, discard: true })).isError, false);
    assert.equal((await c.tool('close', { handle: re.handle, owner_key: re.owner_key, discard: true })).isError, false);
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true }); }
});
