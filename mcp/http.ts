// MCP Streamable HTTP transport (spec 2025-06-18): one endpoint, POST JSON-RPC messages, JSON responses.
// - Bound to 127.0.0.1 by default; a bearer token when configured; Origin checked against DNS rebinding.
// - Mcp-Session-Id issued at initialize; it is the caller of last resort when a call has no `caller`.
// - GET (server-sent stream) is not offered (405); DELETE ends a session.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { handleMessage } from './stdio.ts';

const MAX_BODY = 10 * 1048576;

export function startHttp(o: { port: number; host: string; token: string | null }): void {
  const sessions = new Set<string>();
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const tokenOk = (req: IncomingMessage) => {
    if (!o.token) return true;
    const got = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const a = Buffer.from(got), b = Buffer.from(o.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (url.pathname !== '/mcp') return json(res, 404, { error: 'Use the /mcp endpoint.' });
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return json(res, 403, { error: 'Origin not allowed.' });
    if (!tokenOk(req)) return json(res, 401, { error: 'Missing or wrong bearer token.' }, { 'www-authenticate': 'Bearer' });
    const sid = (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
    if (req.method === 'DELETE') { if (sid) sessions.delete(sid); return json(res, 200, { ended: !!sid }); }
    if (req.method === 'GET') return json(res, 405, { error: 'This server answers POST requests only (no server-sent stream).' }, { allow: 'POST, DELETE' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' }, { allow: 'POST, DELETE' });
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { json(res, 413, { error: 'Request too large.' }); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const msgs = Array.isArray(body) ? body : [body];
      const isInit = msgs.some((m) => m?.method === 'initialize');
      let session = sid;
      if (isInit) { session = randomUUID(); sessions.add(session); }
      else if (sid && !sessions.has(sid)) sessions.add(sid); // tolerate a restart: the session id keeps identifying the caller
      try {
        const out = (await Promise.all(msgs.map((m) => handleMessage(m, session)))).filter((x) => x !== undefined);
        const headers: Record<string, string> = session ? { 'mcp-session-id': session } : {};
        if (!out.length) { res.writeHead(202, headers); return res.end(); }
        json(res, 200, Array.isArray(body) ? out : out[0], headers);
      } catch (e) { json(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: (e as Error).message } }); }
    });
  });
  server.requestTimeout = 0; // long calls turn into jobs on their own; never cut a request off mid-way
  server.listen(o.port, o.host, () => process.stderr.write(`P6 Clone MCP listening on http://${o.host}:${(server.address() as { port: number }).port}/mcp${o.token ? ' (bearer token required)' : ''}\n`));
}
