// 4D in the desktop app: the IFC model of a project (read by the main process), the 4D viewer (served by it on the
// p6c4d:// scheme), links by rules and by picking, element status, packages for Navisworks / SYNCHRO / IFC4 tools and
// imports from them, and videos rendered on this computer's GPU. The same core as the MCP 4D tools.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDb, mutate, setUi, toast, useStore } from '../store.ts';
import { nextId, rows } from '../../core/db.ts';
import { formatP6Date, parseP6Date } from '../../core/dates.ts';
import { attachModel, linkByRules, linkElements, linkMaps, linkStatus, modelRow, t4d, T4D, type Rule } from '../../core/bim/link4d.ts';
import { ifc4dText, items4d, linksCsv, README, searchSetsXml, tagIfc, timelinerCsv } from '../../core/bim/exchange4d.ts';
import { applyImport, planImport } from '../../core/bim/import4d.ts';
import { viewerTimeline } from '../../core/bim/sim4d.ts';
import { writeP6Xml } from '../../core/xml/p6xml.ts';
import type { IfcIndex } from '../../core/bim/parse.ts';

type Loaded = { hash: string; path: string; index: IfcIndex; url: string | null };
const loaded = new Map<string, Loaded>(); // by project: the model this session has read
const bar = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } as const;

/** The project's model, read again from the main process's cache (or its file) when the project has one attached. */
function useModel(projId: string | undefined) {
  const ver = useStore((s) => s.dbVersion), db = getDb();
  const row = projId ? modelRow(db, projId) : undefined;
  const [m, setM] = useState<Loaded | null>(projId ? loaded.get(projId) ?? null : null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setErr('');
    if (!projId || !row) return setM(null);
    const have = loaded.get(projId);
    if (have?.hash === row.hash) return setM(have);
    void window.p6.bimLoad({ hash: row.hash, path: row.path }).then((r) => { if (!r.ok) return setErr(r.error); const x = { hash: r.hash, path: r.path, index: r.index, url: r.url }; loaded.set(projId, x); setM(x); });
  }, [projId, row?.hash]);
  return { m, err, row };
}

const baselinesOf = (projId: string) => rows(getDb(), 'PROJECT').filter((p) => p._baseline_of === projId).map((p) => p.proj_short_name);

/** The viewer page in a frame, fed the project's timeline; picks come back through onPick. */
function Viewer({ m, projId, source, date, highlight, onPick, height }: { m: Loaded; projId: string; source: string; date: string; highlight: string[]; onPick?: (guid: string | null, add: boolean) => void; height?: number | string }) {
  const ver = useStore((s) => s.dbVersion), db = getDb();
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const timeline = useMemo(() => { try { return viewerTimeline(db, projId, m.index, [...new Set([source, 'best', 'planned'])]); } catch { return null; } }, [ver, projId, m, source]);
  const post = (msg: unknown) => ref.current?.contentWindow?.postMessage(msg, '*');
  useEffect(() => { const f = (e: MessageEvent) => { if (e.source === ref.current?.contentWindow && e.data?.type === 'p6c4d:pick') onPick?.(e.data.guid, e.data.add); }; window.addEventListener('message', f); return () => window.removeEventListener('message', f); }, [onPick]);
  useEffect(() => { if (ready && timeline) { post({ type: 'p6c4d:timeline', timeline }); post({ type: 'p6c4d:source', source }); } }, [ready, timeline, source]);
  useEffect(() => { if (ready && date) post({ type: 'p6c4d:date', date }); }, [ready, date, timeline]);
  useEffect(() => { if (ready) post({ type: 'p6c4d:highlight', guids: highlight }); }, [ready, highlight]);
  if (!m.url) return <div className="muted">The model has no 3D geometry to show{m.index.geometryNote ? `: ${m.index.geometryNote}` : '.'} Links, rules, status and exchange still work.</div>;
  return <iframe ref={ref} src={m.url} onLoad={() => setTimeout(() => setReady(true), 300)} style={{ border: '1px solid #c4cfe0', width: '100%', height: height ?? '100%', minHeight: 200, background: '#fff' }} />;
}

