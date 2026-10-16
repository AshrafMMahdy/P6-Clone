import { useMemo } from 'react';
import { useStore } from './store.ts';
import { makeCtx, type Ctx } from './model.ts';
import { calendarResolver } from '../core/schedule/cpm.ts';
import { rows } from '../core/db.ts';
import type { WorkCalendar } from '../core/calendar/calendar.ts';

/** Column/format context, recomputed when the database or preferences change. */
export function useCtx(): Ctx {
  const db = useStore((s) => s.db);
  const v = useStore((s) => s.dbVersion);
  const prefs = useStore((s) => s.ui.prefs);
  return useMemo(() => makeCtx(db, prefs), [db, v, prefs]);
}

export function useProjectCalendar(projId?: string): WorkCalendar | undefined {
  const db = useStore((s) => s.db);
  const v = useStore((s) => s.dbVersion);
  return useMemo(() => {
    const p = rows(db, 'PROJECT').find((x) => x.proj_id === projId);
    return p ? calendarResolver(db, []).fallback(p.clndr_id) : undefined;
  }, [db, v, projId]);
}
