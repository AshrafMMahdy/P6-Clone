// The AI panel's conversation with the embedded platform scheduler agent (main/whiq-ipc.ts): its answer streams in as
// it is written; its steps show as short lines (work on screen, engines, sub-agents); its questions and approvals
// are answered here; files it makes are copied into the working folder and shown as chips to open. The composer has
// the working folder and attachments. One chat per project (the panel's conversation key), kept by the agent itself.
// What else the agent does shows as the platform's own front end shows it: each step once, updated in place (running,
// done, failed); its plan; its sub-agents (polled: they have no events of their own); what it saved to memory; the
// replies it suggests; a message sent while it works (steering); and what needs the user.
import { useEffect, useRef, useState } from 'react';
import { Rich } from './AssistantPanel.tsx';
import { getDb, getUi } from '../store.ts';
import { rows } from '../../core/db.ts';

/** The open project(s) by Project ID: the chat's folder in Data\Projects is named after them (none open: no project folder). */
const projectLabel = (): string | undefined => {
  const db = getDb();
  return getUi().openProjects.map((id) => rows(db, 'PROJECT').find((p) => p.proj_id === id)?.proj_short_name).filter(Boolean).join(' + ') || undefined;
};

type Ev = Record<string, any> & { type: string };
type ToolState = 'running' | 'ok' | 'error' | 'skipped' | 'steer' | 'stopped';
type HandoffStatus = 'pending' | 'approved' | 'here' | 'declined';
type Line =
  | { k: 'user'; text: string; steer?: 'queued' | 'delivered'; mid?: string }
  | { k: 'ai'; text: string; mid: string }
  | { k: 'error' | 'note'; text: string }
  | { k: 'tool'; id: string; text: string; state: ToolState; tip?: string }
  | { k: 'file'; name: string; path: string }
  | { k: 'ask'; id: string; question: string; options: string[]; done?: string }
  | { k: 'approval'; id: string; text: string; done?: string }
  | { k: 'handoff'; id: string; task: string; status: HandoffStatus };
type Plan = { steps: { text: string; done: boolean; declined?: string }[]; progress?: number };
type Kid = { chatId: string; name: string; kind: string; status: 'running' | 'paused' | 'done' | 'failed'; steps: number; budget: { steps: number }; continuesUsed: number; lastStep: { tool: string } | null; handBack?: { partial?: boolean } };
type Need = { question: string; at: string };
type Session = {
  messages?: { id: string; role: string; content: string; uiKind?: string; steerState?: string; timestamp?: string; toolCalls?: { id: string; toolName: string; args: Record<string, any>; status: string }[] }[];
  runPlan?: Plan; needsYou?: Need[]; handoffs?: { id: string; task: string; status: HandoffStatus }[]; cost?: { inputTokens: number; outputTokens: number; usd: number };
};

