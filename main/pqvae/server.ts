// The HTTP side of the PQ-VAE sidecar: routes, JSON in and out, the Python sidecar's status codes. main/pqvae/sidecar.ts is the process around it.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Engines } from './engines.ts';
import { encode, growth, refclass, reviewSchedule, trajectory } from './handlers.ts';
import { CALIBRATION } from './schemas.ts';
import type { Rec } from './pyutil.ts';

type Handler = (e: Engines, body: Rec) => Promise<Rec> | Rec;
const ROUTES: Record<string, Handler> = {
  '/encode': encode, '/review_schedule': reviewSchedule, '/trajectory': trajectory, '/refclass': refclass, '/growth': growth,
};
/** Endpoints of the Python sidecar that no scheduler chat reaches (risk, BOQ, claims, payments, comms, forensic, heartbeat). */
const NOT_PORTED = new Set(['/heartbeat', '/tender_review', '/claim_quantum', '/riskreg', '/risk_catalog', '/forensic', '/comms', '/payments']);

const send = (res: ServerResponse, code: number, obj: unknown): void => {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': data.length });
  res.end(data);
};

const readBody = (req: IncomingMessage): Promise<Buffer> => new Promise((ok, no) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', no);
});

/** The HTTP server over a model folder. Requests run one after the other: the ONNX sessions are not entered twice at once. */
export function makeServer(models: string) {
  const engines = new Engines(models);
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const r = chain.then(f, f); chain = r.catch(() => undefined); return r; };
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        if (req.url === '/health') return send(res, 200, { ok: true, loaded: [...engines.loaded].sort(), calibration: CALIBRATION });
        return send(res, 404, { error: 'not found' });
      }
      const raw = await readBody(req);
      let body: Rec;
      try { body = JSON.parse(raw.length ? raw.toString('utf8') : '{}'); } catch (e) { return send(res, 400, { error: `bad json: ${(e as Error).message}` }); }
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      if (NOT_PORTED.has(path)) return send(res, 200, { error: `${path} is not part of the desktop app's scheduler agent` });
      const fn = ROUTES[path];
      if (!fn) return send(res, 404, { error: 'not found' });
      try {
        const out = await serial(async () => fn(engines, body ?? {}));
        if (out && typeof out === 'object' && !Array.isArray(out) && !('calibration' in out)) out.calibration = CALIBRATION;
        send(res, 200, out);
      } catch (e) { send(res, 500, { error: (e as Error).message, trace: String((e as Error).stack ?? '').slice(-1500) }); }
    } catch (e) { try { send(res, 500, { error: (e as Error).message }); } catch { /* the socket is gone */ } }
  });
  return { server, engines };
}
