// Edit > Renumber Activity IDs (P6): Prefix, Suffix (the first number) and Increment; the selected activities (all the
// table shows when none is selected) are numbered in the table's current sort order. A new ID another activity keeps
// is refused, nothing changed, as P6 warns of a duplicate Activity ID. The edit is core's renumber_activities.
import { useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, getUi, mutate, toast } from '../store.ts';
import { rows, type Row } from '../../core/db.ts';
import { applyOps } from '../../core/project/ops.ts';
import { makeCtx } from '../model.ts';
import { buildActivityRows, toolbarSearch } from '../views/activityRows.ts';

/** The activities to renumber in the table's order: the selection, or every activity the table shows. */
function inTableOrder(): Row[] {
  const ui = getUi(), db = getDb();
  const shown = buildActivityRows(makeCtx(db, ui.prefs), ui.openProjects, {}, ui.filter, ui.groupBy, ui.sortBy, toolbarSearch.text).filter((r) => r.kind === 'task').map((r) => r.task!);
  if (!ui.selTasks.length) return shown;
  const sel = new Set(ui.selTasks), seen = new Set(shown.map((t) => t.task_id));
  // a selected activity the table does not show (a collapsed band) keeps its place after the shown ones
  return [...shown.filter((t) => sel.has(t.task_id)), ...rows(db, 'TASK').filter((t) => sel.has(t.task_id) && !seen.has(t.task_id))];
}

export function RenumberDialog() {
  const ui = getUi(), db = getDb();
  const p = rows(db, 'PROJECT').find((x) => x.proj_id === ui.openProjects[0]);
  const [prefix, setPrefix] = useState(p?.task_code_prefix || 'A');
  const [start, setStart] = useState(String(Number(p?.task_code_base) || 1000));
  const [step, setStep] = useState(String(Number(p?.task_code_step) || 10));
  const list = inTableOrder();
  const s = Number(start), k = Number(step);
  const valid = Number.isInteger(s) && s >= 0 && Number.isInteger(k) && k >= 1;
  const run = () => {
    // one operation per project (an Activity ID names one activity within its project), the numbers running on
    const short = new Map(rows(db, 'PROJECT').map((x) => [x.proj_id, x.proj_short_name]));
    const byProj = new Map<string, string[]>();
    for (const t of list) { const l = byProj.get(t.proj_id); if (l) l.push(t.task_code); else byProj.set(t.proj_id, [t.task_code]); }
    let at = s, err = '';
    try {
      mutate('Renumber Activity IDs', (d) => {
        for (const [pid, ids] of byProj) {
          const r = applyOps(d, [{ op: 'renumber_activities', select: { project: short.get(pid), ids, order_by: 'listed' }, prefix, start: at, increment: k }], { hoursPerDay: ui.prefs.hoursPerDay });
          if (!r.ok) { err = r.error!.message; throw new Error(err); }
          at += ids.length * k;
        }
      });
    } catch { toast(err || 'Renumbering failed.'); return; }
    closeDialog();
    toast(`Renumbered ${list.length} activit${list.length === 1 ? 'y' : 'ies'}`);
  };
  return (
    <Dialog title="Renumber Activity IDs" width={380} buttons={<>
      <button className="btn primary" disabled={!valid || !list.length} onClick={run}>OK</button>
      <button className="btn" onClick={closeDialog}>Cancel</button>
    </>}>
      <p>{list.length} {ui.selTasks.length ? 'selected' : 'shown'} activit{list.length === 1 ? 'y' : 'ies'}, numbered in the table's order.</p>
      <table className="form"><tbody>
        <tr><td>Prefix</td><td><input value={prefix} onChange={(e) => setPrefix(e.target.value)} /></td></tr>
        <tr><td>Suffix</td><td><input value={start} onChange={(e) => setStart(e.target.value)} /></td></tr>
        <tr><td>Increment</td><td><input value={step} onChange={(e) => setStep(e.target.value)} /></td></tr>
      </tbody></table>
      {valid && list.length > 0 && <p className="muted">{list.slice(0, 3).map((t, i) => `${t.task_code} → ${prefix}${s + i * k}`).join(', ')}{list.length > 3 ? ', …' : ''}</p>}
    </Dialog>
  );
}
