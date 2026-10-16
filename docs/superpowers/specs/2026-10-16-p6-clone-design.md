# P6 Clone — Design Spec

Date: 2026-10-16
Status: Draft for review

## 1. Purpose

A local-only Electron desktop app that behaves like Oracle Primavera P6 Professional, so the
owner can test the XER (and P6 XML) output of their agentic construction-management platform's
scheduling agent without access to real P6.

Two test directions:

1. **Agent → Clone.** Agent writes XER. Clone imports it the way P6 would (accepts what P6 accepts,
   rejects what P6 rejects, auto-fixes what P6 auto-fixes) and explains every problem in a
   diagnostics log. Scheduler can then schedule, review, update progress.
2. **Clone → Agent.** Scheduler statuses a project mid-execution (data date, actuals, remaining
   durations, resource actuals), exports XER/XML exactly as P6 would, agent reads it back.

Success criteria:

- Every real-P6 sample XER in `Sample XERs/` (v5.0–7.0) imports with zero errors.
- Agent XERs import or fail with diagnostics pointing to table/row/field and the reason.
- F9 scheduling results (early/late dates, float, critical/longest path) match P6 conventions for
  the same inputs. Real-P6 samples double as oracles: imported early/late dates and floats from
  P6 exports must be reproduced by rescheduling (within documented tolerance).
- Exported XER re-imports into the clone with no loss (round-trip identity on all tables, including
  tables the clone does not use) and follows P6 export conventions so real P6 would accept it.
- UI is recognisably P6 Professional: menus, toolbars, directory bar, Activities layout, dialogs.

Not goals: copying Oracle code/assets; users, security, licensing, login; Primavera Cloud / EPPM web.

## 2. What was learned from samples

- Real P6 exports: ERMHDR 5.0, 5.0.2000, 6.0, 6.0.0, 6.2, 7.0. CRLF line endings, Windows-1252
  text, full field lists (e.g. TASK 58 fields in 7.0), `%E` terminator.
- Agent exports ("White Hat IQ Scheduler", "NordBuild"): ERMHDR 12.0 (not a real P6 version),
  8.1, 18.8, 19.12, 20.12. LF line endings, sparse field lists (TASK ~21 fields), non-P6 field name
  `taskpred_id` (P6: `task_pred_id`), one file with a single TASK table and nothing else.
- No modern (v8+) real P6 export is available. Modern field lists come from the developer's
  knowledge of the format and are marked "unverified" in the field-definition data so they can be
  corrected when a real modern export is supplied.

## 3. Architecture

```
<repo root>/
  core/        Pure TypeScript, no Electron/DOM. All domain logic. Unit-tested with node:test.
  cli/         Thin wrapper over core for agent use.
  main/        Electron main: window, native menus, file dialogs, persistence, printing.
  renderer/    React UI (Vite). Talks to main via a small preload IPC API.
  docs/        Specs and plans.
  Sample XERs/ Test fixtures (existing).
```

Stack: Electron, React, TypeScript, Vite. No commercial grid/Gantt libraries; table and Gantt are
custom (canvas for Gantt bars, virtualised DOM rows for the table). XML via a small dependency
(`fast-xml-parser`) only if hand-rolling becomes non-trivial.

### 3.1 Data model = P6 tables

The in-memory database is a set of P6 tables keyed by table name, rows stored as objects with P6
field names (`TASK`, `TASKPRED`, `PROJWBS`, `CALENDAR`, `RSRC`, `TASKRSRC`, `PROJECT`,
`OBS`, `ACCOUNT`, `PROJCOST`, `ACTVTYPE`, `ACTVCODE`,
`TASKACTV`, `UDFTYPE`, `UDFVALUE`, `SCHEDOPTIONS`, `ROLES`, `RSRCRATE`, ...).

- Import = parse into tables, validate, merge into DB.
- Export = select rows for chosen projects, serialize per target version.
- Unknown tables and fields are kept verbatim and round-trip.
- Typed accessor helpers wrap rows for the UI and engine (dates parsed, hours numeric) without a
  separate domain model.

Global (dictionary) tables shared across projects, like P6: EPS (internal table; XER project exports carry no EPS rows, PROJWBS proj_node_flag=Y marks the project root), OBS, calendars (global and
resource), resources, roles, cost accounts, activity code types (global/EPS/project), UDF types,
currencies, units of measure.

### 3.2 Persistence

One JSON database file in Electron `userData` (`p6clone-db.json`), written atomically
(temp file + rename) on change, debounced. Represents P6's local database: projects persist across
sessions. Admin > "Reset Database" wipes it. CLI uses an in-memory DB unless `--db` is given.

### 3.3 Undo/redo

Snapshot of affected tables per user action (structured clone), bounded stack (50). Scheduling,
leveling and progress updates are single undo steps.

