// Right-hand AI assistant: a slim, softly glowing strip always on the window's right edge; clicking it (or Ctrl+Shift+A)
// opens the chat beside it, and the windows make room for it.
// The model looks things up with the tools in ./tools.ts (the conversation loop runs here; the provider call and the
// API key stay in the main process). Activity IDs in answers are links that select the activity.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { getDb, getUi, setUi, useStore } from '../store.ts';
import { makeCtx, projectName } from '../model.ts';
import { rows } from '../../core/db.ts';
import { TOOLS, runTool } from '../../core/query/tools.ts';
import { LIVE_TOOLS, runLive, menuGuide } from './live.ts';
import { compactHistory } from './context.ts';
import type { AiPublicConfig, ChatMsg } from '../../main/ai.ts';

interface Line { who: 'user' | 'ai' | 'tool' | 'error'; text: string }
// rounds without a successful change (lookups, retries) are capped; building a schedule keeps going while edits land
const MAX_IDLE_ROUNDS = 12, MAX_ROUNDS = 60;
const LABEL: Record<string, string> = { list_projects: 'Listed the projects', list_reports: 'Listed the reports', open_report: 'Opened report', create_report: 'Report Wizard', run_report_dialog: 'Run Report', earned_value: 'Read earned value', set_print_options: 'Set up printing', ui_menu: 'Menu', ui_click: 'Clicked', ui_type: 'Typed into', ui_screen: 'Looked at the screen', select_activity: 'Selected', edit_project: 'Changed the project', undo: 'Undo',  project_summary: 'Read the project summary', find_activities: 'Searched activities', get_activity: 'Opened activity', list_wbs: 'Read the WBS', critical_path: 'Read the critical path', schedule_health: 'Ran the schedule health check', resource_summary: 'Read resource assignments' };

