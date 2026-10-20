import { useState } from 'react';
import { writeScheduleOptions } from '../../core/schedule/options.ts';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, mutate, openDialog, setUi, toast, useStore } from '../store.ts';
import { runSchedule } from '../commands.ts';
import { addField, nextId, rows, table } from '../../core/db.ts';
import { formatP6Date, parseP6Date } from '../../core/dates.ts';
import { optionsFor, type SchedOptions } from '../../core/schedule/cpm.ts';
import { updateProgress } from '../../core/progress/update.ts';
import { levelResources } from '../../core/level/level.ts';
import { fmtDate } from '../model.ts';

const dt = (s: string) => (s ? s.replace(' ', 'T').slice(0, 16) : '');
const fromDt = (s: string) => (s ? formatP6Date(parseP6Date(s.replace('T', ' '))!) : '');

/** Tools > Schedule (F9) */
export function ScheduleDialog() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  const [dd, setDd] = useState(dt(p?.last_recalc_date || p?.plan_start_date || ''));
  const [level, setLevel] = useState(false);
  if (!p) return <Dialog title="Schedule" buttons={<button className="btn" onClick={closeDialog}>Close</button>}><p>Open a project first.</p></Dialog>;
  const go = async () => {
    const t = parseP6Date(dd.replace('T', ' '));
    if (t == null) return toast('Enter a valid data date.');
    closeDialog();
    const r = runSchedule({ dataDate: t });
    if (r?.ok) {
      if (level) {
        let log = '';
        mutate('Level Resources', (d) => { log = levelResources(d, ui.openProjects, {}).log; });
        setUi({ levelLog: log });
      }
      toast(`Scheduled. Finish ${fmtDate(r.stats.finish, ui.prefs, true)} · ${r.findings.filter((f) => f.severity === 'warning').length} warning(s) in the schedule log`);
    }
  };
  return (
    <Dialog title="Schedule" width={480} buttons={<>
      <button className="btn primary" onClick={go}>Schedule</button>
      <button className="btn" onClick={closeDialog}>Close</button>
      <button className="btn" onClick={() => openDialog('schedOptions')}>Options...</button>
    </>}>
      <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
        <label>Current Data Date</label>
        <input type="datetime-local" value={dd} onChange={(e) => setDd(e.target.value)} />
      </div>
      <p className="muted">Projects to schedule: {ui.openProjects.map((id) => rows(db, 'PROJECT').find((x) => x.proj_id === id)?.proj_short_name).join(', ')}</p>
      <label><input type="checkbox" checked={level} onChange={(e) => setLevel(e.target.checked)} /> Level resources during scheduling</label>
      <p className="muted">The schedule log is available afterwards under Tools &gt; Schedule Log.</p>
    </Dialog>
  );
}

