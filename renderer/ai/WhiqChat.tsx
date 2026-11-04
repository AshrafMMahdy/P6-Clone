// The AI panel's conversation with the embedded platform scheduler agent (main/whiq-ipc.ts): its answer streams in as
// it is written; its steps show as short lines (work on screen, engines, sub-agents); its questions and approvals
// are answered here; files it makes are copied into the working folder and shown as chips to open. The composer has
// the working folder and attachments. One chat per project (the panel's conversation key), kept by the agent itself.
import { useEffect, useRef, useState } from 'react';
import { Rich } from './AssistantPanel.tsx';

type Ev = Record<string, any> & { type: string };
type Line =
  | { k: 'user' | 'ai' | 'tool' | 'status' | 'error'; text: string }
  | { k: 'file'; name: string; path: string }
  | { k: 'ask'; id: string; question: string; options: string[]; done?: string }
  | { k: 'approval'; id: string; text: string; done?: string };

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

const chatsKey = 'p6clone.whiq.chats';
const savedChats = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(chatsKey) ?? '{}'); } catch { return {}; } };
const saveChat = (key: string, id: string | null) => { try { const m = savedChats(); if (id) m[key] = id; else delete m[key]; localStorage.setItem(chatsKey, JSON.stringify(m)); } catch { /* not kept */ } };

