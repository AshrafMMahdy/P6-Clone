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

## Extra real P6 exports (downloaded from public repositories)

These live in `downloaded XERs/` and are not in git, because several repositories have no license. When
present, `node scripts/oracle.ts` checks them too.

```bash
node --max-old-space-size=8192 scripts/check-folder.ts "downloaded XERs"
```

**Exact, every saved date and float:**
- C1511 Basline Schedule (P6 6.0, 4,093 activities)
- SSAC1511.UD-Sep.25.OK (P6 19.12 progressed update of C1511, 3,130 open activities)
- Hotel Project (older P6, 4,217 activities)
- HBTF-2 (the same programme re-scheduled in P6 24.12)
- Convention & Exhibition Center Roads & Utilities (P6 7.0, 1,036)
- Terminal Building Airport (66)
- myschedule (31)
- the four mpxj calendar test files

Hotel Project and HBTF-2 are the same programme scheduled by two P6 versions. They store different finishes
for the same links, and the clone now reproduces both: the rule depends on the P6 version that wrote the file.

Not compared: activities P6 never scheduled, because they have no saved dates (19 in Hotel Project's project CR,
1 in resource-rates-test). AMC9-213 (47 MB) is fully completed, so there are no open dates to compare.

### plant.xer (P6 15.1, 4 projects, 18,734 activities): 1,595 values; 3 of the 4 projects exact

- **PDH-R0-2 and CUB-r0-1:** exact.
- **PPA-r0-1:** exact apart from one free float. That activity links to a project outside the export; P6
  stores its late limit (2022-06-10 15:30) but not the outside successor's early start (2022-07-05 15:30),
  which its free float measures to.
- **CUB-CUR-B: stale.**
  - Its saved project finish (2022-03-31) differs from the other three (2022-12-16), so P6 scheduled it on
    its own, at a different time.
  - The dates show that calendar "CKPC.ENG 5X10 - 1wk Xmas off" had **25 December 2018, 2019 and 2020 as
    holidays** when it was scheduled. The file's version of that calendar has them as workdays.
  - Project CUB-r0-1 uses an identically defined calendar and matches P6 exactly with those days as workdays,
    so the calendar was edited between the two schedule runs.
  - Restoring the three days and scheduling CUB-CUR-B alone, as P6 did, takes it from 11,190 wrong values
    to 61.

### rehab-2.xer (P6 6.0, 6,977 activities): saved dates are not an F9 result

- **The file passed through an XER-splitting tool.** It comes from that tool's test folder, and it has no
  SCHEDOPTIONS table. P6 always writes that table.
- **Leveled or edited:** 41 of the 3,110 not-started activities that depend only on plain finish-to-start
  links start later than their predecessors allow, by up to 130 workdays, with no constraint. Example:
  V3103170's only predecessor finishes 2008-07-20 and P6 starts it 2009-01-01. F9 cannot produce that;
  resource leveling or later edits can.
- **Durations don't fit:** 232 not-started activities have saved dates spanning more than their duration on
  their calendar.

Pressing F9 in P6 would move these dates, so they can't serve as a scheduling reference.

### Alt-Ctrl-Proj sample.xer

Same file as Baseline Zone 2 Rev.01 (see above).