/** Schedule Options (stored in SCHEDOPTIONS / PROJECT like P6). */
export function ScheduleOptionsDialog() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === ui.openProjects[0])!;
  const [o, setO] = useState<SchedOptions>(() => optionsFor(db, p));
  const set = (patch: Partial<SchedOptions>) => setO({ ...o, ...patch });
  const save = () => {
    mutate('Schedule Options', (d) => {
      for (const pid of ui.openProjects) {
        const S = table(d, 'SCHEDOPTIONS');
        const F = ['schedoptions_id', 'proj_id', 'sched_outer_depend_type', 'sched_open_critical_flag', 'sched_retained_logic', 'sched_float_type', 'sched_calendar_on_relationship_lag', 'sched_use_expect_end_flag', 'sched_lag_early_start_flag', 'sched_progress_override'];
        for (const f of F) addField(S, f);
        let r = S.rows.find((x) => x.proj_id === pid);
        if (!r) { r = { schedoptions_id: String(nextId(d, 'SCHEDOPTIONS')), proj_id: pid }; S.rows.push(r); }
        Object.assign(r, {
          sched_retained_logic: o.logic === 'retained' ? 'Y' : 'N', sched_progress_override: o.logic === 'override' ? 'Y' : 'N',
          sched_float_type: { start: 'FT_SS', finish: 'FT_FF', smallest: 'FT_Min' }[o.floatType],
          sched_calendar_on_relationship_lag: { predecessor: 'rcal_Predecessor', successor: 'rcal_Successor', '24h': 'rcal_24Hour', project: 'rcal_ProjDefault' }[o.lagCalendar],
          sched_open_critical_flag: o.openEndedCritical ? 'Y' : 'N', sched_outer_depend_type: o.ignoreExternal ? 'SD_None' : 'SD_Both', sched_use_expect_end_flag: o.useExpectedFinish ? 'Y' : 'N', sched_lag_early_start_flag: o.ssLagFromActualStart ? 'N' : 'Y',
        });
        const pr = d.tables.PROJECT.rows.find((x) => x.proj_id === pid)!;
        pr.critical_path_type = o.criticalBy === 'longestPath' ? 'CT_DrivPath' : 'CT_TotFloat';
        pr.critical_drtn_hr_cnt = String(o.criticalFloatHrs);
        writeScheduleOptions(d, pr, { floatPaths: o.floatPaths });
      }
    });
    closeDialog();
  };
  return (
    <Dialog title="Schedule Options" width={560} buttons={<><button className="btn primary" onClick={save}>OK</button><button className="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset><legend>General</legend>
        <label style={{ display: 'block' }}><input type="checkbox" checked={o.ignoreExternal} onChange={(e) => set({ ignoreExternal: e.target.checked })} /> Ignore relationships to and from other projects</label>
        <label style={{ display: 'block' }}><input type="checkbox" checked={o.openEndedCritical} onChange={(e) => set({ openEndedCritical: e.target.checked })} /> Make open-ended activities critical</label>
        <label style={{ display: 'block' }}><input type="checkbox" checked={o.useExpectedFinish} onChange={(e) => set({ useExpectedFinish: e.target.checked })} /> Use Expected Finish Dates</label>
        <div className="form" style={{ gridTemplateColumns: 'auto 1fr', marginTop: 6 }}>
          <label>When scheduling progressed activities use</label>
          <select value={o.logic} onChange={(e) => set({ logic: e.target.value as SchedOptions['logic'] })}><option value="retained">Retained Logic</option><option value="override">Progress Override</option><option value="actual">Actual Dates</option></select>
          <label>Calculate float based on</label>
          <select value={o.floatType} onChange={(e) => set({ floatType: e.target.value as SchedOptions['floatType'] })}><option value="finish">Finish Date (Finish Float = Late Finish - Early Finish)</option><option value="start">Start Date (Start Float = Late Start - Early Start)</option><option value="smallest">Smallest of Start Float and Finish Float</option></select>
          <label>Calculate start-to-start lag from</label>
          <select value={o.ssLagFromActualStart ? 'actual' : 'early'} onChange={(e) => set({ ssLagFromActualStart: e.target.value === 'actual' })}><option value="early">Early Start</option><option value="actual">Actual Start</option></select>
          <label>Calendar for scheduling relationship lag</label>
          <select value={o.lagCalendar} onChange={(e) => set({ lagCalendar: e.target.value as SchedOptions['lagCalendar'] })}><option value="predecessor">Predecessor Activity Calendar</option><option value="successor">Successor Activity Calendar</option><option value="24h">24 Hour Calendar</option><option value="project">Project Default Calendar</option></select>
        </div>
      </fieldset>
      <fieldset><legend>Critical activities (project setting)</legend>
        <label style={{ display: 'block' }}><input type="radio" checked={o.criticalBy === 'float'} onChange={() => set({ criticalBy: 'float' })} /> Total float less than or equal to <input type="number" style={{ width: 60 }} value={o.criticalFloatHrs} onChange={(e) => set({ criticalFloatHrs: Number(e.target.value) })} /> h</label>
        <label style={{ display: 'block' }}><input type="radio" checked={o.criticalBy === 'longestPath'} onChange={() => set({ criticalBy: 'longestPath' })} /> Longest Path</label>
      </fieldset>
      <fieldset><legend>Advanced</legend>
        <label style={{ display: 'block' }}><input type="checkbox" checked={o.floatPaths.enabled} onChange={(e) => set({ floatPaths: { ...o.floatPaths, enabled: e.target.checked } })} /> Calculate multiple float paths</label>
        <div style={{ paddingLeft: 20, opacity: o.floatPaths.enabled ? 1 : 0.5 }}>
          <label style={{ display: 'block' }}><input type="radio" disabled={!o.floatPaths.enabled} checked={o.floatPaths.method === 'total_float'} onChange={() => set({ floatPaths: { ...o.floatPaths, method: 'total_float' } })} /> Calculate multiple paths using Total Float</label>
          <label style={{ display: 'block' }}><input type="radio" disabled={!o.floatPaths.enabled} checked={o.floatPaths.method === 'free_float'} onChange={() => set({ floatPaths: { ...o.floatPaths, method: 'free_float' } })} /> Calculate multiple paths using Free Float</label>
          <div className="form" style={{ gridTemplateColumns: 'auto 1fr', marginTop: 4 }}>
            <label>Display multiple float paths ending with activity</label>
            <select disabled={!o.floatPaths.enabled} value={o.floatPaths.endActivity ?? ''} onChange={(e) => set({ floatPaths: { ...o.floatPaths, endActivity: e.target.value || undefined } })}>
              <option value="">(the open end with the latest finish)</option>
              {rows(db, 'TASK').filter((t) => ui.openProjects.includes(t.proj_id) && t.task_type !== 'TT_WBS').map((t) => <option key={t.task_id} value={t.task_code}>{t.task_code} {t.task_name}</option>)}
            </select>
            <label>Number of paths to calculate</label>
            <input type="number" min={1} disabled={!o.floatPaths.enabled} style={{ width: 70 }} value={o.floatPaths.count} onChange={(e) => set({ floatPaths: { ...o.floatPaths, count: Math.max(1, Math.floor(Number(e.target.value) || 1)) } })} />
          </div>
        </div>
      </fieldset>
    </Dialog>
  );
}

