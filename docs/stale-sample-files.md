# The 5 sample files the scheduler cannot match, and why

Rescheduling a file can only reproduce P6's stored dates if nothing changed after P6 last scheduled it.
20 of the 25 real P6 files match P6 value for value. In each of the other 5, the file itself shows that
something was edited after P6's last schedule run. Where the edit can be undone, undoing it makes the
clone match P6 again, which shows the remaining gap is in the file, not in the scheduler.

Commands (run from the project folder):

```bash
node scripts/oracle.ts
```

```bash
node scripts/audit.ts
```

```bash
node scripts/reconstruct-calendar.ts "Beyti plant baseline -b"
```

## badra oil.xer: 86 wrong values; 0 after undoing one edit

- Activity **A3890** says its remaining duration is 264 h, and its remaining start/finish fields span 264 h.
  But its early start/finish, which P6 writes at the same moment, span only 40 h. P6 never stores the two
  differently for a not-started activity.
- The record was last edited by user **"NotPrmUser"** (a program other than P6) on 2012-03-19.
- Put A3890 back to the 40 h P6 used (and its zero-quantity assignment, which the same edit stretched)
  and the clone matches P6 exactly: `node scripts/oracle.ts badra --repair` → EXACT.

## Beyti plant baseline -b(fm-baseline).xer: 842 wrong values; 0 with the calendar P6 used

- Tasks prove P6 treated **9 and 10 November 2011** as holidays on calendar "Beyti". For example, MT-1140
  is a 2-day task that P6 placed from 3 Nov to 12 Nov. That is only possible if 5–10 Nov were all off.
- The calendar in the file has only 5–8 Nov off. The holidays were changed after the last schedule.
- `node scripts/reconstruct-calendar.ts "Beyti plant baseline -b"` works out the calendar from P6's own
  dates (it finds exactly those two days). Rescheduled with it, the result is **0 wrong values on all 252 activities**.

## Baseline Zone 2 Rev.01.xer and Baseline Zone 2 Rev.01(2).xer (same content): 15,878 wrong values; 259 with the calendar P6 used

- On calendar "PHASE 2", 1,502 of 3,111 not-started tasks have stored dates that do not span their own
  duration. That count goes to zero for no version of the calendar now in the file.
- Every task that spans a calendar exception dated June 2015 or later disagrees with it. So does every task
  spanning Eid al-Fitr 2014. P6 scheduled before those exceptions (weekly Fridays from June 2015, Eid 2014)
  were added, and before Ramadan 2014 and Eid al-Adha 2014 were changed.
- The reconstructed calendar (75 days differ from the file) makes 2,981 of the 3,111 tasks consistent and
  cuts the wrong values from 15,878 to 259. The rest are tasks whose durations were also edited. Nothing in
  the file can tell us what they were before.

## Enppi.xer: 150 wrong values

- **LOPS02** has a single predecessor, LOPS01, with a "start on" constraint of 15 Sep 2012, and P6's own
  relationship record (`TASKPRED.aref`) says that link released it on 15 Sep. Yet P6 stored LOPS02's start as
  3 Oct. Some other driver (a constraint or a link) existed when P6 scheduled, and it is gone from the file.
  The same happened to 11 sibling activities (LOJK/LODK/LOPS x2, x12, x22, x32). All of them were
  created in one batch on 2012-06-20 10:24.
- **GM04** has no predecessors and no constraint. P6 would place it at the data date (30 Nov 2011), but the
  file says 23 Jan 2013. It was edited on 2012-06-20, after that project's data date.
- The file also contains a circular relationship (4229PBV70 → 4229EPI300 → 4229PBV80 → 4229PBV70).
- Put back constraints matching P6's starts for those 13 activities and the early dates all match. The late
  dates still differ, because successor links were also changed. The original values cannot be recovered from the file.