const SUB: Record<string, string> = { dispatch_agents: 'Sub-agents', handover: 'Handover to a new agent', continue_agent: 'Sub-agent continues', consult_advisor: 'Advisor', summon_council: 'Council of reviewers', start_task: 'Plan', update_plan: 'Plan' };
/** A tool call as a short line: on-screen work, an engine, a sub-agent or a platform tool. */
function toolLine(name: string, args: Record<string, any>): string {
  const live = /^mcp__p6clone_live__(.+)$/.exec(name);
  if (live) return `On screen: ${live[1].replace(/_/g, ' ')}${args.path ? ` ${args.path}` : args.target ? ` "${args.target}"` : args.activity_id ? ` ${args.activity_id}` : ''}`;
  const engine = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (engine) return `${engine[1]}: ${engine[2].replace(/_/g, ' ')}`;
  if (SUB[name]) {
    const what = args.task ?? args.goal ?? args.question ?? args.title ?? (Array.isArray(args.agents) ? args.agents.map((a: any) => a.task ?? a.mode).join('; ') : '');
    return `${SUB[name]}${args.mode ? ` (${args.mode})` : ''}${what ? `: ${String(what).slice(0, 140)}` : ''}`;
  }
  return name.replace(/_/g, ' ');
}
/** The agent's plan has its own block, so its plan tool gets no step line. */
const NO_LINE = new Set(['run_plan']);
/** A tool record's status as the line's state: waiting to be allowed, or to start, counts as running. */
const stateOf = (status: string): ToolState => status === 'ok' || status === 'error' || status === 'skipped' || status === 'steer' ? status : 'running';
const GLYPH: Record<ToolState, string> = { running: '⋯', ok: '✓', error: '✗', skipped: '–', steer: '↻', stopped: '–' };
const KIND: Record<string, string> = { research: 'researcher', work: 'work piece', handover: 'handover', review: 'reviewer', advisor: 'advisor', fast: 'fast researcher', vision: 'vision', rlm: 'RLM researcher' };
/** Steps a sub-agent has used out of its budget (every continue adds a segment of steps). */
const kidSteps = (k: Kid) => `${k.steps}/${k.budget.steps * (k.continuesUsed + 1)}`;
const kidState = (k: Kid) => k.status === 'done' ? (k.handBack?.partial ? 'handed back (partial)' : 'handed back') : k.status;
/** What still needs the user: the questions the agent went on without, newer than the user's last message. */
const openNeeds = (c: Session): Need[] => {
  const last = (c.messages ?? []).filter((m) => m.role === 'user' && m.uiKind !== 'steer').reduce((t, m) => (m.timestamp && m.timestamp > t ? m.timestamp : t), '');
  return (c.needsYou ?? []).filter((n) => n.at > last);
};
const spent = (usd: number, tokens: number) => `${usd > 0 ? `$${usd.toFixed(usd < 0.1 ? 4 : 2)} · ` : ''}${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`;

const chatsKey = 'p6clone.whiq.chats';
const savedChats = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(chatsKey) ?? '{}'); } catch { return {}; } };
const saveChat = (key: string, id: string | null) => { try { const m = savedChats(); if (id) m[key] = id; else delete m[key]; localStorage.setItem(chatsKey, JSON.stringify(m)); } catch { /* not kept */ } };