function systemPrompt(actions: boolean): string {
  const db = getDb(), ui = getUi();
  const projs = ui.openProjects.map((id) => rows(db, 'PROJECT').find((p) => p.proj_id === id)).filter((p) => p != null);
  return [
    'You are a planning and scheduling assistant inside a Primavera P6 Professional clone. You help a scheduler understand the open project.',
    projs.length ? `Open project(s): ${projs.map((p) => `${p.proj_short_name} "${projectName(db, p)}" (data date ${p.last_recalc_date?.slice(0, 16) || 'not set'})`).join('; ')}.` : 'No project is open; tools then cover every project in the database.',
    `Durations and floats are given in days of ${ui.prefs.hoursPerDay} hours. Today is ${new Date().toISOString().slice(0, 10)}.`,
    'Always use the tools to look facts up; never guess dates, durations or logic. Start with project_summary when you need context. For large projects, filter with find_activities rather than listing everything.',
    'Answer concisely and concretely, the way an experienced P6 planner would. Mention activity IDs exactly as written so the user can click them. Use short bullet lists or small tables when they help. Say plainly when the data cannot answer the question.',
    'You also teach: when the user asks how to do something, give the exact steps in this application (menu paths, dialog names, buttons, keyboard shortcuts) and briefly explain the P6 concept behind it (for example what retained logic, total float or a Start On or After constraint means). The application mirrors P6 Professional; its menu bar is:',
    menuGuide(),
    'Windows (buttons on the left): Projects, WBS, Activities, Assignments, Resources, Timesheets, Risks, Portfolios, Reports. Activity Details tabs (at the bottom of the Activities window): General (ID, name, activity type, duration type, % complete type, calendar, WBS, primary resource), Status (Duration, Status with started/finished and dates, % Complete, Constraints: Primary and Secondary constraint with dates), Resources, Relationships, Predecessors, Successors, Codes, Notebook, Expenses, Summary. F10 commits changes. Right-click in the table or Gantt for context menus; F9 schedules; Ctrl+F finds; Ctrl+Z undoes.',
    actions
      ? 'When the user asks you to DO something (not only explain), do it with the ui_* tools so they can watch each step: ui_menu for menu commands, ui_screen to see the open dialog, ui_type to fill its fields, ui_click for buttons (for example ui_menu "Tools > Schedule..." then ui_click "Schedule"). For changes to activities, relationships, resources or calendars use edit_project (one undoable step). Say briefly what you are doing. Never delete anything unless the user asked. After changing logic or durations, schedule (F9) so the dates update.'
      : 'The user has not allowed you to operate the application; give the steps instead.',
    actions
      ? ['When the user asks you to create or plan a schedule (for example "a schedule for a five-story building"), build it as an experienced planner would, explaining briefly as you go:',
        '1. If the request leaves the project start date or major scope open, assume sensible values and say what you assumed (do not stop to ask). If no project is open or the request is for a new one, start the first edit_project call with add_project (short ID, name, start date).',
        '   Before building, call list_projects to see whether the database holds similar past projects, and read the closest one with the lookups (pass its ID as "project": list_wbs, find_activities, critical_path) to learn how this organisation structures and sequences such work; say which project you learned from. OPTIONAL, your judgement: if a past project is close enough (for example an eight-story building when five are wanted), you may instead start with copy_project (a clean copy: progress cleared, dates moved to the new start) and then adapt it with update/delete/add operations (to remove extra floors or areas use delete_wbs on their WBS elements, which keeps the logic closed; then check the links where they were). Copy only when adapting is clearly less work and gives a better schedule than building fresh; otherwise build from scratch using what you learned. Never change the past project itself.',
        '2. One call for the WBS: phases such as pre-construction / procurement, substructure, superstructure per floor, envelope, MEP, finishes per floor, commissioning and handover.',
        '3. Then one call per WBS area with its activities: IDs like A1000, A1010 (steps of 10), realistic durations in days, start and finish milestones, and the logic inside the area; link areas to each other in the same or the next call. Repeat floor-by-floor work as a pattern (typical-floor cycle) and overlap trades with SS/FS lags where real crews would.',
        '4. Every activity needs a predecessor and a successor except the start and finish milestones. Use constraints only for real external dates.',
        '5. When everything is in: schedule on screen (ui_menu "Tools > Schedule...", ui_click "Schedule"), then check with schedule_health and critical_path, fix open ends or other problems, schedule again, and summarise: activity count, finish date, the critical path, and your assumptions.'].join('\n')
      : '',
    actions
      ? 'Reports (Tools > Reports): list_reports, then open_report to show a report on screen and read its rows (explain what it shows and why it matters). To make a new one, create_report runs the Report Wizard on screen step by step; explain each step (subject area, columns, filter, grouping and sorting) as the user watches. To print or export a report, run_report_dialog with the output (Print Preview, printer, PDF, HTML, text/CSV, Excel). For earned value questions use the earned_value lookup and explain BAC, PV, EV, AC, SPI, CPI, EAC and VAC in plain words; the Earned Value Layout (View > Layouts) shows the same columns per activity.\n' +
      'Schedule quality: the P6 report is ui_menu "Tools > Check Schedule Report..." (pick checks, then Check Schedule; the report lists each failing check with its activities). Beyond P6, the Extensions window (ui_menu "Tools > Extensions") has DCMA 14-point (Run assessment; it includes the critical path test, CPLI and BEI against a baseline) and Schedule lint (Run lint; dangling starts/finishes, FS links that should overlap, empty WBS; each fix has an Apply button). Near-critical paths: Tools > Schedule > Options > Advanced > Calculate multiple float paths, then F9; show the Float Path and Float Path Order columns, group by Float Path. S-curves (planned value, earned value, actual): ui_menu "View > Show on Bottom > Activity Usage Profile" (or Spreadsheet); resource loading: Resource Usage Profile. Recovery, also in Extensions: Crashing (least-cost crashing to a number of days, a date or the cheapest total; crash data per critical activity; Apply makes it), What-ifs (duration changes per scenario, compared on copies) and Schedule reasoner (a trained optimiser that proposes a leveling order and crash modes, compared with P6 leveling; resources need a Max Units/Time limit). Explain what each failing check means and how to fix it.\n' +
      'Printing and exports: to prepare a printout or PDF, call set_print_options (paper, orientation, columns to show or hide, columns only / Gantt only / both with the split, relationship lines, legend, baseline, timescale, header and footer), then open it with ui_menu "File > Print Preview", or "File > Save as PDF..." / "File > Print..." where the user presses Save or Print themselves. For Excel: ui_menu "File > Export to Excel..." (the user chooses where to save) or "File > Import from Excel..." (the user picks the file and confirms the listed changes). Explain what each setting does when you change it.'
      : '',
  ].filter(Boolean).join('\n');
}

