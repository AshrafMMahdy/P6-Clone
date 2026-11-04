// AI assistant: provider settings and chat calls, in the main process so the API key never reaches the window.
// The key is encrypted with the operating system's protection (Electron safeStorage: DPAPI on Windows).
// Providers: Anthropic (Messages API) and anything OpenAI-compatible (OpenAI, OpenRouter, LM Studio, Ollama, ...).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseExtraBody, parseExtraHeaders, RESERVED_BODY, ANTHROPIC_REMOVED_BODY } from './ai-extras.ts';
import { modelOutputLimit } from './modelsDev.ts';

export type ProviderKind = 'anthropic' | 'openai';
export interface AiConfig {
  enabled: boolean; provider: ProviderKind; baseUrl: string; model: string;
  /** let the assistant operate the app (visibly, undoable) */ actions?: boolean;
  /** extra HTTP headers, "Name: value" per line (stored encrypted) */ extraHeaders?: string;
  /** JSON object merged into every request (max_tokens, ...; for Anthropic never temperature / top_p / top_k) */ extraBody?: string;
}
/** What the window may see: everything but the key. */
export interface AiPublicConfig extends AiConfig { hasKey: boolean; keyHint: string; encrypted: boolean }

import type { ToolDef } from '../core/query/tools.ts';
export type { ToolDef };
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
/** Provider-neutral chat message. */
export type ChatMsg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; /** the reply's own reasoning, with its model: Anthropic's whole reply (thinking in place), or an OpenAI-compatible host's reasoning field */ raw?: AnthropicTurn | ReasoningTurn }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
export interface ChatRequest { system: string; messages: ChatMsg[]; tools: ToolDef[] }
/** An Anthropic reply that held thinking blocks, kept whole (thinking, text and tool_use in their order) with the model
 *  that wrote it: it goes back unchanged, to that model, while the stored text and tool calls are still that reply. */
export interface AnthropicTurn { model: string; content: unknown[] }
/** An OpenAI-compatible reply's reasoning in the field the host sent it in (DeepSeek, Kimi, MiniMax, GLM, Qwen:
 *  reasoning_content), with the model that wrote it: it goes back on that model's own turns, which these hosts require
 *  (DeepSeek answers 400 when an assistant turn of a tool conversation comes back without it). */
export interface ReasoningTurn { model: string; field: 'reasoning_content' | 'reasoning'; value: string }
export interface ChatReply { content: string; toolCalls: ToolCall[]; stop: string; raw?: AnthropicTurn | ReasoningTurn }

export interface KeyBox { available(): boolean; encrypt(s: string): string; decrypt(s: string): string }

export const DEFAULTS: AiConfig = { enabled: false, provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '', actions: true };

// ---- providers, model tiers and seats (the platform's AI Providers page, for one user): several providers, each with its
// own key (encrypted with the OS, under a stable id, so a rename keeps it); an ordered list of tiers, strongest first (the
// agent's ladder for handovers and Researchers); seats pointing at tiers (an unset chat seat sits on the first tier).
export type ModelKind = 'anthropic' | 'openai' | 'gemini';
export interface PublicProvider { id: string; name: string; kind: ModelKind; baseUrl: string; extraHeaders: string; extraBody: string; hasKey: boolean; keyHint: string }
export interface TierDef { name: string; provider: string; model: string; /** JSON object of request parameters (optional) */ params?: string }
export interface PublicModels { enabled: boolean; actions: boolean; providers: PublicProvider[]; tiers: TierDef[]; seats: Record<string, string>; encrypted: boolean }
interface StoredProvider { id: string; name: string; kind: ModelKind; baseUrl: string; key?: string; keyEnc?: boolean; keyHint?: string; headersEnc?: string; extraBody?: string }
interface Stored {
  enabled: boolean; actions?: boolean; providers: StoredProvider[]; tiers: TierDef[]; seats: Record<string, string>;
  /** the single-provider settings of earlier versions, read once into providers / tiers */
  provider?: string; baseUrl?: string; model?: string; key?: string; keyEnc?: boolean; keyHint?: string; headersEnc?: string; extraHeaders?: string; extraBody?: string;
}
export const KIND_BASE: Record<ModelKind, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com' };

