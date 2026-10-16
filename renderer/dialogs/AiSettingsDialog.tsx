// Edit > AI Assistant Settings: provider, URL, model and API key. The key is sent once to the main process, which
// encrypts it; afterwards the dialog only shows that a key is saved (masked) and can replace or remove it.
import { useEffect, useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, toast } from '../store.ts';
import type { AiPublicConfig, ProviderKind } from '../../main/ai.ts';
import { parseExtraBody, parseExtraHeaders } from '../../main/ai-extras.ts';

const PRESETS: { label: string; provider: ProviderKind; url: string; hint: string; needsKey: boolean }[] = [
  { label: 'Anthropic', provider: 'anthropic', url: 'https://api.anthropic.com', hint: 'e.g. claude-sonnet-5-5', needsKey: true },
  { label: 'OpenAI', provider: 'openai', url: 'https://api.openai.com/v1', hint: 'a chat model that supports tools', needsKey: true },
  { label: 'OpenRouter', provider: 'openai', url: 'https://openrouter.ai/api/v1', hint: 'e.g. anthropic/claude-sonnet-5.5', needsKey: true },
  { label: 'LM Studio (local)', provider: 'openai', url: 'http://localhost:1234/v1', hint: 'the model loaded in LM Studio (needs tool support)', needsKey: false },
  { label: 'Ollama (local)', provider: 'openai', url: 'http://localhost:11434/v1', hint: 'e.g. qwen3 or llama3.1', needsKey: false },
  { label: 'Other (OpenAI-compatible)', provider: 'openai', url: '', hint: 'any server with /chat/completions', needsKey: false },
];