## 4. XER format layer (core/xer)

### 4.1 Parser

- Detect encoding (UTF-8 BOM / UTF-8 / Windows-1252). P6 writes Windows-1252.
- Accept CRLF and LF (warn on LF: P6 writes CRLF).
- Records: `ERMHDR` header, `%T` table, `%F` fields, `%R` rows, `%E` end.
- Preserve raw field order per table for faithful re-export.

### 4.2 Validator (P6-like + diagnostics)

Each finding: `{severity: fatal|error|warning|info, code, table, rowIndex, keyValue, field, message,
p6Behavior}` where `p6Behavior` states what real P6 would do (reject file, skip row, default value,
silently accept).

Rules (non-exhaustive, data-driven):

- Header: first line `ERMHDR`, version recognised, export date parseable. Unknown version → warning.
- Structure: `%F` before `%R`; row field count equals `%F` count; `%E` present; known table names.
- Required tables for a project import: PROJECT, PROJWBS (project node), TASK; CALENDAR referenced.
- Required fields per table (from field definitions), field-name typos (e.g. `taskpred_id` →
  suggests `task_pred_id`).
- Types: dates `yyyy-mm-dd hh:mm`, numbers, Y/N flags, enum codes (`TT_Task`, `TK_NotStart`,
  `PR_FS`, `CS_MSO`, `DT_FixedDUR2`, `CP_Drtn`, `RT_Labor`, ...).
- Referential integrity: TASK.wbs_id/proj_id/clndr_id, TASKPRED task ids, TASKRSRC rsrc/task,
  PROJWBS parent chain (no cycles, single project node), ACTVCODE→ACTVTYPE, UDFVALUE→UDFTYPE.
- Key uniqueness; task_code unique within project.
- Calendar `clndr_data` grammar parse; day/week hour counts consistent.
- Logic: relationship loops (P6 blocks scheduling), self-links, duplicate links.
- Progress consistency: actual start ≤ actual finish, status vs actual dates, actuals after data date.
- Mirrors P6 auto-fixes: missing calendar → project default calendar; orphan WBS → project root;
  missing guid → generated.

### 4.3 Import wizard semantics

P6 steps: Import Format (XER / P6 XML / Microsoft Project XML out of scope) → Import Type
(Project) → File → Projects to Import with Import Action per project (Create New Project, Update
Existing Project, Replace Existing Project, Add Into Existing Project) and target EPS → Update
Project Options (per-table Keep Existing / Update Existing / Insert New / Do Not Import, for
calendars, resources, codes, UDFs) → Summary → Import log.

ID remapping: imported keys get new internal ids (as P6 does) while preserving cross-references.

### 4.4 Writer

- Target version selectable: 5.0, 6.0, 6.2, 7.0, 8.x, 15.x–24.x (list in field-definition data).
- Field list and table order per version; missing values blank; P6 date format; CRLF;
  Windows-1252; `%E` line.
- Header: `ERMHDR\t<ver>\t<date>\tProject\t<user>\t<user name>\t<db name>\tProject Management\t<currency>`.
- Exports dictionaries referenced by the selected projects only (calendars, resources, codes, UDFs,
  accounts, OBS), like P6.
- Optional: include baseline projects.

### 4.5 Field definitions (core/xer/schema)

Data file: per table, ordered fields with type, enum set, required flag, and the versions they
appear in, plus `verified: true|false` (true when confirmed against a real P6 export).

## 5. P6 XML (core/xml)

Import and export P6 XML (`APIBusinessObjects` schema): Project, WBS, Activity, Relationship,
Calendar, Resource, ResourceAssignment, ActivityCode(Type), UDF, CostAccount, EPS, OBS, Baseline
projects. Same validator-style diagnostics. Maps to the same tables.

## 6. Calendars (core/calendar)

- Parse/serialize `clndr_data`: work week with multiple shifts per day (`s|08:00 f|16:00` pairs),
  exceptions keyed by serial day (`d|41519`, days since 1899-12-30) with optional work hours.
- Global, project and resource calendars; base calendar inheritance.
- Operations in work hours: `addWork(date, hours)`, `subtractWork`, `workBetween`, next/previous
  work time. Minute resolution.
- Calendars dialog (Enterprise > Calendars): list, work week editor, exception day editor via
  month calendar view, hours/day-week-month-year.

## 7. Scheduler (core/schedule)

P6 CPM with project-level SCHEDOPTIONS honored:

- Durations and lags in hours on calendars. Lag calendar: predecessor / successor / 24-hour /
  project default (`sched_calendar_on_relationship_lag`).
- Relationship types FS, SS, FF, SF; negative lag.
- Activity types: Task Dependent, Resource Dependent (resource calendars), Level of Effort
  (spans its predecessors/successors), Start Milestone, Finish Milestone, WBS Summary.