/** Tools > Update Progress */
export function UpdateProgressDialog() {
  const ui = useStore((s) => s.ui);
  const db = getDb();
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  const cur = parseP6Date(p?.last_recalc_date);
  const [dd, setDd] = useState(dt(cur != null ? formatP6Date(cur + 7 * 1440) : ''));
  if (!p) return <Dialog title="Update Progress" buttons={<button className="btn" onClick={closeDialog}>Close</button>}><p>Open a project first.</p></Dialog>;
  const go = () => {
    const t = parseP6Date(dd.replace('T', ' '));
    if (t == null) return toast('Enter a valid new data date.');
    let s = { started: 0, completed: 0, updated: 0 };
    mutate('Update Progress', (d) => {
      for (const pid of ui.openProjects) { const r = updateProgress(d, pid, t); s = { started: s.started + r.started, completed: s.completed + r.completed, updated: s.updated + r.updated }; }
    });
    closeDialog();
    runSchedule({ dataDate: t });
    toast(`Progress updated to ${fmtDate(t, ui.prefs, true)}: ${s.started} started, ${s.completed} completed, ${s.updated} in progress. Project rescheduled.`);
  };
  return (
    <Dialog title="Update Progress" width={460} buttons={<><button className="btn primary" onClick={go}>Apply</button><button className="btn" onClick={closeDialog}>Cancel</button></>}>
      <div className="form" style={{ gridTemplateColumns: 'auto 1fr' }}>
        <label>Current Data Date</label><input readOnly value={fmtDate(cur, ui.prefs, true)} />
        <label>New Data Date</label><input type="datetime-local" value={dd} onChange={(e) => setDd(e.target.value)} />
      </div>
      <p className="muted">Activities planned to start before the new data date get actual starts; those planned to finish get actual finishes; remaining durations are recalculated. Resource actuals follow the activity progress. The project is then rescheduled.</p>
    </Dialog>
  );
}

export const fromDtStr = fromDt;
