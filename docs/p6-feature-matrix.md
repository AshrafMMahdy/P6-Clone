# P6 Clone vs Primavera P6 Professional: feature matrix

Audit date: 2026-10-17, at commit `ed16126`. Read-only audit: nothing was fixed in this pass.

## How this was done

1. **Inventory from P6, not from this code.** The rows below come from Primavera P6 Professional's own feature map: every menu and submenu (File, Edit, View, Project, Enterprise, Tools, Admin, Help), every window (Projects, EPS, WBS, Activities, Assignments, Resources, Roles, Tracking, Portfolios, Timesheets, Issues, Risks, Thresholds, Reports, Work Products and Documents, Expenses), their dialogs, every Activity Details and Project Details tab, the column groups, Admin and User Preferences, toolbar and right-click commands, import/export formats, printing and Page Setup, reports, scheduling/leveling/progress options, baselines, Global Change, codes and UDFs, filters, layouts, grouping and sorting.
2. **Checked for real.** Each item was traced end to end: menu id (`main/menu.ts`) → `renderer/App.tsx` / `renderer/commands.ts` → dialog or view → `renderer/model.ts` / `core/`. An option that a dialog shows but the engine never reads is graded partial or missing, not done. Behaviour was also run where cheap:
   - the real app driven with Playwright (`_electron`, throwaway `--user-data`, `Sample XERs/cairo festival city.xer`): every menu command sent, each dialog's fields, tabs and buttons recorded, right-click menus, Ctrl+Numpad, Cut/Paste (see [Live checks](#live-checks-in-the-running-app));
   - XER → XER, XER → P6 XML → XER, XER → MSPDI/MPX → XER, Excel export → import, and encoding round trips on CfC, 130 TRIAL, Tower-A, cairo alex-road, plant (15.1) and HBTF-2 (24.12);
   - scratch scripts against `core/schedule/cpm.ts` for each schedule option;
   - `node --test` on the reports, level, progress, cpm and cost tests (21/21 pass); the oracle baseline (`tests/oracle-baseline.json`: 29 of 35 entries reproduce P6's stored dates and floats exactly; the rest are the stale files in `docs/stale-sample-files.md`).
3. **Sibling sessions committed fixes during the audit** (2105890, 9a0f9b9, 3700bdd, 327446b, 1593d17, ed16126). Every row they touch was re-checked at the final commit; those rows say "Fixed in …".

### Grades

| Grade | Meaning |
|---|---|
| **done** | Works like P6 for normal use |
| **partial** | Exists but incomplete or behaves differently; the Notes say exactly how |
| **missing** | Not in the clone |
| **n/a** | Server, security or multi-user feature that makes no sense in a single-user local clone (Users, Security Profiles, Check In/Out, Job Services, Refresh F5...) |
| **extra** | Clone-only addition, not a P6 item (not counted in the P6 totals) |

### AI and MCP/CLI columns

- **AI** = the in-app assistant. `op X` = an `edit_project` operation (`core/project/ops.ts`: add_project, copy_project, set_project, add_calendar, add_holidays, add_wbs, delete_wbs, add_activity, update_activity, delete_activity, dissolve_activity, add/update/delete_relationship, add_resource, assign_resource, unassign_resource). `lookup X` = `core/query/tools.ts` (list_projects, project_summary, find_activities, get_activity, list_wbs, critical_path, schedule_health, resource_summary, earned_value, trace_logic). Other live tools: select_activity, set_print_options, list_reports, open_report, run_report_dialog, create_report, undo. `UI only` / `UI*` = only by driving the screen with ui_menu / ui_click / ui_type. Limits that apply to many rows: ui_click reaches buttons, tabs, labels and open context-menu items only (`renderer/ai/live.ts:112`), so it **cannot pick a table row** in a dialog or window (Projects, baselines, layouts, columns, dictionaries) and cannot open a right-click menu; ui_type fills labelled inputs and selects only (`live.ts:121`), so it **cannot fill textareas** (notebooks) or the unlabelled inline cells of the dictionary grids; every file pick or save is a native dialog it cannot drive. There is no schedule, level or progress tool (it drives the dialogs), and it **cannot read** the Schedule, Leveling or Import logs or the validation findings.
- **MCP/CLI** = `mcp/server.ts` tools (open_file, new_project, list_open, edit, schedule, update_progress, level_resources, validate, review, the lookups, compare, undo, save, export_pdf, export_excel, import_excel, earned_value, list_reports, run_report, create_report, close) and `cli/p6clone.ts` commands (validate, export, schedule, progress, level, new, edit, print, export-excel, import-excel, reports, report, query incl. `query trace`, review, diff, compare). `—` = not possible.

## Summary of counts

| Area | done | partial | missing | n/a | P6 items | clone extras |
|---|---|---|---|---|---|---|
| 1. File menu | 5 | 3 | 3 | 2 | 13 | 0 |
| 2. Edit menu | 12 | 7 | 5 | 0 | 24 | 1 |
| 3. View menu | 10 | 14 | 14 | 2 | 40 | 0 |
| 4. Activities window and Activity Details | 44 | 23 | 10 | 1 | 78 | 1 |
| 5. Projects, EPS, Project Details, WBS, baselines, expenses | 40 | 21 | 61 | 1 | 123 | 0 |
| 6. Enterprise dictionaries, resources, codes, calendars, assignments, timesheets, portfolios | 53 | 44 | 38 | 5 | 140 | 0 |
| 7. Tools: scheduling, leveling, progress, Global Change, comparison | 25 | 25 | 16 | 1 | 67 | 6 |
| 8. Admin and User Preferences | 2 | 10 | 25 | 5 | 42 | 1 |
| 9. Reports | 11 | 8 | 4 | 0 | 23 | 1 |
| 10. Import and export formats | 54 | 34 | 15 | 0 | 103 | 2 |
| 11. Printing and other exchange | 7 | 10 | 9 | 0 | 26 | 0 |
| 12. CLI / MCP surface | 2 | 5 | 4 | 0 | 11 | 0 |
| **Total** | **265** | **204** | **204** | **17** | **690** | **12** |

Reading the numbers: the core a scheduler touches every day (import, CPM scheduling, the Activities table and Gantt, relationships, calendars, progress, baselines, printing, reports, XER round trip) is mostly **done**. The **missing** count is dominated by whole P6 windows and dictionaries that were never built (Issues, Thresholds, Work Products and Documents, Tracking, Expenses window, budget log / spending plan / funding, Activity Network, financial periods, Admin Preferences, Admin Categories) and by Project Details / WBS Details fields that the XER carries but the UI never shows.

## Status of the items the earlier loops left open

| Open item (from gap-hunt / improvement-loop notes) | Status now | Evidence |
|---|---|---|
| XER export drops unknown fields | **Fixed** for fields real P6 writes (2105890); fields outside P6's schema (e.g. agent typos like `taskpred_id`) are still dropped, as P6 would. **New finding:** modern layouts (8.x–24.12) are still inferred: a real 24.12 file loses PROJECT fintmpl_id, last_schedule_date, baselines_to_export…, ROLERATE start_date/max_qty_per_hr, TASK crt_path_num, TASKPRED comments; a real 15.1 file loses 15 PROJECT and 6 TASK fields and gains 5.0-era fields; PROJWBS/TASK field order and table order differ | [XER table coverage](#xer-table-coverage-import-keep-export), [Export wizard](#export-wizard) |
| XER export drops OBS/shift tables and resource UDF values | **Fixed** (2105890): POBS whole, SHIFT/SHIFTPER follow resources, resource/role UDF values follow their rows | XER table coverage |
| Scheduler ignores SS lag from Early/Actual Start | **Fixed** (9a0f9b9), re-verified with a case that tells the modes apart | [Scheduling options](#scheduling-options-f9-and-options) |
| MCP update_progress has no rollback | **Fixed** (3700bdd). Still: a missing/empty `data_date` is not rejected (server.ts:209) | [CLI / MCP surface](#cli--mcp-surface) |
| No compare / trace tool | **Fixed** (3700bdd): MCP `compare`, `trace_logic` lookup for AI, MCP and CLI `query trace`. Still no in-app Claim Digger | [Global Change, Claim Digger, Schedule Check](#global-change-claim-digger-schedule-check) |
| P6 XML lacks baselines, steps, project/resource codes; fixed namespace | **Fixed** (327446b), re-verified by round trip. Still lossy: notes, RoleRate/ResourceRole, UoM, curves, issues, thresholds, financial periods, ~35 PROJECT / ~20 TASK / ~16 TASKRSRC fields, leveling options; element order is not the XSD's; RateType written raw | [P6 XML](#p6-xml) |
| Activity Details tabs Steps, Feedback, WPs & Docs, Risks missing | **Fixed** (1593d17). Steps drive physical % when the project says so; WPs & Docs has no window behind it (documents are created from the tab) | [Activity Details tabs](#activity-details-tabs) |
| Global Change and Project/Resource Codes menus missing | **Fixed, partly** (ed16126). Global Change: If/Then on activity columns, report, commit as one undo; no Else, no field expressions, activities only. Code dictionaries: flat values (no child values), no grouping/filtering by these codes | [Tools menu](#tools-menu), [Enterprise menu](#enterprise-menu-and-dictionaries) |
| Right-click menus thin; Cut/Paste renumbers | **Mostly fixed** (ed16126): Cut + Paste moves activities keeping IDs and links; both menus gained Cut/Copy/Paste, Link, Dissolve, Fill Down (table also Renumber, Assign Activity Codes). Still: no Filters / Group and Sort / Find / Collapse To / Table Font in the menus; Copy has no Copy Activity Options and never reaches the Windows clipboard | [Right-click and keyboard](#activities-window-right-click-menus-and-keyboard), [Edit menu](#edit-menu) |
| Ctrl+Numpad zooms instead of expand/collapse | **Still open** (App.tsx:213-217) | Right-click and keyboard |
| Project Details UDF and Calculations tabs missing | **Tabs added** (ed16126). Only "% complete based on steps" changes behaviour; the other Calculations settings are stored and exported but no engine code reads them. Still missing: Resources, Budget Log, Spending Plan, Budget Summary, Funding tabs and most Settings/Defaults fields | [Project Details tabs](#project-details-tabs) |

## Top 25 gaps by value to this user

Ranked for the two uses: **(V)** validating XER output from the platform's scheduling agent, **(T)** an educational AI-assisted P6 trainer. Rows that serve both rank highest.

| # | Gap | Use | Why it matters | Where |
|---|---|---|---|---|
| 1 | **Modern XER layouts are inferred, not observed.** Exports for 8.x–24.12 reuse the 6.2 layout plus kept source fields: real 15.1/24.12 fields drop or 5.0-era fields appear, and field/table order differs. Real 15.1, 19.12, 20.12 and 24.12 exports already sit in `downloaded XERs/` but `schema-observed.json` ignores them | V | The clone's "what P6 writes" is the yardstick for the agent's XER; an inferred layout can pass or fail the agent for the wrong reason | Export wizard; XER table coverage |
| 2 | **Silent scheduling-option gaps.** "Make open-ended activities critical" is saved but never read by `cpm.ts`; "Actual Dates" progress mode behaves as Retained Logic; multiple float paths are never calculated (Float Path columns only echo the XER); "float based on finish of each project / opened projects" has no control; the Total Float option is mislabelled "Calculate float based on" | V T | A file that uses these options gets dates/floats that differ from P6 with no warning; a trainee is shown the wrong effect | Scheduling options |
| 3 | **Fixed:** Update Existing now matches and keeps what the file lacks (per-data-type Update / Keep / Do Not Import / Remove from Project), Add Into Existing Project and Do Not Import for dictionaries added; MCP `import_file`. Was: **Import "Update Existing" acts as Replace** (activities only in the target are deleted) and "Insert New" makes duplicate resource IDs; no "Do Not Import" per data type, no Link Existing | V | Testing "apply the agent's update XER to the current project" gives the wrong result | Import wizard |
| 4 | **XER data the UI cannot show, edit or act on.** Activity UDF values cannot be edited anywhere; code and UDF columns are read-only; WBS and resource UDF values are invisible; UDFs cover 4 of 10 subject areas; PROJECT settings such as WBS separator, fiscal year, summarize level, default cost account, rate type, leveling priority and the Resources tab flags are never shown; the new Calculations tab stores its flags but the engine ignores all except "% complete based on steps" | V T | Imported agent data that cannot be seen cannot be checked, and these are core P6 lessons | Codes and UDFs; Project Details tabs |
| 5 | **No in-app Claim Digger / revision comparison**, and no "convert another project to a baseline". Comparing two agent revisions only works through CLI/MCP `compare`, which skips resources, assignments, codes and UDFs | V T | Revision-to-revision review is the user's main validation loop | Global Change, Claim Digger, Schedule Check; Baselines |
| 6 | **The assistant cannot read the Schedule, Leveling or Import logs or validation findings**, and has no schedule/level/progress tool | T V | It cannot explain out-of-sequence, open-end or constraint warnings, or why P6 would reject a file, which is the heart of the trainer | Tools menu; Import wizard |
| 7 | **The assistant's UI tools have blind spots**: cannot pick table rows in dialogs (layouts, columns, baselines, dictionaries, Projects window), cannot open an existing project, cannot fill notebooks; no ops for codes, UDFs, notebooks, baselines, project status/EPS, expenses, duration/% complete type, suspend/resume, roles, calendar edits | T | Many "show me how" requests fail half-way on screen | AI column throughout |
| 8 | **Schedule Check has no in-app window** and lacks missed tasks, BEI, CPLI and the critical path test (the engine `core/query/review.ts` exists for CLI/MCP) | V T | DCMA-style review is what the user does to agent output; the trainer can't show it | Global Change, Claim Digger, Schedule Check |
| 9 | **Saved layouts and user preferences are shallow**: layouts don't save the top/bottom panes, detail tab or timescale and have no .plf import/export; User Preferences has only hours/day, decimals, 4 date formats and show-time; durations always in days | T V | A trainer teaches layouts and preferences early; a reviewer wants to load the same layout every time | View menu; User Preferences |
| 10 | **Filters and Group & Sort are thin**: one filter at a time, no AND/OR combining or highlight, no nested user-filter groups; one grouping level (WBS or one code), no totals; one sort key | V T | Reviewing a big agent schedule and teaching layouts both lean on these | View menu |
| 11 | **Earned value settings are fixed and PV is approximated**: % complete technique and ETC technique can't be set; PV is a straight-line calendar share of the baseline dates, not P6's spread | V T | EV reports differ from P6 on resource-loaded XERs; EV techniques can't be taught | Admin Preferences; Reports |
| 12 | **Activity Details still hides P6 fields**: Status tab has no Units/Costs panel and no side-by-side Physical/Units %; Resources tab lacks Role, Driving, editable Units/Time, assignment dates, lag, cost account, rate type; General lacks Responsible Manager; Summary is dates only; Expenses tab has name, account, budget and actual only; tabs can't be customised | V T | TASKRSRC and cost fields in agent XERs can't be checked in the UI | Activity Details tabs |
| 13 | **Column catalogue is about 70 fixed fields** (no folders, no Edit Column): missing Units/Cost % complete, Planned Duration, Remaining Float, BL duration/start variance, primary resource, nonlabor/material units and costs, user baselines | V T | Columns are how a reviewer inspects a file | View menu |
| 14 | **P6 XML is still lossy and not schema-ordered**: notes, RoleRate/ResourceRole, UoM, curves, issues, thresholds, financial periods, ~35 PROJECT fields, leveling options; RateType written raw; no ERMHDR so legacy files give a false DATES_NOT_CURRENT | V | If the agent also emits P6 XML, the clone can't vouch for it | P6 XML |
| 15 | **Encoding and selected-project export**: always cp1252 (non-Latin text silently becomes "?"); a selected-project export drops NONWORK and RISKTYPE; CLI/MCP can't export one project or choose the encoding; MCP `validate` checks memory, not the bytes `save` writes | V | Arabic project names (common in the samples) and per-project exports are part of real agent output | Export wizard; CLI / MCP surface |
| 16 | **Baselines are project-baseline only**: no user BL1–3, no Update Baseline, no rename/type; finish variance in calendar days, not working days | V T | Variance numbers differ from P6; BL1-3 is standard training | Baselines |
| 17 | **Activity Network view is missing** (Trace Logic covers a part) | T | Classic P6 view for teaching logic | Activity Network and Trace Logic |
| 18 | **Copy/Paste and keyboard still differ from P6**: no Copy Activity Options (paste never copies codes, notebooks, UDFs, expenses); nothing goes to the Windows clipboard (no copy-to-Excel); Ctrl+Numpad +/- zooms instead of expanding/collapsing; right-click menus lack Filters, Group and Sort, Find, Collapse To | T | The trainer would teach the wrong habit | Edit menu; Right-click and keyboard |
| 19 | **Leveling is thin**: one priority field, no other-project load, no preserve-dates, no minimum float, no cost recalc; late dates and project finish not updated after leveling; residual report assumes 8 h/day | V T | Leveled agent files can't be reproduced; leveling options can't be taught | Leveling options |
| 20 | **Admin Preferences opens User Preferences; durations only in days; currency hard-coded US$**; exchange rates unused; no hours per week/month/year | V T | Non-USD cost validation is misleading; time-unit lessons impossible | Admin and User Preferences |
| 21 | **Resource usage views are thin**: one resource at a time, units only (no costs), no stacking or cumulative, no Activity Usage Profile/Spreadsheet (the View menu item opens the resource profile); P6 default curves not seeded | V T | Main P6 tools for checking resource loading | Resource Assignments window and usage views |
| 22 | **Gantt and printing ignore bar settings**: Bars dialog recolours 9 fixed bars only; no float, LOE, progress-line, sight-line bars; drag-to-link always FS; printed Gantt and timescale ignore Bars/Timescale; Page Setup has no scaling or fit-to-N-pages, single header/footer band, 9 variables | T | Visible presentation lessons; printed output differs from P6 | Gantt chart; Printing and Page Setup |
| 23 | **Projects and WBS windows are fixed views**: no column chooser, filters or group/sort in Projects; WBS can't be moved/indented/reordered, no WBS Details tabs; Projects window Status column shows Open/Active instead of the real status (bug) and `list_projects` returns a blank status (bug) | V T | Restructuring and comparing several imported agent projects | Projects window and EPS; WBS window |
| 24 | **Expenses are thin**: no Expenses window; no category, units/price, accrual type, auto-compute, vendor; remaining forced to budget − actual; not in the Excel export | V | Expense rows in agent XERs can't be inspected | Expenses |
| 25 | **Whole P6 windows missing**: Issues, Thresholds (and Monitor Thresholds), Work Products & Documents window (only the activity tab exists), Tracking, Budget Log / Spending Plan / Funding, financial periods and Store Period Performance | T | Data round-trips in XER, but nothing to teach or inspect | Issues, Thresholds…; Enterprise menu |

Just outside the top 25: Global Change limits (activities only, no Else or field expressions), flat project/resource code values with no grouping by them, the Report Editor / time-distributed reports / batch reports, timesheet two-level approval, MSP export losing codes/notes/UDFs, and Excel import aborting on the first refused row.

## Bugs found in passing

Not features, but wrong behaviour seen while tracing:

| Bug | Where |
|---|---|
| Projects window Status column shows "Open"/"Active" from whether the project is open, not the real project status on the root PROJWBS | `renderer/views/ProjectsView.tsx:45` |
| `list_projects` lookup reads `PROJECT.status_code`, which XER PROJECT rows don't have, so status is blank | `core/query/tools.ts:73` |
| Assignment Units/Time is shown ×8 whatever the hours-per-day preference | `ActivityDetails.tsx:242`, `CommonDialogs.tsx:135` |
| Resource overtime factor is editable but never used (overtime priced at the regular rate); role prices (ROLERATE) never used for costing | `core/resource/assign.ts:8,26` |
| New calendar month hours differ: dialog uses week × 52/12, the `add_calendar` op week × 4.3 | `EnterpriseDialogs.tsx:230`, `core/project/ops.ts:151` |
| EPS reparent has no cycle check | `ProjectDialogs.tsx:270` |
| View > Show on Top > Activity Usage Profile opens the bottom Resource Usage Profile | `App.tsx:147` |
| Admin > Admin Preferences opens the User Preferences dialog; Admin > Timesheet Dates opens the Timesheets window | `App.tsx:140`, `main/menu.ts:138` |
| Leveling's residual-overallocation report assumes 8 h/day | `core/level/level.ts:166` |
| Schedule Options labels the Total Float formula "Calculate float based on" (P6's name for a different option) | `ScheduleDialogs.tsx:91` |
| "Level resources during scheduling" ignores the Level dialog's settings and is not saved | `ScheduleDialogs.tsx:21,29-33` |
| MCP `update_progress` passes `null` when `data_date` is empty; MCP `create_report` lives only in the session | `mcp/server.ts:209,70` |
| P6 XML writes assignment RateType as the raw XER code ("COST_PER_QTY") instead of P6's label | `core/xml/p6xml.ts:114` |
| Activity cost columns, Resources, Assignments and Portfolios format money as US$ whatever the base currency | `model.ts:101`, `ResourcesView.tsx:31`, `AssignmentsView.tsx:34`, `PortfoliosView.tsx:16` |
| Print Preview and Save as PDF leave a `%TEMP%\p6clone-print-*` folder behind each time, even when the save is cancelled (seen live) | `renderer/print.ts` / `main/main.ts` print path |
| The first undo step after an import is the import itself: Edit > Undo empties the Activities window while the project stays "open" (Redo restores it). Not wrong, but surprising for a trainee | `renderer/store.ts` journal |

# The matrix

## 1. File menu

### File menu (project items)

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| File > New (Create a New Project wizard) | Multi-page wizard: EPS, ID/name, planned start + must finish, resp. manager, rate type | partial | One page, ProjectDialogs.tsx:15-40, with EPS, ID, Name and Planned Start only. Missing: Must Finish By, Responsible Manager, Assignment Rate Type. Creates the root WBS and SCHEDOPTIONS (edit.ts:121-139), then opens the project. | op add_project (id, start, name, must_finish_by, calendar); opens it on screen | new_project; CLI `new`; edit add_project |
| File > Open (Open Project dialog) | Dialog: EPS tree, tick several projects, access mode | partial | file.open only switches to the Projects window (App.tsx:54). Double-click opens one project (ProjectsView.tsx:76). No dialog and no multi-select. | — (no open tool; rows can't be clicked). Lookups can read any project via `project` arg | open_file (whole file) |
| Open several projects together | Open selected projects together | partial | Right-click "Open Together With Open Projects" adds one project at a time (ProjectsView.tsx:84) | — | open_file holds all projects in file; ops take `project` |
| File > Close All | Close every open project | done | Clears openProjects (App.tsx:55) | ui_menu | close |
| File > Commit Changes (F10) | Commit edits to database | done | saveNow (App.tsx:64). Ctrl+S does the same, and every edit also autosaves 800 ms later (store.ts:125-129) | ui_menu (not needed) | save (XER/XML) ; CLI --out |
| File > Refresh Data (F5) | Reload data changed by other users | n/a | Single-user local database | — | — |
| File > Check In / Check Out | Check project out to a file and back in | n/a | Enterprise/remote-user feature | — | — |
| File > Send Project | Email the project as an XER attachment | missing | Not in menu. Export wizard writes an XER file instead | — | save |
| Recent projects list (File menu MRU) | Recently opened projects under File | missing | No MRU list. The app does reopen the last open projects at startup (store.ts:141-143) | — | — |
| File > Import: target EPS / new vs replace | Import wizard puts project under an EPS or replaces an existing one | done | Wizards.tsx:66,201: action new/replace with EPS select. Imported projects keep their EPS in `_eps_id`, which is not written to XER | UI only | open_file; CLI file args |
| File > Exit | Close application | done | role quit. Saves on beforeunload (App.tsx:225) | — | close |
| Help > Contents / F1 help | Help topics, context help per window/dialog | missing | Help menu has only About (menu.ts:143). The AI assistant's how-to answers are the substitute | assistant answers how-to questions with real menu paths | — |
| Help > About | Version information | done | help.about | ui_menu | CLI --help |

## 2. Edit menu

### Edit menu

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Undo (Ctrl+Z) | Multi-level undo of edits | done | 30-step journal (store.ts:91-116), covers schedule/level too | `undo` tool | undo |
| Redo (Ctrl+Y) | Not in P6 | extra | Clone extra (store.ts:117) | UI only | — |
| Cut (Ctrl+X) | Cut+Paste moves activities, keeping ID, links, assignments | done | Fixed in ed16126: Cut marks the copy; Paste on a WBS or activity moves the activities (another project too), keeping Activity IDs (renumbered only on a clash in the target project), links, assignments and child rows (commands.ts:26-51) | UI only | — |
| Copy (Ctrl+C) | Copies activities; rows also go to Windows clipboard | partial | Internal module clipboard: tasks, links inside the set, assignments (commands.ts:10-22). Nothing goes to the system clipboard | UI only (one activity via select_activity) | — (copy_project = whole project) |
| Paste (Ctrl+V) | Paste with Copy Activity Options; IDs kept or renumbered | partial | After Cut it moves (done). After Copy it always copies internal links and assignments, never codes, notebooks, UDFs or expenses; new IDs from nextTaskCode; actuals cleared; no Copy Activity Options | UI only | — |
| Copy Activity Options dialog | Choose codes/notebooks/rsrc+roles/expenses/relationships/steps/UDFs/WPs | missing | No dialog; the content copied is fixed | — | — |
| Copy/paste cells to and from Excel | Ctrl+C rows → tab text; paste cells into the grid | missing | No navigator.clipboard use in grid; Excel route is File > Export/Import Excel | — | export_excel/import_excel; CLI: export-excel/import-excel |
| Add (Ins) | New activity in selected WBS, next ID | done | Adds to WBS of selected row or band; works in WBS/Projects windows too (commands.ts:81-98). No New Activity Wizard | op add_activity | edit; CLI: edit |
| Delete (Del) | Delete activities (confirm); WBS band too | done | Confirm prompt; a selected band deletes the WBS and its children (commands.ts:99-144) | op delete_activity, delete_wbs | edit; CLI: edit |
| Dissolve | Delete activity, link its preds to succs | done | Multi-select, bridges chains inside the set (commands.ts:68-77) | op dissolve_activity | edit; CLI: edit |
| Renumber Activity IDs | Dialog: prefix, suffix, start, increment, preview; layout order | partial | Confirm only, no dialog. Uses the project's task_code_prefix/base/step. Orders by start date, not by the layout's sort (commands.ts:183-198) | op update_activity new_id (one by one) | edit (update_activity new_id) |
| Link Activities | FS links between selected activities | done | Selection order; skips invalid links and reports how many (commands.ts:50-62) | op add_relationship | edit; CLI: edit |
| Fill Down (Ctrl+E) | Copy top selected cell value down selection | done | Uses the current cell column; read-only columns refused (ActivitiesView.tsx:252-274) | op update_activity per activity | edit |
| Select All (Ctrl+A) | Select all rows shown | done | Rows passing the filter and search box, including collapsed bands (commands.ts:173-178) | UI only | — |
| Find (Ctrl+F) | Find text in a column; Find Next | done | Look in all visible columns or one column; match case; Find All selects every match and expands bands (FindDialog.tsx) | lookup find_activities + select_activity | find_activities; CLI: query find |
| Find Next (F3) | Next match | done | Wraps around with a toast | UI only | — |
| Assign > Predecessors | Assign dialog, multi-select, any project | done | Adds FS, lag 0; edit the type and lag afterwards in the Relationships tab (CommonDialogs.tsx:85-113) | op add_relationship (type, lag) | edit; CLI: edit |
| Assign > Successors | Same as predecessors | done | Same dialog, which='succ' | op add_relationship | edit; CLI: edit |
| Assign > Resources | Pick resources for selected activities | partial | One resource per Assign press. No units entry. Duplicates skipped. No role or "assign by role" (CommonDialogs.tsx:115-141) | op assign_resource (units, units_per_day) | edit; CLI: edit |
| Assign > Roles | Assign roles to activities | missing | Not in menu (menu.ts:50) | — | — |
| Assign > Resources by Role | Staff resource from role | missing | — | — | — |
| Assign > Activity Codes | Assign Activity Codes dialog (multi-activity) | partial | Only sets detailTab='codes' (App.tsx:76). Nothing visible when the bottom pane is not Details. One activity at a time | read: lookup get_activity; write UI only | — (no code op; get_activity reads) |
| Assign > Risks / WPs & Docs | Link risks, work products | partial | Not in the Assign menu, but the Risks and WPs & Docs tabs (1593d17) assign them per activity | UI only | — |
| Spell Check (F7) | Spell-check activity names/notebooks | missing | — | — | — |
| User Preferences | Tabs: Time Units, Dates, Currency, Calculations, Startup… | partial | Only hours/day, duration decimals, date format, show time (CommonDialogs.tsx:143-162). No currency, no assignment-recalc options | UI only | --hours-per-day option |

## 3. View menu

### View menu

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Layout > Open | Open saved/standard layouts | done | 4 built-in layouts plus user layouts in _LAYOUT table (EnterpriseDialogs.tsx:1238-1358) | UI only (rows not ui_click-able) | — |
| Layout > Save / Save As | Saves the whole layout incl. panes | partial | Saves columns, widths, filter, group, sort, zoom, relationship lines and bars. **Not** saved: top/bottom pane, detail tab, timescale format (1234, 1245) | UI only | — |
| Layout Import / Export (.plf) | Exchange layouts as .plf files | missing | — | — | — |
| Layout scope (User/Project/All Users) | Layout availability | n/a | Single user. No project-specific layouts | — | — |
| Show on Top > Activity Table | Toggle table | done | hideTable toggle (App.tsx:145) | UI only | — |
| Show on Top > Gantt Chart | Toggle Gantt | done | hideGantt toggle (App.tsx:146) | UI only | — |
| Show on Top > Activity Network | PERT network on top | missing | Not in menu | — | — |
| Show on Top > Activity Usage Profile | Time-phased units/costs of activities | missing | The menu item exists but opens the bottom Resource Usage Profile (App.tsx:147). No activity-level profile | — | — |
| Show on Top > Activity Usage Spreadsheet | Time-phased activity spreadsheet | missing | Not in menu | — | — |
| Show on Bottom > Activity Details | Details tabs | done | — | UI only | — |
| Show on Bottom > Trace Logic | Logic diagram of selected activity | done | See Activity Network table | lookup trace_logic | trace_logic; CLI: query trace |
| Show on Bottom > Resource Usage Profile | Histogram of selected resource(s) | partial | One resource from the selected activity's assignments; day/week/month buckets; no multi-resource stacking or display options (AssignmentsView.tsx:416-456) | lookup resource_summary | resource_summary; CLI: query resources |
| Show on Bottom > Resource Usage Spreadsheet | Time-phased units/costs grid | partial | Same scope as the profile | lookup resource_summary | resource_summary |
| Show on Bottom > Activity Table / Gantt / Network | Second table/Gantt/network below | missing | — | — | — |
| Show on Bottom > Activity Usage Profile/Spreadsheet | Activity time-phased view | missing | — | — | — |
| Show on Bottom > No Bottom Layout | Hide bottom | done | — | UI only | — |
| Columns dialog | Folders, Edit Column (title, width, alignment) | partial | Flat list; codes and UDFs are prefixed instead of foldered; add/remove/up/down/default only. No Edit Column (CommonDialogs.tsx:10-40) | UI open only (list rows not clickable) | print/export_pdf `columns`; CLI: print --columns |
| Column catalogue | Hundreds of fields in folders | partial | About 70 fixed columns plus codes and UDFs (model.ts:121-224). Missing, among others: Units/Cost % complete, BL duration/start variance, Remaining Float, Planned Duration, Primary Resource, Responsible Manager, Notebook, nonlabor/material units and costs, secondary baselines | lookup get_activity (most fields) | get_activity; CLI: query activity |
| Bars dialog | Add/edit bars: timescale, filter, shape, colour, labels | partial | 9 fixed bars, colour only, plus thickness and one label choice (BarsDialog.tsx). Cannot add bars or set per-bar filter, shape/ends, label position. No float, negative-float, near-critical, LOE or %-complete bar | UI only | — |
| Bar Chart Options | General, Collapsing, Rel. lines, Sight lines, Progress line tabs | partial | Checkboxes only: relationship lines, baseline, summary, data date, shading, grid lines. No Collapsing, Sight Lines, Progress Line or non-driving line options | UI only | export_pdf links option |
| Filters: built-in list | Large default filter set | partial | 16 built-ins (activityRows.ts:27-44), e.g. critical, longest path, status, negative float, late, constrained, 30-day windows, open ends | lookup find_activities (equivalent filters) | find_activities; CLI: query find; print --filter |
| Filters: user-defined | New/Modify with nested parameter rows | partial | Rows of column/op/value with All or Any; 10 operators. No nested groups, no "within range"/"is between" (EnterpriseDialogs.tsx:1145-1197) | UI only | — |
| Filters: combine and highlight | Several filters with AND/OR; highlight vs show | missing | One filter at a time (radio list); never highlights | — | — |
| Group and Sort: grouping | Multi-level group by any field; totals; band font/colour | partial | WBS, none, or one activity code (activityRows.ts:139-163). No multi-level, resource/date/field grouping, grand totals, band styling or page breaks | ui_type on toolbar "Group" select | export_pdf group_by; CLI: print --group |
| Group and Sort: sort | Multi-key sort | partial | One key: 5 presets or column-header asc/desc | ui_type toolbar "Sort" | export_pdf sort_by; CLI: print --sort |
| Timescale | Start/finish, interval, two/three-line format, fiscal, font | partial | Zoom presets or px/day only; the 2 tiers are picked automatically from zoom (Gantt.tsx:122). No date range, format, font or week start | ui_menu View > Zoom; UI | export_pdf settings |
| Table Font and Row | Font, row height, colours | missing | Fixed 19px rows (Grid.tsx:45) | — | — |
| Attachments > Curtain | Shaded date band on Gantt | missing | — | — | — |
| Attachments > Text | Text box on Gantt | missing | — | — | — |
| Progress Line | Line through progress points vs data date | missing | — | — | — |
| Relationship Lines toggle | Show/hide links | done | View menu, toolbar, right-click, Bars dialog | ui_menu | export_pdf links; CLI: print --links |
| Progress Spotlight | Highlight next update period; drag to extend | partial | Fixed 7 days (30 when zoomed out) after the data date; cannot drag (ActivitiesView.tsx:221) | ui_menu | — |
| Zoom In / Out | Timescale zoom | done | Also Ctrl+wheel and right-click Zoom to Fit | ui_menu | — |
| Expand All / Collapse All | Bands open/close | done | App.tsx:97-98 | ui_menu | — |
| Collapse To (level) | Collapse bands to level N | missing | — | — | — |
| Show Sight Lines | Vertical timescale lines | missing | Only the horizontal grid-lines option | — | — |
| Toolbars | Show/hide/customize toolbars | missing | Fixed toolbar set (App.tsx:151-196) | — | — |
| Status Bar | Status bar | done | Shows data date, baseline, project count; always on | ui_screen | — |
| Hint Help | Pop-up values for bars/cells | partial | Tooltips on Gantt bars only (ActivitiesView.tsx:67); none on table cells; no field choice | — | — |
| Refresh Data (F5) | Re-read DB (multi-user) | n/a | Single-user local DB | — | — |

## 4. Activities window and Activity Details

### Activities window: table

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Edit Activity ID / Name in cell | Inline edit, ID unique check | done | Rejects a duplicate ID in the same project (model.ts:122-128) | op update_activity new_id/name | edit; import_excel |
| Edit Original / Remaining Duration | Inline edit | done | Milestone-zero rule; refreshes own dates (model.ts:129-144) | op update_activity duration_days/remaining_days | edit; import_excel |
| Edit Activity % / Physical % | Inline edit | done | Duration % is read-only, which matches P6 | op update_activity percent_complete | edit; import_excel |
| Edit Start / Finish / Actual Start / Actual Finish | Inline edit | done | setStart/setFinish/setActual (model.ts:150-157) | op update_activity start/finish/actual_* | edit; import_excel |
| Edit Activity Type / Duration Type / % Complete Type | Dropdown in cell | done | Select editors (model.ts:171-173) | type: op; duration/% type: UI only | type via edit/import_excel; others — |
| Edit Primary Constraint + Date | Dropdown/date in cell | done | Defaults the date to the early start or finish (model.ts:175-181) | op update_activity constraint | edit |
| Secondary Constraint columns | Editable | partial | Read-only in the table (model.ts:182-183); editable in the Status tab | op update_activity secondary_constraint | edit |
| Calendar column | Editable (picker) | partial | Read-only (model.ts:174); editable in the General tab | op update_activity calendar | edit; import_excel |
| WBS Code / WBS Name columns | Editable (WBS picker) | partial | Read-only (model.ts:184-185); editable in the General tab | op update_activity wbs | edit; import_excel |
| Activity code columns | Editable (code picker) | partial | Read-only (model.ts:243); editable in the Codes tab | read get_activity; write UI only | — |
| Activity UDF columns | Editable values | partial | Shown read-only (model.ts:252). **No UI anywhere edits activity UDF values**; the only way in is import | read get_activity | — |
| Other editable P6 fields (Expected Finish, Suspend/Resume, Priority, Planned dates, Resources) | Editable in cells | partial | Read-only in the table. Expected Finish, Suspend/Resume and Priority can be edited in Details; Planned dates cannot be edited anywhere | expected_finish, priority via op; suspend: UI only | edit (expected_finish, priority) |
| Type-to-edit, F2, Enter/Tab commit and move | Spreadsheet-style editing | done | Grid.tsx:111-139, 206-229 | — | — |
| WBS banding | Nested coloured bands, collapsible, summaries | done | Colours by level; bands show start, finish, min TF and OD (ActivitiesView.tsx:36-45) | lookup list_wbs | list_wbs; CLI: query wbs |
| Band totals (costs/units) | Group totals per band | partial | Bands total only dates, float and OD; costs and units are blank | lookup earned_value (WBS totals) | earned_value; CLI: query ev |
| Sort by header click | Asc, then desc | done | Dates and numbers sort by value; blanks go last (activityRows.ts:100-125) | ui_type toolbar Sort | — |
| Column resize by drag | Drag header edge | done | Saved with layout (Grid.tsx:74-81) | — | — |
| Column reorder by drag | Drag header to move | missing | Only Up/Down in the Columns dialog | — | — |
| Multi-select and keyboard navigation | Ctrl/Shift click, arrows, PgUp/Dn, Ctrl+Home/End | done | Left/Right collapse or expand a band (Grid.tsx:111-139) | select_activity (single) | — |
| Several open projects | Each project as root band | done | buildActivityRows per projId (activityRows.ts:198-208) | lookup list_projects | list_projects; CLI: query projects |
| Activity bar/status icons in ID column | Icons by type/status | done | ActIcon (ActivitiesView.tsx:276-283) | — | — |
| Quick search box | Not in P6 | extra | Clone extra: filters by ID or name (ActivitiesView.tsx:207) | ui_type "Filter activities" | — |

### Activities window: Gantt chart

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Actual and remaining bars | Blue actual, green remaining | done | Actual bar runs to the data date while in progress (Gantt.tsx:173-183) | — | export_pdf (Gantt) |
| Critical remaining bars | Red | done | isCritical | lookup critical_path | critical_path; CLI: query critical |
| Baseline bars | Project, primary, secondary, tertiary baselines | partial | Project baseline only (ActivitiesView.tsx:58); no user primary/secondary/tertiary bars | lookup get_activity (baseline dates) | get_activity |
| Milestone diamonds | Start/finish milestones | done | Gantt.tsx:166-172 | — | — |
| LOE / WBS Summary activity bars | Distinct LOE style | partial | Drawn as ordinary task bars | — | — |
| WBS summary bands | Summary bar per band | done | Black bar with end triangles (Gantt.tsx:151-157) | — | — |
| Total float / negative float bars | Float bar after early finish | missing | — | lookup schedule_health (float data) | — |
| Relationship lines FS/SS/FF/SF | Routed lines with arrows | done | Gantt.tsx:190-218 | lookup get_activity | — |
| Driving / non-driving / critical links | Solid vs dotted; red critical | done | relationship free float = 0 means driving (ActivitiesView.tsx:80) | lookup trace_logic | trace_logic |
| Data date line | Vertical line | done | Option in Bar Chart Options | — | — |
| Drag to link | Drag between bar ends; type from ends | partial | Always FS, whichever part of the bar the drag starts or ends on (Gantt.tsx:288-303, ActivitiesView.tsx:116-121) | op add_relationship | edit |
| Drag bar to move/resize | Drag changes start/duration | missing | — | op update_activity start/duration | edit |
| Bar labels | Several labels per bar, positions | partial | One label to the right of the bar: name, ID or ID-name | — | — |
| %-complete / steps bar | % complete bar style | missing | — | — | — |
| Timescale header | Configurable tiers | partial | Auto 2 tiers by zoom | — | — |
| Non-work shading | Shade non-work time | done | Uses the first project's calendar (Gantt.tsx:111-118) | — | — |
| Zoom, fit, go to data date / selection | Zoom tools | done | Ctrl+wheel around the pointer; right-click fit/go-to (Gantt.tsx:244-272) | ui_menu zoom | — |
| Table/Gantt synced scroll and selection | Same rows | done | Shared scrollTop and selection | — | — |

### Activities window: Activity Network and Trace Logic

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Activity Network view (PERT boxes) | Whole-project network on top or bottom | missing | No network view in the code (grep for network/PERT finds nothing) | — | — |
| Network layout options (box template, fields) | Edit box content/size | missing | — | — | — |
| Save/Open network positions | Keep box positions | missing | — | — | — |
| Trace Logic | Pred/succ levels, network or Gantt form | done | Boxes with levels 0-10, driving-only filter, click to re-trace (TraceLogic.tsx). Network form only | lookup trace_logic | trace_logic; CLI: query trace |

### Activities window: right-click menus and keyboard

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Table right-click | Cut/Copy/Paste/Add/Delete/Dissolve/Renumber/Link/Fill Down/Assign/Columns/Filters/Group&Sort/Font/Find/Collapse to | partial | Since ed16126: Add, Delete, Cut, Copy, Paste, Dissolve, Renumber, Link, Fill Down, Assign Pred/Succ/Resources/Activity Codes, Add WBS, Columns, Expand/Collapse All (ActivitiesView.tsx). Still missing: Filters, Group and Sort, Table Font and Row, Find, Collapse To, Assign Roles | ui_click on items once the menu is open (no tool opens it) | — |
| Gantt right-click | Bar Chart Options, Bars, Timescale, Attachments, Progress Line, Filters, Group and Sort | partial | Since ed16126 also Cut, Copy, Paste, Link, Dissolve, Fill Down; plus Activity Details, Trace Logic, Assign, Delete, Bars, Bar Chart Options, Timescale, relationship lines, baseline, labels, zoom, fit, go to. Missing: Attachments, Progress Line, Sight Lines, Filters, Group and Sort, Columns | as above | — |
| Activity Details right-click (Customize) | Customize Activity Details tabs | missing | — | — | — |
| F2 | Edit cell | done | Grid.tsx:133 | — | — |
| Ins / Del | Add / delete | done | commands.ts:165-166 | op add/delete_activity | edit |
| Ctrl+Z / Ctrl+Y | Undo (/redo) | done | commands.ts:170-171 | `undo` | undo |
| Ctrl+C / Ctrl+X / Ctrl+V | Clipboard; Cut+Paste moves | partial | Ctrl+X then Ctrl+V moves (ed16126). Copy is an internal clipboard only: nothing reaches the Windows clipboard | UI only | — |
| Ctrl+F / F3 | Find / Find Next | done | — | lookup find_activities | find_activities |
| Ctrl+E | Fill Down | done | App.tsx:221 | op update_activity | edit |
| Ctrl+A | Select All | done | — | UI only | — |
| F9 / Shift+F9 | Schedule / Level dialogs | done | F9 also handled in renderer (App.tsx:211); Shift+F9 by menu accelerator | ui_menu Tools > Schedule | schedule, level_resources; CLI: schedule, level |
| F10 Commit (Ctrl+S) | Commit changes | done | saveNow (App.tsx:64, commands.ts:172) | — | save; CLI: --out |
| F5 Refresh | Refresh data | n/a | Single user | — | — |
| Ctrl+Numpad + / - | Expand All / Collapse All | partial | Zooms the timescale instead. Expand/Collapse is Ctrl+Shift+= and Ctrl+Shift+- on the main keyboard only (App.tsx:213-217). Confirms the open item | ui_menu View > Expand All | — |
| Arrow, PgUp/Dn, Home/End, Enter, Tab | Grid navigation | done | Grid.tsx:111-139 | — | — |

### Activity Details tabs

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Tab set | General, Status, Resources, Preds, Succs, Relationships, Codes, Notebook, Steps, Feedback, WPs&Docs, Expenses, Summary, Risks | done | 14 tabs since 1593d17 (Steps, Feedback, WPs & Docs, Risks added; ActivityDetails.tsx, ActivityExtraTabs.tsx). Customizing the tab set is a separate row | ui_click tab names | — |
| Customize Activity Details | Choose and order tabs | missing | — | — | — |
| General tab | ID, name, project, WBS, Responsible Manager, Primary Resource, type, duration type, % type, calendar | partial | Has all of these except **Responsible Manager (OBS)**. Also has Priority (ActivityDetails.tsx:67-101) | op update_activity (name, id, wbs, type, calendar, priority); duration/% type, primary rsrc: UI only (ui_type) | edit (same subset) |
| Status: Duration | Original, Actual, Remaining, At Completion | done | Actual and At Completion are calculated (126-128) | op update_activity duration_days/remaining_days | edit |
| Status: Started/Finished, Expected Finish | Checkboxes + dates | done | Started defaults to early start; Finished defaults to early finish (133-144) | op update_activity actual_start/actual_finish/expected_finish | edit; update_progress |
| Status: Suspend / Resume | Dates | done | Enabled only while in progress (145-146) | UI only (ui_type "Suspend") | — |
| Status: % Complete | Activity %, Duration %, Physical %, Units % | partial | One Activity % field follows the % type. Duration % is read-only. No side-by-side Physical % and Units % fields (151-153) | op update_activity percent_complete | edit |
| Status: Units and Costs panel | Labor/Nonlabor/Material/Costs: budgeted/actual/remaining/at completion | missing | Panel absent | lookup resource_summary / earned_value | resource_summary, earned_value |
| Status: Constraints | Primary + secondary with dates | done | (159-168) | op update_activity constraint/secondary_constraint | edit |
| Resources tab | Resource, Role, Units, Units/Time, curve, driving, dates, lag, costs, cost account | partial | Editable: budgeted/actual/remaining units and curve. Units/Time is read-only. No Role, Driving flag, assignment dates, lag/duration, cost account, rate type or Assign by Role (217-255) | op assign_resource / unassign_resource; lookup get_activity | edit; resource_summary |
| Predecessors / Successors tabs | Type, lag, driving, rel. float, Assign/Remove/Go To | done | Type and lag editable in place; driving and relationship free float shown (174-215) | op add/update/delete_relationship; lookup get_activity | edit; get_activity |
| Relationships tab | Both lists side by side | done | Same component twice | as above | as above |
| Codes tab | Assign/remove codes; add values | done | One dropdown per code type. Cannot create a new value in the tab (257-290) | read get_activity; write UI only (ui_type) | — |
| Notebook tab | Topics, rich-text (HTML) notes | partial | Add picks the next unused topic (cannot choose it). No delete. Plain text converted to and from HTML (292-325) | read get_activity; write — (textarea not reachable by ui_type) | get_activity (read) |
| Steps tab | Steps with weights drive physical % | done | Fixed in 1593d17: add, delete, reorder, name, weight, % complete, completed, description; weighted % sets physical % when the project uses "% complete based on steps" and the activity is Physical. No step templates or step UDFs | UI only (cells are unlabelled inputs) | — (TASKPROC kept in XER and P6 XML) |
| Feedback tab | Team feedback text | done | Fixed in 1593d17: TASKFDBK text per activity | — (textarea not reachable by ui_type) | — |
| WPs & Docs tab | Work products and documents | partial | Added in 1593d17: create a document or assign an existing project document, title, reference no., work-product flag, file/URL, remove. No WPs & Docs window, no status, category, version or deliverable fields | UI only | — |
| Expenses tab | Item, account, category, units, price, budget/actual/remaining, accrual, vendor | partial | Name, account, budgeted and actual cost only; remaining is calculated (327-364) | — (UI only, fragile) | — |
| Summary tab | Units/costs/dates vs baseline | partial | Date table only (planned, actual, remaining, early, late, baseline); no units or costs (366-387) | lookup get_activity | get_activity |
| Risks tab | Risks linked to activity | done | Added in 1593d17: assign/remove risks from the project register (TASKRISK) | UI only | — |

## 5. Projects, EPS, Project Details, WBS, baselines, expenses

### Projects window and EPS

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| EPS tree with projects | Hierarchical EPS nodes containing projects, collapsible | done | ProjectsView.tsx:51-61. Projects without `_eps_id` go under the first EPS node | lookup list_projects (flat, no EPS) | — |
| Project columns | Customisable columns: dates, budgets, %, EV, float, codes, UDFs | partial | 9 fixed columns (ProjectsView.tsx:10-20). View > Columns does not apply here. No cost, %, EV, float, code or UDF columns | lookup list_projects / project_summary | project_summary |
| Status column | Shows project status (Planned/Active/Inactive/What-If) | partial | BUG: shows "Open" or "Active" depending on whether the project is open (ProjectsView.tsx:45), not the real status on root PROJWBS.status_code | lookup list_projects: BUG, reads PROJECT.status_code (query/tools.ts:73), a field XER PROJECT doesn't have, so it is blank | — |
| Project filters | Filter projects by status, dates, codes, etc. | missing | No filter in Projects window | list_projects `text` only | — |
| Group and Sort projects | Group by EPS/project codes/status, sort | missing | EPS grouping only, fixed order | — | — |
| Add project (Insert) | Starts New Project wizard | done | Insert in Projects window opens newProject (commands.ts:85) | op add_project | new_project |
| Delete project | Delete project after confirmation | done | Deletes the project and its baselines, undoable (ProjectDialogs.tsx:164-183). Del key works | — (no delete op) | — |
| Copy / Paste project (Copy Project Options) | Ctrl+C/V project; options: codes, notebooks, baselines, resources, WBS... | partial | No copy/paste in the window: Ctrl+C/V only handle activities (commands.ts:167-169). core copyProject (copy.ts) has fixed options: copies WBS, logic, assignments, codes, UDFs, notebooks and expenses, never baselines; keep_progress and a new start are optional. No options dialog | op copy_project | edit copy_project; CLI edit |
| Project status (Planned/Active/Inactive/What-If) | Set on General tab | done | Project Details General select writes root PROJWBS.status_code (ProjectDialogs.tsx:71), which is P6-correct | UI only (ui_type "Status") | — |
| Project leveling priority | 1-100 priority used when leveling several projects | missing | PROJECT.priority_num round-trips but is never shown or used | — | — |
| Project Gantt bars in Projects window | Project bars across timescale | missing | Only Portfolios view has a project span chart (PortfoliosView.tsx) | — | — |
| Project Details as bottom pane | Docked tabs under the project list | partial | A modal dialog (right-click > Project Details... or Project > Details...), not docked | ui_menu Project > Details... | — |
| Project UDF columns | Project-level UDF values as columns | missing | Project UDFs not shown | — | — |
| EPS dialog: Add / Delete node | Add child node; delete node | done | ProjectDialogs.tsx:254-262. Delete refuses a non-empty node or the root (P6 offers to delete the contents) | UI only (Add; rows not selectable) | — |
| EPS dialog: rename / move | Edit ID and name; arrows to move/indent | partial | ID and name are edited inline and the Parent select reparents (ProjectDialogs.tsx:268-270). No up/down ordering: seq_num is never edited | — | — |
| EPS responsible manager (OBS) | Assign OBS element to EPS node | missing | Not in EPS rows | — | — |
| EPS Details (notebook, budget, spending, funding) | EPS-level details tabs | missing | — | — | — |
| Move project to another EPS | Drag or change EPS | done | Project Details EPS select (ProjectDialogs.tsx:70). No drag-drop. Right-click "Add EPS Node" always adds under the root (ProjectsView.tsx:93) | UI only | — |

### Project Details tabs

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| General: Project ID / Name | Edit ID and name | done | Renaming the ID also renames the root WBS. The name is stored on the root WBS (ProjectDialogs.tsx:63-69) | op set_project name; ID: UI only | edit set_project name |
| General: Status | Planned/Active/Inactive/What-If | done | ProjectDialogs.tsx:71 | UI only | — |
| General: Responsible Manager | OBS element for the project | missing | root PROJWBS.obs_id not exposed | — | — |
| General: Leveling Priority | Project priority number | missing | priority_num not exposed | — | — |
| General: Project web site URL / check-out status | URL; checked-out flag | n/a | Check-out is n/a. proj_url (low value) is not exposed | — | — |
| Dates: Planned Start | Project planned start | done | ProjectDialogs.tsx:75 | op set_project planned_start | edit set_project |
| Dates: Must Finish By | Project deadline for late dates | done | ProjectDialogs.tsx:76 | op set_project must_finish_by | edit set_project |
| Dates: Data Date | Current data date (editable) | done | ProjectDialogs.tsx:77 | op set_project data_date | schedule data_date; update_progress |
| Dates: Scheduled Finish (read-only) | Finish from last schedule | done | ProjectDialogs.tsx:78 | lookup project_summary scheduled_finish | project_summary |
| Dates: Anticipated Start/Finish | Planning dates before activities exist | missing | PROJWBS anticip_* not exposed | — | — |
| Dates: Actual Start / Actual Finish / Finish | Read-only project actuals and forecast finish | missing | Not shown on the tab. The Projects window shows a computed Start/Finish | lookup project_summary earliest_start/latest_finish | project_summary |
| Notebook tab | Project notebook topics (rich text) | partial | Works only when MEMOTYPE has topics with proj_flag=Y (ProjectDialogs.tsx:108); a fresh database has none and there is no Notebook Topics editor. No topic delete. Plain text only | — | — |
| Budget Log tab | Original budget + budget change log | missing | No UI. WBSBUDG/BUDGCHNG rows round-trip untouched | — | — |
| Spending Plan tab | Monthly spending plan / benefit plan | missing | No UI | — | — |
| Budget Summary tab | Original/current/proposed budget, variance | missing | No UI | — | — |
| Funding tab | Funding sources and amounts | missing | PROJFUND round-trips only | — | — |
| Codes tab | Assign project code values | done | Assigns values; the dictionary is now Enterprise > Project Codes (ed16126) | UI only (ui_type by code row) | — |
| Defaults: Duration / % Complete / Activity Type | Defaults for new activities | done | ProjectDialogs.tsx:81-83, used by addActivity (edit.ts:172) | UI only | — |
| Defaults: Calendar | Default activity calendar | done | ProjectDialogs.tsx:84 | op set_project calendar | edit set_project |
| Defaults: Cost Account | Default cost account for new activities | missing | PROJECT.acct_id not exposed | — | — |
| Defaults: Rate Type | Default assignment rate type (Price/Unit 1-5) | missing | def_rate_type is only set at creation (edit.ts:131) | — | — |
| Defaults: Auto-numbering prefix/suffix/increment | Activity ID numbering | done | Used by nextTaskCode and Edit > Renumber (commands.ts:183-197). Suffix is labelled correctly | UI only | — |
| Defaults: Increment based on selected activity | Number new activity from the selected one | missing | task_code_prefix_flag ignored | — | — |
| Resources: allow same resource multiple times | Permit repeat assignment of a resource | missing | rsrc_multi_assign_flag ignored. Ops always refuse duplicates (ops.ts:247) | — | — |
| Resources: drive activity dates default / team | Default "drive dates" and resource team | missing | — | — | — |
| Settings: critical activity definition | Total float <= x, or longest path | done | Float is typed in hours, not duration units (ProjectDialogs.tsx:90-92). Used by isCritical (ctx.ts:43-48) | UI only; lookup critical_path | critical_path |
| Settings: WBS separator | Character joining WBS codes | missing | name_sep_char ignored. '.' is hard-coded (model.ts:89, ops.ts:92, WbsView.tsx:46) | — | — |
| Settings: fiscal year start | First month of fiscal year | missing | fy_start_month_num ignored | — | — |
| Settings: summarize to WBS level | Max WBS level for summaries | missing | wbs_max_sum_level ignored | — | — |
| Settings: baseline for earned value | Project baseline vs user primary baseline | missing | EV always uses the project baseline (cost/rollup.ts:33) | lookup earned_value | earned_value |
| Calculations: % complete based on steps | Steps drive physical % | done | Fixed in ed16126/1593d17: checkbox in Calculations (and Steps tab); weighted steps set physical % (ActivityExtraTabs.tsx:22-27) | UI only | — |
| Calculations: default price/unit (resourceless) | Price for assignments without rates | partial | Editable in the Calculations tab since ed16126 (def_cost_per_qty, travels with XER/XML), but no engine code reads it, so it changes nothing | UI only | — |
| Calculations: link actual-to-date and this period | Keep ATD and this period in sync | partial | Editable in the Calculations tab since ed16126 (act_this_per_link_flag, travels with XER/XML), but no engine code reads it, so it changes nothing | UI only | — |
| Calculations: reset remaining / subtract actual from at completion | Remaining-vs-at-completion update rules | partial | Editable in the Calculations tab since ed16126 (reset_planned_flag, add_act_remain_flag, travels with XER/XML), but no engine code reads it, so it changes nothing | UI only | — |
| Calculations: link budget and at completion (not started) | Budget = at completion for not-started | partial | Editable in the Calculations tab since ed16126 (rem_target_link_flag, travels with XER/XML), but no engine code reads it, so it changes nothing | UI only | — |
| Calculations: recalc units/costs on change | Units<->cost recalculation options | partial | Editable in the Calculations tab since ed16126 (cost_qty_recalc_flag, travels with XER/XML), but no engine code reads it, so it changes nothing | UI only | — |
| UDFs tab | Project UDF values | done | Added in ed16126 (ProjectUdfs): text, number and date UDFs of subject area Projects; no Indicator/Code types | UI only | — |

### Project menu

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Project > Projects | Open Projects window | done | App.tsx:54 (also under Enterprise) | ui_menu | list_projects |
| Project > WBS | Open WBS window | done | App.tsx:106 | ui_menu; lookup list_wbs | list_wbs |
| Project > Activities | Open Activities window | done | App.tsx:107 | ui_menu | find_activities |
| Project > Resource Assignments | Open Assignments window | done | App.tsx:108 (contents audited elsewhere) | ui_menu | resource_summary |
| Project > Work Products and Documents | Open WPs & Docs window | missing | Not in menu | — | — |
| Project > Expenses | Open Expenses window | partial | Only switches to Activities with the Expenses detail tab (App.tsx:109) | ui_menu | — |
| Project > Thresholds | Open Thresholds window | missing | Not in menu | — | — |
| Project > Issues | Open Issues window | missing | Not in menu | — | — |
| Project > Risks | Open Risks window | done | Opens RiskView (App.tsx:133). Depth audited elsewhere | ui_menu | — |
| Project > Tracking | Open Tracking window | missing | Not in menu | — | — |
| Project > Maintain Baselines | Baseline manager | partial | See section 6 | ui_menu + ui_click Add | — |
| Project > Assign Baselines | Project + user baselines | partial | Project baseline only (see section 6) | ui_menu + ui_type | — |
| Project > Set Default Project | Choose default among open projects | missing | Implicitly openProjects[0] (commands.ts:27,89; live.ts:195) | — | ops `project` field |
| Select Project (Activities toolbar) | Show one of the open projects | missing | All open projects always show together | — | — |
| Project > Details... (clone extra) | (P6: bottom pane of Projects window) | done | Dialog (App.tsx:110) | ui_menu | — |

### WBS window and WBS Details

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| WBS tree | Hierarchy of WBS elements with project node | done | WbsView.tsx:26-64. Collapsible, ordered by seq_num | lookup list_wbs | list_wbs |
| WBS columns | Customisable: code, name, dates, budgets, %, EV, float... | partial | 8 fixed columns (WbsView.tsx:11-20): code, name, activities, start, finish, duration, total float, status. No cost, budget, %, EV or baseline columns. No column chooser | lookup list_wbs (counts, dates) | list_wbs |
| Add WBS element | Insert new element | done | Insert adds a child of the selected element with code WBSn (commands.ts:115-126, edit.ts:246) | op add_wbs | edit add_wbs |
| Delete WBS element | Delete element with children/activities | done | Confirms, then deletes children and activities (commands.ts:130-144) | op delete_wbs (keep_logic default) | edit delete_wbs |
| Rename WBS code/name, set status | Edit in table or details | done | Inline grid editors (WbsView.tsx:66-89) | — (no update_wbs op; grid cells not ui_type-able) | — |
| Move / indent / outdent / up / down | Arrow buttons to restructure WBS | missing | No reparent or reorder. seq_num is never edited | — | — |
| Copy / Paste WBS | Copy element with activities | missing | — | — | — |
| WBS Details: General | Code, name, status, responsible manager, anticipated dates, category | partial | Only code, name and status (inline). No OBS, anticipated dates or WBS category | — | — |
| WBS Details: Notebook | WBS notebook topics | missing | WBSMEMO is edited only on the project root (Project Details) | — | — |
| WBS Details: Budget Log / Spending Plan / Budget Summary / Funding | WBS-level budgeting | missing | WBSBUDG round-trips only | — | — |
| WBS Details: WPs & Docs | Documents assigned to WBS | missing | — | — | — |
| WBS Details: Earned Value settings | Technique, ETC calc per WBS | missing | EV uses one global method (rollup.ts) | lookup earned_value (per top WBS) | earned_value |
| WBS Details: WBS Milestones | Weighted WBS milestones for % complete | missing | WBSSTEP not handled | — | — |
| WBS chart view | Org-chart style WBS boxes | missing | — | — | — |
| Gantt chart in WBS window | WBS summary bars on timescale | missing | Table only. WBS bands do show in the Activities Gantt | — | export_pdf (activities) |
| WBS filters / group | Filter WBS elements | missing | — | — | — |
| WBS responsible manager (OBS) | OBS per WBS for access/reporting | missing | obs_id preserved, not shown | — | — |
| "Activities of this WBS" | (clone context item) | partial | Only switches to Activities; doesn't filter or scroll to the WBS (WbsView.tsx:90) | — | find_activities wbs |

### Baselines

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Maintain Baselines: Add (copy of current project) | Save a copy as a baseline | done | Full copy kept as a hidden project, named "ID - Bn" (baseline.ts:9-25). The first one is auto-assigned as project baseline (ProjectDialogs.tsx:224) | ui_menu + ui_click "Add" | — |
| Add: convert another project to a baseline | Turn an existing project into a baseline of this one | missing | Can't attach an imported XER revision as baseline. Assign lists only `_baseline_of` copies (ProjectDialogs.tsx:194) | — | compare / CLI diff, compare (separate files instead) |
| Baseline name / type | Edit baseline name and baseline type | missing | Name fixed, no BASETYPE | — | — |
| Delete baseline | Remove baseline | done | Confirms, clears assignments (baseline.ts:33-36) | — (rows not selectable by ui_click) | — |
| Restore baseline | Restore baseline as a normal project | done | Clears `_baseline_of` (baseline.ts:39-42) | — (row select) | — |
| Update Baseline (with options) | Update baseline from current project, chosen data types | missing | — | — | — |
| Assign: project baseline | Choose project baseline | done | AssignBaselinesDialog (ProjectDialogs.tsx:186-211); sets sum_base_proj_id | ui_menu + ui_type "Project Baseline" | — |
| Assign: primary/secondary/tertiary user baselines | Per-user BL1/BL2/BL3 | missing | Comment at ProjectDialogs.tsx:185 says so | — | — |
| BL Project Start / Finish columns | Baseline start/finish per activity | done | model.ts:160-161. Matched by Activity ID (ctx.ts:23-27) | lookup get_activity baseline_start/finish | get_activity |
| Variance - BL Project Finish Date | Baseline finish minus current finish, working days | partial | Computed in calendar time, not on the activity calendar (model.ts:162-167). No start or duration variance columns | lookup get_activity (dates only) | get_activity |
| BL duration / BL cost / BL1-3 columns | Baseline duration, budgeted cost, user-baseline fields | missing | — | — | — |
| Baseline bars in Gantt | Project and user baseline bars | partial | Project baseline bar only (Gantt.tsx:159-163; print layout.ts:210-219). Toggle in Bars dialog | — | export_pdf (showBaseline) |
| Baseline comparison layout / reports | Layouts/reports comparing to baseline | done | "Baseline Comparison Layout" (EnterpriseDialogs.tsx:1241), std-late and std-milestones reports (reports/engine.ts:232,239) | open_report / run_report_dialog | run_report |
| Earned value against baseline | BAC/PV from project baseline | done | rollup.ts:33-42 | lookup earned_value | earned_value |
| Baselines in XER round-trip | Baselines not exported; sum_base_proj_id dangles | done | Export skips baseline PROJECT rows (write.ts:78), as P6 does. An imported sum_base_proj_id has no effect | — | save |

### Expenses

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Expenses window | Project-wide expense table with details, group/sort | missing | Only the per-activity tab (App.tsx:109 -> ActivityDetails.tsx:327) | — | — |
| Add / delete expense on activity | Add/delete expense items | done | ActivityDetails.tsx:338-355 | UI only (ui_click "Add" on tab) | — |
| Expense item, cost account | Name and cost account | done | ActivityDetails.tsx:350-351 | UI only | — |
| Budgeted / actual / remaining / at completion cost | Cost fields, remaining editable | partial | Remaining is forced to budget minus actual and is not editable (ActivityDetails.tsx:333). No At Completion | — | — |
| Expense category | Admin expense category | missing | cost_type_id ignored; no COSTTYPE editor | — | — |
| Budgeted units, price/unit, unit of measure | Units x price = cost | missing | target_qty, cost_per_qty and qty_name are not in the UI | — | — |
| Accrual type | Start / End / Uniform | missing | cost_load_type is always CL_Uniform on add | — | — |
| Auto compute actuals | Actuals from % complete | missing | auto_compute_act_flag always N | — | — |
| Vendor, document number, description | Expense details | missing | vendor_name, po_number and cost_descr are stored but not shown | — | — |
| Expense % complete / actual this period | Progress of expense | missing | — | — | — |
| Expense costs in activity totals and EV | Included in total cost / EV | done | model.ts:191-193; rollup.ts:28 | lookup earned_value | earned_value |
| Expense columns (Budgeted Expense Cost etc.) | Separate expense cost columns | missing | Only merged into total cost columns | — | — |
| Expenses in Excel export | P6 spreadsheet export has an expenses subject | missing | Workbook sheets are TASK, TASKPRED, RSRC, TASKRSRC only | — | export_excel (no expenses) |

### Issues, Thresholds, Work Products & Documents, Tracking

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Issues window | List and edit project issues | missing | PROJISSU round-trips as raw rows only (db.ts:23, write.ts:56-61) | — | — |
| Issue details | Priority, status, responsible manager, tracking layout, history, notify | missing | — | — | — |
| Thresholds window | Threshold parameter, lower/upper, WBS, dates | missing | PROJTHRS/THRSPARM round-trip only | — | — |
| Monitor Thresholds | Tools > Monitor Thresholds creates issues | missing | Nearest: review / schedule_health DCMA checks, which are not P6 thresholds | lookup schedule_health | review, schedule_health; CLI review |
| Work Products & Documents window | Document library with status, deliverable flag, locations | missing | DOCUMENT/TASKDOC only listed as known tables (xer/schema.ts:63) | — | — |
| Assign WPs & Docs to activities/WBS | Activity and WBS WPs & Docs tabs | partial | Activities: WPs & Docs tab since 1593d17. WBS: none | UI only | — |
| Tracking window | Project tables, Gantt and histogram tracking layouts | missing | Portfolios dashboard (PortfoliosView.tsx) partly fills the role: per-project costs, EV, span chart | — | — |

## 6. Enterprise dictionaries, resources, codes, calendars, assignments, timesheets, portfolios

### Enterprise menu and dictionaries

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Enterprise > Projects | Opens Projects window (EPS tree) | done | menu.ts:102 -> App.tsx:54 | ui_menu; lookup list_projects | list_projects; CLI query summary |
| Enterprise > Enterprise Project Structure | EPS hierarchy: add/delete/move nodes, responsible manager | partial | ProjectDialogs.tsx:242: add, delete (blocked if not empty), rename, reparent. No OBS responsible manager. Reparent select has no cycle check (:270). No indent/outdent arrows | UI* | — |
| Enterprise > Tracking | Tracking window: portfolio bar charts, Gantt, histograms, spreadsheets | missing | Not in menu.ts. Portfolios dashboard (PortfoliosView) covers some of it | — | — |
| Enterprise > Project Portfolios | Portfolio definitions dialog | partial | Opens a Portfolios window, not a dialog (App.tsx:134). See section 9 | UI* | — |
| Enterprise > Resources | Resources window | partial | App.tsx:114. See section 2 | see s.2 | see s.2 |
| Enterprise > Roles | Roles dictionary | partial | App.tsx:115 -> RolesDialog. See section 3 | UI* | — |
| Enterprise > Resource Codes | Resource code types and values dictionary | partial | Added in ed16126 (CodeDictionaryDialog): add/rename/delete types, max length, add/edit/delete values with usage count. Values are flat (no child values); no secure codes | UI* (rows not clickable) | — |
| Enterprise > Project Codes | Project code types and values dictionary | partial | Added in ed16126, same dialog as resource codes: flat values only | UI* | — |
| Enterprise > Activity Codes | Activity code types and values dictionary | partial | App.tsx:117 -> CodesDialog. See section 4 | UI* | — |
| Enterprise > User Defined Fields | UDF definitions per subject area | partial | App.tsx:118 -> UdfDialog. See section 4 | UI* | — |
| Enterprise > OBS | OBS hierarchy dictionary | partial | App.tsx:116 -> ObsDialog. See section 3 | UI* | — |
| Enterprise > Resource Shifts | Shift definitions limiting max units by time of day | missing | SHIFT/SHIFTPER only round-trip (write.ts:23,28) | — | — |
| Enterprise > Resource Curves | 21-point curve dictionary with default curves | missing | No dialog. RSRCCURVDATA present only if imported. See section 6 | — | — |
| Enterprise > Calendars | Global/project/resource calendars | partial | App.tsx:119 -> CalendarsDialog. See section 5 | UI*; ops add_calendar, add_holidays | edit (add_calendar, add_holidays); CLI edit |
| Enterprise > Cost Accounts | Cost account hierarchy | done | App.tsx:120 -> AccountsDialog. See section 6 | UI* | — |
| Enterprise > Activity Step Templates | Reusable activity step lists | missing | Steps exist per activity (Steps tab, 1593d17) but there are no templates | — | — |
| Enterprise > Funding Sources | Funding source hierarchy | missing | FUNDSRC only listed as a schema table (schema.ts:63) | — | — |
| Admin > Financial Periods | Period dictionary for Store Period Performance | missing | FINDATES only round-trip | — | — |
| Admin > Timesheet Dates | Batch-create timesheet periods | partial | menu.ts:138 routes to the Timesheets window (tools.timesheets); periods dialog is one more click (TimesheetsView.tsx:177) | UI* | — |

### Resources window and Resource Details

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Resource hierarchy tree | Parent/child resources, expand/collapse | done | ResourcesView.tsx:138-177; Add Child, context menu, cycles broken | UI* | Excel RSRC sheet (export_excel) |
| Add resource | Add with defaults | done | addResource :82 (default calendar, RSRCRATE row) | op add_resource (id, name, type, calendar, parent, units/day, max, price) | edit add_resource; CLI edit |
| Delete resource | Delete; warns about assignments | done | Blocked if assigned (:113); cascades children, rates, roles, codes | UI* (no op) | — |
| Resource table columns | Customise with View > Columns | partial | Fixed 9 columns (COLS :12). View > Columns only edits activity columns (CommonDialogs.tsx:15) | UI* | — |
| Resource filters / group and sort | Display filters (e.g. active), group by type or code | missing | No filter, group or sort in the Resources window | — | — |
| General: Resource ID / Name | Editable, unique ID | done | Unique ID check in commitCell :252 | op add_resource (create only) | edit add_resource |
| General: Resource Type | Labor / Nonlabor / Material | done | Also updates TASKRSRC.rsrc_type (:273) | op add_resource type | edit |
| General: Unit of Measure | For material resources | partial | Only from imported UMEASURE rows (:325) | UI* | — |
| General: E-mail, Title, Employee ID | Text fields | done | :322-324 | UI* (labelled fields) | — |
| General: Active | Active flag | done | Inactive rows greyed | UI* | — |
| General: Primary Role | Primary role from the Roles tab | missing | RSRC.role_id not shown | — | — |
| Codes tab | Assign resource code values | done | Added in ed16126 (ResourceCodesTab) | UI* | — |
| Notes tab | Resource notes | missing | rsrc_notes not shown | — | — |
| Details: Calendar | Shared or personal calendar | partial | Select shared or resource calendars (:319). Cannot create a personal calendar here | UI*; op add_resource calendar | edit |
| Details: Shift | Resource shift | missing | — | — | — |
| Details: Currency | Resource currency | missing | curr_id set on add, never editable | — | — |
| Details: Default Units/Time | Default units/time for new assignments | done | Shown per day using prefs.hoursPerDay (:186) | op add_resource units_per_day | edit |
| Details: Overtime allowed / factor | OT flag plus factor used in actual OT cost | partial | OT factor editable (:330) but never used: OT cost priced at the regular rate (assign.ts:26). No ot_flag | UI* | — |
| Details: Auto compute actuals | Autocompute actuals flag | missing | — | — | — |
| Details: Calculate costs from units | Default cost-units link | missing | Assignments always link cost to units on creation (assign.ts:68) | — | — |
| Details: Level during resource leveling | Leveling flag | done | :334; honoured in level.ts:42 | UI* | level_resources; CLI level |
| Units & Prices: effective-dated rows | Add/remove effective dates | done | :341-405; recosts linked assignments | UI*; op add_resource sets first row | edit add_resource |
| Units & Prices: Max Units/Time | Per effective date | done | Drives usage capacity (usage.ts:124) and leveling | op add_resource max_units_per_day | edit |
| Units & Prices: Price/Unit 1-5 | Five rate types per effective date | partial | Only Price/Unit (cost_per_qty) editable. priceOf reads cost_per_qty2..5 if an imported rate_type points to them (assign.ts:15) | op add_resource price_per_unit | edit |
| Roles tab | Roles with proficiency 1-5 | done | :407-470 (RSRCROLE.skill_level) | UI* | — |
| Assignments tab (resource side) | Resource's assignments across projects | done | Read-only list with totals (:472) | lookup resource_summary | resource_summary; CLI query resources |
| Resource UDF values | Edit resource UDF values | missing | Resource UDFs can be defined (EnterpriseDialogs.tsx:639) but their values are never shown or edited. Preserved on XER/XML import | — | — |
| Timesheets tab (login, approver) | Timesheet user, approval manager | n/a | Server/user feature | — | — |
| Currency formatting of prices | Uses base/view currency | partial | Hard-coded USD formatter (ResourcesView.tsx:31) ignores CURRTYPE | — | — |

### Roles and OBS

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Role hierarchy | Add root/child, delete, reorder | done | RolesDialog EnterpriseDialogs.tsx:853; delete blocked if assigned. No reorder | UI* | — |
| Role ID / Name | Editable, unique ID | done | :907-912 | UI* | — |
| Role description / responsibilities | Rich-text description | missing | — | — | — |
| Role Prices (Price/Unit 1-5) | Five prices per role (effective-dated in 8.x+) | partial | One Price/Unit in ROLERATE.cost_per_qty (:886) | UI* | — |
| Role limits | Effective-dated max units per role | missing | ROLELIMIT is only deleted along with its role (:882) | — | — |
| Role > Resources tab | Assign resources to a role with proficiency | partial | Count only (:914). Assignment is made from the resource side | UI* | — |
| Role-based assignment cost | Role price used when no resource is set | missing | priceOf ignores ROLERATE (assign.ts:8) | — | — |
| OBS hierarchy | Add/delete OBS elements | done | ObsDialog :726; Add Child / Add Sibling; delete blocked if a WBS uses it | UI* | — |
| OBS responsible manager | Assign OBS to EPS, project, WBS | missing | WBS obs_id is counted (:735) but not editable in the WBS view; nothing for EPS or project. Only Risks use OBS (RiskView.tsx:144) | — | — |
| OBS users / security | Users per OBS | n/a | Security | — | — |

### Codes and user defined fields

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Activity code types: add/rename/delete | Dictionary of code types | done | CodesDialog EnterpriseDialogs.tsx:481; delete cascades values and assignments | UI* | — |
| Activity code scope | Global / EPS / Project | partial | Global or Project selectable (:603). EPS is shown when imported but cannot be set | UI* | — |
| Max code length | 1-20 (60 later) characters | done | 1-60, enforced on value inputs via maxLength (:625). Existing longer values not checked | UI* | — |
| Hierarchical code values | Values with child values | done | Add / Add Child, tree view (:622) | UI* | — |
| Code value colors (8.3+) | Color per value for bars and bands | missing | — | — | — |
| Secure codes | Security-restricted codes | n/a | Security | — | — |
| Group by activity code | Bands by code, hierarchical | partial | One level, leaf value only (activityRows.ts:143); no code hierarchy and no multi-level grouping | UI* | run_report (wbs grouping only) |
| Filter by activity code | Filter criteria on codes | done | User filters accept code_ columns via COLUMN_BY_ID (activityRows.ts:65) | lookup find_activities activity_code | find_activities |
| Delete code value | Removes value and its assignments | done | :548 cascades children and TASKACTV | UI* | — |
| Project codes dictionary | Project code types and values | partial | See Enterprise > Project Codes (flat values) | UI* | — |
| Assign project code values | Project Details > Codes | done | ProjectDialogs.tsx Codes tab; values from Enterprise > Project Codes | UI* | — |
| Group/filter projects by project code | Projects window bands; portfolio filters | missing | Projects window groups by EPS only; portfolio rule has no code criterion (portfolio.ts:10) | — | — |
| Resource codes: dictionary / assignment / grouping | Resource codes end to end | partial | Dictionary and Codes tab since ed16126. No resource code columns, grouping or filtering in the Resources window | UI* | — |
| UDF subject areas | 10 areas (activities, expenses, steps, issues, projects, risks, assignments, resources, WBS, documents) | partial | Only 4 tabs: Activities, WBS, Projects, Resources (EnterpriseDialogs.tsx:639) | UI* | — |
| UDF data types | Text, Start/Finish Date, Cost, Number, Integer, Indicator, Code | partial | No Indicator (FT_STATICTYPE) or Code; imported unknown types are shown raw (:704) | UI* | — |
| UDF add / rename / delete | Define and remove UDFs | done | Delete cascades UDFVALUE (:671); data type locked while values exist (:701) | UI* | — |
| WBS / Project / Resource UDF values | Edit in those windows | missing | Not displayed or edited anywhere | — | — |
| UDF indicators (icons) | Traffic-light icons in columns | missing | — | — | — |
| Filter / group by UDF | Filters and grouping on UDFs | partial | Filter works (udf_ columns); no grouping by UDF | UI* | — |
| UDF formulas | P6 EPPM web only | n/a | — | — | — |

### Calendars

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Global / Project / Resource lists | Radio buttons per calendar type | done | Grouped list (EnterpriseDialogs.tsx:257) | lookup project_summary (count only) | project_summary |
| Add calendar | Add global, project or resource calendar (copy from) | partial | Add always creates a global CA_Base copy of the default calendar (:216-231). Cannot create project or resource calendars | UI*; op add_calendar (global only) | edit add_calendar; CLI edit |
| Delete calendar | Blocked when in use | done | Checks activities, projects, resources, base-of, default (:236) | UI* | — |
| Rename calendar | Edit name | done | Labelled field, so ui_type works | UI | — |
| Default calendar flag | One global default | done | Set As Default, global only (:250) | UI* | — |
| Standard work week | Work hours per weekday | done | Free-text shifts per day, minute granularity, overlap checks (EnterpriseDialogs.tsx:162, :393) | UI*; op add_calendar work_week (new calendars only: no op changes an existing calendar's work week or deletes a calendar) | edit add_calendar |
| Detailed work hours (shifts, 30-minute slots) | Several work periods per day | done | Comma-separated periods; finer than P6's 30-minute grid | UI* | edit add_calendar |
| Exceptions / holidays | Mark nonwork or custom-hours days | done | Month grid toggle, custom hours, Nonwork/Standard/Workday (:417-470) | UI*; op add_holidays, add_calendar work_exceptions | edit add_holidays |
| Inherit holidays from base calendar | Project/resource calendars inherit base exceptions | done | Shown with legend (:446); applied in CPM (cpm.ts:106 inheritExceptions). Base select disabled for global calendars | UI* | schedule |
| Hours per day / week | Time Periods: set per calendar | partial | Read-only, recomputed from the work week (writeCal :187) | — | — |
| Hours per month / year | Time Periods: set per calendar | partial | Not shown or editable. New-calendar month hours differ: dialog wk*52/12 (:230) vs op wk*4.3 (ops.ts:151) | — | — |
| Calendar "Used By" | List of projects/activities/resources using it | partial | Counts only (:326) | — | — |
| Personal resource calendar | Create from Resource Details | missing | See section 2 | — | — |

### Cost accounts, currencies, funding, periods, curves, shifts

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Cost account hierarchy | Add root/child, delete | done | AccountsDialog :775; delete blocked when used | UI* | — |
| Cost account ID / name / description | Editable | done | Unique ID per level (:835) | UI* | — |
| Cost account budget roll-up display | Budget by account (reports) | done | Own and total budgeted cost columns (:840); Cost by Cost Account report | UI*; open_report costAccount | run_report costAccount; CLI report |
| Project default cost account | Project Details > Defaults | missing | — | — | — |
| Cost account on resource assignment | Assignment cost account | missing | No column in Activity Resources tab or Assignments window. TASKRSRC.acct_id only via import | — | — |
| Cost account on expense | Expense cost account | done | ActivityDetails.tsx:351 | UI* | — |
| Currency list add/delete | Currencies dictionary | done | CurrenciesDialog :925; keeps at least one; blocked if a project uses it | UI* | — |
| Base currency | Flagged base currency | partial | First row is base implicitly (:985); cannot be changed | — | — |
| Exchange rates | Rate to base, used for view currency | partial | Editable but never used in any cost calculation or display | — | — |
| Currency symbol / decimals | Formats money everywhere | partial | Symbol used only in Roles/Cost Accounts dialogs. Resources, Assignments and Portfolios use hard-coded USD (ResourcesView.tsx:31, AssignmentsView.tsx:34, PortfoliosView.tsx:16) | — | — |
| Decimal / grouping symbols, +/- formats | Editable format fields | missing | Stored on add (:943), not editable | — | — |
| View currency (user preference) | Show costs in chosen currency | missing | — | — | — |
| Resource curves dictionary | Define 21-point curves | missing | No dialog | — | — |
| Default curves (Bell, Front/Back Loaded, ...) | Shipped with P6 | missing | Not seeded; a new database offers only Linear | — | — |
| Assignment curve selection | Curve column on assignment | partial | Dropdown in Activity Details > Resources (ActivityDetails.tsx:243); imported curves only | UI* | — |
| Curve in time-phased spreading | Units/costs spread by curve | partial | Used only for remaining units in usage views (usage.ts:111); not for actuals, costs or EV | — | — |
| Resource shifts | Shift dictionary and shift-based limits | missing | — | — | — |

### Resource Assignments window and usage views

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Project > Resource Assignments window | Assignment table for open projects | partial | AssignmentsView.tsx; always grouped by resource (:68) | UI*; lookup resource_summary | resource_summary; run_report assignments |
| Units and cost columns | Bud/act/rem/at-completion units and costs, dates | done | Fixed COLS :12 | lookup resource_summary | resource_summary; CLI query resources |
| Other assignment columns | Role, curve, rate type, driving, cost account, OT, price, budgeted units/time, remaining/late dates | missing | No Columns dialog for this window | — | — |
| Edit units in window | Edit any editable column | partial | Budgeted/actual/remaining units only (:29, P6 duration-type rules via recalcAssignment). Units/time, dates and price read-only | UI* | — |
| Group / sort / filter assignments | Group by resource, activity, project, WBS... | missing | Fixed grouping by resource; no filters | — | run_report (assignments group_by resource/activity) |
| Delete assignment in window | Delete key | missing | Only from Activity Details > Resources > Remove | op unassign_resource | edit unassign_resource |
| Assign Roles (role-only assignment) | Assign a role, resource TBD | missing | assignResource accepts roleId (assign.ts:60) but nothing passes one | — | — |
| Replace resource on assignment | Swap resource, keep units | missing | — | — | — |
| Staff role assignments | Assign resource by role and proficiency | missing | — | — | — |
| Resource Usage Profile | Histogram; stacked by project/resource; cumulative; cost or units | partial | AssignmentsView.tsx:266: one resource, units only (actual, remaining, overallocation), limit line, data date. No cost, cumulative curve, budgeted/baseline, stacking or all-resources view | — | — |
| Resource Usage Spreadsheet | Time-phased rows per resource/assignment; units and costs | partial | :230: one resource; actual, remaining, total, available, overallocated, cumulative units. No cost fields or per-assignment rows | lookup resource_summary (totals only) | run_report usageMonth (monthly units, all resources) |
| Timescale | Hour..Year | partial | Day/week/month only (:214) | — | — |
| Limits line by effective date | Max units from rates and calendar | done | usage.ts:124-135 | — | — |
| Overallocation highlight | Red over limit | done | Profile red segment; spreadsheet Overallocated row | — | level_resources |
| Resource usage report | Time-phased resource report | done | "Resource Usage by Month" (renderer/reports/engine.ts:297) | open_report / run_report_dialog | run_report usageMonth; CLI report |

### Timesheets

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Timesheet periods (Admin > Timesheet Dates) | Batch-create weekly periods; delete | done | TimesheetsView.tsx:293: 1/7/14-day periods, overlap check, delete guarded | UI* | — |
| Resource timesheet entry | Team Member / Progress Reporter weekly grid | done | Daily hours per assignment, Complete flag (:81-139). Beyond P6 Pro (server feature in P6) | UI* | — |
| Overtime hours | OT rows | done | Overtime toggle (:184) | UI* | — |
| Submit / Approve / Reject with notes | Status workflow | done | timesheet.ts:268-300 | UI* (Approve/Reject buttons) | — |
| Tools > Timesheet Approval | Approval list with hours | done | Approval tab: status filter, Approve All, applied/pending hours (:236) | ui_menu + ui_click | — |
| Two-level approval (resource mgr + project mgr) | Configurable approval levels | partial | One approval level | — | — |
| Tools > Apply Actuals | Apply approved hours, optional new data date | partial | Updates actual units, actual start/finish, remaining (timesheet.ts:378); does not offer to move the data date | ui_menu Tools > Apply Actuals | — |
| Admin Preferences > Timesheets | Entry by hours/%, approval rules, privileges | missing | Mostly n/a for single user | — | — |
| Timesheet users, logins, e-mail | Server-side | n/a | — | — | — |

### Portfolios

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Portfolio add / delete / rename / description | Project Portfolios dialog | done | PortfoliosView.tsx:43-118 (_PORTFOLIO table, not in XER, as in P6) | UI* | — |
| Selected-projects portfolio | Pick projects | done | Checkbox list | UI* | — |
| Filter-based portfolio | Filter on any project field or code | partial | Status, EPS (and below), name contains only (portfolio.ts:10) | UI* | — |
| All Projects portfolio | Built-in | done | :77 | UI* | — |
| File > Select Project Portfolio | Limit Projects window to a portfolio | missing | Status bar hard-coded "Portfolio: All Projects" (App.tsx:251) | — | — |
| Portfolio dashboard metrics | Tracking-style project spreadsheet | done | Counts, dates, float, costs, PV/EV/AC, SPI/CPI (PortfoliosView COLS) | UI* | list_projects (no EV totals) |
| Portfolio charts | Tracking bar charts, histograms, resource analysis | partial | Project span chart only | — | — |
| Open portfolio projects | Open all projects in a portfolio | done | "Open these projects" (:55) | UI* | — |

## 7. Tools: scheduling, leveling, progress, Global Change, comparison

### Tools menu

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Tools > Schedule (F9) | CPM-schedules open projects to data date | done | menu.ts:120 -> App.tsx:122 -> ScheduleDialogs.tsx:16-52 -> commands.ts:147 runSchedule -> cpm.ts:134. Schedules all open projects together; a failed run is undone and the log is shown (commands.ts:155). Oracle: 29/35 real files exact | UI only (ui_menu "Tools > Schedule...", ui_click "Schedule") | MCP schedule; CLI schedule |
| Tools > Level Resources (Shift+F9) | Resolve resource overallocation by delaying activities | partial | menu.ts:121 -> LevelDialog EnterpriseDialogs.tsx:999. Several options missing (see section 3) | UI only | MCP level_resources (within_float only, server.ts:217); CLI level (no options, commands.ts:31) |
| Tools > Update Progress | Auto-status activities to new data date from planned dates | partial | ScheduleDialogs.tsx:106-133 -> core/progress/update.ts:31. No "selected activities" choice (section 4) | UI only; manual progress via op update_activity (actual_start/percent_complete/remaining_days) | MCP update_progress; CLI progress |
| Tools > Schedule Risk Analysis | (P6 Pro: Risks window only; Monte Carlo is Primavera Risk Analysis) | extra | App.tsx:133 -> RiskView.tsx (register, heat map, three-point estimates, Monte Carlo core/risk/montecarlo.ts with seeded PRNG and CPM per iteration). Goes beyond P6 Pro | UI only | — |
| Tools > Schedule Log | Last SCHEDLOG: settings, statistics, errors and warnings | partial | App.tsx:135 -> LogDialog CommonDialogs.tsx:42 (Save As .txt). Content in log.ts:16-56. Missing vs P6: "activities with external dates", "milestones with invalid relationships", "started activities without actual start", per-project block for multi-project runs (uses the first project's options, cpm.ts:648). Leveling results go in a separate log | — (cannot read the log) | CLI schedule prints the full log; MCP schedule returns only warning lines (server.ts:205) |
| Tools > Import Log | Import result log (P6: shown after import) | extra | App.tsx:136 -> ImportLogDialog CommonDialogs.tsx:53: severity filter, P6-consequence column, Save As, Copy JSON | — | MCP open_file/validate diagnostics; CLI validate |
| Tools > Reports submenu | Reports window, Report Wizard, quick reports | done | menu.ts:130. Six quick links run named reports (App.tsx:144) | list_reports / open_report / run_report_dialog / create_report | MCP list_reports/run_report/create_report; CLI reports/report |
| Tools > Validate XER File | (clone-only) | extra | CommonDialogs.tsx:175-180 parses the file without importing and opens the Import Log | UI only (the user must pick the file in the OS dialog) | MCP validate, open_file; CLI validate |
| Tools > Global Change | Define if/then/else field changes; preview; apply | partial | Added in ed16126 (GlobalChangeDialogs.tsx): saved library, If (all/any filter-style conditions on any activity column), Then (= value, or + - * / on numbers) on any editable activity column, Global Change Report, Commit as one undo step. Missing: Else, expressions using other fields or text concatenation, subject areas other than activities (assignments, expenses, WBS), import/export of definitions | UI only (library rows not ui_click-able; condition selects unlabelled) | substitute: CLI edit --ops, import-excel; MCP edit, import_excel |
| Tools > Global Search & Replace (v18+) | Find/replace text in a field across activities | missing | Edit > Find exists (FindDialog.tsx); no replace | op update_activity name (substitute) | CLI edit/import-excel (substitute) |
| Tools > Recalculate Assignment Costs | Reprice assignments from current resource rates | missing | `recomputeCosts` exists (core/resource/assign.ts) but no command calls it for all assignments | — | — |
| Tools > Store Period Performance | Snapshot period actuals into financial periods | missing | No FINDATES/TRSRCFIN handling; Financial Periods are missing too | — | — |
| Tools > Claim Digger | Compare project with baseline/another project; HTML/CSV report | partial | Only CLI/MCP: core/diff.ts:43 compareSchedules (by Project ID, WBS path, Activity ID, relationship key). No app menu or UI; cannot pick the assigned baseline inside the same DB; output is text/JSON only | — | MCP compare (server.ts:67); CLI compare, diff |
| Tools > Schedule Check (v19+) | Run logic/constraint/float/duration checks; report | partial | Engine core/query/review.ts:13 (12 DCMA-style checks, graded). No menu or window in the app | lookup schedule_health (tools.ts:191, its own simpler check set) | MCP review; CLI review, query health |
| Tools > Top-Down Estimation | Spread estimated labour units down the WBS | missing | — | — | — |
| Tools > Issue Navigator | List threshold-generated issues | missing | PROJISSU/thresholds are only XER passthrough (core/db.ts) | — | — |
| Tools > Spell Check | Check spelling in text fields/notebooks | missing | — | — | — |
| Tools > Visualizer (v20+) | Separate Gantt/timescaled-logic designer app | missing | Low value; the clone's Gantt + print engine cover part of it | — | MCP export_pdf; CLI print (substitutes) |
| Tools > Job Services / Publish / Check In-Out / Unifier and Cloud links | Server or enterprise features | n/a | — | — | — |

### Scheduling options (F9 and Options)

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Current Data Date | Data date to schedule from | done | ScheduleDialogs.tsx:20,44-45 -> runSchedule({dataDate}); written to last_recalc_date (cpm.ts:628) | UI only (ui_type "Current Data Date"); op set_project data_date only moves it | MCP schedule data_date; CLI schedule --data-date |
| Log to file | Write SCHEDLOG.TXT on each run | partial | No checkbox. The log is kept in memory (setUi scheduleLog, commands.ts:154; not persisted). Saved manually via LogDialog Save As (CommonDialogs.tsx:45) | — | CLI schedule prints it (stdout) |
| Schedule automatically when a change affects dates | Reschedule after every edit | missing | No auto-schedule. Edits say "reschedule with F9" (commands.ts:46; live.ts:218) | — | — |
| Level resources during scheduling | Run leveling after each schedule | partial | Schedule dialog checkbox (ScheduleDialogs.tsx:21,29-33) is not persisted and not in Options. It levels with default options `{}`, ignoring the Level dialog's settings | UI only | CLI level = schedule + level; MCP separate call |
| Recalculate assignment costs after scheduling | Reprice assignments on F9 | missing | Not in the dialog or engine | — | — |
| Ignore relationships to/from other projects | Drop external links | done | Saved as SD_None (ScheduleDialogs.tsx:73). Read at cpm.ts:63, applied at 199-202, 348 and 420 | UI only | from XER SCHEDOPTIONS only |
| Make open-ended activities critical | Open ends get TF = 0 | partial | Checkbox saved (ScheduleDialogs.tsx:73) and printed in the log (log.ts:38), but **the engine never reads `openEndedCritical`**. Verified: TF stays 32 h with Y | UI only | from XER only (still ignored) |
| Use Expected Finish Dates | Remaining duration from expected finish | done | cpm.ts:361-367 (only when remaining work starts at the data date), FF = 0 at 474 | UI only | from XER |
| Progressed activities: Retained Logic | Remaining work waits for predecessors | done | Default (cpm.ts:59). Covered by unit test cpm.test.ts:79 and the oracle | UI only | from XER |
| Progressed activities: Progress Override | Ignore logic for started activities | done | cpm.ts:330 applyLogic. Unit tested | UI only | from XER |
| Progressed activities: Actual Dates | P6's third mode (logic from actual dates) | partial | Behaves as Retained Logic except start links from an in-progress predecessor use its actual start (cpm.ts:261). Verified: same result as Retained in an out-of-sequence test | UI only | from XER |
| Calculate SS lag from Early Start / Actual Start | Choose SS/SF lag origin for started predecessors | done | Fixed in 9a0f9b9 (after the earlier loops listed it open): Options has the select (ScheduleDialogs.tsx:94) and cpm.ts:72,265 reads sched_lag_early_start_flag. Re-verified at HEAD with an in-progress predecessor held by an open predecessor: Early Start gives the successor 17 Jan, Actual Start 12 Jan. Applies under Retained Logic (Progress Override always runs from the actual start) | UI only | from XER SCHEDOPTIONS only |
| Define critical activities: TF <= x | Critical threshold in hours | done | Saved to PROJECT.critical_drtn_hr_cnt (ScheduleDialogs.tsx:77). Used by ctx.ts:47, reports.ts:49 and review | UI only | from XER |
| Define critical activities: Longest Path | Critical = driving path to finish | done | critical_path_type CT_DrivPath (ScheduleDialogs.tsx:76). driving_path_flag computed at cpm.ts:509-517; ctx.ts:46 | UI only (lookup critical_path reads it) | from XER |
| Calculate float on finish of each project / opened projects | Float end per project or latest open project | partial | Engine supports it (cpm.ts:68, 381-387, reading sched_use_project_end_date_for_float), but **there is no dialog control and Options does not save it**. Only XER values take effect | — | from XER only |
| Compute Total Float as Start / Finish / Smallest | TF formula | done | cpm.ts:462-464 and 496. The dialog mislabels it "Calculate float based on" (ScheduleDialogs.tsx:91), which is P6's name for the previous option | UI only | from XER |
| Calendar for scheduling relationship lag | Predecessor / successor / 24 h / project default | done | cpm.ts:238-247; also used for relationship free float (cpm.ts:673) | UI only | from XER |
| Advanced: Calculate multiple float paths (free/total float) | Compute float_path / float_path_order | missing | Float Path columns only show imported XER values (model.ts:218-219). Not computed or cleared on F9 | — | — |
| Advanced: ending activity / number of paths | Target activity and path count | missing | Not implemented | — | — |
| Options stored per project (SCHEDOPTIONS) | Options live with the project | done | ScheduleDialogs.tsx:62-79 writes SCHEDOPTIONS for every open project; read by optionsFor cpm.ts:56. Round-trips in XER/XML. Dialog shows the first open project's values | — | Only XER values are used; no MCP/CLI flags to change options |
| Schedule multiple open projects together | One network across open projects | done | cpm.ts:134 over projIds; inter-project links (cpm.test.ts:136) | UI only | MCP/CLI schedule every project in the file |

### Leveling options

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Level all resources | Level every leveling-enabled resource | done | EnterpriseDialogs.tsx:1037. Skips level_flag N and material (level.ts:42) | UI only | MCP level_resources; CLI level |
| Level selected resources | Pick resources from a list | partial | Only the single resource selected in the Resources window (EnterpriseDialogs.tsx:1006,1014). No multi-select list | UI only | — |
| Consider assignments in other projects with priority >= n | Load from closed projects | missing | Only open projects' tasks count (level.ts:28-29) | — | — |
| Preserve scheduled early and late dates | Keep unleveled dates in separate fields | missing | Leveled dates overwrite early/planned dates (level.ts:157-160). Late dates are not recomputed | — | — |
| Recalculate assignment costs after leveling | Reprice after leveling | missing | — | — | — |
| Level resources only within float | Never push past late finish | done | level.ts:136,146 | UI only | MCP within_float |
| Preserve minimum float when leveling | Keep n hours of float | missing | — | — | — |
| Max percent to overallocate | Allow over-limit by % | done | level.ts:31,69. The residual-overallocation report assumes 8 h/day (level.ts:166), so its figures are off on other calendars | UI only | — |
| Leveling priorities (multi-field list, asc/desc) | Ordered fields, e.g. priority, then ES, then TF | partial | One choice only: Early Start, Total Float or Activity Priority, each with a fixed tie-break (level.ts:84-89). No list and no descending order | UI only | — |
| Resource max units/time and calendar | Capacity from limits per day | done | Max from RSRC/RSRCRATE (level.ts:33-39, last rate row, not effective-dated). Resources without a limit are listed as not leveled (level.ts:170). Daily capacity uses the activity calendar's shifts (level.ts:67-70) | — | — |
| Leveling result propagation | Successors move; floats and project finish updated | partial | Successors of moved activities are pushed (level.ts:118-127). Only the moved activity's TF is recomputed (level.ts:161). Late dates and PROJECT.scd_end_date are not updated, so project finish in summaries stays unleveled | — | — |
| Leveling log | Leveling section in the schedule log | partial | Separate "Leveling Log" dialog (EnterpriseDialogs.tsx:1027,1034) listing delays and remaining overallocation. Not merged into the Schedule Log | — (cannot read it) | MCP returns `report` text; CLI only in --json `extra` |

### Progress and actuals

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Update Progress: new data date | Move data date forward | done | ScheduleDialogs.tsx:111,128 (defaults to +7 days); update.ts:59 | UI only; op set_project data_date | MCP update_progress; CLI progress --data-date |
| Update Progress: all vs selected activities | Apply to all or the selection | missing | Always every non-WBS activity of every open project (update.ts:38-39) | — | — |
| Actual start/finish from planned dates | Planned start < DD becomes actual start; planned finish <= DD becomes actual finish | done | update.ts:40-50 (planned = target_* dates, which F9 sets to early dates for not-started work, cpm.ts:617) | UI only | MCP/CLI |
| Remaining duration from planned finish | RD = work time from DD to planned finish | done | update.ts:51 on the activity calendar | UI only | MCP/CLI |
| % complete and resource actuals | Update % and actual units/costs | partial | Physical % is set only for CP_Phys or blank type (update.ts:56). Assignment actuals are prorated by duration % (update.ts:17-29), whatever the units curve | — | MCP/CLI same engine |
| Reschedule after Update Progress | Recalculate dates at the new data date | done | ScheduleDialogs.tsx:121; MCP rolls everything back if scheduling fails (server.ts:212) | UI only | MCP/CLI |
| Manual progress entry (actuals, RD, %) | Enter in Status tab | done | Not a Tools item; noted for the AI path | op update_activity actual_start/actual_finish/remaining_days/percent_complete/expected_finish | MCP edit; CLI edit |
| Undo of scheduling, leveling and progress | Not available in P6 (no undo) | extra | Every Tools action is one mutate() step, undone with Ctrl+Z | op undo / live tool undo | MCP undo |

### Global Change, Claim Digger, Schedule Check

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Global Change: define if/where conditions | Conditions on any field | done | ed16126: same operators as user filters, all or any (FILTER_OPS) | UI only | — |
| Global Change: then/else assignments with expressions | Set field = value or expression (add, multiply, concatenate) | partial | ed16126: "=" a value, or + - * / a number on editable activity columns; no Else, no field-to-field expressions, no concatenation | Batched update_activity with explicit values (substitute) | CLI edit --ops; MCP edit (substitute) |
| Global Change: preview report, then commit or cancel | Show old and new values before applying | done | ed16126: Global Change Report lists activity, column, old and new value and errors; Commit is one undo step | UI only | MCP import_excel dry_run (substitute) |
| Global Change library (save/copy/import/export) | Reusable change definitions | partial | ed16126: New, Modify, Delete, saved in the database (_GCHANGE). No Copy, Import or Export | UI only | — |
| Claim Digger: choose project or baseline to compare | Current vs baseline or another project | partial | CLI/MCP only. Two files or two open handles (diff.ts:43). Cannot compare against the assigned baseline inside one DB, and there is no app UI | — | MCP compare; CLI compare |
| Claim Digger: fields compared | Activities, relationships, resources, expenses, codes, notebooks... | partial | Project, WBS, activity (name, WBS, type, calendar, status, durations, start/finish, TF, actuals, physical %, constraints: diff.ts:74-80) and relationships (lag). No resources, assignments, expenses, codes, UDFs or notebooks | — | MCP/CLI compare |
| Claim Digger: output (HTML/CSV, Excel) | Comparison report file | partial | Text or JSON only (diff.ts:98 compareText; --json) | — | CLI compare --json |
| Table-level diff | (clone-only) | extra | diffDbs (diff.ts:15), rows keyed by internal ids | — | CLI diff |
| Schedule Check: missing logic, leads, lags, relationship types | Checks run in the app | partial | review.ts:33-39 (DCMA thresholds). No in-app window or menu item | lookup schedule_health (tools.ts:191) | MCP review; CLI review |
| Schedule Check: hard constraints, high float, negative float, long durations, invalid dates | DCMA-style checks | partial | review.ts:40-46; same: no in-app UI | lookup schedule_health | MCP review; CLI review |
| Schedule Check: resources, missed tasks, CPLI, BEI, critical path test | DCMA 14 complete | partial | Resources (review.ts:47-49) and out-of-sequence (50-51). **Missing: missed tasks (vs baseline), BEI, CPLI, critical-path test** | — | — |
| Saved dates P6 would change on F9 | (clone-only) | extra | review.ts:54-57 uses stored-dates.ts. Valuable for validating agent XERs | — | MCP review/validate; CLI review |
| Schedule Check output (report, export) | Printable/exportable check report | partial | Text (reviewText review.ts:63) and JSON; exit codes 0/1/3 for CI (p6clone.ts:50) | — | CLI review [--json] |

## 8. Admin and User Preferences

### Admin menu, Admin Preferences, Admin Categories

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Admin menu contents | Users, Security Profiles, Admin Prefs, Admin Categories, Currencies, Financial Periods, Timesheet Dates | partial | menu.ts:136-141 has only Admin Preferences, Timesheet Dates and Reset Database. Currencies sits under Enterprise (menu.ts:113) | UI only | — |
| Users / Security Profiles / Change Password | Multi-user security | n/a | — | — | — |
| Admin Preferences dialog | Database-wide settings, ~9 tabs | partial | admin.preferences opens the **same** User Preferences dialog (App.tsx:140 = App.tsx:81; CommonDialogs.tsx:143-162) | UI only | — |
| General: code separator | Separator for WBS/code paths | missing | name_sep_char is always "." (edit.ts:131); paths hardcode "." (engine.ts:187, diff.ts:67) | — | — |
| General: week starts on | First day of week in timescales | missing | — | — | — |
| General: default activity duration | Duration of new activities | missing | Fixed at 5 days (core/project/edit.ts:174), which matches P6's default but cannot be changed | — | — |
| General: max activity code/WBS levels | Hierarchy limits | missing | Not needed for normal use | — | — |
| Data Limits | Max baselines, codes, levels | missing | Low value; nothing enforced | — | — |
| ID Lengths | Max chars for project/WBS/activity/resource IDs | missing | Not enforced, so an agent's over-long IDs would not be flagged here (check core/xer/validate.ts) | — | — |
| Time Periods: hours per day | Duration display conversion | partial | Per-user "Hours per day" (CommonDialogs.tsx:150), used by fmtDur (model.ts:38-44), reports, ops | ops use prefs.hoursPerDay (live.ts:209) | MCP hours_per_day; CLI --hours-per-day |
| Time Periods: hours/week, month, year | Other unit conversions | missing | Durations are only ever shown in days | — | — |
| Time Periods: use assigned calendar for hours/day | Per-activity calendar conversion | missing | — | — | — |
| Earned Value: % complete technique | Activity %, 0/100, 50/50, custom, WBS milestones, weighted steps | missing | Fixed to activity % complete (rollup.ts:51,13-23). Project ev_compute_type is neither read nor editable | lookup earned_value (fixed technique) | MCP earned_value |
| Earned Value: ETC technique | ETC = remaining, PF=1, PF=1/CPI, 1/(CPI*SPI), custom PF | missing | Fixed ETC = remaining cost (rollup.ts:69); ev_etc_compute_type ignored | — | — |
| Earned Value: baseline used | Project baseline / user primary / budget with planned dates | partial | Always the project baseline (sum_base_proj_id), else current budget (rollup.ts:33-43). No user baselines | — | — |
| Reports tab: custom header/footer labels | Three admin-defined label texts | missing | Page Setup offers free header/footer text instead (PageSetupDialog.tsx) | set_print_options | MCP/CLI print settings |
| Options tab | Link to web, cost settings | n/a | — | — | — |
| Rate Types: titles of Price/Unit 1-5 | Rename rate types | missing | Engine honours an assignment's rate_type (assign.ts:15), but there are no titles and no editor for prices 2-5 | — | — |
| Industry (terminology) | Construction/IT etc. labels | missing | Low value | — | — |
| Admin Categories: baseline types | Lookup list | missing | — | — | — |
| Admin Categories: expense categories | COSTTYPE list | missing | No editor; imported COSTTYPE only passes through | — | — |
| Admin Categories: WBS categories / project phases | Lookup list | missing | — | — | — |
| Admin Categories: document categories / status | Work products and documents | missing | Documents exist only through the activity WPs & Docs tab (1593d17); no categories or status | — | — |
| Admin Categories: risk categories | RISKTYPE tree | partial | Defaults auto-created (RiskView.tsx:185, register.ts:69-82). No admin editor | — | — |
| Admin Categories: notebook topics | MEMOTYPE list | partial | Created inline from the Notebook tab (ActivityDetails.tsx:306-307, ProjectDialogs.tsx:104-117). No admin list or rename | — | — |
| Admin Categories: units of measure | UMEASURE list | partial | Picked on a resource (ResourcesView.tsx:325) from imported rows only; no editor | — | — |
| Admin Categories: overhead codes | Timesheet non-project activities | missing | — | — | — |
| Reset Database | (clone-only) | extra | App.tsx:141, confirmed | UI only | — |

### User Preferences

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Preferences persistence | Per-user, saved | done | Saved with the DB file (store.ts:132-133) | — | — |
| Time Units: duration unit (h/d/w/m/y) | Display durations in the chosen unit | missing | Always days (model.ts:42) | — | MCP/CLI days only |
| Time Units: duration decimals | 0-3 decimals | done | 0/1/2 (CommonDialogs.tsx:151; model.ts:43) | UI only | — |
| Time Units: show unit label / sub-unit | e.g. "5d 4h" | missing | — | — | — |
| Time Units: units/time format (% vs units/duration) | Resource units display | missing | Units shown as h/d (CommonDialogs.tsx:135) | — | — |
| Dates: format | Many orders, month name, 4-digit year, separators | partial | 4 fixed formats (CommonDialogs.tsx:156; model.ts:29-34) | UI only | MCP/CLI fixed dd-MMM-yy |
| Dates: time display (12 h / 24 h / none, minutes) | Time format | partial | Show time on/off, 24 h only (model.ts:35) | UI only | — |
| Currency: view currency, symbol, decimals | Display currency | missing | US$ hardcoded in activity columns (model.ts:101); reports use plain numbers (engine.ts:26) | — | — |
| E-Mail | Mail client settings | n/a | — | — | — |
| Assistance: wizards on/off | New resource/activity wizards | missing | No wizard toggles. New Project always uses a dialog (ProjectDialogs.tsx:15) | — | — |
| Application: startup window, group/sort defaults, column headers | Startup behaviour | partial | Last view, layout and open projects are restored automatically (store.ts:132). No settings for them | — | — |
| Password | Change password | n/a | — | — | — |
| Resource Analysis: all projects vs open, time-phased interval, remaining from | Resource usage options | missing | — | — | — |
| Calculations: preserve units vs budgeted cost; staffing (resource vs role price); adding a 2nd resource | Assignment recalculation rules | missing | Fixed rules in recalcAssignment (assign.ts:34-57) | — | — |
| Startup Filters | Load subsets of enterprise data | n/a | Single local DB | — | — |

## 9. Reports

### Reports

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Reports window with report groups tree | Hierarchical groups, user-editable | partial | ReportsView.tsx:31-42. Groups are fixed (engine.ts:253 REPORT_GROUPS); users can't add, rename or nest groups. Schedule and Import logs are listed there too | list_reports, open_report | MCP list_reports; CLI reports |
| Standard report library | Large shipped library (Schedule, Resource, Cost, EV, Progress...) | partial | 27 standard reports: 7 fixed (reports.ts:29-128), Resource Usage by Month (engine.ts:258), 19 specs (engine.ts:231-251). All 27 run (reports.test.ts). P6 ships many more | open_report | MCP run_report; CLI report |
| Schedule Report (by WBS) | Activities under WBS bands | done | reports.ts:31-43 | open_report | MCP/CLI |
| Critical Activities | TF <= limit or longest path | done | reports.ts:45-53; honours critical_path_type | open_report | MCP/CLI |
| Total Float report | Open activities sorted by TF | done | engine.ts:240 (filter "open", numeric sort engine.ts:127-134) | open_report | MCP/CLI |
| Earned Value by WBS | BAC/PV/EV/AC/SV/CV/SPI/CPI/EAC/VAC by WBS | partial | Formulas right (rollup.ts:67-73), rolled up the tree (engine.ts:183-205). PV is a **linear calendar-time** share of baseline dates (rollup.ts:46-50), not P6's calendar/curve spread; the EV technique is fixed | open_report; lookup earned_value | MCP/CLI |
| Baseline Variance | Finish variance vs baseline | partial | Calendar days, not work days on the activity calendar. Project baseline only, matched by Activity ID (reports.ts:68-81) | open_report | MCP/CLI |
| Lookahead, Late, Not started, In progress, Milestones, Constraints, Open ends, Relationships, Resource lists, Cost by account, Usage by month | Standard schedule/resource/cost reports | done | engine.ts:232-250, reports.ts:55-127, engine.ts:292-306 | open_report | MCP/CLI |
| Report Wizard: subject areas | Many areas plus additional subject areas (sub-reports) | partial | 5 areas (activities, assignments, WBS, resources, relationships; engine.ts:95-101). No EPS/projects/expenses/codes/risks/issues; no sub-reports | create_report (drives the wizard on screen) | MCP create_report; CLI report --definition |
| Report Wizard: columns | Choose columns | done | Every activity column including codes, UDFs and EV (engine.ts:104-108; ReportDialogs.tsx:68-80) | create_report | MCP/CLI |
| Report Wizard: filter | Filter rows | done | Default and user filters (engine.ts:110; ReportDialogs.tsx:81-84) | create_report | MCP/CLI |
| Report Wizard: group and sort, totals | Group by any field with subtotals; multi-key sort | partial | Activities group by WBS or none only (no codes/fields). Single sort key. No totals or subtotals in bands (engine.ts:150-153, 164-175) | create_report | MCP/CLI |
| Report Wizard: time-distributed data / timescale | Spread columns per period | missing | Only the fixed Resource Usage by Month report has periods | — | — |
| Report Wizard: title, name, group | Name and placement | done | ReportDialogs.tsx:90-94 | create_report | MCP/CLI |
| Report Editor (banded designer) | Edit bands, fields, text, layout | missing | Only the wizard (Modify re-opens it) | — | — |
| Modify / Delete report | Edit or remove a user report | done | Custom reports only (ReportsView.tsx:47-49); undoable | create_report (same name replaces) | MCP create_report replaces by name |
| Copy / Paste report | Duplicate any report | partial | Copy opens the wizard on a copy of a definition-based report (ReportsView.tsx:48). The 8 fixed-format reports can't be copied | — | — |
| Import / Export report (.erp) | Share report definitions | missing | Definitions are kept in internal _REPORT table (app.ts:15); not exported to XER | — | CLI report --definition json (substitute) |
| Batch Reports | Run a set of reports in one go | missing | — | — | — |
| Run Report: Print Preview / Direct to Printer | Paged output | done | ReportDialogs.tsx:10-28 -> app.ts:38-42 (uses Page Setup) | run_report_dialog (the user presses OK) | MCP run_report .pdf; CLI report --out .pdf |
| Run Report: HTML file / ASCII text file | File outputs | done | output.ts:26-38 (ASCII = CSV) | run_report_dialog | MCP/CLI .html/.csv/.txt |
| Run Report: PDF and Excel | (clone extra) | extra | output.ts:11-14,41-46 | run_report_dialog | MCP/CLI .pdf/.xlsx |
| Report headers/footers and page setup | Page Setup for reports | done | reportPages uses Page Setup variables (output.ts:16-22) | set_print_options | MCP/CLI settings |
| User-report persistence | Stored in the P6 database | partial | Saved in the clone DB (_REPORT). MCP create_report lives only in the session and is not written to the file (server.ts:70,134-138) | — | MCP session only |

## 10. Import and export formats

### Import wizard

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Format: Primavera PM XER | Import XER from any 5.0–24.x export | done | parse.ts never throws; generic table reader; imported 130 TRIAL/HBTF-2 (24.12)/plant (15.1, 26 MB) cleanly | UI only (user picks file) | MCP open_file; CLI all commands read XER |
| Format: P6 XML (APIBusinessObjects) | Import P6 / EPPM XML | partial | Reads the elements in p6xml.ts maps, now including BaselineProject, ActivityStep and project/resource codes (327446b). Writes and reads UnitOfMeasure, ExpenseCategory, ResourceCurve (<Values><Value0..Value100/>), ResourceRole (Proficiency "1 - Master"..), RoleRate, FinancialPeriod, ThresholdParameter, ProjectThreshold, ProjectIssue, ActivityPeriodActual, ProjectResource and most fields of every other object, all checked against P6's own XML schema (p6apibo.xsd as MPXJ embeds it; tests/p6xml-coverage.test.ts lists what is not carried and why: P6XML_NOT_CARRIED); also ActivityNote (with and without topic), ProjectSpendingPlan, the root WBS node's budget/earned-value/discount fields on the Project element, activity-code colors and assignment curves; coded values are written only where the jar verifies the P6 text | UI only | open_file; CLI reads .xml |
| Format: MS Project XML / MPX | Import MSPDI / MPX | done | mspdi.ts/mpx.ts → shared.ts projectToDb; summary tasks become WBS; findings for deadlines, % lags, elapsed lags, cross-project links | UI only | open_file, CLI (detectFormat) |
| Format: MPP via installed MS Project | Needs MS Project on the PC | done | main/msproject.ts PowerShell COM bridge (FileOpenEx/FileSaveAs MSProject.XML); 120 s timeout | UI; MCP reads .mpp through MPXJ (core/msp/mpp.ts) | open_file / compare read .mpp (no write) |
| Format: Spreadsheet (XLS) in wizard | Spreadsheet is one of the wizard's formats | partial | Disabled in wizard (Wizards.tsx:151); separate File > Import from Excel menu instead (.xlsx only) | UI only | import-excel / import_excel |
| Format: Primavera Contractor / P3 | Legacy formats (older versions) | missing | Not offered; low value | — | — |
| Format: UN/CEFACT XML | Recent P6 versions only | missing | Not offered | — | — |
| Import type: Project | Default | done | Wizards.tsx:155 | UI only | — |
| Import type: Resource Only / Roles Only | Imports only resource/role dictionaries | missing | Radios disabled (Wizards.tsx:156-157) | — | — |
| Action: Create New Project (into EPS) | New project under chosen EPS | done | import.ts alloc() renumbers every key; EPS picker per project (Wizards.tsx:201) | UI only | — (CLI/MCP open the file as is, no merge into a database) |
| Action: Replace Existing Project | Delete target data, load file | done | deleteProject() then insert, keeps target proj_id (import.ts:63-77) | UI only | — |
| Action: Update Existing Project | Merge: update matches, add new, keep the rest | partial | Behaves like Replace: deleteProject() wipes the target first and only reuses task_id/wbs_id by code. Measured (upd.mjs): an activity that exists only in the target ("LOCAL-ONLY") was **deleted**; its notes and UDFs go with it | UI only | — |
| Action: Link Existing / Do Not Import | Link to existing project, or skip | partial | "Do Not Import" done; Link Existing missing | UI only | — |
| Default action when the ID matches | P6 proposes an action per matched project | done | Defaults to Replace when proj_short_name matches (Wizards.tsx:65) | UI only | — |
| Update options: data types offered | ~20 subject areas (codes, UDFs, notebook topics, OBS, currencies…) | partial | Only 6 shown: Calendars, Resources, Roles, Activity Codes, UDFs, Cost Accounts (Wizards.tsx:44). OBS, Project/Resource codes, notebook topics, currencies, cost types are always "Keep Existing" (import.ts MATCH) | UI only | — |
| Update options: actions | Keep Existing / Update Existing / Insert New / Do Not Import | partial | 3 of 4 (no Do Not Import). "Insert New" on a matching name makes duplicates: re-importing CfC with RSRC=insert gave two "s.l", "f.w.l"… resources with the same ID (upd.mjs). P6 does not allow duplicate IDs | UI only | — |
| Delete relationships/data not in file (Update) | Optional per subject area | missing | No option; Update deletes everything in the target anyway | — | — |
| Global data matching (calendars, codes, resources) | Matched by name/ID, kept | done | MATCH by name; children matched within parent (import.ts:18-32); 2nd import of CfC added no CURRTYPE/CALENDAR/RSRC rows | UI only | — |
| Currency handling on import | Converts costs when the file currency differs | missing | The ERMHDR currency is ignored on import; CURRTYPE matched by short name only | — | — |
| Import Log | Text log of problems | extra | ImportLogDialog with severities and "What P6 does", Save As .txt, Copy JSON (CommonDialogs.tsx:60-62). Opens on fatal/error/warning | ui_menu "Tools > Import Log"; ui_screen sees counts only, not the findings | CLI validate (all findings); MCP open_file/validate (first 40 non-info) |
| Refuse files P6 rejects | Import fails on fatal problems | done | verdict fatal → import refused, log shown (Wizards.tsx:120) | — | open_file returns opened:false |
| Large files | Imports slowly | done | Staged progress messages; 26 MB plant.xer round trip OK; 90 MB synthetic sample present | — | — |

### Export wizard

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Export XER, choose version | Version drop-down | partial | 20 versions 5.0–24.12 (schema.ts:214), but layouts verified only for 5.0, 6.0.0, 6.2, 7.0. 8.x–24.12 reuse the "6.2" modern-build layout plus kept source fields. Real 24.12 file HBTF-2 → clone 24.12: PROJECT lacks fintmpl_id, last_schedule_date, baselines_to_export, baseline_names_to_export, sumtask_loaded; ROLERATE lacks start_date, max_qty_per_hr; ACTVTYPE export_flag, TASK crt_path_num, ACTVCODE total_assignments, TASKPRED comments; PROJWBS/TASK field order differs (layout.mjs) | UI only | CLI export --version; MCP save version |
| Export: all / selected projects | Pick projects in a grid | done | Checkbox grid (Wizards.tsx:292-298); selectRows pulls referenced dictionaries to a fixpoint | UI only | — (CLI export and MCP save always write every project; no --project) |
| Export type: Resource Only | Exports the resource dictionary only | missing | Disabled radio (Wizards.tsx:290) | — | — |
| Export baselines with the XER | Baselines to export (newer versions) | missing | baselines_to_export fields dropped; no option | — | — |
| ERMHDR header | Version, date, user, DB, currency | partial | Version/date/currency written; user and DB name always "admin/admin/dbxDatabaseNoName" (write.ts:114-117), source header not kept | — | — |
| Encoding | Writes the system ANSI codepage (1252 on Latin systems) | partial | Always cp1252; unrepresentable characters → "?" (encoding.ts:321). Measured: UTF-8 "Ωmega مرحبا café" exported as "?mega ????? café". cp1256 Arabic bytes pass through unchanged but display as mojibake. WriteOptions.encoding:'utf-8' exists but nothing exposes it | — | — (no flag) |
| CRLF line endings, %E end | CRLF, %E at end | done | Output ends "\r\n%E\r\n" (layout.mjs) | — | — |
| Table order | Fixed per version | partial | Observed order for old versions; modern ones inferred: HBTF-2 24.12 real order "RCATTYPE RCATVAL ROLES … RSRCRCAT RSRCROLE TASK" vs clone "RCATTYPE ROLES RCATVAL … RSRCROLE TASK ACTVCODE RSRCRCAT" | — | — |
| Unknown / custom fields | P6 writes its own schema only | done | Exact layouts keep the version's fields; approximated versions keep source fields seen in any real layout (write.ts:127-130, fixed in 2105890). Non-P6 fields are dropped (Tower-A taskpred_id, cost_type) | — | — |
| Export P6 XML | XML of selected projects | partial | See section 4 | UI only | CLI export --format xml; MCP save *.xml |
| Export MSP XML / MPX / MPP | One project per file | partial | One project only (Wizards.tsx:249); see section 5 | UI only | — (no CLI/MCP MSP writer) |
| Export Spreadsheet (XLS) via wizard | Spreadsheet format with templates | partial | Not in the wizard; separate "Export to Excel" with fixed columns (section 6) | UI only | export-excel / export_excel |
| Self-check after export | — (clone extra) | extra | Re-reads the written bytes and validates them (Wizards.tsx:271-274) | — | CLI validate on the output file |

### XER table coverage (import, keep, export)

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| PROJECT | Project row with settings | partial | Kept. 15.1/24.12 layouts drop real fields (plant 15.1: matrix_id, last_level_date, last_schedule_date, px_*, hist_*, schedule_type, sync_wbs_heir_flag, wbs_heir_levels…) | project_summary, list_projects | query summary/projects |
| PROJWBS | WBS tree | done | Field order differs in modern layouts; status_reviewer (15.1) dropped | list_wbs | query wbs |
| TASK | Activities | partial | Round trip lossless for 5.0/6.0/19.12 sources; real 15.1/24.12 lose cbs_id, pre/post_pess_*, control_updates_flag, crt_path_num | find_activities, get_activity | query find/activity |
| TASKPRED | Relationships | done | 24.12 `comments` dropped (new field) | get_activity, trace_logic | query trace |
| TASKRSRC | Assignments | done | 15.1 cbs_id dropped | resource_summary | query resources |
| TASKMEMO / MEMOTYPE | Notebooks | done | MEMOTYPE pulled by memo_type_id | get_activity (notes) | — |
| WBSMEMO | WBS notebooks | done | Kept in XER; lost in P6 XML and MSP | — | — |
| TASKACTV / ACTVTYPE / ACTVCODE | Activity codes | done | ACTVCODE child of type; total_assignments (24.12) dropped | get_activity, find --code | query find --code |
| PCATTYPE / PCATVAL / PROJPCAT | Project codes | done | Exported via PROJPCAT refs; 15.1 export adds 5.0-era fields (proj_catg_type_wt, proj_catg_wt) that P6 15.1 does not write | — | — |
| RCATTYPE / RCATVAL / RSRCRCAT | Resource codes | done | RSRCRCAT child of RSRC | — | — |
| UDFTYPE / UDFVALUE (task, WBS, project) | UDFs | done | fk remapped per UDF subject (import.ts:130) | get_activity (UDFs) | — |
| UDFVALUE (resource, role, assignment) | UDFs without proj_id | done | Fixed in 2105890: values follow their kept rows (write.ts:91-97). Import with RSRC "keep" re-inserts values for existing resources (duplicates) | — | — |
| CALENDAR | Global/project/resource calendars | done | Matched by name for globals; project calendars renumbered | project_summary | — |
| RSRC / RSRCRATE | Resources, rates | done | RSRCRATE child of RSRC | resource_summary | query resources |
| ROLES / ROLERATE / RSRCROLE | Roles | partial | ROLERATE start_date, max_qty_per_hr dropped at modern versions (real 24.12 has them) | — | — |
| ACCOUNT | Cost accounts | done | Pulled by acct_id | — | — |
| CURRTYPE | Currencies | done | Always exported whole (ALWAYS set) | — | — |
| OBS / POBS | OBS | done | POBS whole (fixed 2105890); OBS by obs_id refs | — | — |
| SHIFT / SHIFTPER | Resource shifts | done | Fixed in 2105890 (SOFT_REFS RSRC.shift_id; SHIFTPER child). plant SHIFT 1→1. No layout known: written with source fields | — | — |
| NONWORK | Non-work types (global) | partial | Kept, and exported in an all-projects export; **dropped** when exporting selected projects (plant 7→0) because nothing references it | — | — |
| RISKTYPE / PROJRISK / TASKRISK | Risk types, risks | partial | RISKTYPE dropped in a selected-project export (plant 42→0). PROJRISK/TASKRISK have no key in db.ts KEYS, so they are not renumbered on import | — | — |
| COSTTYPE / PROJCOST | Expense categories, expenses | done | COSTTYPE pulled by cost_type_id | — | — |
| TASKPROC | Steps | done | Kept in XER and (since 327446b) P6 XML; lost in MSP. Shown and edited in the Steps tab (1593d17) | — | — |
| DOCUMENT / TASKDOC | Work products and documents | partial | Kept and exported, but doc_id is not in KEYS, so ids are not renumbered on import (collisions across imports) | — | — |
| PROJISSU / PROJTHRS / THRSPARM | Issues, thresholds | done | 130 TRIAL: 75 issues lossless in XER (lost in XML) | — | — |
| FINDATES / TASKFIN / TRSRCFIN | Financial periods, period performance | done | cairo alex-road: FINDATES 5, TASKFIN 31 lossless in XER (lost in XML) | — | — |
| FINTMPL | Financial period template | partial | Table kept; PROJECT.fintmpl_id dropped at 24.12 (layout) | — | — |
| WBSBUDG / WBSRSRC | WBS budget/spending plan | done | Lossless in XER; in P6 XML as ProjectSpendingPlan and ProjectResource | — | — |
| BUDGCHNG / PROJFUND / FUNDSRC | Budget log, funding | partial | Kept generically; FUNDSRC has no key (no renumbering); never seen in samples | — | — |
| SCHEDOPTIONS | Schedule/leveling options | done | Leveling fields lost in XML only | — | — |
| RSRCCURVDATA | Resource curves | done | Selected export keeps only referenced curves (plant 7→5); P6 likely writes all | — | — |
| UMEASURE / LOCATION / APPLYACTOPTIONS / TASKNOTE | Misc dictionaries | done | Generic; TASKNOTE is an ActivityNote without a topic in P6 XML (APPLYACTOPTIONS and POBS have no element there) | — | — |
| Baselines (as projects) | Separate projects / baselines_to_export | partial | Clone baselines are PROJECT rows with _baseline_of; written as ordinary projects in an all-projects export, left out of a selected export | — | — |

### P6 XML

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Namespace/version | Matches the P6 version | done | Fixed in 327446b: writes the requested version's namespace (8.1 for pre-XML versions). Verified: `export --format xml --version 8.4` writes the V8.4 namespace | — | export --format xml --version; MCP save *.xml |
| Element order vs XSD | XSD sequence order | partial | ObjectId first, then map order (p6xml.ts:94-103), not the XSD order. Risk if P6 validates against the schema (not verified with real P6) | — | — |
| Activities, WBS, relationships, assignments | Core objects | done | CfC XML round trip: TASK 132, TASKPRED 233, TASKRSRC 81; `compare` = 0 changes | — | — |
| Calendars (global/project, exceptions) | Calendar objects | done | Re-serialised clndr_data; last_chng_date lost | — | — |
| Activity codes and UDFs (nested Code/UDF) | Nested in Activity | done | codesXml/udfsXml | — | — |
| Baselines (BaselineProject) | Optional export/import | done | Fixed in 327446b: written, and read back as a baseline attached to its project (p6xml.ts:303, 336-342) | — | save *.xml; open_file |
| Steps (ActivityStep) | Activity steps | done | Fixed in 327446b. Re-run at HEAD: Tower-A TASKPROC now survives XER → XML → XER | — | — |
| Project codes / resource codes | Code types/values/assignments | done | Fixed in 327446b. Re-run at HEAD: cairo alex-road PCATTYPE 1 / PCATVAL 3 kept; only the weight fields (proj_catg_type_wt, proj_catg_wt) drop | — | — |
| Notes: WBS, project; issues; thresholds | Notebook topics per object | missing | WBSMEMO (CfC 6→0), PROJISSU (75→0), PROJTHRS/THRSPARM → 0; only ActivityNote kept | — | — |
| RoleRate / ResourceRole / UnitOfMeasure / curves | Dictionaries | partial | ResourceRole, UnitOfMeasure, ExpenseCategory and ResourceCurve are written to P6 XML and read back equal to the XER on every sample (tests/review-owner-clone.test.ts); RoleRate, FinancialPeriod, thresholds, issues and period actuals are carried too; P6XML_NOT_CARRIED lists the remaining fields | — | — |
| Financial periods, period performance, WBS budgets | FinancialPeriod, ActivityPeriodActual | missing | No UI; all five tables are written to and read from P6 XML | — | — |
| Project-level fields | ~100 Project elements | partial | Only 17 mapped (PROJECT_MAP); CfC lost 35 non-empty PROJECT fields; SCHEDOPTIONS lose all leveling settings | — | — |
| Activity fields | Work/equipment units, est weight, review | partial | 18-21 non-empty TASK fields lost (est_wt, *_work_qty, *_equip_qty, lock_plan_flag, float_path…) | — | — |
| Assignment fields | Curves, lag, rate source | partial | 15-16 lost (curv_id, target_lag_drtn_hr_cnt, cost_qty_link_flag, rem_late_*…). RateType written raw "COST_PER_QTY" instead of P6's enum label (p6xml.ts:114, no enum conversion) | — | — |
| Resource fields | Shift, unit, notes, OT, role | partial | 9-13 lost (role_id, unit_id, curr_id, ot_factor, rsrc_notes, shift…); cost_per_qty2..5 lost | — | — |
| Which P6 build wrote the file | — | partial | XML has no ERMHDR, so the legacy 6.x milestone rule is lost: CfC.xml validates with DATES_NOT_CURRENT (16 activities at 08:01), the same data as XER validates clean | — | validate |

### Microsoft Project

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Import MSPDI/MPX tasks, links, WBS | Summary tasks → WBS | done | CfC MSPDI/MPX round trip: 132 tasks, 233 links (SS kept), 49 WBS | UI only | open_file / CLI read |
| Calendars | Base and resource calendars | partial | Weekly and day exceptions done; recurring exceptions import only their first day (mspdi.ts:147) | — | — |
| Constraints / secondary constraint | Mapped; deadlines ignored | done | P6 codes carried in Text3/Text5; deadline ↔ finish-on-or-before secondary (shared.ts:328) | — | — |
| Resources and assignments | Labor/nonlabor/material | done | 4 RSRC/81 TASKRSRC kept; cost resources → labor with a finding | — | — |
| P6 extras (Activity ID, type, duration type) | Configurable MSP template mapping | partial | Fixed mapping Text1-Text6 (mpx.ts:33); no template editor. Tower-A lost duration_type, complete_pct_type, priority_type on 4/4 activities | — | — |
| Baselines | Baseline fields | missing | No Baseline elements written/read | — | — |
| Activity codes, notes, UDFs, expenses, steps | Custom fields / notes | missing | TASKACTV, TASKMEMO, WBSMEMO, UDFVALUE, PROJCOST, TASKPROC, ROLES, OBS all → 0 (msp.mjs) | — | — |
| Export MSPDI / MPX | One project per file | done | Wizard only; first selected project | UI only | — |
| MPP read/write | Via installed MS Project | done | COM bridge both ways (msproject.ts:186-215) | UI only | — |
| MSP version choice on export | 2003/2007… | missing | — | — | — |

### Excel

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Export sheets TASK, TASKPRED, RSRC, TASKRSRC | Spreadsheet export subject areas | done | p6sheets.ts:59-65 plus USERDATA; field-name row 1, titles row 2 | UI only (user saves) | export-excel / export_excel |
| EXPENSES (PROJCOST) sheet | Expense subject area | missing | No PROJCOST sheet | — | — |
| Template: choose columns per sheet, save template | Modify template, save and reuse | missing | Fixed column lists (p6sheets.ts:17-20); no codes or UDF columns | — | — |
| File type | .xls (Excel 97-2003) | partial | .xlsx only (own zip writer, xlsx.ts) | — | — |
| Import: add/update/delete activities | Matched by Activity ID | done | Measured: rename, duration change, new activity, delete row → one transaction, undoable | UI only | import-excel / import_excel (dry run) |
| "Delete This Row" | delete_record_flag = Y | done | TASK, TASKPRED, TASKRSRC | UI only | same |
| Read-only columns ignored | Calculated fields skipped | done | Status, start/finish, float ignored (p6sheets.ts:3-4) | — | — |
| Round-trip idempotent | Re-import without edits changes nothing | done | CfC: 0 operations, 446 rows unchanged; Tower-A 0 ops | — | — |
| RSRC sheet updates existing resources | Updates fields | partial | Only adds new resources; existing ones skipped (p6sheets.ts:155) | — | — |
| TASKRSRC updates units | Updates units | partial | An existing assignment counts as unchanged; unit edits are ignored (p6sheets.ts:167) | — | — |
| Errors in rows | Import log of refused rows | partial | The first refused row aborts the whole import (CfC test: "A milestone has zero duration"); P6 logs and skips | — | exit 65 |

## 11. Printing and other exchange

### Printing and Page Setup

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Print Activities layout, all rows, multi-page | Prints the whole layout | done | layoutSchedule paginates rows, titles and timescale on every page; CfC 132 activities → 4 A3 pages | set_print_options + ui_menu | CLI print; MCP export_pdf |
| Paper size / orientation | Page tab | done | Letter…A1, portrait/landscape (layout.ts:11-12) | set_print_options | --paper/--portrait |
| Scaling: Adjust to % / Fit to N pages wide × tall | Page tab | missing | Always fits one page wide; font size (5-14 pt) is the only density control | — | — |
| Margins | Margins tab | done | mm, 0-60 | set_print_options | settings |
| Header/footer sections | 1-5 sections, height, divider, first/last/all pages | partial | One band: left/center/right text, show on/off (PageSetupDialog.tsx:24-36). No sections, heights, dividers, or page-scope option | set_print_options | settings |
| Header/footer content types | Text, Picture/Logo, Gantt Legend, Revision Box, Blank | partial | Text only; legend is a separate strip; no picture/logo/revision box | — | — |
| Header/footer variables | ~30 variables | partial | 9 variables (layout.ts:36) | set_print_options | settings |
| Options: timescale start/finish | Fixed dates or relative | partial | Whole project or custom fixed from/to; no relative (DD-1W) | set_print_options | settings range |
| Options: print activity table / Gantt / both | Choose content | done | content both/table/gantt, table share % | set_print_options | --content |
| Options: columns to print | All or through a column | done | Own list or layout columns; unknown ids reported | set_print_options | --columns |
| Options: Activity Network print | Prints network view | missing | No network printing | — | — |
| Printed bars follow the Bars dialog | Bar styles as on screen | partial | Fixed colours (layout.ts C constant); ui.bars not used; timescale always month/year | — | — |
| Printed timescale follows the on-screen timescale | Timescale format | partial | Always year/month | — | — |
| Group bands, page break per group | Group & Sort page breaks | partial | WBS bands printed; no page break per group | — | --group wbs/none |
| Print Preview | Preview with paging | done | Chromium preview of the SVG pages (print.ts:160) | ui_menu "File > Print Preview" | — |
| Print / Save as PDF | Print or PDF printer | done | App: Chromium printToPDF with real fonts. CLI/MCP: built-in PDF, Helvetica WinAnsi, non-Latin text → "?" (output.ts:41) | ui_menu (user presses Print/Save) | CLI print .pdf/.html; MCP export_pdf |
| Print other windows (WBS, Resource Usage, Assignments, Tracking) | Each view prints its own content | partial | Prints the visible screen with a text header/footer (print.ts:164-182); paper forced to A3 (main.ts:93,125); [Page]/[Pages] removed | ui_menu | — |
| Page Setup saved per layout | Stored with the layout | partial | Kept per computer in localStorage (print.ts:136-144), not per layout | — | — |

### Other exchange

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| Copy grid cells to Excel (Ctrl+C) | Copies selected rows/columns as tab-separated text | missing | Ctrl+C copies activities to an internal clipboard for pasting in the clone only (commands.ts:9-16,167); nothing reaches the OS clipboard | — | — |
| Paste from Excel into the table | Paste into columns | missing | — | — | — |
| Send Project (e-mail) | File > Send Project | missing | No mail/MAPI integration | — | — |
| Layouts import/export (.plf) | Open Layout > Import/Export | missing | Layouts live in the _LAYOUT table only; Open/Save/Save As have no file import/export (EnterpriseDialogs.tsx:1275+) | ui_menu View > Layout | — |
| Reports import/export (.erp) | Reports window Import/Export | missing | Custom reports in _REPORT only | create_report | create_report (session only) |
| Publish project web site / layouts to HTML | Tools > Publish | partial | Printing to HTML exists in CLI/MCP (pagesToHtml); no web-site publisher in the app | — | print --out .html |
| Check Out / Check In | Project to/from XER file | missing | — | — | — |
| Import/export global data (filters, codes, calendars only) | Via XER "Resource only", global XER | missing | — | — | — |

## 12. CLI / MCP surface

### CLI / MCP surface

| Item | P6 behaviour | Clone status | Notes | AI | MCP/CLI |
|---|---|---|---|---|---|
| MCP update_progress rollback | — | done | Rolls back when scheduling fails (server.ts:211-212, 3700bdd) | — | update_progress |
| MCP update_progress null data date | — | partial | `dd(a.data_date)!` returns null for "" or a missing value and passes null to updateProgress (server.ts:209); the schema says required, but this is not enforced | — | update_progress |
| MCP compare / trace_logic | — | done | compare (server.ts:111-128); trace_logic in LOOKUPS (tools.ts:39) and CLI `query trace` | trace_logic | compare, trace_logic, query trace |
| MCP validate checks what will be saved | — | partial | Validates the in-memory DB (server.ts:219), not the bytes `save` writes, so layout drops at the target version are invisible. The CLI can validate the written file | — | validate |
| Export a selected project | Export wizard selection | missing | CLI export and MCP save always write every project (no projIds) | — | — |
| XML version / encoding / MSP output | — | partial | XML version now honoured (327446b). Still no --encoding flag and no MSPDI/MPX writer in CLI/MCP | — | — |
| Import/merge into an existing project | Update Existing | missing | No CLI/MCP import with a plan (new/replace/update); only open as is | — | — |
| JSON shapes CLI vs MCP | — | partial | validate: CLI {file, version, verdict, findings[all]} vs MCP {verdict, counts, findings[≤40, non-info, "where" string]}. schedule: CLI {ok, stats, findings, extra} vs MCP {ok, data_date, finish, stats, warnings[≤30]} | — | — |
| MCP diagnostics truncation | — | partial | brief() drops info findings and caps at 40 (server.ts:78); a file P6 rejects returns opened:false with no handle | — | open_file |
| MCP table-level diff | — | missing | CLI `diff` has no MCP twin | — | CLI diff only |
| AI reads validation / import findings | — | missing | No AI tool returns findings; ui_screen shows only the severity drop-down counts | — | — |

## Live checks in the running app

Playwright `_electron` drove the built app (`dist/` built 18:10:54, which includes ed16126) with a throwaway `--user-data` profile, importing `Sample XERs/cairo festival city.xer` (93 activities, 4 resources, 41 assignments) through the Import wizard. Every menu id in `main/menu.ts` was sent with an activity selected and what opened was recorded; native file dialogs were stubbed. Skipped: Delete, Dissolve, Reset Database, AI Assistant, Print (native print dialog). No console errors, page errors or main-process stderr in the final run.

| Check | Observed |
|---|---|
| Every menu command | Each opens its dialog or view; none is a stub. Submenu parents do nothing (as expected). Report shortcuts (Tools > Reports > Schedule Report …) switch to the Reports window |
| File > New | One-page "Create a New Project": EPS, Project ID, Project Name, Planned Start |
| Admin > Admin Preferences | Opens the same "User Preferences" dialog as Edit > User Preferences: hours per day, decimals, 4 date formats, show time. No tabs |
| Project > Expenses | Stays in Activities and switches Activity Details to its Expenses tab (no Expenses window) |
| View > Show on Top > Activity Usage Profile | Changes the bottom pane to the resource usage profile |
| Activity Details | 14 tabs: General, Status, Resources, Relationships, Predecessors, Successors, Codes, Notebook, Steps, Feedback, WPs & Docs, Expenses, Risks, Summary. Status tab has no Units/Costs sections and no Physical %/Units % fields |
| Project Details | Tabs General, Notebook, Dates, Defaults, Settings, Calculations, Codes, UDFs. Settings has only the critical-activity definition. No Resources, Budget Log, Spending Plan, Budget Summary, Funding tabs |
| Table right-click | Add Activity, Delete, Cut, Copy, Paste, Assign Predecessors/Successors/Resources/Activity Codes, Link Activities, Dissolve, Fill Down, Renumber Activity IDs, Add WBS Element, Columns, Expand All, Collapse All. The same menu appears on a column header (no column-specific items such as sort or hide) |
| Gantt right-click | Activity Details, Trace Logic, Assign x3, Delete Activity, Cut, Copy, Paste, Link, Dissolve, Fill Down, Bars, Bar Chart Options, Timescale, Relationship Lines, Baseline Bars, Activity Labels, Zoom In/Out, Zoom to Fit, Go To Data Date, Go To Selected Activity |
| Ctrl+Numpad + / − | Zoom the timescale (×1.6 per press); rows unchanged. Expand/Collapse All are Ctrl+Shift+= / Ctrl+Shift+− |
| Cut then Paste into another WBS | A1000 moved to WBS 2.2.1 keeping its Activity ID and its successors; toast "Moved 1 activity … relationships kept". (An earlier run on the pre-ed16126 bundle deleted the activity and pasted a new A2880 with no links.) Copy + Paste creates a new activity |
| View > Columns | Two flat lists, 75 columns, no folders; no Notebook, Units % / Cost % complete, Remaining Labor Units, start/duration variance |
| View > Filters | 16 built-in filters chosen by radio button (one at a time), New / Modify / Delete for user filters; Group and Sort tab: WBS, none or one activity code; 5 sort keys |
| View > Bars | 9 fixed bars (colour only), thickness, one label choice; Bar Chart Options: 6 checkboxes |
| Schedule Options | One page (no Advanced tab): ignore external links, open-ended critical, expected finish, progressed-activity logic, Total Float formula (labelled "Calculate float based on"), SS lag from Early/Actual Start, lag calendar, critical definition. No auto-schedule, recalc costs, multiple float paths |
| Level Resources | Level all resources, within float, max % to overallocate, one leveling priority; View Last Log |
| Update Progress | Current and new data date only (no all/selected choice) |
| Enterprise dialogs | EPS, Roles, OBS, Project Codes, Activity Codes, Resource Codes, UDFs (4 subject areas), Calendars, Cost Accounts, Currencies all open with Add/Delete; Portfolios and Resources are windows |
| Toolbar | Open Project, Import, Export, Print; Undo/Redo; Add, Delete, Assign Predecessors; Schedule, Level, Update Progress, Maintain Baselines; Columns, Filters, Group and Sort, Relationship Lines, Zoom In/Out, Expand/Collapse All; Validate File. Not customisable |

One renderer crash ("window process ended: crashed") happened on the pre-ed16126 bundle after ~7 minutes idling on an empty Activities window while View > Expand All was re-sent; a 4-minute reproduction on the current build stayed at ~117 MB and did not crash.