export function AiSettingsDialog() {
  const [cfg, setCfg] = useState<AiPublicConfig | null>(null);
  const [key, setKey] = useState('');
  const [changingKey, setChangingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  useEffect(() => { void window.p6.aiGetConfig().then((c) => { setCfg(c); setChangingKey(!c.hasKey); }); }, []);
  if (!cfg) return <Dialog title="AI Assistant Settings" buttons={<button className="btn" onClick={closeDialog}>Cancel</button>}><p>Loading...</p></Dialog>;
  const preset = PRESETS.find((p) => p.provider === cfg.provider && p.url && cfg.baseUrl.replace(/\/+$/, '') === p.url) ?? PRESETS.find((p) => p.label.startsWith('Other'))!;
  const set = (patch: Partial<AiPublicConfig>) => setCfg({ ...cfg, ...patch });
  // the free-form fields are checked here with the same rules the main process applies
  let extraError = '';
  try { parseExtraHeaders(cfg.extraHeaders); parseExtraBody(cfg.extraBody); } catch (e) { extraError = (e as Error).message; }
  const save = async (close: boolean) => {
    if (extraError) return null;
    setBusy(true);
    try {
      const next = await window.p6.aiSetConfig({ enabled: cfg.enabled, provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, actions: cfg.actions, extraHeaders: cfg.extraHeaders, extraBody: cfg.extraBody }, changingKey && key ? key : undefined);
      setCfg(next); setKey(''); setChangingKey(!next.hasKey);
      if (close) { closeDialog(); toast(next.enabled ? 'AI assistant enabled (View > AI Assistant, Ctrl+Shift+A)' : 'AI assistant settings saved'); }
      return next;
    } finally { setBusy(false); }
  };
  const test = async () => {
    if (!(await save(false))) return;
    setTestMsg('Testing...');
    const r = await window.p6.aiChat(`test-${Date.now()}`, { system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Say OK' }], tools: [] });
    setTestMsg(r.ok ? `Connected. The model replied: "${r.reply.content.trim().slice(0, 80)}"` : `Failed: ${r.error}`);
  };
  const removeKey = async () => { setBusy(true); try { const n = await window.p6.aiSetConfig({ enabled: cfg.enabled, provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, actions: cfg.actions, extraHeaders: cfg.extraHeaders, extraBody: cfg.extraBody }, ''); setCfg(n); setChangingKey(true); toast('API key removed'); } finally { setBusy(false); } };

  return (
    <Dialog title="AI Assistant Settings" width={640} height={560} buttons={<>
      <button className="btn primary" disabled={busy || !!extraError} onClick={() => void save(true)}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
      <button className="btn" disabled={busy || !cfg.model} onClick={() => void test()}>Test Connection</button>
    </>}>
      <label style={{ display: 'block', margin: '4px 0 10px' }}><input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> <b>Enable the AI assistant</b> (a panel on the right of the window that answers questions about the open project)</label>
      <label style={{ display: 'block', margin: '0 0 10px 20px' }}><input type="checkbox" checked={cfg.actions !== false} onChange={(e) => set({ actions: e.target.checked })} /> Let the assistant operate the app when you ask it to (you see every step on screen; every change can be undone with Ctrl+Z; it asks before deleting)</label>
      <table className="form"><tbody>
        <tr><td>Provider</td><td><select value={preset.label} onChange={(e) => { const p = PRESETS.find((x) => x.label === e.target.value)!; set({ provider: p.provider, baseUrl: p.url || cfg.baseUrl }); }}>
          {PRESETS.map((p) => <option key={p.label}>{p.label}</option>)}
        </select></td></tr>
        <tr><td>API style</td><td><select value={cfg.provider} onChange={(e) => set({ provider: e.target.value as ProviderKind })}><option value="anthropic">Anthropic Messages API</option><option value="openai">OpenAI-compatible (chat/completions)</option></select></td></tr>
        <tr><td>Provider URL</td><td><input style={{ width: 380 }} value={cfg.baseUrl} placeholder="https://..." onChange={(e) => set({ baseUrl: e.target.value })} /></td></tr>
        <tr><td>Model</td><td><input style={{ width: 380 }} value={cfg.model} placeholder={preset.hint} onChange={(e) => set({ model: e.target.value })} /></td></tr>
        <tr><td>API key</td><td>
          {!changingKey && cfg.hasKey
            ? <span><input type="password" readOnly value="••••••••••••••••" style={{ width: 200 }} /> {cfg.keyHint} <button className="btn" onClick={() => setChangingKey(true)}>Change</button> <button className="btn" onClick={() => void removeKey()}>Remove</button></span>
            : <input type="password" autoComplete="off" style={{ width: 380 }} value={key} placeholder={preset.needsKey ? 'Paste your API key' : 'Not needed for a local server (leave empty)'} onChange={(e) => setKey(e.target.value)} />}
        </td></tr>
        <tr><td style={{ verticalAlign: 'top' }}>Extra headers<br /><span className="muted">optional</span></td><td><textarea rows={2} style={{ width: 380, font: '12px Consolas, monospace' }} value={cfg.extraHeaders ?? ''} placeholder={'One per line, e.g.\nanthropic-beta: ...   or   OpenAI-Organization: org_...'} onChange={(e) => set({ extraHeaders: e.target.value })} /></td></tr>
        <tr><td style={{ verticalAlign: 'top' }}>Extra request<br />parameters (JSON)<br /><span className="muted">optional</span></td><td><textarea rows={3} style={{ width: 380, font: '12px Consolas, monospace' }} value={cfg.extraBody ?? ''} placeholder={'{"temperature": 0.2, "top_p": 0.9, "max_tokens": 8000}'} onChange={(e) => set({ extraBody: e.target.value })} /></td></tr>
      </tbody></table>
      {extraError && <div style={{ padding: 6, margin: '6px 0', border: '1px solid #e0a0a0', background: '#fde4e4' }}>{extraError}</div>}
      <p className="muted" style={{ marginTop: 10 }}>
        The key is encrypted with Windows' own protection{cfg.encrypted ? '' : ' (not available on this computer: stored in plain text)'} and kept by the app's background process; it is never written into the project database or shown again.
        The assistant reads the open project through lookups (summary, activity search, activity details, WBS, critical path, schedule health, resources), so it works on very large programmes.
        Project data is sent to the provider you choose; use a local server (LM Studio, Ollama) to keep it on this computer.
      </p>
      {testMsg && <div style={{ padding: 8, border: '1px solid #ccc', background: testMsg.startsWith('Failed') ? '#fde4e4' : '#eef7ee' }}>{testMsg}</div>}
    </Dialog>
  );
}