export function WhiqChat(props: { convKey: string; clearSignal: number; onBusy: (b: boolean) => void; examples: string[] }) {
  const [chatId, setChatId] = useState<string | null>(() => savedChats()[props.convKey] ?? null);
  const [lines, setLines] = useState<Line[]>([]);
  const [live, setLive] = useState('');
  /** the text streaming in now (a ref too: done turns it into the answer, and the event handler is not re-made per token) */
  const liveRef = useRef('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [folder, setFolder] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const add = (l: Line) => setLines((x) => [...x, l]);
  /** a chat made in this panel just now: nothing to load (its first message is already shown) */
  const fresh = useRef<string | null>(null);
  const busyOn = (b: boolean) => { setBusy(b); props.onBusy(b); };

  // a cleared conversation starts a new chat (the agent keeps the old one)
  useEffect(() => { if (!props.clearSignal) return; saveChat(props.convKey, null); setChatId(null); setLines([]); setLive(''); setStatus(''); setFolder(''); }, [props.clearSignal]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [lines, live]);
  useEffect(() => { void window.p6.whiq.warm(); }, []);

  // the chat's history and folder, then its live events
  useEffect(() => {
    if (!chatId) return;
    let off = () => {};
    void (async () => {
      const c = fresh.current === chatId ? null : await window.p6.whiq.chat(chatId);
      if (c && !c.ok) { saveChat(props.convKey, null); setChatId(null); return; } // gone (a reset agent): start afresh
      if (c) {
      const msgs = ((c.data as any).messages ?? []) as { role: string; content: string; toolCalls?: { toolName: string; args: Record<string, any> }[] }[];
      setLines(msgs.flatMap((m): Line[] => m.role === 'user' ? [{ k: 'user', text: m.content }] : m.role === 'assistant'
        ? [...(m.toolCalls ?? []).map((t): Line => ({ k: 'tool', text: toolLine(t.toolName, t.args ?? {}) })), ...(m.content?.trim() ? [{ k: 'ai' as const, text: m.content.trim() }] : [])] : []));
      }
      const f = await window.p6.whiq.folder(chatId);
      if (f.ok) setFolder(f.data);
      off = window.p6.whiq.onEvent((id, e) => { if (id === chatId) onEvent(e); });
      await window.p6.whiq.watch(chatId);
    })();
    return () => { off(); void window.p6.whiq.unwatch(chatId); };
  }, [chatId]);

  const onEvent = (e: Ev) => {
    switch (e.type) {
      case 'token': liveRef.current += e.delta ?? ''; setLive(liveRef.current); break;
      case 'token_reset': liveRef.current = ''; setLive(''); break;
      case 'status': setStatus(e.label ?? ''); break;
      case 'message': {
        const m = e.message ?? {};
        if (m.role === 'assistant' && m.content?.trim()) { add({ k: 'ai', text: m.content.trim() }); liveRef.current = ''; setLive(''); }
        break;
      }
      case 'tool_call': {
        // text written before a step is that step's preface: it stays as said
        if (liveRef.current.trim()) { add({ k: 'ai', text: liveRef.current.trim() }); liveRef.current = ''; setLive(''); }
        const r = e.record ?? {};
        if (r.status === 'pending_approval') add({ k: 'approval', id: r.id, text: r.approvalNote ?? `Allow: ${toolLine(r.toolName, r.args ?? {})}?` });
        else add({ k: 'tool', text: toolLine(r.toolName ?? '', r.args ?? {}) });
        break;
      }
      case 'ask_user': add({ k: 'ask', id: e.toolCallId, question: e.question ?? (e.questions?.[0]?.question ?? 'The agent asks:'), options: (e.options ?? e.questions?.[0]?.options ?? []).map((o: any) => (typeof o === 'string' ? o : o.label ?? String(o))) }); break;
      case 'ask_resolved': case 'ask_timeout': setLines((x) => x.map((l) => (l.k === 'ask' && l.id === e.toolCallId && !l.done ? { ...l, done: e.type === 'ask_timeout' ? '(no answer: the agent went on)' : '(answered)' } : l))); break;
      case 'file_saved': add({ k: 'file', name: e.name, path: e.path }); break;
      case 'folder': setFolder(e.path ?? ''); break;
      case 'error': add({ k: 'error', text: e.message ?? 'The agent stopped with an error.' }); break;
      // the answer streamed in: at the end of the turn it is the agent's answer
      case 'done': if (liveRef.current.trim()) add({ k: 'ai', text: liveRef.current.trim() }); liveRef.current = ''; setLive(''); setStatus(''); busyOn(false); break;
    }
  };

  const ensureChat = async (): Promise<string | null> => {
    if (chatId) return chatId;
    setStatus('Starting the scheduler agent...');
    const c = await window.p6.whiq.createChat(props.convKey);
    if (!c.ok) { add({ k: 'error', text: c.error }); setStatus(''); return null; }
    saveChat(props.convKey, c.data.id);
    fresh.current = c.data.id;
    setChatId(c.data.id);
    // listen before the first message goes (the effect above also subscribes; watch is idempotent)
    await window.p6.whiq.watch(c.data.id);
    return c.data.id;
  };
  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setInput(''); add({ k: 'user', text: q }); busyOn(true);
    const id = await ensureChat();
    if (!id) { busyOn(false); return; }
    const r = await window.p6.whiq.send(id, q);
    if (!r.ok) { add({ k: 'error', text: r.error }); busyOn(false); }
  };
  const stop = async () => { if (chatId) await window.p6.whiq.abort(chatId); busyOn(false); setStatus(''); };
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

  return (<>
    <div className="ai-body">
      {!lines.length && !busy && <div className="muted" style={{ padding: 10 }}>
        The platform's scheduler agent works on the open schedule in front of you, and can read and write files (PDF, Word, Excel, PowerPoint, drawings) in a working folder. For example:
        <ul>{props.examples.map((s) => <li key={s}><a href="#" onClick={(e) => { e.preventDefault(); setInput(s); box.current?.focus(); }}>{s}</a></li>)}</ul>
      </div>}
      {lines.map((l, i) => {
        if (l.k === 'file') return <div key={i} className="ai-msg tool">File: <a href="#" onClick={(e) => { e.preventDefault(); void window.p6.whiq.openPath(l.path); }}>{l.name}</a> · <a href="#" onClick={(e) => { e.preventDefault(); void window.p6.whiq.showInFolder(l.path); }}>show in folder</a></div>;
        if (l.k === 'ask') return <div key={i} className="ai-msg ai"><Rich text={l.question} />{l.done ? <div className="muted">{l.done}</div> : <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>{l.options.map((o) => <button key={o} className="btn" onClick={() => void answer(l, o)}>{o}</button>)}{!l.options.length && <span className="muted">Type your answer below.</span>}</div>}</div>;
        if (l.k === 'approval') return <div key={i} className="ai-msg ai">{l.text}{l.done ? <div className="muted">{l.done}</div> : <div style={{ display: 'flex', gap: 4, marginTop: 4 }}><button className="btn" onClick={() => void decide(l, 'approve')}>Allow</button><button className="btn" onClick={() => void decide(l, 'skip')}>Skip</button></div>}</div>;
        return <div key={i} className={`ai-msg ${l.k === 'status' ? 'tool' : l.k}`}>{l.k === 'ai' ? <Rich text={l.text} /> : l.text}</div>;
      })}
      {live && <div className="ai-msg ai"><Rich text={live} /></div>}
      {(busy || status) && <div className="ai-msg tool">{status || 'Thinking...'}</div>}
      <div ref={bottom} />
    </div>
    <div className="ai-input">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 4px', fontSize: 11 }}>
        <button className="tbtn" title={folder ? `Working folder: ${folder} (click to change)` : 'Choose the working folder: where the agent puts its files and what it may read'} onClick={() => void chooseFolder()}><span className="lbl">📁 {folderName || 'Working folder'}</span></button>
        <button className="tbtn" title="Attach files: copied into the working folder's 00_INPUTS for the agent to read" onClick={() => void attach()}><span className="lbl">📎 Attach</span></button>
      </div>
      <div className="ai-compose">
        <textarea ref={box} rows={3} value={input} placeholder="Ask the scheduler agent (Enter to send, Shift+Enter for a new line)" onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        {busy
          ? <button className="ai-send stop" title="Stop" aria-label="Stop" onClick={() => void stop()}><svg viewBox="0 0 16 16" width="12" height="12"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg></button>
          : <button className="ai-send" title="Send (Enter)" aria-label="Send" disabled={!input.trim()} onClick={() => void send()}><svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
      </div>
    </div>
  </>);
}
