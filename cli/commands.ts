import { writeFileSync } from 'node:fs';
import type { Db } from '../core/db.ts';
import { parseP6Date, formatP6Date } from '../core/dates.ts';
import { scheduleProjects } from '../core/schedule/cpm.ts';
import { writeXer } from '../core/xer/write.ts';

export interface ScheduleCmdOptions { dataDate?: string; out?: string; version?: string; json?: boolean }

export async function runScheduleCommand(cmd: string, db: Db, o: ScheduleCmdOptions): Promise<number> {
  const projIds = (db.tables.PROJECT?.rows ?? []).map((p) => p.proj_id);
  const dd = o.dataDate ? parseP6Date(o.dataDate) : null;
  if (o.dataDate && dd == null) throw new Error(`bad --data-date "${o.dataDate}"`);
  const extra: Record<string, unknown> = {};

  if (cmd === 'progress') {
    if (dd == null) throw new Error('--data-date required');
    const { updateProgress } = await import('../core/progress/update.ts');
    for (const id of projIds) extra[id] = updateProgress(db, id, dd);
  }
  const res = scheduleProjects(db, projIds, dd != null ? { dataDate: dd } : {});
  if (cmd === 'level' && res.ok) {
    const { levelResources } = await import('../core/level/level.ts');
    extra.level = levelResources(db, projIds, {});
  }
  if (o.out && res.ok) writeFileSync(o.out, writeXer(db, { version: o.version ?? db.header?.version ?? '19.12' }));

  if (o.json) {
    console.log(JSON.stringify({ ok: res.ok, stats: { ...res.stats, finish: formatP6Date(res.stats.finish), dataDate: formatP6Date(res.stats.dataDate) }, findings: res.findings, extra }, null, 2));
  } else {
    console.log(res.log);
    if (o.out && res.ok) console.log(`\nWrote ${o.out}`);
  }
  return res.ok ? 0 : 1;
}