- Duration types (Fixed Duration & Units/Time, Fixed Duration & Units, Fixed Units, Fixed Units/Time)
  driving units/duration recalcs when edited.
- Constraints primary/secondary: Start On, Start On or Before, Start On or After, Finish On,
  Finish On or Before, Finish On or After, Mandatory Start, Mandatory Finish, As Late As Possible,
  Expected Finish (option).
- Project planned start, Must Finish By date, data date.
- Progress: actual start/finish honored; remaining work scheduled from data date; Retained Logic,
  Progress Override, Actual Dates modes; out-of-sequence detection.
- Open-ended options: "Make open-ended activities critical"; ignore relationships to/from other
  projects option; multi-project scheduling across inter-project relationships with external
  early start / late finish dates when the other project is not opened.
- Floats: total float (start / finish / smallest), free float, critical = TF ≤ threshold or longest
  path; longest path; multiple float paths (option).
- Writes back: early/late start/finish, remaining early/late, TF/FF, driving_path_flag,
  status-related dates, project scd_end_date, last_recalc_date.
- Schedule log (text report like P6's `SCHEDLOG.TXT`): settings, statistics, errors, open starts/
  finishes, out-of-sequence, constraint and actual-date violations, loops.
- Validation oracle tests: reschedule real-P6 sample projects and compare with dates in the file.

## 8. Resources and costs (core/resource, core/cost)

- Resource dictionary hierarchy: Labor, Nonlabor, Material; units, price/unit history (RSRCRATE),
  max units/time, calendar, default units/time, overtime.
- Roles with rates; role-to-resource assignment.
- Assignments: budgeted/actual/remaining units and costs, units/time, lag, curve (linear only for
  spreading, others preserved), driving flag, cost account. Duration type logic links units,
  units/time and duration.
- Resource usage spreadsheet and profile (histogram, availability line) over time scale.
- Cost accounts dictionary (Enterprise > Cost Accounts) hierarchical; expenses (PROJCOST) with
  budget/actual/remaining; activity and WBS cost rollups; earned value basics (BCWS, BCWP, ACWP,
  SPI/CPI) for columns/reports.

## 9. Resource leveling (core/level)

P6-style leveler (Tools > Level Resources): serial method, priority by activity attributes
(default: early start, then total float, then ID), level within float or allow extension,
leveling across selected projects, consider assignments in other projects at priority, overallocation
threshold, preserve scheduled early/late dates option. Writes leveled start/finish into early
dates like P6. Leveling log.

## 10. Progress updating (core/progress)

- Activity status edits (Status tab): Started/Finished checkboxes with actual dates, duration %,
  physical %, units %, remaining duration, expected finish, suspend/resume; percent complete type
  per activity.
- Tools > Update Progress: auto-compute actuals up to new data date, as P6 (start activities planned
  to start, finish those planned to finish, set remaining from plan).
- Apply Actuals (resource actuals from planned).
- Store Period Performance — out of scope unless trivial.
- Baselines: Project > Maintain Baselines (save copy, restore, delete), Assign Baselines (project
  baseline, user primary/secondary/tertiary), baseline bars and baseline columns (BL start/finish,
  variance).

## 11. Enterprise structures

- EPS: tree (Enterprise > EPS), projects belong to EPS nodes; Projects window shows EPS tree with
  projects, open/close projects (multi-select open → multi-project view).
- OBS: tree, assign to WBS/projects (responsible manager).
- Activity codes (global/EPS/project) with values tree, assign, group by code.
- UDFs (Enterprise > User Defined Fields) for activities/WBS/projects/resources; show in columns.
- Currencies and units of measure dictionaries (minimal editors).

## 12. UI (renderer)

Look: classic P6 Professional (Windows, light grey chrome, Tahoma/Segoe UI 8–9pt, dense grids,
blue selection), not modern flat design.

- **Native menu bar** (Electron Menu): File, Edit, View, Project, Enterprise, Tools, Admin, Help,
  with the P6 items relevant to the above (New, Open, Close All, Import, Export, Page Setup, Print
  Preview, Print, Exit; Undo, Cut/Copy/Paste, Add, Delete, Dissolve, Renumber IDs; Layout,
  Columns, Bars, Filters, Group and Sort, Timescale, Expand/Collapse; Projects, WBS, Activities,
  Baselines, Assign Baselines; EPS, OBS, Resources, Roles, Calendars, Activity Codes, UDFs,
  Cost Accounts; Schedule F9, Level F10, Update Progress, Reports, Schedule Log; Admin Preferences;
  About).
- **Toolbars**: standard (open/import/print/undo), Activities (add/delete, link, schedule, level,
  progress spotlight), view (layouts, columns, filters, group/sort, zoom timescale).
- **Directory bar** (left): Projects, WBS, Activities, Resources, Resource Assignments, Reports.
- **Projects window**: EPS/project tree with columns (ID, name, start, finish, data date, status).
- **WBS window**: WBS tree grid with optional chart.
- **Activities window**: top split of table + Gantt; bottom tabbed detail (General, Status,
  Resources, Predecessors, Successors, Relationships, Codes, Notebook, Steps (passthrough), Feedback
  (passthrough), Expenses, Summary).
  - Table: columns chooser (all relevant TASK fields, computed fields, UDFs, codes), group by WBS
    (colored bands with summary dates) or by code, sort, filters (Critical, Not Started, In
    Progress, Completed, custom simple filter builder), inline edit with P6 validation, add/
    delete/indent WBS, copy/paste activities, renumber.
  - Gantt: timescale header (year/quarter/month/week/day), bars: actual (blue), remaining
    (green), critical remaining (red), milestones (diamonds), baseline (yellow, under bar), WBS
    summary bars (black), LOE; data date line; relationship lines (on/off); drag to link
    activities; tooltips.
  - Spotlight / progress line — spotlight only.
- **Resources window**: dictionary tree + details tabs (General, Codes, Details, Units & Prices,
  Roles).
- **Resource Assignments window** and bottom **Resource Usage Profile/Spreadsheet**.
- **Dialogs**: Import wizard, Export wizard, Schedule (F9, with Options: logic mode, float calc,
  lag calendar, open-ended, multi-project), Level Resources, Update Progress, Maintain/Assign
  Baselines, Calendars, Project Details (General, Dates incl. data date/must-finish, Defaults,
  Settings, Calculations), Columns, Filters, Group & Sort, Bars (minimal), Timescale, Admin
  Preferences (time units display, date format), Import log, Schedule log.
- **Layouts**: save/load named layouts (columns, grouping, filters, bar settings) in DB.

## 13. Reports and printing

- Print Preview / Print the current Activities view (table + Gantt) with page setup (orientation,
  scale to N pages wide, header/footer with project name, data date, page x of y). Uses Electron
  `webContents.print` / `printToPDF` for "Save as PDF".
- Built-in reports (Tools > Reports): Schedule report (activities by WBS with dates/float),
  Critical activities, Resource assignments by resource, Cost by WBS / cost account, Schedule log,
  Import diagnostics. Output to print/PDF and CSV.

## 14. CLI (cli/)

```
p6clone validate <file.xer|file.xml> [--json]           diagnostics; exit code 0/1/2
p6clone schedule <file> [--data-date YYYY-MM-DD] [--out out.xer] [--version 19.12] [--json]
p6clone progress <file> --data-date YYYY-MM-DD --out out.xer   auto Update Progress then schedule
p6clone level <file> --out out.xer
p6clone export <file> --format xer|xml --version <v> --out <path>
p6clone diff <a.xer> <b.xer> [--json]                   table/row/field level differences
```

Same core code as the GUI, so results are identical.

## 15. Error handling

- Import never partially commits: validate → stage → commit or abort, with the log always shown.
- Scheduling errors (loops, missing calendars) abort with log, data untouched.
- DB write failure surfaces a dialog; previous DB file kept (atomic rename).
- Renderer crashes do not corrupt data (main owns the DB).

## 16. Testing

- Core unit tests (node:test + tsx): parser, writer, calendar math, CPM cases (each relationship
  type, constraints, progress modes, float types), leveling, progress update, XML.
- Fixture tests over all files in `Sample XERs/`: import, expected diagnostics snapshot per file,
  export → re-import round-trip identity.
- Oracle tests: reschedule real-P6 samples and compare early/late dates and floats with file values.
- UI smoke test: launch Electron via Playwright, import a sample, F9, export.

## 17. Delivery milestones

1. Core XER parse/validate/write + field definitions + CLI validate/export, fixture tests.
2. Calendars + CPM scheduler + schedule log + CLI schedule, oracle tests.
3. Electron shell, persistence, menus, Projects/WBS/Activities windows, table, Gantt, details tabs,
   import/export wizards, F9 dialog. (First usable GUI.)
4. Progress updating, baselines, resources/assignments, costs, resource profile.
5. EPS/OBS/codes/UDF/cost-account editors, multi-project open and scheduling, leveling.
6. P6 XML import/export, reports and printing, layouts, polish.

Each milestone ends runnable and tested.

## 18. Out of scope

Users, security profiles, login, licensing, Primavera Cloud/EPPM web, Microsoft Project formats,
timesheets/Team Member, risk analysis, portfolios/capacity planning, issues/thresholds editing
(passthrough only), methodology/Methodology Management, Claim Digger, job services, API/integration
servers, non-linear resource curves for spreading (preserved but spread linearly), store period
performance.
