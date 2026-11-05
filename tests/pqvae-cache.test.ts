// The PQ-VAE engine's disk cache of text readings (main/pqvae/textCache.ts): a review read cold, then again by a fresh
// engine on the same cache folder, answers exactly the same and reads no text again; the files are in the documented,
// language-neutral layout (model.txt, 256 shards of 1,568-byte records) that the platform's Python sidecar can share.
// Skipped until scripts/pqvae-export.py has written the models.
//   node --import ./tests/setup.ts --test tests/pqvae-cache.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const models = process.env.PQVAE_MODELS ?? join(root, 'vendor', 'whiq-agent', 'pqvae-onnx');
const fx = join(import.meta.dirname, 'fixtures', 'pqvae');
const skip = existsSync(join(models, 'manifest.json')) ? false : 'vendor/whiq-agent/pqvae-onnx/manifest.json is missing (python -P scripts/pqvae-export.py)';

/** One engine on `cache`: answers `body` on `path`, then its /health; stopped after. */
async function once(cache: string, path: string, body: unknown): Promise<{ answer: unknown; health: any }> {
  const proc = spawn(process.execPath, [join(root, 'main', 'pqvae', 'sidecar.ts'), '--models', models, '--port', '0', '--cache', cache], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LLM_ROUTER_URL: 'http://127.0.0.1:1' }, windowsHide: true,
  });
  try {
    const port = await new Promise<number>((ok, no) => {
      let buf = '';
      proc.stdout!.on('data', (d: Buffer) => { buf += d; const m = /\{"port":(\d+)\}/.exec(buf); if (m) ok(Number(m[1])); });
      proc.on('exit', (c) => no(new Error(`sidecar exited ${c}`)));
    });
    const answer = await (await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    return { answer, health };
  } finally { proc.stdin!.end(); }
}

test('text readings on disk: a fresh engine answers exactly the same and reads nothing again', { skip, timeout: 300_000 }, async () => {
  const cache = mkdtempSync(join(tmpdir(), 'pqvae-cache-'));
  const { request } = JSON.parse(readFileSync(join(fx, 'review-cairo.json'), 'utf8'));
  const cold = await once(cache, '/review_schedule', request);
  assert.ok(cold.health.textCache.misses > 0, 'the first engine read the names');
  const warm = await once(cache, '/review_schedule', request);
  assert.deepEqual(warm.answer, cold.answer, 'the same answer, bit for bit');
  assert.equal(warm.health.textCache.misses, 0, 'the second engine read no text again');
  assert.ok(warm.health.textCache.hits > 0);
  // the layout the Python sidecar can share: <root>/<sha256(model id)[:16]>/model.txt + <xx>.bin of 1,568-byte records
  const dirs = readdirSync(cache);
  assert.equal(dirs.length, 1);
  const dir = join(cache, dirs[0]), id = readFileSync(join(dir, 'model.txt'), 'utf8').trim();
  assert.match(id, /^sentence-transformers\/paraphrase-multilingual-MiniLM-L12-v2@[0-9a-f]{40}:fp16#[0-9a-f]{12}$/);
  assert.equal(dirs[0], createHash('sha256').update(id).digest('hex').slice(0, 16));
  const shards = readdirSync(dir).filter((f) => f.endsWith('.bin'));
  assert.ok(shards.length > 0 && shards.every((f) => /^[0-9a-f]{2}\.bin$/.test(f) && statSync(join(dir, f)).size % 1568 === 0));
  // a record is sha256(text) + 384 float32 LE: a known name's record is found in its shard, a unit vector
  const name = request.records.find((r: { name?: string }) => r.name)!.name as string;
  const h = createHash('sha256').update(Buffer.from(name, 'utf8')).digest();
  const b = readFileSync(join(dir, `${h.subarray(0, 1).toString('hex')}.bin`));
  let at = -1;
  for (let i = 0; i + 1568 <= b.length; i += 1568) if (b.subarray(i, i + 32).equals(h)) { at = i; break; }
  assert.ok(at >= 0, `the record of "${name}" is in its shard`);
  let n = 0;
  for (let d = 0; d < 384; d++) n += b.readFloatLE(at + 32 + d * 4) ** 2;
  assert.ok(Math.abs(n - 1) < 1e-4, `a unit vector (norm² ${n})`);
});

test('a cut last record (a crash mid-write) is ignored and the cache still answers', { skip, timeout: 300_000 }, async () => {
  const cache = mkdtempSync(join(tmpdir(), 'pqvae-cache-'));
  const { request } = JSON.parse(readFileSync(join(fx, 'review-small5.json'), 'utf8'));
  const cold = await once(cache, '/review_schedule', request);
  const dir = join(cache, readdirSync(cache)[0]), shard = readdirSync(dir).find((f) => f.endsWith('.bin'))!;
  const { appendFileSync } = await import('node:fs');
  appendFileSync(join(dir, shard), Buffer.alloc(700, 7));   // half a record
  const warm = await once(cache, '/review_schedule', request);
  assert.deepEqual(warm.answer, cold.answer);
});
