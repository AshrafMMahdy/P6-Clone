// Edit > AI Assistant Settings, after the platform's AI Providers page, for one user: General (on, may it work the app),
// API keys (several providers: name, kind, endpoint, key, extra headers / parameters), Models & tiers (an ordered list,
// strongest first: the agent's ladder for handovers and Researchers; each tier a provider and a model, with a Test
// button) and Seats (which tier each of the agent's seats sits on: the agent, Researchers, Reviewer, Advisor, handovers,
// the eyes, ...; an unset chat seat sits on the agent's tier). Keys go once to the main process, which encrypts them, and are never shown again.
import { useEffect, useState } from 'react';
import { Dialog, Tabs } from '../components/Layout.tsx';
import { closeDialog, toast } from '../store.ts';
import type { ModelKind, PublicModels, PublicProvider, TierDef } from '../../main/ai.ts';
import { parseExtraBody, parseExtraHeaders, providerCanSearch } from '../../main/ai-extras.ts';

const PRESETS: { label: string; kind: ModelKind; url: string; hint: string }[] = [
  { label: 'Anthropic', kind: 'anthropic', url: 'https://api.anthropic.com', hint: 'e.g. claude-opus-5-5' },
  { label: 'OpenAI', kind: 'openai', url: 'https://api.openai.com/v1', hint: 'a chat model that supports tools' },
  { label: 'OpenRouter', kind: 'openai', url: 'https://openrouter.ai/api/v1', hint: 'e.g. anthropic/claude-sonnet-5.5' },
  { label: 'Google Gemini', kind: 'gemini', url: 'https://generativelanguage.googleapis.com', hint: 'e.g. gemini-3-pro' },
  { label: 'LM Studio (local)', kind: 'openai', url: 'http://localhost:1234/v1', hint: 'the model loaded in LM Studio (needs tool support)' },
  { label: 'Ollama (local)', kind: 'openai', url: 'http://localhost:11434/v1', hint: 'e.g. qwen3 or llama3.1' },
  { label: 'Other (OpenAI-compatible)', kind: 'openai', url: '', hint: 'any server with /chat/completions' },
];
/** The agent's seats (the platform router's roles, and where handovers go), as the user sees them. Chat seats sit on the
 *  agent's tier when unset. */