/** Extensions > 4D. */
export function FourDPanel() {
  const ui = useStore((s) => s.ui);
  const ver = useStore((s) => s.dbVersion), db = getDb();
  const projId = ui.openProjects[0];
  const { m, err, row } = useModel(projId);
  const [source, setSource] = useState('best');
  const [date, setDate] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [rules, setRules] = useState('[{"type": "property", "property": "name", "equals": "activity_id"}]');
  const [preview, setPreview] = useState<unknown>(null);
  const [target, setTarget] = useState<'navisworks' | 'synchro' | 'ifc4d' | 'csv'>('navisworks');
  const status = useMemo(() => (projId ? linkStatus(db, projId, m?.index ?? null) : null), [ver, projId, m]);
  const timeline = useMemo(() => (m && projId ? viewerTimeline(db, projId, m.index, [source]) : null), [ver, projId, m, source]);
  const span = [parseP6Date(timeline?.start ?? ''), parseP6Date(timeline?.finish ?? '')];
  useEffect(() => { if (!date && timeline?.start) setDate(timeline.dataDate || timeline.start); }, [timeline?.start]);
  if (!projId) return null;
  const proj = rows(db, 'PROJECT').find((p) => p.proj_id === projId)!;
  const sel = rows(db, 'TASK').find((t) => t.task_id === ui.selTasks[0] && t.proj_id === projId);

  const open = async () => {
    const r = await window.p6.bimOpen();
    if (!r) return;
    if (!r.ok) return toast(`Not opened: ${r.error}`);
    loaded.set(projId, { hash: r.hash, path: r.path, index: r.index, url: r.url });
    mutate('Attach model', (d) => { attachModel(d, projId, r.index, r.hash); });
    toast(`${r.index.elements.length} elements in ${r.path.split(/[\\/]/).pop()}.`);
  };
  const runRules = (dry: boolean) => {
    let rs: Rule[];
    try { rs = JSON.parse(rules); if (!Array.isArray(rs)) throw new Error('a list of rules'); } catch (e) { return toast(`Rules: ${(e as Error).message}`); }
    if (dry) return setPreview(linkByRules(getDb(), projId, m!.index, rs, true));
    let out: unknown;
    mutate('Link by rules', (d) => { out = linkByRules(d, projId, m!.index, rs, false); });
    setPreview(out);
  };
  const linkPicked = (mode: 'add' | 'remove') => {
    if (!sel) return toast('Select an activity in the Activities window first.');
    let r: { added?: number; removed?: number } = {};
    mutate(mode === 'add' ? 'Link elements' : 'Unlink elements', (d) => { r = linkElements(d, projId, [{ activity: sel.task_code, guids: picked }], mode, m!.index); });
    toast(mode === 'add' ? `${r.added ?? 0} links added to ${sel.task_code}.` : `${r.removed ?? 0} links removed from ${sel.task_code}.`);
  };
  const setStatus = (st: 'installed' | 'in_progress' | 'not_installed') => {
    if (!picked.length) return toast('Pick elements in the viewer first (Ctrl+click adds).');
    mutate('Element status', (d) => { const T = t4d(d, T4D.status); for (const g of picked) T.rows.push({ status_id: String(nextId(d, T4D.status)), proj_id: projId, guid: g, status: st, date: date || formatP6Date(Math.floor(Date.now() / 60000)) }); });
    toast(`${picked.length} elements ${st.replace('_', ' ')} on ${date.slice(0, 10)}.`);
  };
  const exportPkg = async () => {
    const key = rows(db, 'UDFTYPE').some((u) => u.table_name === 'TASK' && u.udf_type_label === '4D Key') ? '4d_key' : 'activity_id';
    const items = items4d(db, projId, m?.index ?? null, { key });
    if (!items.length && target !== 'csv') return toast('No activity has linked elements yet.');
    const code = proj.proj_short_name, stem = (row?.path.split(/[\\/]/).pop() ?? code).replace(/\.ifc$/i, '');
    const files: { name: string; data: string }[] = [];
    if (target === 'csv') files.push({ name: `${code}-4d-links.csv`, data: linksCsv(db, projId, m?.index ?? null) });
    else {
      if (!row) return toast('Attach a model first.');
      const text = await window.p6.bimText(row.path).catch(() => null);
      if (text == null) return toast(`The model file ${row.path} is gone; open it again.`);
      if (target === 'ifc4d') { try { files.push({ name: `${stem}-4D-IFC4.ifc`, data: ifc4dText(db, projId, text, items, baselinesOf(projId)).text }); } catch (e) { return toast((e as Error).message); } }
      else {
        files.push({ name: `${stem}-4D.ifc`, data: tagIfc(text, items).text });
        if (target === 'navisworks') files.push({ name: `${code}-4D-sets.xml`, data: searchSetsXml(items, code) }, { name: 'timeliner.csv', data: timelinerCsv(items) });
        else files.push({ name: `${code}.xml`, data: writeP6Xml(db, { projIds: [projId], version: '19.12' }) });
      }
      files.push({ name: 'README.txt', data: README[target] });
    }
    const out = await window.p6.bimWriteFiles({ title: `Folder for the ${target} package`, files });
    if (out) toast(`Wrote ${out.length} files.`);
  };
  const importPkg = async () => {
    const imp = await window.p6.bimReadImport().catch((e: Error) => (toast(`Not read: ${e.message}`), null));
    if (!imp) return;
    const plan = planImport(getDb(), projId, imp, m?.index ?? null, { createActivities: true });
    const n = plan.proposals.reduce((k, p) => k + p.guids.length, 0) + [...plan.forNew.values()].reduce((k, g) => k + g.length, 0);
    const msg = `${imp.source}: ${imp.tasks.length} tasks, ${n} element links${plan.toCreate.length ? `, ${plan.toCreate.length} new activities` : ''}${plan.unmatchedTasks.length && !plan.toCreate.length ? `, ${plan.unmatchedTasks.length} tasks match no activity` : ''}${plan.sets.length ? `, ${plan.sets.length} selection sets` : ''}.${imp.notes.length ? `\n\n${imp.notes.slice(0, 5).join('\n')}` : ''}\n\nImport?`;
    if (!confirm(msg)) return;
    let r: unknown;
    try { mutate(`Import 4D ${imp.path.split(/[\\/]/).pop()}`, (d) => { r = applyImport(d, projId, plan, m?.index ?? null, { source: imp.path.split(/[\\/]/).pop()!, hoursPerDay: ui.prefs.hoursPerDay, calendarDays: false }); }); } catch (e) { return toast(`Not imported: ${(e as Error).message}`); }
    const x = r as { added?: number; created_activities?: unknown[] };
    toast(`Imported: ${x.added ?? 0} links${x.created_activities ? `, ${x.created_activities.length} activities` : ''}. Ctrl+Z undoes.`);
  };
  const video = async () => {
    if (!m?.url || !timeline) return;
    toast('Rendering the video on this computer…');
    const r = await window.p6.bimVideo({ hash: m.hash, timeline: viewerTimeline(db, projId, m.index, [...new Set([source, 'best', 'planned'])]), options: { left: source, overlays: ['date', 'legend', 'activity_list', 'gantt_strip'], view: 'iso' }, step: 7, fps: 4, name: `${proj.proj_short_name}-4D` });
    toast(r.ok ? (r.saved ? `Saved ${r.saved} (${r.frames} frames).` : 'Not saved.') : `Video failed: ${r.error}`);
  };
  const onPick = (g: string | null, add: boolean) => setPicked((p) => (!g ? (add ? p : []) : add ? (p.includes(g) ? p.filter((x) => x !== g) : [...p, g]) : [g]));
  const pickedEl = picked.length === 1 ? m?.index.elements.find((e) => e.guid === picked[0]) : undefined;
  const { byGuid } = linkMaps(db, projId);
  const codeOf = new Map(rows(db, 'TASK').map((t) => [t.task_id, t.task_code]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 }}>
      <div style={bar}>
        <button onClick={() => void open()}>{row ? 'Replace model…' : 'Open model (IFC, Revit)…'}</button>
        {row && <span className="muted">{row.path.split(/[\\/]/).pop()} · {status?.elements ?? 0} elements · {status?.links ?? 0} links · {status?.linked_elements ?? 0} elements linked</span>}
        {err && <span style={{ color: '#b00' }}>{err}</span>}
      </div>
      {m && <>
        <div style={bar}>
          <label>Show <select value={source} onChange={(e) => setSource(e.target.value)}>{['best', 'planned', 'actual', 'late', ...baselinesOf(projId)].map((s) => <option key={s}>{s}</option>)}</select></label>
          {span[0] != null && span[1] != null && <input type="range" min={span[0]} max={span[1]} step={1440} value={parseP6Date(date) ?? span[0]} onChange={(e) => setDate(formatP6Date(Number(e.target.value)))} style={{ flex: 1, minWidth: 160 }} />}
          <span style={{ minWidth: 80 }}>{date.slice(0, 10)}</span>
          <button onClick={() => void video()} disabled={!m.url}>Video…</button>
        </div>
        <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
          <div style={{ flex: 2, minWidth: 0 }}><Viewer m={m} projId={projId} source={source} date={date} highlight={picked} onPick={onPick} /></div>
          <div style={{ flex: 1, minWidth: 240, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <fieldset><legend>Picked ({picked.length})</legend>
              {pickedEl && <div className="muted" style={{ fontSize: 11 }}>{pickedEl.ifcClass} · {pickedEl.name} · {pickedEl.storey}<br />linked to {(byGuid.get(pickedEl.guid) ?? []).map((l) => codeOf.get(l.task_id)).join(', ') || 'nothing'}</div>}
              <div style={bar}>
                <button disabled={!picked.length} onClick={() => linkPicked('add')}>Link to {sel?.task_code ?? 'selected activity'}</button>
                <button disabled={!picked.length} onClick={() => linkPicked('remove')}>Unlink</button>
              </div>
              <div style={bar}>Status on date: <button onClick={() => setStatus('installed')}>Installed</button><button onClick={() => setStatus('in_progress')}>In progress</button><button onClick={() => setStatus('not_installed')}>Not installed</button></div>
            </fieldset>
            <fieldset><legend>Link by rules</legend>
              <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={4} style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} />
              <div style={bar}><button onClick={() => runRules(true)}>Dry run</button><button onClick={() => runRules(false)}>Apply</button></div>
              {preview != null && <pre style={{ fontSize: 10, maxHeight: 160, overflow: 'auto' }}>{JSON.stringify(preview, null, 1).slice(0, 4000)}</pre>}
            </fieldset>
            <fieldset><legend>Exchange</legend>
              <div style={bar}><select value={target} onChange={(e) => setTarget(e.target.value as typeof target)}><option value="navisworks">Navisworks (IFC, search sets, TimeLiner CSV)</option><option value="synchro">SYNCHRO (IFC + P6 XML)</option><option value="ifc4d">IFC4 4D (Bonsai)</option><option value="csv">Links CSV</option></select><button onClick={() => void exportPkg()}>Export…</button></div>
              <div style={bar}><button onClick={() => void importPkg()}>Import 4D…</button><span className="muted" style={{ fontSize: 11 }}>IFC 4D, search sets, TimeLiner CSV/xlsx, .nwf/.nwd, SYNCHRO .sp</span></div>
            </fieldset>
            {status?.activities_without_elements.length ? <div className="muted" style={{ fontSize: 11 }}>No elements yet: {status.activities_without_elements.slice(0, 20).map((id) => <a key={id} href="#" onClick={(e) => { e.preventDefault(); const t = rows(getDb(), 'TASK').find((x) => x.task_code === id && x.proj_id === projId); if (t) setUi({ selTasks: [t.task_id], selTask: t.task_id }); }}>{id} </a>)}</div> : null}
          </div>
        </div>
      </>}
    </div>
  );
}

