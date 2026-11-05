// The PQ-VAE engine's sidecar for the desktop app, in Node: the same local HTTP API as the platform's Python sidecar (pqvae/sidecar.py), so the
// agent's client (pqvaeClient.ts) uses it unchanged, with no Python and no torch on the user's PC. Models are ONNX (scripts/pqvae-export.py)
// run by onnxruntime-web. Only the endpoints the scheduler module's tools reach are here:
//   GET  /health                                       -> { ok, loaded: [engines], calibration }
//   POST /encode          { records }                  -> { codes: [[l0, l1, l2] …], n }
//   POST /review_schedule { records, shuffles?, calib? } -> phase order, sequencing grammar vs random orders, per-activity surprise and duration flags
//   POST /trajectory      { periods, ptype, planned_months?, calib? } -> pred_overrun_x, pred_delay_months (+ company-corrected)
//   POST /refclass        { ptype, budget_eur, calib? } -> reference-class forecast (real data only)
//   POST /growth          { ptype, contract_form }     -> lognormal growth parameters + recoverability
// Any other endpoint of the Python sidecar answers HTTP 200 { error } (the client turns `error` into a message). Every answer carries
// `calibration: "v2-minilm"`.
// Differences from the Python sidecar, each visible in the answer: a programme past 256 activities is scored in windows (`windowed_scoring`);
// past 3,000 distinct names the names that differ only in their digits share one reading (`notice`, so a review fits the client's 180 s);
// past 120 periods /trajectory says how many it read (`notice`); shuffles below 1 answer verdict "n/a" instead of NaN. A call whose client has
// gone stops between batches. Only Host 127.0.0.1:<port> / localhost:<port> without an Origin is served; a body over 64 MB is 413.
//
//   node main/pqvae/sidecar.ts --models <dir> [--port <n>] [--threads <n>] [--cache <dir>]      --port 0 (the default) takes a free port; --threads (default 1)
//   is the WebAssembly runtime's thread count (start.ts passes min(4, cores - 1), at least 1)
// The chosen port is printed as one JSON line on stdout, {"port":N}. It listens on 127.0.0.1 only and ends when its stdin closes (the spawning
// process holds the pipe: the sidecar never outlives it); started from a terminal it keeps running. LLM_ROUTER_URL names the router whose
// decide seat reads activity names (default http://127.0.0.1:5009).
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { here } from './runtime.ts';
import { makeServer } from './server.ts';

function main(): void {
  const args = process.argv.slice(2);
  const opt = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const port = Number(opt('--port') ?? 0);
  if (opt('--threads')) process.env.PQVAE_THREADS = opt('--threads');
  const h = here() ?? process.cwd();
  const models = resolve(opt('--models') ?? process.env.PQVAE_MODELS ?? [join(h, '..', '..', 'vendor', 'whiq-agent', 'pqvae-onnx'), join(h, 'pqvae-onnx'), join(h, '..', 'pqvae-onnx')].find((d) => existsSync(join(d, 'manifest.json'))) ?? '');
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error(`pqvae sidecar: bad --port ${opt('--port')}`); process.exit(2); }
  if (!existsSync(join(models, 'manifest.json'))) { console.error(`pqvae sidecar: no model folder at ${models} (--models <dir>; scripts/pqvae-export.py writes it)`); process.exit(2); }
  // --cache <dir> (or PQVAE_TEXT_CACHE): text readings kept on disk across requests and runs (textCache.ts); none, memory only
  const cache = opt('--cache') ?? process.env.PQVAE_TEXT_CACHE;
  const { server } = makeServer(models, undefined, cache ? resolve(cache) : undefined);
  server.on('error', (e: NodeJS.ErrnoException) => { console.error(`pqvae sidecar: ${e.code === 'EADDRINUSE' ? `port ${port} is in use (EADDRINUSE)` : e.message}`); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ port: (server.address() as { port: number }).port })));
  // ends with whoever started it: when the pipe on stdin closes
  if (!process.stdin.isTTY) {
    const stop = (): void => process.exit(0);
    process.stdin.on('data', () => undefined).on('end', stop).on('close', stop).on('error', stop).resume();
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
}

main();
