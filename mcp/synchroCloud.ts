// M7 (optional, dormant): SYNCHRO 4D in the cloud through Bentley's iTwin Schedules API. It answers "not configured"
// until BENTLEY_CLIENT_ID and BENTLEY_CLIENT_SECRET (a service client with the itwin-platform scope) are set in the
// environment; nothing is stored in files. The agent's normal route to SYNCHRO stays export_4d / import_4d: this is
// for a user who wants the schedule pushed to a SYNCHRO 4D (v10) schedule directly. Untested against Bentley's service
// (the API is a technical preview): written from developer.bentley.com/apis/schedules.
import { rows, type Db } from '../core/db.ts';
import { parseP6Date } from '../core/dates.ts';
import { fail } from './runtime.ts';

const API = 'https://api.bentley.com', IMS = 'https://ims.bentley.com/connect/token';
const ACCEPT = 'application/vnd.bentley.itwin-platform.v1+json';

export const SYNCHRO_CLOUD_TOOL = (withHandle: (s: Record<string, unknown>) => Record<string, unknown>, project: unknown) => ({
  name: 'synchro_cloud', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  description: 'OPTIONAL, dormant until configured: SYNCHRO 4D in the cloud (Bentley iTwin Schedules API, technical preview). action status (default) says whether it is configured; list_schedules {itwin_id} lists the iTwin’s schedules; push_tasks {schedule_id} creates the project’s activities as tasks of a SYNCHRO 4D (v10) schedule (Activity ID as the user-defined ID, early start and original duration; 200 per request). Needs BENTLEY_CLIENT_ID and BENTLEY_CLIENT_SECRET in the server’s environment. Element links are not pushed: use export_4d target synchro for a linked package.',
  inputSchema: withHandle({ type: 'object', properties: { project, action: { type: 'string', enum: ['status', 'list_schedules', 'push_tasks'] }, itwin_id: { type: 'string' }, schedule_id: { type: 'string' } } }),
});

const configured = () => !!(process.env.BENTLEY_CLIENT_ID && process.env.BENTLEY_CLIENT_SECRET);

async function token(): Promise<string> {
  const r = await fetch(IMS, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.BENTLEY_CLIENT_ID!, client_secret: process.env.BENTLEY_CLIENT_SECRET!, scope: 'itwin-platform' }) });
  if (!r.ok) return fail('cloud_auth', `Bentley sign-in refused (${r.status}).`, 'Check BENTLEY_CLIENT_ID / BENTLEY_CLIENT_SECRET and that the client has the itwin-platform scope.');
  return ((await r.json()) as { access_token: string }).access_token;
}

async function call(tok: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${tok}`, accept: ACCEPT, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return fail(r.status === 429 ? 'rate_limited' : 'cloud_error', `Bentley Schedules API ${r.status}: ${(body as { error?: { message?: string } }).error?.message ?? r.statusText}`, r.status === 404 ? 'Check the IDs.' : 'Try again later.');
  return body as Record<string, any>;
}

export async function runSynchroCloud(db: Db, projId: string, a: Record<string, any>, tick: (done: number, total: number, msg: string) => Promise<void>) {
  const action = String(a.action ?? 'status');
  if (!configured()) return { configured: false, optional: true, note: 'SYNCHRO cloud is optional and not configured: set BENTLEY_CLIENT_ID and BENTLEY_CLIENT_SECRET in the MCP server’s environment. Without it, use export_4d target synchro and import_4d.' };
  if (action === 'status') return { configured: true, optional: true, api: `${API}/schedules` };
  const tok = await token();
  if (action === 'list_schedules') {
    const id = String(a.itwin_id ?? '') || fail('bad_input', 'itwin_id is needed.', 'The iTwin (project) ID from Bentley.');
    const r = await call(tok, `/schedules?iTwinId=${encodeURIComponent(id)}`);
    return { schedules: (r.schedules ?? r.items ?? []).map((x: Record<string, unknown>) => ({ id: x.id, name: x.name, type: x.type ?? (x.isNextGen ? 'v10' : 'v6.5') })) };
  }
  if (action !== 'push_tasks') fail('bad_input', `Unknown action "${action}".`, 'Use status, list_schedules or push_tasks.');
  const sid = String(a.schedule_id ?? '') || fail('bad_input', 'schedule_id is needed.', 'list_schedules gives it.');
  const tasks = rows(db, 'TASK').filter((t) => t.proj_id === projId && t.task_type !== 'TT_WBS' && t.task_type !== 'TT_LOE');
  const iso = (s: string) => { const m = parseP6Date(s); return m == null ? undefined : new Date(m * 60000).toISOString(); };
  const batch = tasks.map((t) => ({ name: t.task_name || t.task_code, userDefinedId: t.task_code, type: 'Work', plannedStart: iso(t.early_start_date || t.target_start_date), plannedDuration: Math.round(Number(t.target_drtn_hr_cnt || 0) * 3600) }));
  const ops: string[] = [];
  for (let i = 0; i < batch.length; i += 200) {
    await tick(i, batch.length, 'pushing tasks to SYNCHRO');
    const r = await call(tok, `/schedules/${encodeURIComponent(sid)}/tasks/batch`, { method: 'POST', body: JSON.stringify({ batch: batch.slice(i, i + 200) }) });
    if (r.operation?.id) ops.push(r.operation.id);
  }
  return { pushed: batch.length, schedule_id: sid, operations: ops, note: 'Creation runs as Bentley operations; the tasks appear when they finish. Links between tasks and element assignments are not pushed.' };
}
