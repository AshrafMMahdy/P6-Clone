// The model cache's clean (owner decision 2026-11-11, aggressive cleaning; the 24 hours is his own arbitrary choice): a cached
// model not used for more than 24 hours is deleted, one used within 24 hours stays, and there is no size limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const age = (p: string, hours: number) => { const t = new Date(NOW - hours * H); utimesSync(p, t, t); };
async function withCache<T>(fn: (dir: string, prune: (now: number) => number) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'p6c-prune-')), saved = process.env.P6CLONE_MODEL_CACHE;
  process.env.P6CLONE_MODEL_CACHE = dir;
  try { const { pruneCache } = await import('../core/bim/model.ts'); return await fn(dir, pruneCache); }
  finally { if (saved == null) delete process.env.P6CLONE_MODEL_CACHE; else process.env.P6CLONE_MODEL_CACHE = saved; rmSync(dir, { recursive: true, force: true }); }
}

test('a cached model used 23 hours ago stays, one used 25 hours ago goes; superseded/ follows the same 24 hours', async () => {
  await withCache((dir, prune) => {
    const f = (n: string) => join(dir, n);
    writeFileSync(f('a-v10.ndjson'), 'x'); age(f('a-v10.ndjson'), 23);
    writeFileSync(f('b-v10.ndjson'), 'x'); age(f('b-v10.ndjson'), 25);
    mkdirSync(f('c-v10.tiles')); age(f('c-v10.tiles'), 25);
    mkdirSync(f('superseded')); writeFileSync(f('superseded/old.glb'), 'x'); writeFileSync(f('superseded/new.glb'), 'x');
    age(f('superseded/old.glb'), 25); age(f('superseded/new.glb'), 23);
    assert.equal(prune(NOW), 3);
    assert.equal(existsSync(f('a-v10.ndjson')), true);
    assert.equal(existsSync(f('b-v10.ndjson')), false);
    assert.equal(existsSync(f('c-v10.tiles')), false);
    assert.equal(existsSync(f('superseded/old.glb')), false);
    assert.equal(existsSync(f('superseded/new.glb')), true);
  });
});

test('there is no size limit: a cache far over 10 GB of fresh models loses nothing', async () => {
  await withCache((dir, prune) => {
    // 12 models of 1 GB each, as sparse files (no disk is used), all used within the last hour
    const names = Array.from({ length: 12 }, (_, i) => join(dir, `m${i}-v10.glb`));
    for (const n of names) { writeFileSync(n, ''); truncate(n, 1024 ** 3); age(n, 0.5); }
    assert.equal(prune(NOW), 0);
    assert.ok(names.every((n) => existsSync(n)));
  });
});

test('the clean runs at most once an hour', async () => {
  await withCache((dir, prune) => {
    const p = join(dir, 'z-v10.ndjson');
    writeFileSync(p, 'x'); age(p, 30);
    const later = NOW + 1000 * H; // past any earlier call's hour
    assert.equal(prune(later), 1);
    writeFileSync(p, 'x'); age(p, 1030); // stale again, but within the hour of the last check
    assert.equal(prune(later + H / 2), 0);
    assert.equal(existsSync(p), true);
    assert.equal(prune(later + H + 1), 1);
  });
});
import { truncateSync } from 'node:fs';
const truncate = truncateSync;
