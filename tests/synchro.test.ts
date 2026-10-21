import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSynchro } from '../core/bim/synchro.ts';

// study-only SYNCHRO samples (not in the repository); the tests run where they exist
const dir = join(import.meta.dirname, '..', 'sample 4D', 'synchro');
const schep = join(dir, 'schependomlaan', 'Synchro project Schependomlaan.sp');
const none = !existsSync(dir) && 'SYNCHRO samples (sample 4D/synchro) are not present';

function spFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? spFiles(p) : n.toLowerCase().endsWith('.sp') ? [p] : []; });
}

test('Schependomlaan (SYNCHRO 5.1): 125 tasks with their ST ids, links, the IFC objects and the 4D assignments', { skip: !existsSync(schep) && 'Schependomlaan .sp not present' }, () => {
  const r = readSynchro(readFileSync(schep));
  assert.equal(r.version, '5.1.1.4');
  assert.equal(r.tasks.length, 125);
  const ids = new Set(r.tasks.map((t) => t.id));
  assert.ok(ids.has('ST00020') && ids.has('ST00030'));
  const first = r.tasks.find((t) => t.id === 'ST00020')!;
  assert.equal(first.name, 'Maatvoering gemeente');
  assert.equal(first.start, '2015-02-20 08:00');
  assert.equal(first.finish, '2015-02-20 17:00', 'one 8-hour day on the standard calendar');
  assert.equal(first.durationHours, 8);
  assert.ok(r.predecessors.length > 0);
  assert.ok(r.resources.some((x) => x.name === 'brievenbussen_(#269096)'));
  assert.ok(r.assignments.length > 7000);
  const res = new Set(r.resources.map((x) => x.uuid)), tasks = new Set(r.tasks.map((t) => t.uuid));
  assert.ok(r.assignments.every((a) => tasks.has(a.task) && res.has(a.resource)), 'every assignment joins a task to a resource read from the file');
});

test('every SYNCHRO sample (5.1 to 6.5) parses without throwing', { skip: none }, () => {
  const files = spFiles(dir);
  assert.ok(files.length > 0);
  for (const f of files) {
    const r = readSynchro(readFileSync(f));
    assert.match(r.version, /^\d+\.\d+/, f);
    for (const t of r.tasks) assert.ok(t.start === null || /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(t.start), f);
  }
});

test('a file that is not SYNCHRO is refused', () => {
  assert.throws(() => readSynchro(new Uint8Array(64)), /Not a SYNCHRO/);
});