/** The 4D bottom pane of the Activities window: the selected activities' elements highlighted, at their start. */
export function FourDPane() {
  const ui = useStore((s) => s.ui);
  const ver = useStore((s) => s.dbVersion), db = getDb();
  const projId = ui.openProjects[0];
  const { m, err, row } = useModel(projId);
  const { byTask } = useMemo(() => (projId ? linkMaps(db, projId) : { byTask: new Map() }), [ver, projId]);
  const sel = ui.selTasks.filter((id) => byTask.has(id));
  const highlight = useMemo(() => sel.flatMap((id) => (byTask.get(id) ?? []).map((l: { guid: string }) => l.guid)), [sel.join(), byTask]);
  const t = rows(db, 'TASK').find((x) => x.task_id === ui.selTasks[0]);
  const date = t ? t.act_end_date || t.reend_date || t.early_end_date || t.target_end_date : '';
  if (!projId || !row) return <div className="muted" style={{ padding: 8 }}>No model attached: Tools &gt; Extensions &gt; 4D opens one.</div>;
  if (err) return <div style={{ padding: 8, color: '#b00' }}>{err}</div>;
  if (!m) return <div className="muted" style={{ padding: 8 }}>Reading the model…</div>;
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <div className="muted" style={{ fontSize: 11, padding: '2px 4px' }}>{t ? `${t.task_code}: ${(byTask.get(t.task_id) ?? []).length} elements, shown at its finish ${date.slice(0, 10)}` : 'Select an activity.'}</div>
    <div style={{ flex: 1, minHeight: 0 }}><Viewer m={m} projId={projId} source="best" date={date} highlight={highlight} /></div>
  </div>;
}