export class AiStore {
  private file: string; private box: KeyBox;
  constructor(file: string, box: KeyBox) { this.file = file; this.box = box; }
  private read(): Stored {
    let raw: Partial<Stored> = {};
    if (existsSync(this.file)) { try { raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch { raw = {}; } }
    const s: Stored = { enabled: !!raw.enabled, actions: raw.actions, providers: raw.providers ?? [], tiers: raw.tiers ?? [], seats: raw.seats ?? {} };
    if (!raw.providers && (raw.provider || raw.key || raw.model)) {
      // settings of an earlier version: its one provider becomes "main", its model the first tier
      s.providers = [{ id: 'main', name: 'main', kind: raw.provider === 'openai' ? 'openai' : 'anthropic', baseUrl: raw.baseUrl ?? '', key: raw.key, keyEnc: raw.keyEnc, keyHint: raw.keyHint,
        headersEnc: raw.headersEnc ?? (raw.extraHeaders || undefined), extraBody: raw.extraBody }];
      if (raw.model) s.tiers = [{ name: 'Main', provider: 'main', model: raw.model }];
    }
    return s;
  }
  private write(s: Stored): void { writeFileSync(this.file, JSON.stringify({ enabled: s.enabled, actions: s.actions, providers: s.providers, tiers: s.tiers, seats: s.seats }, null, 1)); }
  private secret(p: StoredProvider, v: string | undefined): string {
    if (!v) return '';
    try { return p.keyEnc === false ? v : this.box.decrypt(v); } catch { return ''; }
  }
  private seal(v: string): { value: string; enc: boolean } { const enc = this.box.available(); return { value: enc ? this.box.encrypt(v) : v, enc }; }
  /** The main agent's tier and its provider (the seat "agent", else the first tier). */
  private agent(s: Stored): { tier?: TierDef; p?: StoredProvider } {
    const tier = s.tiers.find((t) => t.name === s.seats.agent) ?? s.tiers[0];
    return { tier, p: tier ? s.providers.find((p) => p.id === tier.provider) : s.providers[0] };
  }

  publicModels(): PublicModels {
    const s = this.read();
    return {
      enabled: s.enabled, actions: s.actions !== false, tiers: s.tiers, seats: s.seats, encrypted: this.box.available(),
      providers: s.providers.map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, extraHeaders: this.secret(p, p.headersEnc), extraBody: p.extraBody ?? '', hasKey: !!p.key, keyHint: p.keyHint ?? '' })),
    };
  }
  /** Saves the whole setup. keys: per provider id, a new key ('' removes it; left out keeps the saved one). Refused, nothing
   *  saved, when a tier names no provider, a seat no tier, two share a name, or extra headers / body / parameters do not parse. */
  saveModels(m: PublicModels, keys: Record<string, string | undefined> = {}): PublicModels {
    const s = this.read();
    const names = new Set<string>();
    for (const p of m.providers) {
      const n = p.name.trim();
      if (!n) throw new Error('A provider needs a name.');
      if (names.has(n.toLowerCase())) throw new Error(`Two providers are named "${n}".`);
      names.add(n.toLowerCase());
      parseExtraHeaders(p.extraHeaders); parseExtraBody(p.extraBody, p.kind === 'anthropic' ? 'anthropic' : 'openai');
    }
    const ids = new Set(m.providers.map((p) => p.id)), tnames = new Set<string>();
    for (const t of m.tiers) {
      if (!t.name.trim()) throw new Error('A tier needs a name.');
      if (tnames.has(t.name.trim())) throw new Error(`Two tiers are named "${t.name}".`);
      tnames.add(t.name.trim());
      if (!ids.has(t.provider)) throw new Error(`Tier "${t.name}" names no provider of this list.`);
      if (!t.model.trim()) throw new Error(`Tier "${t.name}" has no model.`);
      if (t.params?.trim()) { let ok = false; try { const v = JSON.parse(t.params); ok = !!v && typeof v === 'object' && !Array.isArray(v); } catch { /* not JSON */ } if (!ok) throw new Error(`Tier "${t.name}": parameters must be a JSON object, e.g. {"temperature": 0.3}.`); }
    }
    for (const [seat, t] of Object.entries(m.seats)) if (t && !tnames.has(t)) throw new Error(`Seat "${seat}" names no tier of this list.`);
    const before = new Map(s.providers.map((p) => [p.id, p]));
    const providers: StoredProvider[] = m.providers.map((p) => {
      const old = before.get(p.id);
      const sp: StoredProvider = { id: p.id, name: p.name.trim(), kind: p.kind, baseUrl: p.baseUrl.trim(), extraBody: p.extraBody.trim() || undefined, key: old?.key, keyEnc: old?.keyEnc, keyHint: old?.keyHint };
      const k = keys[p.id];
      if (k !== undefined) {
        if (!k.trim()) { delete sp.key; delete sp.keyHint; delete sp.keyEnc; }
        else { const v = this.seal(k.trim()); sp.key = v.value; sp.keyEnc = v.enc; sp.keyHint = k.trim().length > 8 ? `…${k.trim().slice(-4)}` : ''; }
      }
      // extra headers can carry secrets (gateway tokens): sealed like the key (and only readable the same way)
      const h = p.extraHeaders.trim();
      if (h) { const v = sp.keyEnc === false ? { value: h, enc: false } : this.seal(h); sp.headersEnc = v.value; if (!v.enc) sp.keyEnc = false; }
      return sp;
    });
    this.write({
      enabled: !!m.enabled, actions: m.actions !== false, providers,
      tiers: m.tiers.map((t) => ({ name: t.name.trim(), provider: t.provider, model: t.model.trim(), ...(t.params?.trim() ? { params: t.params.trim() } : {}) })),
      seats: Object.fromEntries(Object.entries(m.seats).filter(([, t]) => !!t)),
    });
    return this.publicModels();
  }
  /** The embedded agent's models (main/whiq-config.ts): every provider with its key, the tiers in order, the seats. */
  agentModels(): { providers: { name: string; type: 'anthropic' | 'openai-compat' | 'gemini'; baseUrl: string; key: string }[]; tiers: { name: string; provider: string; model: string; params?: Record<string, unknown> }[]; seats: Record<string, string> } {
    const s = this.read();
    if (!s.tiers.length) throw new Error('Set a provider and a model in AI Assistant Settings first.');
    return {
      providers: s.providers.map((p) => ({ name: p.id, type: p.kind === 'anthropic' ? 'anthropic' as const : p.kind === 'gemini' ? 'gemini' as const : 'openai-compat' as const, baseUrl: p.baseUrl || KIND_BASE[p.kind], key: this.secret(p, p.key) })),
      tiers: s.tiers.map((t) => ({ name: t.name, provider: t.provider, model: t.model, ...(t.params ? { params: JSON.parse(t.params) as Record<string, unknown> } : {}) })),
      seats: s.seats,
    };
  }

  // ---- the main agent's provider and model, for the panel's own loop (a build without the platform agent)
  publicConfig(): AiPublicConfig {
    const s = this.read(), { tier, p } = this.agent(s);
    return {
      enabled: s.enabled, provider: !p || p.kind === 'anthropic' ? 'anthropic' : 'openai', baseUrl: p?.baseUrl ?? DEFAULTS.baseUrl, model: tier?.model ?? '', actions: s.actions !== false,
      extraHeaders: p ? this.secret(p, p.headersEnc) : '', extraBody: p?.extraBody ?? '', hasKey: !!p?.key, keyHint: p?.keyHint ?? '', encrypted: p?.keyEnc !== false,
    };
  }
  /** One provider and one model (the simple setup): the main agent's provider and tier are set, the others kept.
   *  apiKey: undefined keeps the saved key, '' removes it. */
  save(c: AiConfig, apiKey?: string): AiPublicConfig {
    const m = this.publicModels(), { tier, p } = this.agent(this.read());
    const id = p?.id ?? 'main';
    const prov: PublicProvider = { id, name: p?.name ?? 'main', kind: c.provider === 'openai' ? 'openai' : 'anthropic', baseUrl: String(c.baseUrl || '').trim(), extraHeaders: String(c.extraHeaders ?? ''), extraBody: String(c.extraBody ?? ''), hasKey: false, keyHint: '' };
    const providers = m.providers.some((x) => x.id === id) ? m.providers.map((x) => (x.id === id ? prov : x)) : [prov, ...m.providers];
    const model = String(c.model || '').trim(), tname = tier?.name ?? 'Main';
    const tiers = !model ? m.tiers.filter((t) => t.name !== tname)
      : m.tiers.some((t) => t.name === tname) ? m.tiers.map((t) => (t.name === tname ? { ...t, provider: id, model } : t)) : [{ name: tname, provider: id, model }, ...m.tiers];
    const seats = Object.fromEntries(Object.entries(m.seats).filter(([, t]) => tiers.some((x) => x.name === t)));
    this.saveModels({ ...m, enabled: !!c.enabled, actions: c.actions !== false, providers, tiers, seats }, apiKey === undefined ? {} : { [id]: apiKey });
    return this.publicConfig();
  }
  key(): string { const { p } = this.agent(this.read()); return p ? this.secret(p, p.key) : ''; }
  /** A tier's provider and model as one request's settings, with its key (a tier's Test button). Gemini tiers are
   *  reached through the agent's router only. */
  tierRequest(name: string): { cfg: AiConfig; key: string } {
    const s = this.read(), t = s.tiers.find((x) => x.name === name);
    if (!t) throw new Error(`No tier "${name}" is saved (save the settings first).`);
    const p = s.providers.find((x) => x.id === t.provider);
    if (!p) throw new Error(`Tier "${name}" names no provider.`);
    if (p.kind === 'gemini') throw new Error('A Gemini tier is tested by the agent itself: ask it something.');
    return { cfg: { enabled: true, provider: p.kind === 'anthropic' ? 'anthropic' : 'openai', baseUrl: p.baseUrl || KIND_BASE[p.kind], model: t.model, extraHeaders: this.secret(p, p.headersEnc), extraBody: p.extraBody }, key: this.secret(p, p.key) };
  }
  config(): AiConfig { const c = this.publicConfig(); return { enabled: c.enabled, provider: c.provider, baseUrl: c.baseUrl, model: c.model, extraHeaders: c.extraHeaders, extraBody: c.extraBody }; }
}

