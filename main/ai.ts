// AI assistant: provider settings and chat calls, in the main process so the API key never reaches the window.
// The key is encrypted with the operating system's protection (Electron safeStorage: DPAPI on Windows).
// Providers: Anthropic (Messages API) and anything OpenAI-compatible (OpenAI, OpenRouter, LM Studio, Ollama, ...).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseExtraBody, parseExtraHeaders, RESERVED_BODY } from './ai-extras.ts';

export type ProviderKind = 'anthropic' | 'openai';
export interface AiConfig {
  enabled: boolean; provider: ProviderKind; baseUrl: string; model: string;
  /** let the assistant operate the app (visibly, undoable) */ actions?: boolean;
  /** extra HTTP headers, "Name: value" per line (stored encrypted) */ extraHeaders?: string;
  /** JSON object merged into every request (temperature, top_p, max_tokens, ...) */ extraBody?: string;
}
/** What the window may see: everything but the key. */
export interface AiPublicConfig extends AiConfig { hasKey: boolean; keyHint: string; encrypted: boolean }

import type { ToolDef } from '../core/query/tools.ts';
export type { ToolDef };
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
/** Provider-neutral chat message. */
export type ChatMsg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
export interface ChatRequest { system: string; messages: ChatMsg[]; tools: ToolDef[] }
export interface ChatReply { content: string; toolCalls: ToolCall[]; stop: string }

interface Stored extends AiConfig { key?: string; keyEnc?: boolean; keyHint?: string; headersEnc?: string }
export interface KeyBox { available(): boolean; encrypt(s: string): string; decrypt(s: string): string }

export const DEFAULTS: AiConfig = { enabled: false, provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '', actions: true };

export class AiStore {
  private file: string; private box: KeyBox;
  constructor(file: string, box: KeyBox) { this.file = file; this.box = box; }
  private read(): Stored {
    if (!existsSync(this.file)) return { ...DEFAULTS };
    try { return { ...DEFAULTS, ...JSON.parse(readFileSync(this.file, 'utf8')) }; } catch { return { ...DEFAULTS }; }
  }
  private headers(s: Stored): string {
    if (s.headersEnc) { try { return s.keyEnc === false ? s.headersEnc : this.box.decrypt(s.headersEnc); } catch { return ''; } }
    return s.extraHeaders ?? '';
  }
  publicConfig(): AiPublicConfig {
    const s = this.read();
    return { enabled: s.enabled, provider: s.provider, baseUrl: s.baseUrl, model: s.model, actions: s.actions !== false, extraHeaders: this.headers(s), extraBody: s.extraBody ?? '', hasKey: !!s.key, keyHint: s.keyHint ?? '', encrypted: s.keyEnc !== false };
  }
  /** apiKey: undefined keeps the saved key, '' removes it. */
  save(c: AiConfig, apiKey?: string): AiPublicConfig {
    const s = this.read();
    parseExtraHeaders(c.extraHeaders); parseExtraBody(c.extraBody); // refuse to save what would break every request
    const next: Stored = { ...s, enabled: !!c.enabled, provider: c.provider === 'openai' ? 'openai' : 'anthropic', baseUrl: String(c.baseUrl || '').trim(), model: String(c.model || '').trim(), actions: c.actions !== false, extraBody: String(c.extraBody ?? '').trim() };
    // extra headers can carry secrets (gateway tokens): encrypted like the key
    delete next.extraHeaders;
    const h = String(c.extraHeaders ?? '').trim();
    if (h) next.headersEnc = this.box.available() ? this.box.encrypt(h) : h; else delete next.headersEnc;
    if (apiKey !== undefined) {
      const k = apiKey.trim();
      if (!k) { delete next.key; delete next.keyHint; delete next.keyEnc; }
      else {
        const enc = this.box.available();
        next.key = enc ? this.box.encrypt(k) : k;
        next.keyEnc = enc;
        next.keyHint = k.length > 8 ? `…${k.slice(-4)}` : '';
      }
    }
    writeFileSync(this.file, JSON.stringify(next, null, 1));
    return this.publicConfig();
  }
  key(): string {
    const s = this.read();
    if (!s.key) return '';
    return s.keyEnc === false ? s.key : this.box.decrypt(s.key);
  }
  config(): AiConfig { const s = this.read(); return { enabled: s.enabled, provider: s.provider, baseUrl: s.baseUrl, model: s.model, extraHeaders: this.headers(s), extraBody: s.extraBody }; }
}