// per-computer settings of the panel (not part of the project database); storage can be unavailable, so never fail
const pref = (k: string) => { try { return localStorage.getItem(`p6clone.ai.${k}`); } catch { return null; } };
const setPref = (k: string, v: string) => { try { localStorage.setItem(`p6clone.ai.${k}`, v); } catch { /* not kept */ } };

type Entry = { k: 'line'; l: Line } | { k: 'msg'; m: ChatMsg };
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
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<ChatMsg[]>([]);
  const callId = useRef<string | null>(null);
  const stopped = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [autoOpen, setAutoOpen] = useState(() => pref('autoOpen') === '1');
  const booted = useRef(false);
  // the conversation is kept per project (the open projects' IDs; "_general" with none open), append-only until cleared
  const openIds = useStore((s) => s.ui.openProjects);
  const key = chatKey(openIds);
  const busyRef = useRef(false);
  const gen = useRef(0);
  const load = (k: string) => {
    const g = ++gen.current;
    void window.p6.aiChatLoad(k).then((es) => {
      if (g !== gen.current) return;
      const list = es as Entry[];
      history.current = list.flatMap((e) => (e.k === 'msg' ? [e.m] : []));
      setLines(list.flatMap((e) => (e.k === 'line' ? [e.l] : [])));
    });
  };

  useEffect(() => { void window.p6.aiGetConfig().then(setCfg); window.p6.onAiConfig(setCfg); }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [lines, open]);
  useEffect(() => { if (open) box.current?.focus(); }, [open]);
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
  useEffect(() => { if (cfg?.enabled && !busyRef.current) load(key); }, [key, cfg?.enabled]);
  if (!cfg?.enabled) return null;

  const ask = async () => {
    const q = input.trim();
    if (!q || busy) return;
    // everything this answer adds goes to the conversation it started in (unless that is cleared meanwhile)
    const convKey = key, g = gen.current;
    const log = (e: Entry) => { if (g === gen.current) void window.p6.aiChatAppend(convKey, [e]); };
    const add = (l: Line) => { if (g !== gen.current) return; setLines((x) => [...x, l]); log({ k: 'line', l }); };
    const push = (m: ChatMsg) => { if (g !== gen.current) return; history.current.push(m); log({ k: 'msg', m }); };
    setInput(''); add({ who: 'user', text: q });
    push({ role: 'user', content: q });
    setBusy(true); busyRef.current = true; stopped.current = false;
    try {
      for (let round = 0, idle = 0; round < MAX_ROUNDS && idle < MAX_IDLE_ROUNDS && !stopped.current; round++) {
        const id = `${Date.now()}-${round}`;
        callId.current = id;
        const allow = cfg.actions !== false;
        const r = await window.p6.aiChat(id, { system: systemPrompt(allow), messages: compactHistory(history.current), tools: allow ? [...TOOLS, ...LIVE_TOOLS] : TOOLS });
        if (!r.ok) { add({ who: 'error', text: r.error }); break; }
        const { content, toolCalls } = r.reply;
        push({ role: 'assistant', content, toolCalls });
        if (content.trim() && !toolCalls.length) add({ who: 'ai', text: content.trim() });
        if (!toolCalls.length) break;
        // answer each lookup from the database (fresh context each round: the project may have changed)
        const db = getDb(), ui = getUi(), ctx = makeCtx(db, ui.prefs);
        for (const c of toolCalls) {
          let out: unknown;
          try { out = LIVE_TOOLS.some((t) => t.name === c.name) ? await runLive(c.name, c.args ?? {}) : runTool(c.name, c.args ?? {}, getDb(), makeCtx(getDb(), getUi().prefs), getUi().openProjects, ui.prefs.hoursPerDay); } catch (e) { out = { error: (e as Error).message }; }
          const json = JSON.stringify(out);
          push({ role: 'tool', toolCallId: c.id, name: c.name, content: json.length > 60000 ? json.slice(0, 60000) + '... (truncated)' : json });
          const err = (out as { error?: string })?.error;
          if (c.name === 'edit_project' && !err) idle = -1;
          add({ who: 'tool', text: `${LABEL[c.name] ?? c.name}${c.args?.project ? ` [${c.args.project}]` : ''}${c.args?.path ? ` ${c.args.path}` : c.args?.target ? ` "${c.args.target}"` : c.args?.field ? ` "${c.args.field}"` : c.args?.activity_id ? ` ${c.args.activity_id}` : c.args?.text ? ` for "${c.args.text}"` : ''}${err ? ` (${err})` : ''}` });
        }
        idle++;
        if (round === MAX_ROUNDS - 1 || idle === MAX_IDLE_ROUNDS) add({ who: 'error', text: 'Stopped after many steps. Ask me to continue, or try a narrower question.' });
      }
    } finally {
      setBusy(false); busyRef.current = false; callId.current = null;
      // the open project changed during the answer: a conversation started with no project open (say, one that
      // created the project) moves to that project; otherwise show the conversation of what is open now
      const now = chatKey(getUi().openProjects);
      if (now !== convKey && g === gen.current) { if (convKey === GENERAL) await window.p6.aiChatMove(convKey, now); load(now); }
    }
  };
  const stop = () => { stopped.current = true; if (callId.current) void window.p6.aiCancel(callId.current); };
  // Clear context: the assistant forgets the conversation (stops a running answer first)
  const clear = () => { if (busy) stop(); gen.current++; history.current = []; setLines([]); void window.p6.aiChatClear(key); };
  const asked = lines.filter((l) => l.who === 'user').length;

  const strip = <div className={`ai-strip ${open ? 'open' : ''}`} title={`${open ? 'Hide' : 'Open'} the AI Assistant (Ctrl+Shift+A)`} onClick={() => setUi({ aiOpen: !open })}><span>AI Assistant</span></div>;
  if (!open) return strip;
  return (<>
    {strip}
    <div className={`ai-panel ${wide ? 'wide' : ''}`}>
      <div className="ai-head">
        <b>AI Assistant</b><span className="muted ai-shrink" title={cfg.model || 'no model set'}>{cfg.model || 'no model set'}</span>
        <span style={{ flex: 1 }} />
        <label className="ai-auto" title="Open the assistant by itself whenever the app starts"><input type="checkbox" checked={autoOpen} onChange={(e) => { setAutoOpen(e.target.checked); setPref('autoOpen', e.target.checked ? '1' : '0'); }} />Open on startup</label>
        {asked > 0 && <span className="muted ai-shrink" title="Each new question includes the earlier ones, so you can ask follow-ups">remembers {asked} question{asked > 1 ? 's' : ''}</span>}
        <button className="tbtn" title="Clear context: start a new conversation (the assistant forgets earlier questions)" disabled={!lines.length} onClick={clear}><span className="lbl">Clear context</span></button>
        <button className="tbtn" title={wide ? 'Narrow' : 'Widen'} onClick={() => setUi({ aiWide: !wide })}><span className="lbl">{wide ? '⇥' : '⇤'}</span></button>
        <button className="tbtn" title="Minimize (Ctrl+Shift+A)" onClick={() => setUi({ aiOpen: false })}><span className="lbl">—</span></button>
      </div>
      <div className="ai-body">
        {!lines.length && <div className="muted" style={{ padding: 10 }}>
          Ask about the open project, for example:
          <ul>{['What is driving the project finish?', 'Which activities have negative float, and why?', 'How do I add a Start On or After constraint?', cfg.actions !== false ? 'Schedule the project for me (F9) and show me the critical path.' : 'What is planned for the next 4 weeks?'].map((s) => <li key={s}><a href="#" onClick={(e) => { e.preventDefault(); setInput(s); box.current?.focus(); }}>{s}</a></li>)}</ul>
        </div>}
        {lines.map((l, i) => <div key={i} className={`ai-msg ${l.who}`}>{l.who === 'ai' ? <Rich text={l.text} /> : l.text}</div>)}
        {busy && <div className="ai-msg tool">Thinking...</div>}
        <div ref={bottom} />
      </div>
      <div className="ai-input">
        <div className="ai-compose">
        <textarea ref={box} rows={3} value={input} placeholder="Ask about this project (Enter to send, Shift+Enter for a new line)" onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); setUi({ aiOpen: false }); return; } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } if (e.key === 'Escape') setUi({ aiOpen: false }); }} />
        {busy
          ? <button className="ai-send stop" title="Stop" aria-label="Stop" onClick={stop}><svg viewBox="0 0 16 16" width="12" height="12"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg></button>
          : <button className="ai-send" title="Send (Enter)" aria-label="Send" disabled={!input.trim()} onClick={() => void ask()}><svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
        </div>
      </div>
    </div>
  </>
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
