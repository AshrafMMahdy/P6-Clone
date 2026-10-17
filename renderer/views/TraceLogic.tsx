// View > Show on Bottom > Trace Logic: the selected activity's predecessors and successors a few levels deep, as
// boxes joined by relationship lines (driving links solid, non-driving dashed, critical links red).
import { useMemo, useState } from 'react';
import { setUi, useStore } from '../store.ts';
import { useCtx } from '../hooks.ts';
import { fmtDate, fmtDur, isCritical, REL_TYPES } from '../model.ts';
import { relationshipFloat } from '../../core/schedule/cpm.ts';
import { traceLogic } from '../../core/project/ctx.ts';
import { taskStart, taskFinish } from './activityRows.ts';

const W = 170, H = 50, GX = 60, GY = 12, PAD = 10;

export function TraceLogic() {
  const ui = useStore((s) => s.ui);
  const ctx = useCtx();
  const [preds, setPreds] = useState(2), [succs, setSuccs] = useState(2), [drivingOnly, setDrivingOnly] = useState(false);
  const relFF = useMemo(() => relationshipFloat(ctx.db, ctx), [ctx]);
  const t = ui.selTask ? ctx.taskById.get(ui.selTask) : undefined;
  const trace = useMemo(() => t ? traceLogic(ctx, t.task_id, { preds, succs, drivingOnly }, relFF) : null, [ctx, t, preds, succs, drivingOnly, relFF]);

  const pos = new Map<string, { x: number; y: number }>();
  let width = 0, height = 0;
  if (trace) {
    const lvls = [...trace.levels.keys()].sort((a, b) => a - b);
    lvls.forEach((l, i) => {
      const ids = [...trace.levels.get(l)!].sort((a, b) => (taskStart(ctx.taskById.get(a)!) ?? 0) - (taskStart(ctx.taskById.get(b)!) ?? 0));
      ids.forEach((id, j) => pos.set(id, { x: PAD + i * (W + GX), y: PAD + j * (H + GY) }));
      width = Math.max(width, PAD * 2 + (i + 1) * (W + GX) - GX);
      height = Math.max(height, PAD * 2 + (ids.length + (trace.more.get(l) ? 1 : 0)) * (H + GY));
    });
  }
  const levelSel = (v: number, set: (n: number) => void) => <select value={v} onChange={(e) => set(Number(e.target.value))}>{[0, 1, 2, 3, 4, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select>;

  return (
    <div className="details trace-logic" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '3px 8px', display: 'flex', gap: 10, alignItems: 'center', background: '#e8e8e8', borderBottom: '1px solid #ccc' }}>
        <b>Trace Logic</b>
        <label>Predecessor levels {levelSel(preds, setPreds)}</label>
        <label>Successor levels {levelSel(succs, setSuccs)}</label>
        <label><input type="checkbox" checked={drivingOnly} onChange={(e) => setDrivingOnly(e.target.checked)} /> Driving relationships only</label>
        <span className="muted" style={{ marginLeft: 'auto' }}>Solid = driving, dashed = non-driving, red = critical. Click a box to trace from it.</span>
      </div>
      {!t || !trace ? <div className="tabbody muted">Select an activity to trace its logic.</div> : (
        <div style={{ flex: 1, overflow: 'auto', background: '#fff' }}>
          <svg width={width} height={height} style={{ display: 'block', font: '11px Segoe UI, sans-serif' }}>
            {trace.links.map(({ rel, from, to, ff }) => {
              const a = pos.get(from), b = pos.get(to);
              if (!a || !b) return null;
              const fromStart = rel.pred_type === 'PR_SS' || rel.pred_type === 'PR_SF', toFinish = rel.pred_type === 'PR_FF' || rel.pred_type === 'PR_SF';
              const x1 = a.x + (fromStart ? 0 : W), y1 = a.y + H / 2, x2 = b.x + (toFinish ? W : 0), y2 = b.y + H / 2;
              const bend = Math.max(30, Math.abs(x2 - x1) / 2);
              const crit = isCritical(ctx.taskById.get(from)!, ctx) && isCritical(ctx.taskById.get(to)!, ctx);
              return (
                <path key={rel.task_pred_id} className={ff === 0 ? 'trace-link driving' : 'trace-link'} fill="none" stroke={crit ? '#d00000' : '#1f3f9f'} strokeWidth={ff === 0 ? 1.6 : 1} strokeDasharray={ff === 0 ? undefined : '4 3'} markerEnd="url(#trace-arrow)"
                  d={`M${x1},${y1} C${x1 + (fromStart ? -bend : bend)},${y1} ${x2 + (toFinish ? bend : -bend)},${y2} ${x2},${y2}`}>
                  <title>{`${ctx.taskById.get(from)!.task_code} → ${ctx.taskById.get(to)!.task_code}: ${REL_TYPES[rel.pred_type] ?? rel.pred_type}, lag ${fmtDur(rel.lag_hr_cnt, ctx.prefs)}d${ff == null ? '' : `, relationship free float ${fmtDur(ff / 60, ctx.prefs)}d${ff === 0 ? ' (driving)' : ''}`}`}</title>
                </path>
              );
            })}
            {[...pos].map(([id, p]) => {
              const a = ctx.taskById.get(id)!, crit = isCritical(a, ctx), me = id === t.task_id;
              const s = taskStart(a), f = taskFinish(a);
              return (
                <g key={id} className={`trace-box${me ? ' sel' : ''}`} data-code={a.task_code} transform={`translate(${p.x},${p.y})`} style={{ cursor: 'pointer' }}
                  onClick={() => setUi({ selTask: id, selTasks: [id], selWbs: a.wbs_id, revealTask: id })}>
                  <rect width={W} height={H} rx={3} fill={me ? '#fff8c0' : a.act_end_date ? '#e4e8ff' : '#fff'} stroke={crit ? '#d00000' : '#1f3f9f'} strokeWidth={me ? 2 : 1} />
                  <text x={5} y={13} fontWeight="bold">{a.task_code}</text>
                  <text x={W - 5} y={13} textAnchor="end">{a.act_end_date ? '' : `TF ${fmtDur(a.total_float_hr_cnt, ctx.prefs)}`}</text>
                  <text x={5} y={27}>{a.task_name.length > 30 ? a.task_name.slice(0, 29) + '…' : a.task_name}</text>
                  <text x={5} y={42}>{fmtDate(s, ctx.prefs)}{a.act_start_date ? ' A' : ''} – {fmtDate(f, ctx.prefs)}{a.act_end_date ? ' A' : ''}</text>
                  <title>{`${a.task_code} - ${a.task_name}`}</title>
                </g>
              );
            })}
            {[...trace.more].map(([l, n]) => {
              const x = [...trace.levels.keys()].sort((a, b) => a - b).indexOf(l);
              return <text key={l} x={PAD + x * (W + GX) + 5} y={PAD + trace.levels.get(l)!.length * (H + GY) + 14} className="muted">+{n} more not shown</text>;
            })}
            <defs><marker id="trace-arrow" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L6,3L0,6z" fill="#555" /></marker></defs>
          </svg>
        </div>
      )}
    </div>
  );
}