// Anthropic max_tokens 16000: room for a WBS area of schedule operations in one tool call
const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** Build the HTTP request for a provider, with the user's extra headers and parameters (pure, so it can be tested). */
export function buildRequest(cfg: AiConfig, key: string, req: ChatRequest): { url: string; headers: Record<string, string>; body: unknown } {
  const r = baseRequest(cfg, key, req);
  const extra = parseExtraBody(cfg.extraBody);
  for (const k of RESERVED_BODY) delete extra[k];
  const headers = parseExtraHeaders(cfg.extraHeaders);
  // Anthropic keys not scoped to a workspace need "anthropic-workspace-id"; accept the obvious spellings of it
  if (cfg.provider === 'anthropic') for (const n of Object.keys(headers)) {
    if (/^(anthropic)?workspace(id)?$/.test(n.toLowerCase().replace(/[^a-z]/g, '')) && n !== 'anthropic-workspace-id') { headers['anthropic-workspace-id'] = headers[n]; delete headers[n]; }
  }
  return { url: r.url, headers: { ...r.headers, ...headers }, body: { ...(r.body as object), ...extra } };
}

function baseRequest(cfg: AiConfig, key: string, req: ChatRequest): { url: string; headers: Record<string, string>; body: unknown } {
  if (cfg.provider === 'anthropic') {
    const base = trimSlash(cfg.baseUrl || 'https://api.anthropic.com');
    const messages: unknown[] = [];
    for (const m of req.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') messages.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.args }))] });
      else {
        // consecutive tool results go into one user message
        const prev = messages[messages.length - 1] as { role: string; content: unknown[] } | undefined;
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        if (prev && prev.role === 'user' && Array.isArray(prev.content) && (prev.content[0] as { type?: string })?.type === 'tool_result') prev.content.push(block);
        else messages.push({ role: 'user', content: [block] });
      }
    }
    return {
      url: `${base}${/\/v1$/.test(base) ? '' : '/v1'}/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model: cfg.model, max_tokens: 16000, system: req.system, messages, tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) },
    };
  }
  const base = trimSlash(cfg.baseUrl || 'https://api.openai.com/v1');
  const messages: unknown[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) });
    else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (/openrouter\.ai/.test(base)) { headers['HTTP-Referer'] = 'https://localhost/p6-clone'; headers['X-Title'] = 'P6 Clone'; }
  return {
    url: `${base}/chat/completions`,
    headers,
    body: { model: cfg.model, messages, ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}) },
  };
}

/** Turn a provider response into a ChatReply (pure). */
export function parseReply(cfg: AiConfig, json: any): ChatReply {
  if (cfg.provider === 'anthropic') {
    const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
    return {
      content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), args: b.input ?? {} })),
      stop: String(json?.stop_reason ?? ''),
    };
  }
  const m = json?.choices?.[0]?.message ?? {};
  const calls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  return {
    content: typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : '',
    toolCalls: calls.map((c, i) => { let args: Record<string, unknown> = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* model sent bad JSON */ } return { id: String(c.id ?? `call_${i}`), name: String(c.function?.name ?? ''), args }; }),
    stop: String(json?.choices?.[0]?.finish_reason ?? ''),
  };
}

export async function chat(store: AiStore, req: ChatRequest, signal?: AbortSignal): Promise<ChatReply> {
  const cfg = store.config();
  if (!cfg.model) throw new Error('No model is set. Open Edit > AI Assistant Settings and enter a model name.');
  const key = store.key();
  if (!key && cfg.provider === 'anthropic') throw new Error('No API key is saved. Open Edit > AI Assistant Settings.');
  const r = buildRequest(cfg, key, req);
  let res: Response;
  try {
    res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(`Could not reach ${r.url}: ${(e as Error).message}. Check the provider URL (a local server must be running).`);
  }
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.error ?? json?.message ?? text.slice(0, 300);
    throw new Error(`The provider answered ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  if (!json) throw new Error('The provider did not return JSON.');
  return parseReply(cfg, json);
}