/** The Claude API version the assistant names. 2026-10-21 removed temperature / top_p / top_k (a 400 on every model). */
export const ANTHROPIC_API_VERSION = '2026-10-21';
/** The beta that carries thinking.block_binding. */
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
/** Anthropic requires max_tokens: the model's own output limit (models.dev), else what this model's refusal named
 *  earlier (remembered for the process), else the known-safe 32768 that every current Claude model takes. Never a fixed
 *  smaller number: a long tool call (a WBS area of schedule operations) must not be cut. The user's extra body still
 *  overrides it. */
export const ANTHROPIC_FALLBACK_OUTPUT = 32768;
const learnedOutput = new Map<string, number>();
export function anthropicMaxTokens(model: string): number {
  return learnedOutput.get(model) ?? modelOutputLimit('anthropic', model) ?? ANTHROPIC_FALLBACK_OUTPUT;
}
/** A refusal of the asked max_tokens ("max_tokens: 64000 > 32000, which is the maximum allowed…"): the number to ask
 *  instead, when the host named one below what was asked. */
export function outputLimitFromRefusal(text: string, asked: number): number | null {
  if (!/max_tokens|maximum (?:allowed )?(?:number of )?(?:output )?tokens/i.test(text)) return null;
  const nums = (text.match(/\d{4,7}/g) ?? []).map(Number).filter((n) => n >= 1024 && n < asked);
  return nums.length ? Math.max(...nums) : null;
}
const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** Build the HTTP request for a provider, with the user's extra headers and parameters (pure, so it can be tested). */
export function buildRequest(cfg: AiConfig, key: string, req: ChatRequest): { url: string; headers: Record<string, string>; body: unknown } {
  const r = baseRequest(cfg, key, req);
  const extra = parseExtraBody(cfg.extraBody, undefined);
  for (const k of RESERVED_BODY) delete extra[k];
  // Settings saved before API version 2026-10-21 can still carry a sampling parameter, which that version refuses on every
  // request; the dialog shows why when it is opened (parseExtraBody with the provider).
  if (cfg.provider === 'anthropic') for (const k of ANTHROPIC_REMOVED_BODY) delete extra[k];
  const headers = parseExtraHeaders(cfg.extraHeaders);
  // Anthropic keys not scoped to a workspace need "anthropic-workspace-id"; accept the obvious spellings of it
  if (cfg.provider === 'anthropic') for (const n of Object.keys(headers)) {
    if (/^(anthropic)?workspace(id)?$/.test(n.toLowerCase().replace(/[^a-z]/g, '')) && n !== 'anthropic-workspace-id') { headers['anthropic-workspace-id'] = headers[n]; delete headers[n]; }
  }
  const merged: Record<string, string> = { ...r.headers };
  for (const [name, value] of Object.entries(headers)) {
    // the user's own anthropic-beta joins the one the request needs (any spelling of the name), never replaces it
    const own = name.toLowerCase() === 'anthropic-beta' ? Object.keys(merged).find((n) => n.toLowerCase() === 'anthropic-beta') : undefined;
    if (own) { merged[own] = [merged[own], value].filter(Boolean).join(','); continue; }
    merged[name] = value;
  }
  const body: Record<string, unknown> = { ...(r.body as object), ...extra };
  // a user's own thinking setting keeps the binding the handed-back blocks need
  const binding = (r.body as { thinking?: { block_binding?: unknown } }).thinking?.block_binding;
  if (binding && extra.thinking && typeof extra.thinking === 'object') body.thinking = { ...(extra.thinking as object), block_binding: binding };
  return { url: r.url, headers: merged, body };
}

