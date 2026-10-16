// Edit > Find (Ctrl+F): P6-style find in the Activities window. Find Next selects the next match (in table order),
// expanding collapsed WBS bands and scrolling it into view; Find All selects every match.
import { useState } from 'react';
import { Dialog } from '../components/Layout.tsx';
import { closeDialog, getDb, getUi, setUi, toast } from '../store.ts';
import { rows } from '../../core/db.ts';
import { COLUMN_BY_ID, makeCtx } from '../model.ts';
import { buildActivityRows } from '../views/activityRows.ts';

let last = { q: '', field: 'any', caseSens: false };

export function FindDialog() {
  const [q, setQ] = useState(last.q);
  const [field, setField] = useState(last.field);
  const [caseSens, setCase] = useState(last.caseSens);
  const ui = getUi();
  const cols = ui.columns.map((id) => COLUMN_BY_ID.get(id)).filter((c) => c != null);

  const matches = (): string[] => {
    const db = getDb(), u = getUi(), ctx = makeCtx(db, u.prefs);
    // table order, ignoring collapsed bands (a match inside one is revealed)
    const order = buildActivityRows(ctx, u.openProjects, {}, u.filter, u.groupBy, u.sortBy).filter((r) => r.kind === 'task').map((r) => r.task!);
    const norm = (s: string) => (caseSens ? s : s.toLowerCase());
    const needle = norm(q.trim());
    if (!needle) return [];
    const look = field === 'any' ? cols : cols.filter((c) => c.id === field);
    return order.filter((t) => look.some((c) => norm(c.get(t, ctx)).includes(needle))).map((t) => t.task_id);
  };
  const reveal = (ids: string[]) => {
    // expand the WBS bands that hide the found activities
    const db = getDb(), parent = new Map(rows(db, 'PROJWBS').map((w) => [w.wbs_id, w.parent_wbs_id]));
    const open: Record<string, boolean> = { ...getUi().collapsed };
    for (const id of ids) {
      const t = rows(db, 'TASK').find((x) => x.task_id === id);
      for (let w = t?.wbs_id, n = 0; w && n < 100; w = parent.get(w), n++) delete open[`w:${w}`];
    }
    setUi({ collapsed: open, view: 'activities' });
  };
  const next = () => {
    last = { q, field, caseSens };
    const m = matches();
    if (!m.length) return toast(`"${q}" was not found.`);
    const cur = getUi().selTask, i = cur ? m.indexOf(cur) : -1;
    const id = m[(i + 1) % m.length];
    reveal([id]);
    setUi({ selTasks: [id], selTask: id, revealTask: id });
    if (i + 1 >= m.length && i >= 0) toast('Search wrapped to the first match.');
  };
  const all = () => {
    last = { q, field, caseSens };
    const m = matches();
    if (!m.length) return toast(`"${q}" was not found.`);
    reveal(m);
    setUi({ selTasks: m, selTask: m[0], revealTask: m[0] });
    toast(`${m.length} activit${m.length > 1 ? 'ies' : 'y'} found and selected`);
    closeDialog();
  };
  return (
    <Dialog title="Find" width={480} height={210} buttons={<>
      <button className="btn primary" onClick={next}>Find Next</button>
      <button className="btn" onClick={all}>Find All</button>
      <button className="btn" onClick={closeDialog}>Close</button>
    </>}>
      <label style={{ display: 'block', margin: '6px 0' }}>Find what <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') next(); }} style={{ width: 260 }} /></label>
      <label style={{ display: 'block', margin: '6px 0' }}>Look in <select value={field} onChange={(e) => setField(e.target.value)}>
        <option value="any">All visible columns</option>
        {cols.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
      </select></label>
      <label style={{ display: 'block', margin: '6px 0' }}><input type="checkbox" checked={caseSens} onChange={(e) => setCase(e.target.checked)} /> Match case</label>
    </Dialog>
  );
}
