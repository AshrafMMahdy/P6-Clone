// Right-hand AI assistant: a slim, softly glowing strip always on the window's right edge; clicking it (or Ctrl+Shift+A)
// opens the chat beside it, and the windows make room for it. The chat is the platform's Scheduler Agent (vendor/whiq-agent,
// WhiqChat): there is no second path. When the agent is not installed or is turned off, the panel says so and why (item 26,
// rule 8: the panel's own loop, which called the model directly with none of the platform's rules, was removed).
// Activity IDs in answers are links that select the activity.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { WhiqChat } from './WhiqChat.tsx';
import { getDb, setUi, useStore } from '../store.ts';
import { rows } from '../../core/db.ts';
import type { AiPublicConfig } from '../../main/ai.ts';
import { ipcWords } from '../dialogs/AiSettingsDialog.tsx';

// per-computer settings of the panel (not part of the project database); storage can be unavailable, so never fail
const pref = (k: string) => { try { return localStorage.getItem(`p6clone.ai.${k}`); } catch { return null; } };
const setPref = (k: string, v: string) => { try { localStorage.setItem(`p6clone.ai.${k}`, v); } catch { /* not kept */ } };

const GENERAL = '_general';
const chatKey = (ids: string[]) => {
  const db = getDb();
  const names = ids.map((id) => rows(db, 'PROJECT').find((p) => p.proj_id === id)?.proj_short_name).filter((n): n is string => !!n);
  return names.length ? names.map((n) => n.toLowerCase()).sort().join('+') : GENERAL;
};

export function AssistantPanel() {
  const open = useStore((s) => s.ui.aiOpen);
  const wide = useStore((s) => s.ui.aiWide);
  const [cfg, setCfg] = useState<AiPublicConfig | null>(null);
  // AI settings that cannot be read (the file is kept as it is): said in the panel, which is shown so the user learns why
  const [cfgErr, setCfgErr] = useState('');
  const [autoOpen, setAutoOpen] = useState(() => pref('autoOpen') === '1');
  // the platform's scheduler agent; when it is not there, the reason it is not (not installed, turned off, its status unreadable)
  const [agent, setAgent] = useState<{ state: 'checking' } | { state: 'on' } | { state: 'off'; why: string }>({ state: 'checking' });
  const [clearSignal, setClearSignal] = useState(0);
  const [agentBusy, setAgentBusy] = useState(false);
  const booted = useRef(false);
  // the conversation is kept per project (the open projects' IDs; "_general" with none open)
  const openIds = useStore((s) => s.ui.openProjects);
  const key = chatKey(openIds);

  useEffect(() => {
    void window.p6.aiGetConfig().then((c) => { setCfg(c); setCfgErr(''); }, (e) => setCfgErr(ipcWords(e))); window.p6.onAiConfig((c) => { setCfg(c); setCfgErr(''); });
    void window.p6.whiq.status().then((r) => setAgent(!r.ok ? { state: 'off', why: `The Scheduler Agent's status could not be read: ${r.error}` } : r.data.missing ? { state: 'off', why: String(r.data.missing) } : { state: 'on' }));
  }, []);
  // the closed strip takes its own room on the right (it must not cover the Gantt's scrollbar)
  useEffect(() => { document.querySelector('.workspace')?.classList.toggle('ai-on', !!cfg?.enabled); }, [cfg?.enabled]);
  useEffect(() => { const w = document.querySelector('.workspace'); w?.classList.toggle('ai-open', !!(cfg?.enabled && open)); w?.classList.toggle('ai-wide', !!wide); }, [cfg?.enabled, open, wide]);
  // opens by itself the very first time the assistant is available, then only if the user ticked the box
  useEffect(() => {
    if (!cfg?.enabled || booted.current) return;
    booted.current = true;
    const first = pref('booted') !== '1';
    setPref('booted', '1');
    if (first || pref('autoOpen') === '1') setUi({ aiOpen: true });
  }, [cfg?.enabled]);
  if (cfgErr) return open ? <><div className="ai-strip open" onClick={() => setUi({ aiOpen: false })}><span>AI Assistant</span></div><div className="ai-panel"><div className="ai-body"><div className="muted" style={{ padding: 10 }}>{cfgErr}</div></div></div></> : <div className="ai-strip" title={cfgErr} onClick={() => setUi({ aiOpen: true })}><span>AI Assistant</span></div>;
  if (!cfg?.enabled) return null;

  const examples = ['What is driving the project finish?', 'Review this schedule against DCMA 14 and write the findings to a Word report.', 'Read the attached contract PDF and list the milestone dates it requires.', cfg.actions !== false ? 'Schedule the project for me (F9) and show me the critical path.' : 'What is planned for the next 4 weeks?'];
  const strip = <div className={`ai-strip ${open ? 'open' : ''}`} title={`${open ? 'Hide' : 'Open'} the AI Assistant (Ctrl+Shift+A)`} onClick={() => setUi({ aiOpen: !open })}><span>AI Assistant</span></div>;
  if (!open) return strip;
  return (<>
    {strip}
    <div className={`ai-panel ${wide ? 'wide' : ''}`}>
      <div className="ai-head">
        <b>Scheduler Agent</b><span className="muted ai-shrink" title={cfg.model || 'no model set'}>{cfg.model || 'no model set'}</span>
        <span style={{ flex: 1 }} />
        <label className="ai-auto" title="Open the assistant by itself whenever the app starts"><input type="checkbox" checked={autoOpen} onChange={(e) => { setAutoOpen(e.target.checked); setPref('autoOpen', e.target.checked ? '1' : '0'); }} />Open on startup</label>
        <button className="tbtn" title="Clear context: start a new conversation (the assistant forgets earlier questions)" disabled={agent.state !== 'on' || agentBusy} onClick={() => setClearSignal((n) => n + 1)}><span className="lbl">Clear context</span></button>
        <button className="tbtn" title={wide ? 'Narrow' : 'Widen'} onClick={() => setUi({ aiWide: !wide })}><span className="lbl">{wide ? '⇥' : '⇤'}</span></button>
        <button className="tbtn" title="Minimize (Ctrl+Shift+A)" onClick={() => setUi({ aiOpen: false })}><span className="lbl">—</span></button>
      </div>
      {agent.state === 'on' ? <WhiqChat key={key} convKey={key} clearSignal={clearSignal} onBusy={setAgentBusy} examples={examples} />
        : agent.state === 'off' && <div className="ai-body"><div className="muted" style={{ padding: 10 }}>The Scheduler Agent is not available, so the assistant cannot answer: {agent.why}</div></div>}
    </div>
  </>
  );
}