/** The kept reply when it is still this message for this model (same text, same tool calls in order), else null. */
function keptTurn(m: ChatMsg, model: string): unknown[] | null {
  if (m.role !== 'assistant' || !m.raw || m.raw.model !== model || !('content' in m.raw) || !Array.isArray(m.raw.content)) return null;
  const blocks = m.raw.content as Array<{ type?: string; text?: string; id?: string }>;
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  const ids = blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
  const calls = (m.toolCalls ?? []).map((c) => c.id);
  return text === m.content && ids.length === calls.length && ids.every((id, i) => id === calls[i]) ? m.raw.content : null;
}

/** The host of a URL, or '' when it is not one. */
function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return ''; } }

function baseRequest(cfg: AiConfig, key: string, req: ChatRequest): { url: string; headers: Record<string, string>; body: unknown } {
  if (cfg.provider === 'anthropic') {
    const base = trimSlash(cfg.baseUrl || 'https://api.anthropic.com');
    const messages: unknown[] = [];
    for (const m of req.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      // the reply as the model wrote it, thinking in place, while it is still that reply for this model; else without thinking
      else if (m.role === 'assistant') messages.push({ role: 'assistant', content: keptTurn(m, cfg.model) ?? [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.args }))] });
      else {
        // consecutive tool results go into one user message
        const prev = messages[messages.length - 1] as { role: string; content: unknown[] } | undefined;
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        if (prev && prev.role === 'user' && Array.isArray(prev.content) && (prev.content[0] as { type?: string })?.type === 'tool_result') prev.content.push(block);
        else messages.push({ role: 'user', content: [block] });
      }
    }
    // Thinking blocks going back are bound to the context before them on Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, and
    // the conversation is shortened as it grows (renderer/ai/context.ts): "drop_block" drops a block whose context changed
    // instead of failing the request. Models without the check accept it.
    const sendsThinking = req.messages.some((m) => m.role === 'assistant' && keptTurn(m, cfg.model) !== null);
    return {
      url: `${base}${/\/v1$/.test(base) ? '' : '/v1'}/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_API_VERSION, ...(sendsThinking ? { 'anthropic-beta': THINKING_BINDING_BETA } : {}) },
      body: { model: cfg.model, max_tokens: anthropicMaxTokens(cfg.model), system: req.system, messages, tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        ...(sendsThinking ? { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } } : {}) },
    };
  }
  const base = trimSlash(cfg.baseUrl || 'https://api.openai.com/v1');
  // The reasoning_content family takes its reasoning back on its own turns; DeepSeek and Kimi refuse a tool conversation's
  // assistant turn without the field. Other hosts get nothing back (some return a field they refuse as input: Groq).
  const host = hostOf(base);
  const echoesReasoning = /(^|\.)(deepseek\.com|moonshot\.(ai|cn)|kimi\.(ai|com)|z\.ai|bigmodel\.cn|aliyuncs\.com)$/i.test(host);
  const needsReasoningField = /(^|\.)(deepseek\.com|moonshot\.(ai|cn)|kimi\.(ai|com))$/i.test(host);
  const messages: unknown[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      // The model's own reasoning back on these hosts; DeepSeek and Kimi also need the field (empty) on a turn another
      // model wrote once tools are in the conversation.
      const own = echoesReasoning && m.raw && 'field' in m.raw && m.raw.model === cfg.model ? { reasoning_content: m.raw.value } : needsReasoningField && req.tools.length ? { reasoning_content: '' } : {};
      messages.push({ role: 'assistant', content: m.content || null, ...own, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) });
    }
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
      ...(blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking') ? { raw: { model: cfg.model, content: blocks } } : {}),
    };
  }
  const m = json?.choices?.[0]?.message ?? {};
  const calls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  return {
    content: typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : '',
    toolCalls: calls.map((c, i) => { let args: Record<string, unknown> = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* model sent bad JSON */ } return { id: String(c.id ?? `call_${i}`), name: String(c.function?.name ?? ''), args }; }),
    stop: String(json?.choices?.[0]?.finish_reason ?? ''),
    ...(typeof m.reasoning_content === 'string' && m.reasoning_content ? { raw: { model: cfg.model, field: 'reasoning_content' as const, value: m.reasoning_content } }
      : typeof m.reasoning === 'string' && m.reasoning ? { raw: { model: cfg.model, field: 'reasoning' as const, value: m.reasoning } } : {}),
  };
}

export async function chat(store: AiStore, req: ChatRequest, signal?: AbortSignal): Promise<ChatReply> {
  return chatWith(store.config(), store.key(), req, signal);
}

/** One request to a provider and model (the panel's own loop; a tier's Test button). */
export async function chatWith(cfg: AiConfig, key: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatReply> {
  if (!cfg.model) throw new Error('No model is set. Open Edit > AI Assistant Settings and enter a model name.');
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
    // The model takes fewer output tokens than asked and said how many: remember it and ask again (each retry asks less).
    const asked = Number((r.body as { max_tokens?: unknown }).max_tokens);
    const lower = cfg.provider === 'anthropic' && res.status === 400 ? outputLimitFromRefusal(text, asked) : null;
    if (lower) { learnedOutput.set(cfg.model, lower); return chatWith(cfg, key, req, signal); }
    const msg = json?.error?.message ?? json?.error ?? json?.message ?? text.slice(0, 300);
    throw new Error(`The provider answered ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  if (!json) throw new Error('The provider did not return JSON.');
  return parseReply(cfg, json);
}
