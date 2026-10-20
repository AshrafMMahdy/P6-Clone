// Check Schedule / DCMA reports as HTML (written by the MCP server and CLI, shown by the desktop app) and as text.
import type { CheckResult } from './common.ts';

interface AnyReport { report: string; checks: CheckResult[]; summary: Record<string, number>; [k: string]: unknown }
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const fmtMetric = (c: CheckResult) => (c.metric == null ? '—' : c.unit === '%' ? `${c.metric}%` : c.unit === 'days' ? `${c.metric} d` : String(c.metric));
export const fmtTarget = (c: CheckResult) => (c.threshold ? `${c.threshold.op} ${c.threshold.value}${c.unit === '%' ? '%' : c.unit === 'days' ? ' d' : ''}` : '—');
const RESULT = { pass: 'Pass', fail: 'Fail', not_assessed: 'Not assessed' } as const;

export function analysisReportHtml(r: AnyReport, stamp: string): string {
  const rowsHtml = r.checks.map((c) => `<tr class="${c.result}"><td><a href="#${c.id}">${esc(c.name)}</a></td><td>${fmtTarget(c)}</td><td>${fmtMetric(c)}</td><td>${c.numerator ?? '—'}</td><td>${c.denominator ?? '—'}</td><td>${RESULT[c.result]}</td></tr>`).join('');
  const sections = r.checks.map((c) => `<h3 id="${c.id}">${esc(c.name)}: ${RESULT[c.result]}</h3>${c.note ? `<p>${esc(c.note)}</p>` : ''}${c.threshold ? `<p class="src">Target ${fmtTarget(c)} (${esc(c.threshold.source)})</p>` : ''}${c.activities.length ? `<table><tr><th>ID</th><th>Name</th><th></th></tr>${c.activities.map((a) => `<tr><td>${esc(a.id)}</td><td>${esc(a.name)}</td><td>${esc(a.value ?? '')}</td></tr>`).join('')}</table>${c.total_activities > c.activities.length ? `<p class="src">${c.total_activities - c.activities.length} more not listed.</p>` : ''}` : ''}`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.report)}</title><style>
body{font:13px Tahoma,Segoe UI,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;margin:6px 0 12px}td,th{border:1px solid #c8d0dc;padding:3px 8px;text-align:left}th{background:#e8eef8}
tr.fail td:last-child{color:#a01818;font-weight:bold}tr.pass td:last-child{color:#1d6b2d}.src{color:#666;font-size:12px}h3{margin:18px 0 4px}</style></head><body>
<h2>${esc(r.report)}</h2><p class="src">${esc(stamp)}</p>
<table><tr><th>Check</th><th>Target</th><th>Result</th><th>Found</th><th>Examined</th><th></th></tr>${rowsHtml}</table>${sections}</body></html>`;
}

export function analysisReportText(r: AnyReport): string {
  const out = [r.report, ''];
  for (const c of r.checks) {
    out.push(`${RESULT[c.result].toUpperCase().padEnd(13)} ${c.name}: ${fmtMetric(c)} (target ${fmtTarget(c)})${c.denominator != null ? `  [${c.numerator} of ${c.denominator}]` : ''}`);
    if (c.result === 'fail') for (const a of c.activities.slice(0, 5)) out.push(`              - ${a.id} ${a.name}${a.value != null ? ` (${a.value})` : ''}`);
  }
  return out.join('\n');
}
