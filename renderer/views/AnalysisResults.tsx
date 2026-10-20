// A check-by-check results table (Check Schedule, DCMA 14-point, lint): click a check to see why and which activities;
// click an activity to go to it in the Activities window.
import { useState } from 'react';
import { getDb, getUi, setUi } from '../store.ts';
import { rows } from '../../core/db.ts';
import type { CheckResult } from '../../core/analysis/common.ts';
import { fmtMetric, fmtTarget } from '../../core/analysis/report.ts';

const RESULT = { pass: 'Pass', fail: 'Fail', not_assessed: 'Not assessed' } as const;
const COLOR = { pass: '#1d6b2d', fail: '#a01818', not_assessed: '#777' } as const;

/** Go to an activity by its ID in the open projects. */
export function goToActivity(code: string): void {
  const open = new Set(getUi().openProjects);
  const t = rows(getDb(), 'TASK').find((x) => x.task_code === code && open.has(x.proj_id));
  if (t) setUi({ view: 'activities', selTasks: [t.task_id], selTask: t.task_id, revealTask: t.task_id });
}

export function AnalysisResults({ checks, onGo }: { checks: CheckResult[]; onGo?: () => void }) {
  const go = (code: string) => { onGo?.(); goToActivity(code); };
  const link = (code: string) => <a href="#" onClick={(e) => { e.preventDefault(); go(code); }}>{code}</a>;
  const [open, setOpen] = useState<string | null>(checks.find((c) => c.result === 'fail')?.id ?? null);
  return (
    <div className="tblwrap" style={{ flex: 1, overflow: 'auto' }}>
      <table className="tbl" style={{ width: '100%' }}>
        <thead><tr><th>Check</th><th>Target</th><th>Result</th><th>Found</th><th>Examined</th><th></th></tr></thead>
        <tbody>
          {checks.map((c) => [
            <tr key={c.id} className={open === c.id ? 'sel' : ''} style={{ cursor: 'pointer' }} onMouseDown={() => setOpen(open === c.id ? null : c.id)}>
              <td>{c.name}</td><td>{fmtTarget(c)}</td><td>{fmtMetric(c)}</td><td>{c.numerator ?? '—'}</td><td>{c.denominator ?? '—'}</td>
              <td style={{ color: COLOR[c.result], fontWeight: c.result === 'fail' ? 'bold' : undefined }}>{RESULT[c.result]}</td>
            </tr>,
            open === c.id && (
              <tr key={c.id + ':d'}><td colSpan={6} style={{ background: '#f7f9fc', whiteSpace: 'normal' }}>
                {c.note && <div style={{ margin: '2px 0 4px' }}>{c.note}</div>}
                {c.threshold && <div className="muted" style={{ fontSize: 11 }}>Target {fmtTarget(c)} ({c.threshold.source})</div>}
                {c.detail && <div className="muted" style={{ fontSize: 11 }}>{Object.entries(c.detail).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')}</div>}
                {c.activities.length > 0 && <table className="tbl" style={{ margin: '4px 0' }}><tbody>
                  {c.activities.map((a, i) => <tr key={i}><td>{/ -> /.test(a.id) ? <>{link(a.id.split(' -> ')[0])} → {link(a.id.split(' -> ')[1])}</> : link(a.id)}</td><td>{a.name}</td><td className="muted">{a.value ?? ''}</td></tr>)}
                </tbody></table>}
                {c.total_activities > c.activities.length && <div className="muted" style={{ fontSize: 11 }}>{c.total_activities - c.activities.length} more not listed.</div>}
              </td></tr>
            ),
          ])}
        </tbody>
      </table>
    </div>
  );
}
