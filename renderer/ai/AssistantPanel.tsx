// Right-hand AI assistant: a slim strip on the window's right edge that expands over the Gantt chart into a chat.
// The model looks things up with the tools in ./tools.ts (the conversation loop runs here; the provider call and the
// API key stay in the main process). Activity IDs in answers are links that select the activity.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { getDb, getUi, setUi, useStore } from '../store.ts';
import { makeCtx, projectName } from '../model.ts';
import { rows } from '../../core/db.ts';
import { TOOLS, runTool } from './tools.ts';
import type { AiPublicConfig, ChatMsg } from '../../main/ai.ts';

interface Line { who: 'user' | 'ai' | 'tool' | 'error'; text: string }
const MAX_ROUNDS = 12;
const LABEL: Record<string, string> = { project_summary: 'Read the project summary', find_activities: 'Searched activities', get_activity: 'Opened activity', list_wbs: 'Read the WBS', critical_path: 'Read the critical path', schedule_health: 'Ran the schedule health check', resource_summary: 'Read resource assignments' };

function systemPrompt(): string {
  const db = getDb(), ui = getUi();
  const projs = ui.openProjects.map((id) => rows(db, 'PROJECT').find((p) => p.proj_id === id)).filter((p) => p != null);
  return [
    'You are a planning and scheduling assistant inside a Primavera P6 Professional clone. You help a scheduler understand the open project.',
    projs.length ? `Open project(s): ${projs.map((p) => `${p.proj_short_name} "${projectName(db, p)}" (data date ${p.last_recalc_date?.slice(0, 16) || 'not set'})`).join('; ')}.` : 'No project is open; tools then cover every project in the database.',
    `Durations and floats are given in days of ${ui.prefs.hoursPerDay} hours. Today is ${new Date().toISOString().slice(0, 10)}.`,
    'Always use the tools to look facts up; never guess dates, durations or logic. Start with project_summary when you need context. For large projects, filter with find_activities rather than listing everything.',
    'Answer concisely and concretely, the way an experienced P6 planner would. Mention activity IDs exactly as written so the user can click them. Use short bullet lists or small tables when they help. Say plainly when the data cannot answer the question.',
  ].join('\n');
}

export function AssistantPanel() {
  const open = useStore((s) => s.ui.aiOpen);
  const wide = useStore((s) => s.ui.aiWide);
  const [cfg, setCfg] = useState<AiPublicConfig | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<ChatMsg[]>([]);
  const callId = useRef<string | null>(null);
  const stopped = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { void window.p6.aiGetConfig().then(setCfg); window.p6.onAiConfig(setCfg); }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [lines, open]);
  useEffect(() => { if (open) box.current?.focus(); }, [open]);
  // the closed strip takes its own room on the right (it must not cover the Gantt's scrollbar)
  useEffect(() => { document.querySelector('.workspace')?.classList.toggle('ai-on', !!cfg?.enabled); }, [cfg?.enabled]);
  if (!cfg?.enabled) return null;

  const add = (l: Line) => setLines((x) => [...x, l]);
  const ask = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput(''); add({ who: 'user', text: q });
    history.current.push({ role: 'user', content: q });
    setBusy(true); stopped.current = false;
    try {
      for (let round = 0; round < MAX_ROUNDS && !stopped.current; round++) {
        const id = `${Date.now()}-${round}`;
        callId.current = id;
        const r = await window.p6.aiChat(id, { system: systemPrompt(), messages: history.current, tools: TOOLS });
        if (!r.ok) { add({ who: 'error', text: r.error }); break; }
        const { content, toolCalls } = r.reply;
        history.current.push({ role: 'assistant', content, toolCalls });
        if (content.trim() && !toolCalls.length) add({ who: 'ai', text: content.trim() });
        if (!toolCalls.length) break;
        // answer each lookup from the database (fresh context each round: the project may have changed)
        const db = getDb(), ui = getUi(), ctx = makeCtx(db, ui.prefs);
        for (const c of toolCalls) {
          let out: unknown;
          try { out = runTool(c.name, c.args ?? {}, db, ctx, ui.openProjects, ui.prefs.hoursPerDay); } catch (e) { out = { error: (e as Error).message }; }
          const json = JSON.stringify(out);
          history.current.push({ role: 'tool', toolCallId: c.id, name: c.name, content: json.length > 60000 ? json.slice(0, 60000) + '... (truncated)' : json });
          add({ who: 'tool', text: `${LABEL[c.name] ?? c.name}${c.args?.activity_id ? ` ${c.args.activity_id}` : c.args?.text ? ` for "${c.args.text}"` : ''}` });
        }
        if (round === MAX_ROUNDS - 1) add({ who: 'error', text: 'Stopped after many lookups. Try a narrower question.' });
      }
    } finally { setBusy(false); callId.current = null; }
  };
  const stop = () => { stopped.current = true; if (callId.current) void window.p6.aiCancel(callId.current); };
  const clear = () => { history.current = []; setLines([]); };

  if (!open) return (
    <div className="ai-strip" title="AI Assistant (Ctrl+Shift+A)" onClick={() => setUi({ aiOpen: true })}><span>AI Assistant</span></div>
  );
  return (
    <div className={`ai-panel ${wide ? 'wide' : ''}`}>
      <div className="ai-head">
        <b>AI Assistant</b><span className="muted">{cfg.model || 'no model set'}</span>
        <span style={{ flex: 1 }} />
        <button className="tbtn" title="Clear the conversation" onClick={clear}><span className="lbl">Clear</span></button>
        <button className="tbtn" title={wide ? 'Narrow' : 'Widen'} onClick={() => setUi({ aiWide: !wide })}><span className="lbl">{wide ? '⇥' : '⇤'}</span></button>
        <button className="tbtn" title="Minimize (Ctrl+Shift+A)" onClick={() => setUi({ aiOpen: false })}><span className="lbl">—</span></button>
      </div>
      <div className="ai-body">
        {!lines.length && <div className="muted" style={{ padding: 10 }}>
          Ask about the open project, for example:
          <ul>{['What is driving the project finish?', 'Which activities have negative float, and why?', 'Summarise the schedule health problems.', 'What is planned for the next 4 weeks?'].map((s) => <li key={s}><a href="#" onClick={(e) => { e.preventDefault(); setInput(s); box.current?.focus(); }}>{s}</a></li>)}</ul>
        </div>}
        {lines.map((l, i) => <div key={i} className={`ai-msg ${l.who}`}>{l.who === 'ai' ? <Rich text={l.text} /> : l.text}</div>)}
        {busy && <div className="ai-msg tool">Thinking...</div>}
        <div ref={bottom} />
      </div>
      <div className="ai-input">
        <textarea ref={box} rows={3} value={input} placeholder="Ask about this project (Enter to send, Shift+Enter for a new line)" onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } if (e.key === 'Escape') setUi({ aiOpen: false }); }} />
        {busy ? <button className="btn" onClick={stop}>Stop</button> : <button className="btn primary" disabled={!input.trim()} onClick={() => void ask()}>Send</button>}
      </div>
    </div>
  );
}

/** Small markdown subset (paragraphs, bullets, numbered lists, tables, **bold**, `code`) with activity IDs as links. */
function Rich({ text }: { text: string }) {
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