const SEATS: { id: string; label: string; help: string; chat: boolean }[] = [
  { id: 'agent', label: 'Agent', help: 'the scheduler agent itself', chat: true },
  { id: 'research', label: 'Researcher', help: 'sub-agents the agent sends to read and dig (it may also send one to another tier)', chat: true },
  { id: 'handover', label: 'Handover', help: 'where the agent hands work it cannot finish (unset: the next tier up the list; never below the agent\'s own)', chat: false },
  { id: 'skeptic', label: 'Reviewer', help: 'checks the agent\'s work (the skeptic)', chat: true },
  { id: 'senior_guidance', label: 'Advisor', help: 'senior guidance when the agent is stuck or planning', chat: true },
  { id: 'fast_retrieve', label: 'Fast retrieval', help: 'quick look-ups in long documents', chat: true },
  { id: 'vision_ocr', label: 'Eyes (vision / OCR)', help: 'a vision model that reads drawings, scans and images for the agent when its own model cannot see', chat: true },
  { id: 'ocr_locator', label: 'OCR locator', help: 'finds where a text is on a page', chat: true },
  { id: 'autopilot', label: 'Autopilot', help: 'answers the agent\'s questions when no one is there', chat: true },
  { id: 'extract', label: 'Extraction', help: 'pulls structured data out of documents', chat: true },
  { id: 'decide', label: 'Decisions', help: 'small yes / no judgements in the loop', chat: true },
  { id: 'web_search', label: 'Web search', help: 'a search provider (unset: the agent model searches when its provider can: Anthropic, Gemini or OpenRouter; else off)', chat: false },
  { id: 'embedding', label: 'Embeddings', help: 'an embedding model for semantic search (off unless set)', chat: false },
  { id: 'reranker', label: 'Reranker', help: 'orders search hits (off unless set)', chat: false },
  { id: 'stt', label: 'Speech to text', help: 'transcribes audio (off unless set)', chat: false },
];
const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function AiSettingsDialog() {
  const [m, setM] = useState<PublicModels | null>(null);
  const [keys, setKeys] = useState<Record<string, string | undefined>>({});
  const [tab, setTab] = useState('general');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void window.p6.aiGetModels().then(setM); }, []);
  // the code sandbox the agent's code runs in (picked when the agent starts: WSL's Linux jail, else Pyodide)
  const [sb, setSb] = useState<{ kind: string; wsl?: string; wslSetup?: boolean; error?: string } | null>(null);
  const readSb = () => void window.p6.whiq.sandbox().then((r) => setSb(r.ok ? r.data : null));
  useEffect(readSb, []);
  if (!m) return <Dialog title="AI Assistant Settings" buttons={<button className="btn" onClick={closeDialog}>Cancel</button>}><p>Loading...</p></Dialog>;
  const set = (patch: Partial<PublicModels>) => setM({ ...m, ...patch });
  const setProv = (i: number, patch: Partial<PublicProvider>) => set({ providers: m.providers.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  // a renamed tier keeps its seats (they point at it by name)
  const setTier = (i: number, patch: Partial<TierDef>) => {
    const was = m.tiers[i].name, renamed = patch.name !== undefined && patch.name !== was;
    set({ tiers: m.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)), ...(renamed ? { seats: Object.fromEntries(Object.entries(m.seats).map(([k, v]) => [k, v === was ? patch.name! : v])) } : {}) });
  };
  const moveTier = (i: number, d: number) => { const t = [...m.tiers]; [t[i], t[i + d]] = [t[i + d], t[i]]; set({ tiers: t }); };
  const used = (id: string) => m.tiers.some((t) => t.provider === id);
  const tierUsed = (n: string) => Object.values(m.seats).includes(n);
  // the free-form fields checked here with the rules the main process applies
  let fieldError = '';
  for (const p of m.providers) { try { parseExtraHeaders(p.extraHeaders); parseExtraBody(p.extraBody, p.kind === 'anthropic' ? 'anthropic' : 'openai'); } catch (e) { fieldError = `${p.name}: ${(e as Error).message}`; } }
  const save = async (close: boolean) => {
    setBusy(true);
    try {
      const r = await window.p6.aiSaveModels(m, keys);
      if (!r.ok) { setMsg({ ok: false, text: r.error }); return false; }
      setM(r.models); setKeys({});
      if (close) { closeDialog(); toast(r.models.enabled ? 'AI assistant enabled (View > AI Assistant, Ctrl+Shift+A)' : 'AI assistant settings saved'); }
      return true;
    } finally { setBusy(false); }
  };
  const test = async (name: string) => {
    if (!(await save(false))) return;
    setMsg({ ok: true, text: `Testing ${name}...` });
    const r = await window.p6.aiTestTier(name);
    setMsg(r.ok ? { ok: true, text: `${name}: connected. The model replied: "${r.reply.trim().slice(0, 80)}"` } : { ok: false, text: `${name}: ${r.error}` });
  };
  const addProvider = () => { const id = newId(); set({ providers: [...m.providers, { id, name: `provider ${m.providers.length + 1}`, kind: 'anthropic', baseUrl: PRESETS[0].url, extraHeaders: '', extraBody: '', hasKey: false, keyHint: '' }] }); };
  // the Web search seat unset: the agent's tier, when its provider can search (the same rule as the agent's router config)
  const agentTierDef = m.tiers.find((t) => t.name === m.seats.agent) ?? m.tiers[0];
  const agentProv = m.providers.find((p) => p.id === agentTierDef?.provider);
  const offOrAgentSearch = agentTierDef && agentProv && providerCanSearch(agentProv.kind, agentProv.baseUrl) ? `(the agent's: ${agentTierDef.name})` : '(off)';
  const addTier = () => set({ tiers: [...m.tiers, { name: m.tiers.length ? `Tier ${m.tiers.length + 1}` : 'Main', provider: m.providers[0]?.id ?? '', model: '' }] });
  const mono = { font: '12px Consolas, monospace' } as const;

  return (
    <Dialog title="AI Assistant Settings" width={760} height={600} buttons={<>
      <button className="btn primary" disabled={busy || !!fieldError} onClick={() => void save(true)}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
    </>}>
      <Tabs tabs={[['general', 'General'], ['keys', '1 · API keys'], ['tiers', '2 · Models & tiers'], ['seats', '3 · Seats']]} value={tab} onChange={setTab} />
      <div style={{ padding: '8px 4px', overflow: 'auto', maxHeight: 440 }}>
        {tab === 'general' && <>
          <label style={{ display: 'block', margin: '4px 0 10px' }}><input type="checkbox" checked={m.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> <b>Enable the AI assistant</b> (the scheduler agent in a panel on the right of the window)</label>
          <label style={{ display: 'block', margin: '0 0 10px 20px' }}><input type="checkbox" checked={m.actions} onChange={(e) => set({ actions: e.target.checked })} /> Let it operate the app when you ask it to (you see every step on screen; every change can be undone with Ctrl+Z; it asks before deleting)</label>
          <p className="muted">Set your providers' keys in tab 1, the models in tab 2 (the first tier is the agent's model unless a seat says otherwise), and in tab 3 which model each of the agent's helpers uses.
            Keys are encrypted with Windows' own protection{m.encrypted ? '' : ' (not available on this computer: stored in plain text)'} and never shown again. Project data and documents go to the providers you choose; a local server (LM Studio, Ollama) keeps them on this computer.</p>
          <fieldset><legend>Code sandbox (where the agent runs the code it writes, cut off from your files and the internet)</legend>
            <p style={{ margin: '2px 0 6px' }}>{!sb || (sb.kind === 'none' && !sb.error) ? 'Chosen when the agent first starts: the Linux sandbox in WSL if it is set up on this computer, else Python inside the app.'
              : sb.kind === 'wsl' ? 'In use: the Linux sandbox in WSL (Python with its packages and ortools, shell and Node commands).'
              : sb.kind === 'pyodide' ? 'In use: Python inside the app (Pyodide: Python only, no ortools, no shell commands).'
              : `No sandbox: ${sb.error}. The agent works without running code.`}
              {sb?.wsl && sb.kind !== 'wsl' && sb.wsl !== 'not tried' ? <span className="muted"> WSL: {sb.wsl}.</span> : null}</p>
            {sb?.wslSetup && <button className="btn" onClick={() => void window.p6.whiq.sandboxSetupWsl()}>Set up the Linux sandbox in WSL...</button>}
            {sb && sb.kind !== 'wsl' && sb.wsl && sb.wsl !== 'not tried' && <button className="btn" onClick={() => void window.p6.whiq.sandboxRecheck().then(readSb)}>Check again</button>}
          </fieldset>
        </>}
        {tab === 'keys' && <>
          {m.providers.map((p, i) => {
            const preset = PRESETS.find((x) => x.kind === p.kind && x.url && p.baseUrl.replace(/\/+$/, '') === x.url) ?? PRESETS[PRESETS.length - 1];
            const changing = keys[p.id] !== undefined;
            return <fieldset key={p.id} style={{ marginBottom: 8 }}><legend><input value={p.name} onChange={(e) => setProv(i, { name: e.target.value })} style={{ width: 160 }} /></legend>
              <table className="form"><tbody>
                <tr><td>Which one</td><td><select value={preset.label} onChange={(e) => { const x = PRESETS.find((y) => y.label === e.target.value)!; setProv(i, { kind: x.kind, baseUrl: x.url || p.baseUrl }); }}>{PRESETS.map((x) => <option key={x.label}>{x.label}</option>)}</select>
                  {' '}<select value={p.kind} onChange={(e) => setProv(i, { kind: e.target.value as ModelKind })}><option value="anthropic">Anthropic Messages API</option><option value="openai">OpenAI-compatible</option><option value="gemini">Gemini</option></select></td></tr>
                <tr><td>Endpoint</td><td><input style={{ width: 420, ...mono }} value={p.baseUrl} placeholder="https://..." onChange={(e) => setProv(i, { baseUrl: e.target.value })} /></td></tr>
                <tr><td>API key</td><td>{!changing && p.hasKey
                  ? <span><input type="password" readOnly value="••••••••••••" style={{ width: 160 }} /> {p.keyHint} <button className="btn" onClick={() => setKeys({ ...keys, [p.id]: '' })}>Replace</button> <button className="btn" onClick={() => { setKeys({ ...keys, [p.id]: '' }); setProv(i, { hasKey: false }); }}>Remove</button></span>
                  : <input type="password" autoComplete="off" style={{ width: 420 }} value={keys[p.id] ?? ''} placeholder="Paste the key (leave empty for a local server)" onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} />}</td></tr>
                <tr><td>Extra headers</td><td><textarea rows={1} style={{ width: 420, ...mono }} value={p.extraHeaders} placeholder="optional, one per line: Name: value" onChange={(e) => setProv(i, { extraHeaders: e.target.value })} /></td></tr>
                <tr><td>Extra parameters</td><td><textarea rows={1} style={{ width: 420, ...mono }} value={p.extraBody} placeholder='optional JSON, e.g. {"max_tokens": 8000}' onChange={(e) => setProv(i, { extraBody: e.target.value })} /></td></tr>
              </tbody></table>
              <button className="btn" disabled={used(p.id)} title={used(p.id) ? 'In use by a tier: point the tier elsewhere first' : 'Remove this provider'} onClick={() => set({ providers: m.providers.filter((_, j) => j !== i) })}>Remove provider</button>
            </fieldset>;
          })}
          <button className="btn" onClick={addProvider}>+ Add a provider</button>
        </>}
        {tab === 'tiers' && <>
          <p className="muted">Strongest first: the agent hands harder work up this list and starts Researchers and handovers on the tier it picks. An unset seat uses the agent's tier.</p>
          <table className="tbl"><thead><tr><th>Tier</th><th>Provider</th><th>Model</th><th>Parameters (JSON)</th><th /><th /></tr></thead><tbody>
            {m.tiers.map((t, i) => <tr key={i}>
              <td><input value={t.name} style={{ width: 90 }} onChange={(e) => setTier(i, { name: e.target.value })} /></td>
              <td><select value={t.provider} onChange={(e) => setTier(i, { provider: e.target.value })}><option value="" />{m.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
              <td><input value={t.model} style={{ width: 170, ...mono }} placeholder={PRESETS.find((x) => x.kind === m.providers.find((p) => p.id === t.provider)?.kind)?.hint ?? 'model id'} onChange={(e) => setTier(i, { model: e.target.value })} /></td>
              <td><input value={t.params ?? ''} style={{ width: 130, ...mono }} placeholder="{}" onChange={(e) => setTier(i, { params: e.target.value })} /></td>
              <td style={{ whiteSpace: 'nowrap' }}><button className="tbtn" disabled={i === 0} title="Stronger: move up" onClick={() => moveTier(i, -1)}>↑</button><button className="tbtn" disabled={i === m.tiers.length - 1} title="Weaker: move down" onClick={() => moveTier(i, 1)}>↓</button></td>
              <td style={{ whiteSpace: 'nowrap' }}><button className="btn" disabled={busy || !t.model} onClick={() => void test(t.name)}>Test it</button> <button className="tbtn" disabled={tierUsed(t.name)} title={tierUsed(t.name) ? 'A seat uses it: point the seat elsewhere first' : 'Remove this tier'} onClick={() => set({ tiers: m.tiers.filter((_, j) => j !== i) })}>🗑</button></td>
            </tr>)}
          </tbody></table>
          <button className="btn" disabled={!m.providers.length} onClick={addTier}>+ Add a tier</button>
        </>}
        {tab === 'seats' && <>
          <p className="muted">All seats use the agent's model unless you pick another tier. The eyes give the agent vision when its own model cannot read images.</p>
          <table className="tbl"><thead><tr><th>Seat</th><th>Tier</th><th>What it does</th></tr></thead><tbody>
            {SEATS.map((s) => <tr key={s.id}><td>{s.label}</td>
              <td><select value={m.seats[s.id] ?? ''} onChange={(e) => set({ seats: { ...m.seats, [s.id]: e.target.value } })}><option value="">{s.id === 'handover' ? '(the next tier up)' : !s.chat ? (s.id === 'web_search' ? offOrAgentSearch : '(off)') : s.id === 'agent' ? `(first tier${m.tiers[0] ? `: ${m.tiers[0].name}` : ''})` : `(the agent's${(m.seats.agent || m.tiers[0]?.name) ? `: ${m.seats.agent || m.tiers[0].name}` : ''})`}</option>{m.tiers.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}</select></td>
              <td className="muted">{s.help}</td></tr>)}
          </tbody></table>
        </>}
        {fieldError && <div style={{ padding: 6, margin: '6px 0', border: '1px solid #e0a0a0', background: '#fde4e4' }}>{fieldError}</div>}
        {msg && <div style={{ padding: 8, marginTop: 6, border: '1px solid #ccc', background: msg.ok ? '#eef7ee' : '#fde4e4' }}>{msg.text}</div>}
      </div>
    </Dialog>
  );
}
