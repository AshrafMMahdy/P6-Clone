// The HTTP side of the PQ-VAE sidecar: routes, JSON in and out, the Python sidecar's status codes. main/pqvae/sidecar.ts is the process around it.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Aborted, Engines } from './engines.ts';
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

/** The largest request body taken (a 12,000-activity schedule is about 3 MB). */
export const MAX_BODY = 64 * 1024 * 1024;
class TooBig extends Error {}

const readBody = (req: IncomingMessage, limit: number): Promise<Buffer> => new Promise((ok, no) => {
  if (Number(req.headers['content-length']) > limit) return no(new TooBig());
  const chunks: Buffer[] = [];
  let size = 0, done = false;
  req.on('data', (c: Buffer) => {
    if (done) return;
    size += c.length;
    if (size > limit) { done = true; chunks.length = 0; no(new TooBig()); } else chunks.push(c);
  });
  req.on('end', () => { if (!done) ok(Buffer.concat(chunks)); });
  req.on('error', no);
});

/** The HTTP server over a model folder. Requests run one after the other: the ONNX sessions are not entered twice at once. A request whose client
 *  has gone is stopped between batches, and one still waiting its turn never starts, so an abandoned call leaves nothing queued behind it.
 *  Only the local client is served: a Host that is not 127.0.0.1:<port> or localhost:<port> (DNS rebinding) and any request carrying an Origin
 *  (a web page's) are refused with 403; the platform's client sends neither. */
export function makeServer(models: string, maxBody = MAX_BODY) {
  const engines = new Engines(models);
  let chain: Promise<unknown> = Promise.resolve();
  let abandoned = 0;
  const serial = <T>(f: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    const run = async (): Promise<T> => {
      if (signal.aborted) throw new Aborted();
      engines.signal = signal;
      try { return await f(); } finally { engines.signal = null; }
    };
    const r = chain.then(run, run);
    chain = r.catch(() => undefined);
    return r;
  };
  const server = createServer(async (req, res) => {
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) gone.abort(); });
    try {
      const port = (server.address() as AddressInfo | null)?.port;
      const host = String(req.headers.host ?? '').toLowerCase();
      const refuse = (error: string): void => { res.setHeader('Connection', 'close'); send(res, 403, { error }); };   // the body is not read: do not keep the connection
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse('host not allowed');
      if (req.headers.origin !== undefined) return refuse('requests from web pages are not allowed');
      if (req.method === 'GET') {
        if (req.url === '/health') return send(res, 200, { ok: true, loaded: [...engines.loaded].sort(), calibration: CALIBRATION, abandoned });
        return send(res, 404, { error: 'not found' });
      }
      let raw: Buffer;
      try { raw = await readBody(req, maxBody); } catch (e) {
        if (!(e instanceof TooBig)) throw e;
        // no "Connection: close": Node then reads and drops the rest of the upload before it would close, so the client,
        // still sending, gets the answer (a close mid-upload resets the connection and loses it); Node's request timeout bounds it
        return send(res, 413, { error: `request body is over ${maxBody / 1024 / 1024} MB` });
      }
      let body: Rec;
      try { body = JSON.parse(raw.length ? raw.toString('utf8') : '{}'); } catch (e) { return send(res, 400, { error: `bad json: ${(e as Error).message}` }); }
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      if (NOT_PORTED.has(path)) return send(res, 200, { error: `${path} is not part of the desktop app's scheduler agent` });
      const fn = ROUTES[path];
      if (!fn) return send(res, 404, { error: 'not found' });
      try {
        const out = await serial(async () => fn(engines, body ?? {}), gone.signal);
        if (out && typeof out === 'object' && !Array.isArray(out) && !('calibration' in out)) out.calibration = CALIBRATION;
        send(res, 200, out);
      } catch (e) {
        if (e instanceof Aborted) { abandoned++; return; }   // the client is gone: nobody to answer
        send(res, 500, { error: (e as Error).message, trace: String((e as Error).stack ?? '').slice(-1500) });
      }
    } catch (e) { try { send(res, 500, { error: (e as Error).message }); } catch { /* the socket is gone */ } }
  });
  return { server, engines };
}