export function WhiqChat(props: { convKey: string; clearSignal: number; onBusy: (b: boolean) => void; examples: string[] }) {
  const [chatId, setChatId] = useState<string | null>(() => savedChats()[props.convKey] ?? null);
  const [lines, setLines] = useState<Line[]>([]);
  const linesRef = useRef<Line[]>([]);
  linesRef.current = lines;
  const [live, setLive] = useState('');
  /** the text streaming in now (a ref too: done turns it into the answer, and the event handler is not re-made per token) */
  const liveRef = useRef('');
  const liveMid = useRef('');   // the message that text belongs to
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [folder, setFolder] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planOpen, setPlanOpen] = useState(true);
  const [kids, setKids] = useState<Kid[]>([]);
  const [kidsOpen, setKidsOpen] = useState(false);
  const [needs, setNeeds] = useState<Need[]>([]);
  const [sugg, setSugg] = useState<'pending' | { items: string[]; best: number } | null>(null);
  const [cost, setCost] = useState({ usd: 0, tokens: 0 });
  const [auto, setAuto] = useState<Ev | null>(null);
  const autoRef = useRef<Ev | null>(null);
  const [attention, setAttention] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const add = (l: Line) => setLines((x) => [...x, l]);
  /** change the line `match` finds, or add `make()` when there is none: one line per step, message or suggestion */
  const put = (match: (l: Line) => boolean, make: (old?: Line) => Line) => setLines((x) => (x.some(match) ? x.map((l) => (match(l) ? make(l) : l)) : [...x, make()]));
  const note = (text: string) => add({ k: 'note', text });
  /** a chat made in this panel just now: nothing to load (its first message is already shown) */
  const fresh = useRef<string | null>(null);
  const busyRef = useRef(false);   // read inside the event handler (state there is the first render's)
  const busyOn = (b: boolean) => { busyRef.current = b; setBusy(b); props.onBusy(b); };
  /** steps still running are over when the turn is */
  const stopRunning = () => setLines((x) => x.map((l) => (l.k === 'tool' && l.state === 'running' ? { ...l, state: 'stopped' } : l)));
  /** text streamed before a step or at the end of a turn becomes the agent's message */
  const flushLive = () => {
    const t = liveRef.current.trim();
    if (t) put((l) => l.k === 'ai' && l.mid === liveMid.current, () => ({ k: 'ai', text: t, mid: liveMid.current }));
    liveRef.current = ''; setLive('');
  };

  // a cleared conversation starts a new chat (the agent keeps the old one)
  useEffect(() => {
    if (!props.clearSignal) return;
    saveChat(props.convKey, null); setChatId(null); setLines([]); setLive(''); setStatus(''); setFolder('');
    setPlan(null); setKids([]); setNeeds([]); setSugg(null); setCost({ usd: 0, tokens: 0 }); setAuto(null); autoRef.current = null; setAttention('');
  }, [props.clearSignal]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [lines, live]);
  useEffect(() => { void window.p6.whiq.warm(); }, []);

  /** the chat as the agent keeps it: what needs the user, its plan, and which steered messages it has read */
  const sync = async (id: string) => {
    const r = await window.p6.whiq.chat(id, true);
    if (!r.ok || !r.data) return;
    const c = r.data as Session;
    setNeeds(openNeeds(c)); setPlan(c.runPlan ?? null);
    const read = new Set((c.messages ?? []).filter((m) => m.steerState === 'delivered').map((m) => m.id));
    setLines((x) => x.map((l) => (l.k === 'user' && l.steer === 'queued' && l.mid && read.has(l.mid) ? { ...l, steer: 'delivered' } : l)));
  };

  // the chat's history and folder, then its live events
  useEffect(() => {
    if (!chatId) return;
    let off = () => {};
    // listen first: events that come while the history and the folder load are not lost
    off = window.p6.whiq.onEvent((id, e) => { if (id === chatId) onEvent(e); });
    void (async () => {
      const c = fresh.current === chatId ? null : await window.p6.whiq.chat(chatId);
      if (c && !c.ok) { saveChat(props.convKey, null); setChatId(null); return; } // gone (a reset agent): start afresh
      if (c) {
        const s = c.data as Session;
        const shown = (s.messages ?? []).filter((m) => m.uiKind !== 'steer');   // the platform's hidden hints to the agent are not the user's
        const hist: Line[] = [
          ...shown.flatMap((m): Line[] => m.role === 'user' ? [{ k: 'user', text: m.content, mid: m.id, ...(m.uiKind === 'user-steer' ? { steer: m.steerState === 'delivered' ? 'delivered' as const : 'queued' as const } : {}) }] : m.role === 'assistant'
            ? [...(m.toolCalls ?? []).filter((t) => !NO_LINE.has(t.toolName)).map((t): Line => ({ k: 'tool', id: t.id, text: toolLine(t.toolName, t.args ?? {}), state: t.status === 'running' ? 'stopped' : stateOf(t.status) })), ...(m.content?.trim() ? [{ k: 'ai' as const, text: m.content.trim(), mid: m.id }] : [])] : []),
          ...(s.handoffs ?? []).map((h): Line => ({ k: 'handoff', id: h.id, task: h.task, status: h.status })),
        ];
        const key = (l: Line) => ('mid' in l && l.mid) || ('id' in l && l.id) || '';
        const known = new Set(hist.map(key).filter(Boolean));
        setLines((x) => [...hist, ...x.filter((l) => !key(l) || !known.has(key(l)))]);
        setPlan(s.runPlan ?? null); setNeeds(openNeeds(s));
        if (s.cost) setCost({ usd: s.cost.usd, tokens: s.cost.inputTokens + s.cost.outputTokens });
      }
      const f = await window.p6.whiq.folder(chatId);
      if (f.ok) setFolder(f.data);
      await window.p6.whiq.watch(chatId, projectLabel());
    })();
    return () => { off(); void window.p6.whiq.unwatch(chatId); };
  }, [chatId]);

  // the sub-agents have no events: ask for them while the agent works (or any of them does), and once when it stops
  const anyKidRunning = kids.some((k) => k.status === 'running');
  useEffect(() => {
    if (!chatId) return;
    let alive = true;
    const load = () => { void window.p6.whiq.children(chatId).then((r) => { if (alive && r.ok) setKids(r.data as Kid[]); }); };
    load();
    if (!busy && !anyKidRunning) return () => { alive = false; };
    const t = setInterval(load, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [chatId, busy, anyKidRunning]);

  const onEvent = (e: Ev) => {
    switch (e.type) {
      case 'token':
        // a new message starts: the one before it is finished (each message is its own bubble, and can be hidden or rewritten on its own)
        if (e.messageId && e.messageId !== liveMid.current) { flushLive(); liveMid.current = e.messageId; }
        liveRef.current += e.delta ?? ''; setLive(liveRef.current); break;
      case 'token_reset': liveRef.current = ''; setLive(''); break;
      case 'status':
        setStatus(e.label ?? ''); setSugg(null);
        // a steered message the turn ended before reading starts a turn of its own: the panel is busy again
        if (!busyRef.current && linesRef.current.some((l) => l.k === 'user' && l.steer === 'queued')) busyOn(true);
        break;
      case 'message': {
        const m = e.message ?? {};
        if (m.role === 'user') {
          // the agent's copy of a message sent here: the steered one is tracked by its id (steer_delivered), a reply to a question is just a reply
          const mine = (l: Line) => l.k === 'user' && l.steer === 'queued' && !l.mid && l.text === m.content;
          setLines((x) => { const i = x.findIndex(mine); return i < 0 ? x : x.map((l, j) => (j === i && l.k === 'user' ? (m.uiKind === 'user-steer' ? { ...l, mid: m.id, ...(m.steerState === 'delivered' ? { steer: 'delivered' as const } : {}) } : { k: 'user', text: l.text }) : l)); });
        } else if (m.role === 'assistant' && m.uiPayload?.code === 'needs_you') void sync(chatId!);   // the pinned note says it
        else if (m.role === 'assistant' && m.uiKind !== 'steer' && m.content?.trim()) { put((l) => l.k === 'ai' && l.mid === m.id, () => ({ k: 'ai', text: m.content.trim(), mid: m.id })); liveRef.current = ''; setLive(''); }
        break;
      }
      // the finished message's text rewritten (internal names to plain words), or the message taken back (it answered a hint the user never saw)
      case 'message_replaced': setLines((x) => x.map((l) => (l.k === 'ai' && l.mid === e.messageId ? { ...l, text: e.content } : l))); break;
      case 'message_hidden':
        setLines((x) => x.filter((l) => !(l.k === 'ai' && l.mid === e.messageId)));
        if (liveMid.current === e.messageId) { liveRef.current = ''; setLive(''); }
        break;
      case 'tool_call': {
        // text written before a step is that step's preface: it stays as said
        flushLive();
        const r = e.record ?? {};
        if (r.status === 'pending_approval') put((l) => l.k === 'approval' && l.id === r.id, (old) => old ?? { k: 'approval', id: r.id, text: r.approvalNote ?? `Allow: ${toolLine(r.toolName, r.args ?? {})}?` });
        else if (!NO_LINE.has(r.toolName)) put((l) => l.k === 'tool' && l.id === r.id, () => ({ k: 'tool', id: r.id, text: toolLine(r.toolName ?? '', r.args ?? {}), state: stateOf(r.status), ...(r.error ? { tip: String(r.error) } : {}) }));
        break;
      }
      // tool_result only carries what the model reads; the line's state comes from its tool_call
      case 'tool_result': break;
      case 'run_plan': setPlan(e.plan ?? null); break;
      case 'ask_user': add({ k: 'ask', id: e.toolCallId, question: e.question ?? (e.questions?.[0]?.question ?? 'The agent asks:'), options: (e.options ?? e.questions?.[0]?.options ?? []).map((o: any) => (typeof o === 'string' ? o : o.label ?? String(o))) }); break;
      case 'ask_resolved': case 'ask_timeout': setLines((x) => x.map((l) => (l.k === 'ask' && l.id === e.toolCallId && !l.done ? { ...l, done: e.type === 'ask_timeout' ? '(no answer: the agent went on)' : '(answered)' } : l))); break;
      case 'file_saved': add({ k: 'file', name: e.name, path: e.path }); break;
      case 'folder': setFolder(e.path ?? ''); break;
      case 'memory_saved': for (const m of e.items ?? []) note(`Saved to memory: ${m.text}`); break;
      case 'suggestions': setSugg(e.pending ? 'pending' : e.items?.length ? { items: e.items, best: e.best ?? 0 } : null); break;
      case 'steer_delivered': setLines((x) => x.map((l) => (l.k === 'user' && l.mid === e.messageId ? { ...l, steer: 'delivered' } : l))); break;
      case 'handoff': put((l) => l.k === 'handoff' && l.id === e.handoff.id, () => ({ k: 'handoff', id: e.handoff.id, task: e.handoff.task, status: e.handoff.status })); break;
      case 'cost': setCost((c) => ({ usd: c.usd + (e.delta?.usd ?? 0), tokens: c.tokens + (e.delta?.inputTokens ?? 0) + (e.delta?.outputTokens ?? 0) })); break;
      case 'autopilot': {
        const r = e.run as Ev, was = autoRef.current;
        const over = r.status === 'done' || r.status === 'stopped';
        autoRef.current = over ? null : r; setAuto(over ? null : r);
        if (over && was) note(`Autopilot ${r.status}: ${r.log?.[r.log.length - 1]?.detail ?? ''}`.trim());
        break;
      }
      case 'browser_attention': setAttention(e.attention?.reason ?? ''); break;
      case 'error': add({ k: 'error', text: e.message ?? 'The agent stopped with an error.' }); break;
      // the agent itself went (settings changed, a crash): an answer in progress is over; the next message starts it again
      case 'agent_down':
        if (busyRef.current) { flushLive(); add({ k: 'error', text: e.message ?? 'The agent stopped.' }); }
        liveRef.current = ''; setLive(''); setStatus(''); stopRunning(); busyOn(false); break;
      // the answer streamed in: at the end of the turn it is the agent's answer
      case 'done': flushLive(); setStatus(''); stopRunning(); busyOn(false); void sync(chatId!); break;
    }
  };

  const ensureChat = async (): Promise<string | null> => {
    if (chatId) return chatId;
    setStatus('Starting the scheduler agent...');
    const c = await window.p6.whiq.createChat(props.convKey, projectLabel());
    if (!c.ok) { add({ k: 'error', text: c.error }); setStatus(''); return null; }
    saveChat(props.convKey, c.data.id);
    fresh.current = c.data.id;
    setChatId(c.data.id);
    // listen before the first message goes (the effect above also subscribes; watch is idempotent)
    await window.p6.whiq.watch(c.data.id, projectLabel());
    return c.data.id;
  };
  /** A message while the agent works is steering: the agent reads it at its next step, nothing in flight is cut off. */
  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q) return;
    const steering = busyRef.current;
    setInput(''); setSugg(null); setNeeds([]); add({ k: 'user', text: q, ...(steering ? { steer: 'queued' as const } : {}) }); busyOn(true);
    const id = await ensureChat();
    if (!id) { busyOn(steering); return; }
    const r = await window.p6.whiq.send(id, q);
    if (!r.ok) { add({ k: 'error', text: r.error }); busyOn(steering); }
  };
  const stop = async () => { if (chatId) await window.p6.whiq.abort(chatId); busyOn(false); setStatus(''); stopRunning(); };
  const answer = async (l: Extract<Line, { k: 'ask' }>, reply: string) => {
    if (!chatId) return;
    setLines((x) => x.map((y) => (y === l ? { ...l, done: reply } : y)));
    const r = await window.p6.whiq.askReply(chatId, l.id, reply);
    if (!r.ok) add({ k: 'error', text: r.error });
  };
  const decide = async (l: Extract<Line, { k: 'approval' }>, kind: 'approve' | 'skip') => {
    setLines((x) => x.map((y) => (y === l ? { ...l, done: kind === 'approve' ? 'allowed' : 'skipped' } : y)));
    const r = await window.p6.whiq.approval(l.id, kind);
    if (!r.ok) add({ k: 'error', text: r.error });
  };
  /** The agent suggested running a task in a separate chat. There is no second chat here: carry on in this one, or drop it. */
  const handoff = async (l: Extract<Line, { k: 'handoff' }>, decision: 'here' | 'not_now') => {
    if (!chatId) return;
    const r = await window.p6.whiq.handoff(chatId, l.id, decision);
    if (!r.ok) add({ k: 'error', text: r.error }); else busyOn(true);   // the agent answers the decision with a turn
  };
  const chooseFolder = async () => {
    const id = await ensureChat();
    if (!id) return;
    const r = await window.p6.whiq.chooseFolder(id);
    if (r.ok && r.data) setFolder(r.data); else if (!r.ok) add({ k: 'error', text: r.error });
  };
  const attach = async () => {
    const id = await ensureChat();
    if (!id) return;
    const r = await window.p6.whiq.attach(id);
    if (!r.ok) return add({ k: 'error', text: r.error });
    if (!r.data) return;
    setFolder(r.data.folder);
    setInput((t) => `${t}${t && !t.endsWith('\n') ? '\n' : ''}Attached: ${r.data!.files.join(', ')}\n`);
    box.current?.focus();
  };
  const folderName = folder ? folder.split(/[\\/]/).filter(Boolean).pop() : '';
  const live1 = kids.filter((k) => k.status !== 'done'), finished = kids.filter((k) => k.status === 'done');
  const kidRow = (k: Kid) => <div key={k.chatId} className="row"><span>{`${k.name} · ${KIND[k.kind] ?? k.kind} · step ${kidSteps(k)} · ${kidState(k)}${k.status === 'running' && k.lastStep ? ` · ${toolLine(k.lastStep.tool, {})}` : ''}`}</span></div>;
  const planDone = plan?.steps.filter((s) => s.done).length ?? 0;
  const pins = !!plan?.steps.length || kids.length > 0 || !!auto || !!attention;

  return (<>
    {needs.length > 0 && <div className="ai-pin warn">
      <b>Needs you</b>
      {needs.map((n) => <div key={n.at} className="row">{n.question}</div>)}
      <div>Send your answer as a message and the agent takes it from there.</div>
    </div>}
    <div className="ai-body">
      {!lines.length && !busy && <div className="muted" style={{ padding: 10 }}>
        The platform's scheduler agent works on the open schedule in front of you, and can read and write files (PDF, Word, Excel, PowerPoint, drawings) in a working folder. For example:
        <ul>{props.examples.map((s) => <li key={s}><a href="#" onClick={(e) => { e.preventDefault(); setInput(s); box.current?.focus(); }}>{s}</a></li>)}</ul>
      </div>}
      {lines.map((l, i) => {
        if (l.k === 'file') return <div key={i} className="ai-msg tool">File: <a href="#" onClick={(e) => { e.preventDefault(); void window.p6.whiq.openPath(l.path); }}>{l.name}</a> · <a href="#" onClick={(e) => { e.preventDefault(); void window.p6.whiq.showInFolder(l.path); }}>show in folder</a></div>;
        if (l.k === 'ask') return <div key={i} className="ai-msg ai"><Rich text={l.question} />{l.done ? <div className="muted">{l.done}</div> : <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>{l.options.map((o) => <button key={o} className="btn" onClick={() => void answer(l, o)}>{o}</button>)}{!l.options.length && <span className="muted">Type your answer below.</span>}</div>}</div>;
        if (l.k === 'approval') return <div key={i} className="ai-msg ai">{l.text}{l.done ? <div className="muted">{l.done}</div> : <div style={{ display: 'flex', gap: 4, marginTop: 4 }}><button className="btn" onClick={() => void decide(l, 'approve')}>Allow</button><button className="btn" onClick={() => void decide(l, 'skip')}>Skip</button></div>}</div>;
        if (l.k === 'handoff') return <div key={i} className="ai-msg ai">Suggests a separate chat: {l.task}{l.status === 'pending' ? <div style={{ display: 'flex', gap: 4, marginTop: 4 }}><button className="btn" onClick={() => void handoff(l, 'here')}>Do it here</button><button className="btn" onClick={() => void handoff(l, 'not_now')}>Not now</button></div> : <div className="muted">{l.status === 'here' ? '(doing it here)' : l.status === 'declined' ? '(not now)' : '(opened in another chat)'}</div>}</div>;
        if (l.k === 'tool') return <div key={i} className={`ai-msg tool${l.state === 'error' ? ' err' : ''}`} title={l.tip}><span className="st">{GLYPH[l.state]}</span>{l.text}</div>;
        if (l.k === 'note') return <div key={i} className="ai-msg tool">{l.text}</div>;
        if (l.k === 'user') return <div key={i} className="ai-msg user">{l.text}{l.steer && <div className="ai-steer">{l.steer === 'queued' ? 'sent · the agent reads it at its next step' : 'delivered'}</div>}</div>;
        return <div key={i} className={`ai-msg ${l.k}`}>{l.k === 'ai' ? <Rich text={l.text} /> : l.text}</div>;
      })}
      {live && <div className="ai-msg ai"><Rich text={live} /></div>}
      {(busy || status) && <div className="ai-msg tool">{status || 'Thinking...'}</div>}
      <div ref={bottom} />
    </div>
    {pins && <div className="ai-pins">
      {!!plan?.steps.length && <div className="ai-pin">
        <b onClick={() => setPlanOpen((o) => !o)}>{planOpen ? '▾' : '▸'} Plan {planDone}/{plan.steps.length}{plan.progress != null ? ` · ${plan.progress}%` : ''}</b>
        {planOpen && plan.steps.map((s, i) => <div key={i} className={`row${s.declined ? ' declined' : s.done ? ' done' : ''}`} title={s.declined}><span>{s.done ? '☑' : s.declined ? '☒' : '☐'}</span><span>{s.text}</span></div>)}
      </div>}
      {kids.length > 0 && <div className="ai-pin">
        <b>Sub-agents</b>
        {live1.map(kidRow)}
        {finished.length > 0 && <div className="row"><a href="#" onClick={(e) => { e.preventDefault(); setKidsOpen((o) => !o); }}>{kidsOpen ? '▾' : '▸'} {finished.length} finished</a></div>}
        {kidsOpen && finished.map(kidRow)}
      </div>}
      {auto && <div className="ai-pin">{`Autopilot ${String(auto.status)} · ${auto.repliesUsed}/${auto.maxReplies} replies used`}</div>}
      {attention && <div className="ai-pin warn"><b>The agent wants you at its browser</b> <span>{attention}</span></div>}
    </div>}
    {sugg && <div className="ai-chips">
      {sugg === 'pending' ? <span className="muted">Drafting suggested replies...</span>
        : sugg.items.map((s, i) => <button key={s} className={`ai-chip${i === sugg.best ? ' best' : ''}`} title="Send this reply" onClick={() => void send(s)}>{s}</button>)}
    </div>}
    <div className="ai-input">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 4px', fontSize: 11 }}>
        <button className="tbtn" title={folder ? `Working folder: ${folder} (click to change)` : 'Choose the working folder: where the agent puts its files and what it may read'} onClick={() => void chooseFolder()}><span className="lbl">📁 {folderName || 'Working folder'}</span></button>
        <button className="tbtn" title="Attach files: copied into the working folder's 00_INPUTS for the agent to read" onClick={() => void attach()}><span className="lbl">📎 Attach</span></button>
        {cost.tokens > 0 && <span className="muted" style={{ marginLeft: 'auto' }} title="What this chat has used so far">{spent(cost.usd, cost.tokens)}</span>}
      </div>
      <div className={`ai-compose${busy ? ' busy' : ''}`}>
        <textarea ref={box} rows={3} value={input} placeholder={busy ? 'Steer the agent: it reads this at its next step (Enter to send)' : 'Ask the scheduler agent (Enter to send, Shift+Enter for a new line)'} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button className="ai-send" title={busy ? 'Send to the working agent (Enter)' : 'Send (Enter)'} aria-label="Send" disabled={!input.trim()} onClick={() => void send()}><svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        {busy && <button className="ai-send stop" title="Stop" aria-label="Stop" onClick={() => void stop()}><svg viewBox="0 0 16 16" width="12" height="12"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg></button>}
      </div>
    </div>
  </>);
}
