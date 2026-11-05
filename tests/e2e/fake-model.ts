// A scripted stand-in for an OpenAI-compatible model, so the embedded platform agent can be tested end to end with no
// paid model: each reply comes from the test's script, given the request (its messages and the tools offered). Plain
// JSON replies (the platform's router accepts a host that does not stream), each after `delayMs` when the script asks
// (a step that takes a while). Requests are kept for the test to read.
import { createServer } from 'node:http';

export type Req = { model: string; messages: { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }[]; tools?: { type: string; function: { name: string; description?: string; parameters?: any } }[] };
export type Reply = ({ text: string } | { call: string; args: Record<string, unknown> }) & { delayMs?: number };

/** `transcript`: what its /audio/transcriptions answers (the speech-to-text seat's provider); the audio it was sent is kept in `audio`. */
export async function fakeModel(script: (req: Req, n: number) => Reply, transcript = 'Hello from the stand-in transcriber.'): Promise<{ url: string; requests: Req[]; headers: Record<string, string | string[] | undefined>[]; audio: { model: string; format: string; bytes: number; auth: string }[]; close: () => void }> {
  const requests: Req[] = [], headers: Record<string, string | string[] | undefined>[] = [], audio: { model: string; format: string; bytes: number; auth: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.endsWith('/audio/transcriptions')) {
        try { const a = JSON.parse(body); audio.push({ model: a.model, format: a.input_audio?.format, bytes: Buffer.from(String(a.input_audio?.data ?? ''), 'base64').length, auth: String(req.headers.authorization ?? '') }); } catch { res.writeHead(400); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: transcript }));
      }
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
      let r: Req;
      try { r = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      requests.push(r); headers.push(req.headers);
      const out = script(r, requests.length);
      const message = 'text' in out
        ? { role: 'assistant', content: out.text }
        : { role: 'assistant', content: '', tool_calls: [{ id: `call_${requests.length}`, type: 'function', function: { name: out.call, arguments: JSON.stringify(out.args) } }] };
      const n = requests.length;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `fake-${n}`, object: 'chat.completion', model: r.model, choices: [{ index: 0, message, finish_reason: 'text' in out ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests, headers, audio, close: () => server.close() };
}