/** Small markdown subset (paragraphs, bullets, numbered lists, tables, **bold**, `code`) with activity IDs as links. */
export function Rich({ text }: { text: string }) {
  const codes = useRef<Map<string, string> | null>(null);
  if (!codes.current) codes.current = new Map(rows(getDb(), 'TASK').map((t) => [t.task_code, t.task_id]));
  const go = (taskId: string) => setUi({ view: 'activities', selTasks: [taskId], selTask: taskId, revealTask: taskId });
  const inline = (s: string, k: string): ReactNode[] => {
    const out: ReactNode[] = [];
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).forEach((part, i) => {
      if (/^\*\*.+\*\*$/.test(part)) { out.push(<b key={`${k}b${i}`}>{linkify(part.slice(2, -2), `${k}b${i}`)}</b>); return; }
      if (/^`.+`$/.test(part)) { out.push(<code key={`${k}c${i}`}>{linkify(part.slice(1, -1), `${k}c${i}`)}</code>); return; }
      out.push(<Fragment key={`${k}t${i}`}>{linkify(part, `${k}t${i}`)}</Fragment>);
    });
    return out;
  };
  const linkify = (s: string, k: string): ReactNode[] => s.split(/([A-Za-z0-9][\w.\-/]*[A-Za-z0-9])/g).map((tok, i) => {
    const id = codes.current!.get(tok);
    return id ? <a key={`${k}${i}`} href="#" className="ai-act" onClick={(e) => { e.preventDefault(); go(id); }}>{tok}</a> : tok;
  });
  const blocks: ReactNode[] = [];
  const ls = text.split('\n');
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (/^\s*\|/.test(l)) {
      const tbl: string[][] = [];
      while (i < ls.length && /^\s*\|/.test(ls[i])) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(ls[i])) tbl.push(ls[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())); i++; }
      i--;
      blocks.push(<table key={i} className="ai-tbl"><tbody>{tbl.map((r, j) => <tr key={j}>{r.map((c, n) => (j === 0 ? <th key={n}>{inline(c, `${i}-${j}-${n}`)}</th> : <td key={n}>{inline(c, `${i}-${j}-${n}`)}</td>))}</tr>)}</tbody></table>);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(l);
      while (i < ls.length && /^\s*([-*]|\d+\.)\s+/.test(ls[i])) { items.push(ls[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++; }
      i--;
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={i}>{items.map((it, j) => <li key={j}>{inline(it, `${i}-${j}`)}</li>)}</L>);
    } else if (/^#{1,4}\s/.test(l)) blocks.push(<div key={i} className="ai-h">{inline(l.replace(/^#+\s/, ''), String(i))}</div>);
    else if (l.trim()) blocks.push(<p key={i}>{inline(l, String(i))}</p>);
  }
  return <>{blocks}</>;
}
