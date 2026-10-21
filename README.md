# P6 Clone

A local desktop clone of Primavera P6 Professional, built to test XER / P6 XML files written by a scheduling agent.
It imports, validates, schedules (CPM), progresses, levels and exports schedules the way P6 does, and tells you exactly why P6 would accept or reject a file.

Not affiliated with Oracle. No Oracle code or assets are used.

## Run

```bash
npm install
```

```bash
npm start
```

`npm start` builds `dist/` and opens the app. Projects are stored in a local database file (`%APPDATA%/p6-clone/p6clone-db.json`) and persist between sessions, like P6's database.

**As a normal Windows program:** `npm run package` creates `release/P6 Clone/P6 Clone.exe` (no installer needed) and a shortcut `release/P6 Clone.lnk` with the app icon. Copy the shortcut to your Desktop or Start menu. The packaged app and `npm start` share the same database.

Automation flags: `npm start -- --import "path\file.xer"` opens the Import wizard on that file; `--user-data <dir>` uses a separate database.

## Using it like P6

- **File > Import** (XER or P6 XML): format, type, file, projects (Create New / Replace / Update Existing, target EPS), dictionary options (Keep / Update / Insert New). The file is validated first; a P6-fatal file is refused like P6 does, and **Tools > Import Log** lists every finding with table, row, field and what real P6 would do.
- **Projects** window (EPS tree) → double-click to open; right-click to open several projects together.
- **Activities** window: WBS-banded table + Gantt (actual blue, remaining green, critical red, baseline yellow, data date line, relationship lines, driving links solid and non-driving dotted by relationship free float; drag from one bar to another to link FS). Bottom tabs (Predecessors/Successors show Driving and Relationship Free Float from the saved dates): General, Status (Started/Finished, actual dates, remaining duration, % complete, constraints), Resources, Relationships, Predecessors, Successors, Codes, Notebook, Expenses, Summary. Edit cells inline (double-click / F2), Insert adds an activity, Delete deletes. Edit > Link Activities links the selected activities finish-to-start in the order you selected them; Edit > Fill Down (Ctrl+E) copies the current column of the top selected activity to the rest; Edit > Find Next (F3) repeats the last Find. View > Columns also offers each activity code type and activity UDF of the database (Activity Codes: / User Defined Fields:) and the remaining early/late dates, suspend/resume, external dates, float path and leveling priority. View > Filters > New... builds a user filter (Parameter / Is / Value rows, all or any must match; any column including codes and UDFs), saved in the database with the layouts. View > Show on Bottom > Trace Logic (also on the bar chart's right-click menu) draws the selected activity's predecessors and successors up to 10 levels deep as boxes (driving links solid, non-driving dashed, critical red; optionally driving links only); click a box to trace from it.
- **Tools > Schedule (F9)**: data date + Options (Retained Logic / Progress Override / Actual Dates, float type, lag calendar, open-ended critical, ignore external links, expected finish, critical = float or longest path). **Tools > Schedule Log** shows the P6-style log (open ends, out-of-sequence, constraint violations, negative float, loops).
- **Tools > Update Progress**: moves the data date, auto-statuses activities from planned dates, recomputes remaining durations and resource actuals, then reschedules.
- **Tools > Level Resources**: serial leveler (priority by early start / float / priority, within float, overallocation %).
- **Tools > Check Schedule Report**: P6 Professional's 14 checks with P6's populations and default targets; click an activity to go to it. **Schedule Options > Advanced**: multiple float paths (total or free float, end activity, number of paths) fill Float Path and Float Path Order on F9 as P6 does. **View > Show on Bottom > Activity Usage Profile / Spreadsheet**: planned value, earned value, actual and remaining curves per week or month.
- **Tools > Extensions** (beyond P6, usable without the AI agent): DCMA 14-point (own implementation; PAM 200.1 and other profiles, critical path test, CPLI, BEI), Schedule lint (with fixes you can apply), Crashing (least-cost, Kelley-Walker cut sets), What-ifs (many scenarios compared on copies), Schedule reasoner (the White Hat IQ trained optimiser, run locally: a leveling order and crash modes, checked against P6 leveling), Windows analysis (AACE MIP 3.3 / 3.4 half-step) and Time impact analysis (AACE 52R-06), and 4D (an IFC model linked to the activities: the build by date against any baseline, picking elements to link them to the selected activity, rules, element status, Navisworks / SYNCHRO / IFC4 packages and imports, and videos rendered on this computer's GPU; View > Show on Bottom > 4D View follows the selected activity).
- **Project > Project Details**: General, Notebook (project notebook topics: WBSMEMO on the project's root WBS), Dates, Defaults, Settings, Codes (project codes, PROJPCAT).
- **Project > Maintain Baselines**: save/assign/restore/delete baselines; baseline bars and BL columns/variance.
- **Enterprise**: EPS, Resources (rates, max units, calendars, roles), Roles, OBS, Activity Codes, UDFs, Calendars (work week + holidays/exceptions, base calendar inheritance), Cost Accounts, Currencies.
- **Resource Assignments** window with usage profile/spreadsheet; **Reports** (schedule by WBS, critical, lookahead, baseline variance, resource assignments, cost & earned value by WBS, cost by account) → print, PDF, CSV.
- **Activity Details** also has **Steps** (weighted steps; with Project Details > Calculations "Activity percent complete based on activity steps" they set a physical-% activity's % complete), **Feedback**, **WPs & Docs** (work products and documents with reference number and file/link) and **Risks** (links to the risk register). **Project Details** has **Calculations** (P6's activity and resource-assignment calculation settings) and **UDFs** tabs; the Resources window has a **Codes** tab.
- **Tools > Global Change**: saved change definitions; "If" conditions pick activities like a filter, "Then" sets a column or changes a number (+ - x /); Apply Change shows the Global Change Report (every activity, column, old and new value) and Commit Changes applies it as one undoable step. **Enterprise > Project Codes / Resource Codes**: code types and values.
- **Cut and Paste move activities** like P6 (same Activity IDs, relationships, assignments, codes, steps and notes; new IDs only if they clash in another project). Right-click menus in the table and Gantt chart include Cut / Copy / Paste, Link, Dissolve, Fill Down, Assign Activity Codes and Renumber Activity IDs.
- **Reports** (Tools > Reports): P6's standard reports in groups (Schedule, Progress, Earned Value, Cost, Resources): schedule by WBS, critical, late, not started / in progress / completed, started or finished in the last 30 days, starting in the next 30 days, lookahead, milestones, total float, negative float, constraints, open ends, relationships (with relationship free float and driving), baseline variance, earned value by activity and by WBS, activity cost, WBS cost, cost by account, resource list, assignments by resource and by activity, resource usage by month. **Report Wizard** (subject area: activities, resource assignments, WBS, resources or relationships; columns; filter, including your own filters; group and sort; title and group) saves your reports with the project (Modify, Copy, Delete; one undoable step). **Run Report** outputs as in P6: Print Preview, Direct to Printer, HTML File, ASCII Text File (CSV), plus PDF and Excel; printed reports use Page Setup and print every row with column titles on each page.
- **Earned value** as P6 calculates it (baseline budget at completion; planned value from the baseline dates at the data date; earned value from % complete; actual cost; ETC = remaining cost; EAC, SV, CV, SPI, CPI, VAC, schedule and performance % complete) as activity columns and in the built-in **Earned Value Layout** (View > Layout > Open; also Baseline Comparison and Cost Loading layouts). New default filters: Late Activities, Constrained, Started / Finished in the Last 30 Days, Starting / Finishing in the Next 30 Days.
- **Any language in the schedule**: P6 writes XER in the Windows code page of the computer that exported it (Windows-1256 on Arabic Windows, 1251 Cyrillic, 1253 Greek, 1255 Hebrew, 1250 Central European, GBK / Big5 / Shift_JIS). The clone recognises the code page from the text (so Arabic P6 exports read correctly) and lets you choose it in the import wizard (CLI `--encoding`, MCP `open_file` `encoding`). Exports write the code page P6 would use for the text (Windows-1252, or e.g. 1256 when there is Arabic; UTF-8 only when no single code page holds it), selectable in the export wizard (CLI `--out-encoding`, MCP `save` `encoding`). An MCP handle remembers the encoding its XER / MPX file was read in (UTF-8 with or without BOM, Windows-1256, 1252...), and `save` without `encoding` writes in it, BOM as read, so an opened file comes back the same but for what was edited (and the export date); when the text no longer fits that code page it is written as P6 would and `save` says so in `notes`. A new project, or one read from XML, chooses as above; an explicit `encoding` always wins. P6 XML, Excel and HTML are Unicode; report CSVs carry a byte-order mark for Excel. PDFs from the CLI/MCP embed a TrueType font for non-Latin text, with Arabic letters joined and right-to-left text in visual order (the CLI and MCP ship DejaVu Sans in `fonts/`, copied to `dist-cli/fonts/` by `npm run build:cli`: keep that folder beside the bundles; `--font` / `settings.font_path` / `P6CLONE_FONT` choose another .ttf, e.g. a CJK font, and system fonts are tried last). The desktop app's own printouts use the system's fonts directly.
- **Big files**: an XER of any size up to and beyond 512 MB opens and saves (it is read and written in pieces, never as one string). A parsed file takes about 2x its size in memory; opening it with P6's import checks (validation and the saved-dates comparison) peaks at about 4-5x plus ~175 MB for Node itself. `node scripts/measure-memory.ts [file.xer ...]` prints heap and peak memory per stage.
- **Printing and PDF** (File > Page Setup / Print Preview / Print / Save as PDF): the Activities window prints the whole layout, every row on as many pages as needed, like P6. Page Setup chooses the paper (Letter to A1), orientation, margins and text size; what to print (columns and Gantt chart side by side with an adjustable split, columns only, or Gantt chart only); which columns (any column, in any order, independent of the screen layout); relationship lines, baseline bars, legend, grid lines and the timescale range; header and footer bands (left / center / right) with variables such as [Project Name], [Data Date] and [Page] of [Pages]. Column titles and the timescale repeat on every page. Other windows print what is on screen.
- **Excel** (File > Export to Excel / Import from Excel): P6-style workbook with TASK (activities), TASKPRED (relationships), RSRC (resources) and TASKRSRC (assignments) sheets, field names in row 1 and titles in row 2, durations in days and real Excel dates. Edit it and import it back: new and changed activities, relationships, resources and assignments, "Y" in Delete This Row deletes (a relationship row whose type was edited replaces that relationship; only a new row adds one, so a pair the file holds as SS + FF stays so); the import lists what will change, asks first and is one undoable step. Calculated columns (status, dates, float) are ignored like P6 ignores them.
- **Microsoft Project**: File > Import / Export also read and write MSPDI XML and MPX; .mpp goes through your installed Microsoft Project (it converts to/from XML in the background).
  An MSPDI file opened and saved back keeps everything the clone did not edit, element for element (`core/msp/keep.ts`):
  notes, baselines, fixed costs, deadlines, contours, custom fields and their definitions, outline codes, leaf WBS
  codes, initials, timephased data, the project summary task, blank rows, unassigned assignments, resource calendars,
  views and anything else the file carries, with every task, resource, assignment and calendar UID. An element whose
  inputs were edited is written by the clone (and work figures Microsoft Project derives from it, such as an
  assignment's timephased data, are left for Project to recalculate); elements the file did not have are added only when
  they carry a change; the clone's own custom fields (P6 Activity ID...) are not written into a file that did not have
  them. A task's links are kept one by one: an edit rewrites only the link it changed (type and lag, in that link's own
  lag format, a percentage staying a percentage); links the clone does not import (from summary tasks, other projects)
  stay. An edited calendar keeps its UID, GUID, base calendar, work weeks and exceptions: only the week days whose hours
  changed and the exceptions on changed days are written anew (an exception covering a changed day goes on for its
  other days under its own name, as day ranges). A resource whose calendar changed keeps its own resource calendar,
  which then derives from the new one. Rows are renumbered (ID) below an added or moved task, as Microsoft Project
  does (IDs are row numbers; UIDs never change). A moved leaf keeps its WBS code when the file has a WBS code mask;
  without one Project's WBS code is the outline number, so it follows the new place and `save` says so in `notes`.
  `schedule` leaves Microsoft Project's dates alone while nothing that drives them changed (`kept_msp_dates`), and
  otherwise lists the dates it replaced (`msp_dates_changed`). On a file Microsoft Project scheduled, F9 follows
  Project's rule for started tasks (the remaining work goes on right after the work done, unless the file moves
  remaining work after the status date), so an untouched chain lands where Project put it; a started task whose
  progress was set since (actual dates, remaining duration or % complete, by an edit, Update Progress or a timesheet)
  goes on from the data date as in P6, since the work done the file gave no longer holds; finished tasks keep
  Project's dates. A file the clone wrote from P6 names the P6 build whose rules made its dates (`P6 Schedule Rules`
  custom field definition, e.g. 6.x milestones one minute into a period) and F9 applies them again. Not kept: whitespace between elements and comments
  outside elements; a recurring exception one of whose days was edited (its other days stay, as day ranges).
- **Timesheets** window (periods, entry, submit/approve/reject) and **Tools > Apply Actuals**; **Risks** window (register, probability/impact matrix, Monte Carlo schedule risk analysis); **Enterprise > Project Portfolios**.
- **Resource curves**: an assignment's curve (Resources tab, Curve column) shapes how its units are spread in usage profiles and spreadsheets.
- **AI assistant** (optional, off by default): Edit > AI Assistant Settings: provider (Anthropic, OpenAI, OpenRouter, LM Studio, Ollama or any OpenAI-compatible server), URL, model, API key, plus optional extra headers ("Name: value" per line, stored encrypted) and extra request parameters as JSON (temperature, top_p, max_tokens, ...). The key is encrypted with Windows' protection and kept by the app's background process (never in the project database). When enabled, a softly glowing strip stays on the right edge; clicking it (or Ctrl+Shift+A) opens the chat beside it and the window makes room, so nothing is covered. The panel opens by itself the first time; after that only with "Open on startup" ticked in its header. The message box grows with the text up to 10 lines and then scrolls; the send button is the arrow inside it (Enter also sends); the assistant reads the open project through lookups (summary, activity search, activity details, WBS, critical path, schedule health, resources), so it works on very large programmes, and activity IDs in its answers jump to the activity. It also teaches: ask how to do something and it gives the steps with this app's real menu paths and explains the P6 idea behind them. With "Let the assistant operate the app" on (the default), ask it to do the task and you watch it happen: a labelled cursor moves to each control, menus open on screen with the item highlighted, fields are typed in, and edits use the same operations as the headless CLI. Every change is one undoable step (Ctrl+Z) and deletions ask first. It can also plan from scratch: in an empty app ask for, say, "a schedule for a five-story office building" and it creates the project, the WBS, activities with durations and logic and a calendar, schedules it, checks it, and lists its assumptions (a real run built 95 activities and 137 relationships in about 4 minutes). Before planning it looks through the other projects in the database (list_projects, and any lookup can read a project by ID) to learn how similar work was structured; if one is close, it may copy it (copy_project) and adapt it instead of starting fresh. Copying is its choice, never required, and the past project is never changed. Deletions inside a project the assistant itself created skip the confirmation; anywhere else they still ask. Project data goes to the provider you choose; use a local server to keep it on your computer.
- **What the assistant can do** (with "Let the assistant operate the app" on), each step visible on screen: menus and dialog buttons (`ui_menu`, `ui_click`, `ui_type`, `ui_screen`), select activities, edit the project with the operations below (`edit_project`, one undoable step), read any project in the database (`list_projects`; every lookup takes a project ID), plan a new schedule or copy and adapt a past one, set up printing (`set_print_options`, then Print Preview / Print / Save as PDF for you to press), export or import Excel, and work with reports (`list_reports`, `open_report` shows and reads one, `create_report` plays the Report Wizard step by step, `run_report_dialog` opens Run Report with the output chosen). Lookups: project summary, activity search and details, WBS, critical path, schedule health, resources, earned value. Questions are kept as a conversation per project: it is saved as an append-only log in the app's data folder (`ai-chats/`, never in the project or the XER), comes back when the project is opened again, and is sent to the model so it remembers; Clear context deletes it. A conversation started with no project open moves to the project the assistant creates. Long conversations are trimmed automatically before they are sent.
- **Anthropic keys not scoped to a workspace** need the workspace ID: put `anthropic-workspace-id: wrkspc_...` (or `WORKSPACE-ID: ...`) in Extra headers; the header is sent under the name Anthropic expects.
- **File > Export**: XER (choose P6 version 5.0 … 24.12) or P6 XML. After writing, the clone re-reads the file and validates it.

## Headless P6 for your agent: CLI and MCP server

The same engine as the desktop app, with no window: an agent can create, open, edit, schedule, review and save real
XER files the way a scheduler does in P6. Two front doors, one engine:

- **CLI** (`cli/p6clone.ts`): one command per call; each call reads and writes files. Simplest when the agent can run shell commands.
- **MCP server** (`mcp/server.ts`): projects stay **open in memory** between calls (a 70 MB XER is read once), every change can be **undone**, and nothing touches disk until `save`. Best for long editing sessions on big programmes, or agents that cannot run commands.

Both read XER, P6 XML, Microsoft Project XML and MPX (detected from the content; for P6 XML the XER field-list checks are skipped) and write P6 XML when the output path ends in `.xml`, else XER.

Both run on Node 24 directly. For older Node (18+), or to copy into a sandbox without the repository, build single-file bundles:

```bash
node scripts/build-cli.mjs
```

That writes `dist-cli/p6clone.cjs` and `dist-cli/p6clone-mcp.cjs` (under 1 MB each, no dependencies), plus `dist-cli/models/` and `dist-cli/ort/` (the schedule reasoner's model and its 14 MB WebAssembly runtime with its licences, for `optimize_schedule`; copy them along, or the tool says the model is missing, and `server_status` shows `reasoner.loaded`). The release smoke runs every analysis tool on a bundle folder: `node scripts/release-smoke.mjs dist-cli`.

### CLI

```bash
node cli/p6clone.ts new --id TWR-A --name "Tower A" --start 2026-03-01 --out tower.xer
```

```bash
node cli/p6clone.ts edit tower.xer --ops ops.json --schedule --out tower.xer
```

```bash
node cli/p6clone.ts query tower.xer find --critical --starts-before 2026-06-30 --json
```

```bash
node cli/p6clone.ts review tower.xer --json
```

| Command | What it does | Exit code |
|---|---|---|
| `new --id --name --start --out [--version]` | Empty project: WBS root, default calendar, P6 schedule options | 0 |
| `edit <xer> --ops <file.json \| -> --out <xer> [--schedule] [--data-date] [--hours-per-day 8] [--json]` | Applies operations as **one transaction**; `--schedule` runs F9 after | 0 ok, 65 an operation failed (nothing written) |
| `query <xer> projects \| summary \| find \| activity <ID> \| wbs [code] \| critical \| health \| resources [ID] [--json]` | Read-only lookups (`find` filters: `--text --status --critical --not-critical --wbs --resource --starts-after --starts-before --finishes-after --finishes-before --code [TYPE=]value --max-float --min-float --milestones --sort --limit`; `activity` includes activity codes and UDFs) | 0, 66 not found |
| `review <xer> [--json]` | Planning-reviewer checks (DCMA-style thresholds) graded pass / warn / fail | 0 pass, 1 warnings, 3 failures |
| `validate <xer> [--json]` | What real P6 would do on import, plus saved dates P6 would change on F9 | 0 imports, 1 P6 would fail or drop data, 2 P6 rejects |
| `print <xer> --out s.pdf\|s.html [--settings json] [--paper A3] [--portrait] [--content both\|table\|gantt] [--columns a,b] [--links]` | The Activities printout as a PDF (built in, no browser needed) or HTML; same pages as the app. Settings as in Page Setup (paper, landscape, margins, font_pt, content, table_share, columns, show_links, show_baseline, show_legend, show_grid, range/from/to, header/footer {show,left,center,right}) |
| `reports <xer> [--json]` | The reports available (standard reports by group) |
| `report <xer> <id\|name> [--out r.pdf\|r.html\|r.csv\|r.xlsx] [--definition json] [--weeks N] [--settings json]` | Run a report; without --out it prints the rows. --definition runs a Report Wizard definition (name, subject, columns, filter, group_by, sort_by, sort_desc) |
| `export-excel <xer> --out s.xlsx [--project ID]` | P6-style spreadsheet (TASK, TASKPRED, RSRC, TASKRSRC) |
| `import-excel <xer> <s.xlsx> --out out.xer [--project ID] [--schedule] [--dry-run] [--json]` | Update the project from the spreadsheet in one transaction (exit 65 if a row is refused) |
| `compare <old> <new> [--json]` | Schedule comparison like P6's Claim Digger: projects, WBS (by code path), activities (by Activity ID) and relationships (pred -> succ type) added, deleted or changed, so revisions whose internal ids were renumbered compare cleanly | 0 same, 1 differences, 2 a file P6 rejects |
| `schedule`, `progress`, `level`, `export`, `diff` | F9, Update Progress, Level Resources, write XER/XML, table-level differences by internal id | |

**Operations** (`edit --ops`, and the MCP `edit` tool) are a JSON array. Activities are addressed by Activity ID, WBS by
code (or `A.B` path), resources by resource ID, calendars by name, projects by project ID (only needed when the file has
several). An activity read from Microsoft Project XML or MPX keeps its task UID (`source_uid` in lookups; not written to
XER or P6 XML, and kept when saved back to Microsoft Project) and can be named `uid:<UID>` wherever an activity is.
A WBS element can be named `wbs_id:<id>` (the `wbs_id` that `add_wbs` returns and `list_wbs` shows) wherever a WBS is;
`project` can then be left out. Durations, remaining durations and lags are in days of the activity's own calendar (its
hours per day; lags: the relationship-lag calendar, by default the predecessor's), else `--hours-per-day` (default 8);
`*_hours` fields take hours. Dates are `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.

Every day value the CLI and the MCP server give back uses the same rule (P6's "use assigned calendar to specify the
number of work hours for each time period"), so 5 days on a 10-hour calendar reads back as 5: per activity's calendar
are `orig_days`, `rem_days`, `total_float_days`, `free_float_days` (`get_activity`, `find_activities`,
`critical_path`, `trace_logic`, `schedule_health`), the long-duration and high-float thresholds of `review`, the
duration and float columns of reports, `print` / `export_pdf` and `export_excel` / `import_excel`, and `compare`'s
`original_duration`, `remaining_duration` and `total_float`; on the relationship-lag calendar are `lag_days`,
`rel_free_float_days`, links' `free_float_days`, and the lag / relationship free float columns. `project_summary`
says so in `days_are`; `hours_per_day_used_for_days` is the hours per day used where a calendar has none, and still
the one for units per day and `monte_carlo`'s `impact_days`. Hours fields are unchanged. On an 8-hour calendar
nothing changes. The desktop app keeps P6's default (the setting off): its activity table, the assistant's edits and
its lookups all count every day at the hours per day of Edit > User Preferences.

| op | Fields |
|---|---|
| `add_project` | `id, name, start, must_finish_by?, calendar?` |
| `copy_project` | `from, id, name?, start?, keep_progress?`: copies WBS, activities, logic, assignments, codes, UDFs and notebooks with new internal IDs; by default progress is cleared and `start` moves every planned date by the same amount |
| `set_project` | `project?, name?, data_date?, planned_start?, must_finish_by?, calendar?` |
| `set_schedule_options` | `project?`, then any of `logic` (retained, override, actual), `lag_calendar` (predecessor, successor, 24h, project), `float_type` (start, finish, smallest), `critical` (total_float, longest_path), `critical_float_hours` / `critical_float_days`, `open_ended_critical`, `use_expected_finish`, `ignore_external`, `ss_lag_from_actual_start`: P6's Schedule Options, written to SCHEDOPTIONS / PROJECT and used by every later schedule |
| `add_calendar` | `name, work_week?: {sat: [["07:00","12:00"],["13:00","16:00"]], ...}, holidays?: [dates], work_exceptions?: {date: periods}` |
| `add_holidays` | `calendar, dates` |
| `add_wbs` | `code, name?, parent?` (returns `wbs_id`; a sibling with the same code is refused, as in P6) |
| `delete_wbs` | `code, keep_logic?` (default true): removes the WBS element, its children and their activities, linking the predecessors of the removed work to its successors so the chain stays closed (e.g. removing floors from a copied project) |
| `add_activity` | `id?, name, wbs?, duration_days?, type?, calendar?, constraint?: {type, date}, secondary_constraint?, priority?, start?` |
| `update_activity` | `id, new_id?, name?, wbs?, duration_days?, remaining_days?, type?, calendar?, constraint?, start?, finish?, actual_start?, actual_finish?, percent_complete?, expected_finish?, priority?` |
| `delete_activity`, `dissolve_activity` | `id` (dissolve links its predecessors to its successors, like P6) |
| `set_predecessors` | `activity, links: [{pred, type?, lag_days?}]`: every predecessor of the activity replaced in one step (`[]` removes them) |
| `add_relationship`, `update_relationship`, `delete_relationship` | `pred, succ, type?: FS\|SS\|FF\|SF, lag_days?` (update: `new_type?`). P6 keeps one relationship per pair and type (an SS and an FF between the same two activities, as real P6 files hold them); Microsoft Project one per pair (a project read from an MSPDI / MPX file, also one imported before v0.1.14, known by its task UIDs; the same rule in the desktop app's own relationship commands). One already there is skipped and listed in the result's `warnings`. A relationship that closes a loop refuses the edit (checked once per edit, naming the first that closed one) |
| `add_resource` | `id, name?, type?: labor\|nonlabor\|material, units_per_day?, max_units_per_day? \| max_units_per_hour?, price_per_unit?, calendar?` |
| `assign_resource`, `unassign_resource` | `activity, resource, units_per_day?, units?, curve?`, `allow_duplicate?` (assign a resource already on the activity again, as P6 allows) |
| `add_resource_curve` | `name, values` (21 percentages totalling 100: the start, then each 5% of the assignment's time, like P6 Resource Curves) |
| `update_assignment` | `activity, resource, units?, units_per_day?, remaining_units?, curve?` (resource curve name, `""` = linear) |
| `update_wbs` | `code, new_code?, name?, parent?` (move; `""` = top level) |
| `add_code_type`, `add_code_value`, `assign_code` | activity, project or resource codes (`subject`): `name, scope?, max_length?` (default 20, at most 60; a longer value is refused, never cut)`, values?: [{code, name?, parent?}]`; `type, code, name?, parent?`; `type, value` (`""` removes) on an `activity`, `project` or `resource` |
| `add_udf`, `set_udf` | `name, subject?: activity\|wbs\|project\|resource\|assignment, data_type?: text\|number\|integer\|cost\|start_date\|finish_date`; `udf, value` on an `activity`, `wbs`, `project` or `resource` |
| `set_notebook` | `text, topic?` (default Notes; a topic of that name is reused, else added once; text `""` removes that topic's memo, answering `removed: true` or `false` when there was none, and the topic itself always stays) and `activity` (+`project?`), or `project` alone: the project's notebook, as P6 keeps it (a WBSMEMO on the project's root WBS node, under a topic available for projects and WBS; written to XER and P6 XML `ProjectNote`, shown by `project_summary` as `notebook`). Refused on a Microsoft Project XML / MPX handle (`unsupported_for_format`): Project has no notebook topics, and the clone writes no notebooks to its files |
| `add_cost_account`, `add_expense`, `update_expense`, `delete_expense` | `id, name?, parent?`; `activity, name, account?, budgeted_cost?, actual_cost?, remaining_cost?, units?, price_per_unit?, vendor?, po_number?, description?` |
| `add_step`, `update_step`, `delete_step` | `activity, name, new_name?, weight?, percent_complete?, completed?, description?` (physical % from weighted steps, like P6) |
| `set_estimates` | `activity, min_days?, most_likely_days?, max_days?, distribution?: triangle\|betapert\|uniform\|none` or `clear: true` (for `monte_carlo`) |
| `save_baseline`, `assign_baseline`, `delete_baseline`, `restore_baseline` | `name?, assign_as?`; `baseline, as?: project\|bl1\|bl2\|bl3` (the project baseline P6 stores, and the primary/secondary/tertiary user baselines) |
| `build_baseline` | `project?, name?, assign_as?` (default `project`), `activities: [{activity, start?, finish?, duration_days?, cost?}]`: a baseline copy whose listed activities carry the given baseline values. XER keeps baselines the way P6 does: a PROJECT row whose `orig_proj_id` names its project, and the project's `sum_base_proj_id` |
| `add_eps`/`update_eps`/`delete_eps`, `add_obs`/…, `add_role`/… | `id` (OBS: `name`), `name?, parent?, new_id?` (OBS: `new_name?`); `set_project eps` files a project under an EPS node |
| `update_calendar` | `name, new_name?, work_week?, holidays?, work_exceptions?, remove_exceptions?` |

Activity types: `task`, `resource_dependent`, `start_milestone`, `finish_milestone`, `level_of_effort`, `wbs_summary`.
Constraints: `start_on`, `start_on_or_after`, `start_on_or_before`, `finish_on`, `finish_on_or_before`,
`finish_on_or_after`, `mandatory_start`, `mandatory_finish`, `alap`, `none`. Edits behave like P6: a typed start sets a
Start On or After constraint, a typed finish changes the duration, a new duration moves the activity's own finish at
once, and relationships that would make a loop are refused.

### MCP server

One agent: a stdio server.

```json
{ "mcpServers": { "p6-clone": { "command": "node", "args": ["/path/to/dist-cli/p6clone-mcp.cjs"] } } }
```

Many agents on one machine: one shared **Streamable HTTP** server (MCP 2025-06-18), bound to 127.0.0.1, with a bearer
token and one storage root (every path is taken inside it; `..` and symlinks out of it are refused):

```
node --max-old-space-size=4096 dist-cli/p6clone-mcp.cjs --http --root /data/projects --port 8765 --token $P6CLONE_TOKEN
```

Instead of `--root`, `--automation-read-root DIR` and `--automation-write-root DIR` (the craft forks' flags) fence reads
(read or write root) and writes (write root) apart; relative paths start in the write root (reads: the read root when the
file is there); a save makes missing folders inside the write root. Every file is written atomically (a temporary file
in the same folder, flushed, renamed over the target). On stdin EOF, SIGTERM or SIGINT every project with unsaved
changes is saved as `<name>.recovered-<YYYYMMDD-HHMMSS>.xer` in the write root (else the root, else the project's folder),
each file named on stderr.

Endpoint `POST http://127.0.0.1:8765/mcp` (`GET /health` for liveness). Limits come from the environment:
`P6CLONE_MAX_HANDLES` (8), `P6CLONE_MEM_BUDGET_MB` (3072), `P6CLONE_IDLE_MINUTES` (30), `P6CLONE_MEM_FACTOR` (3: memory reserved per byte of file; a parsed XER takes about 2x). Give Node a heap above the budget; opening a file peaks at about 5x its size for a moment.

**Sharing without dead stops**

- `open_file` / `new_project` return an unguessable `handle` (for any call) and an `owner_key`. In HTTP mode `save`,
  `close` and `undo` with `any_caller: true` need the owner key. A file P6 would reject is refused (`p6_would_reject`,
  with `fatal` findings); `lenient: true` opens it anyway when a project could be read from it, and repairs what it
  safely can: a misspelled key column whose values are unique ids is renamed (e.g. `taskpred_id` -> `task_pred_id`),
  empty, missing or repeated ids that nothing points at get fresh ones. `diagnostics.repaired` lists each repair,
  `diagnostics.not_repaired` what was left, and `still_rejected` says whether a save would still be refused.
  `save {repair: true, path}` then writes a repaired copy P6 imports, to a new path (never the file opened), field by
  field and never by guessing: impossible or unreadable durations from the activity's own other fields (remaining
  duration, planned span), else P6's 5-day default; only actual dates P6 refuses are cleared (unreadable, before 1753,
  a finish before its start), while actuals P6 imports (after the data date, a finish without a start) stay as
  recorded and are listed in `invalid_dates`; codes and flags take P6's defaults; a row is removed only when it cannot
  be identified, with what pointed at it. Every change is listed (`changes`: table, row, key, field, old, new, reason)
  and `check` says whether the copy, opened again, would still be rejected. CCA R03 (30 MB, 16,000 activities):
  lenient open 3 s, repair save 7 s (repair, write, re-open check), re-open 3 s, F9 2 s.
- Answers of tools that can change a project carry `unsaved_changes`. `close` is refused (`unsaved_changes`) while there
  are any, unless `discard: true`.
- Calls on one handle run one at a time, in order; a call that waits too long gets `busy` with `retry_after`.
- Pass `caller` (the bridge stamps it; the HTTP session is the fallback): `undo` and `redo` take back only your own
  changes, and are refused (`undo_conflict`) only when someone else's later change touched the same items.
- At the handle or memory limit the least recently used project is written to a recovery file in
  `<root or the temp folder>/.p6clone-recovery/<pid>-<token>/` (unsaved work included) and comes back by itself on its
  next call, with a `_notice`. Idle projects go the same way after 30 minutes. Nothing is discarded; `list_open` and
  `server_status` show where it is.
- Handles survive a restart and a crash: each project in memory is also written to that folder 2 s after its last
  change (`P6CLONE_CHECKPOINT_MS`) and at exit. The folder holds an owner lock (pid, start token, the process's start
  time: Linux `/proc`, Windows the process's CreationDate through CIM or `wmic`, with a timeout; unknown, the pid alone
  decides). A server starting adopts every folder whose owner is gone (no such process, or that pid started at another
  time), and the shared `index.json` of servers before v0.1.15, by moving it into `adopted/` (one server wins when two
  start at once); their handles come back under their old owner keys. A folder whose owner is alive is never touched.
  Unsaved work is also saved as `<name>.recovered-<time>.xer` at exit.
- Retention: a closed project's file goes to `closed/`; once its project was saved with no unsaved changes after it
  (the saved file exists and is at least as new), it is removed `P6CLONE_RECOVERY_KEEP_DAYS` (7) days after the close.
  Anything with unsaved work, or whose saved file is missing, is kept for ever. An adopted folder goes once every
  project in it has been restored. `server_status` gives `recovery`: the folder, its size (`bytes`,
  `bytes_all_servers`) and `kept_unsaved`, every item kept because it holds unsaved work or its saved file is missing.
- Every error is `{error: {code, reason, next_step, retry_after_ms?}}` with `isError` (also `message`, `hint`,
  `retry_after` in seconds, for one release): `next_step` says what to do next; a failed or cancelled job is an error too. Long work (a big
  `open_file`, `monte_carlo`) can run with `async: true` and `job_status`; any call still running after 25 s turns into
  a job by itself. Oversized results come back as a preview with a note on how to ask for less.
- One `edit` may carry tens of thousands of operations: time and memory grow with their number, not its square (a plan
  rebuilding `129 trial.xer`, 48,355 operations with 21,646 `assign_code` and 19,399 `assign_resource`, applies in about
  15 s at 165 MB peak RSS, undo journal included). Lookups by Activity ID, WBS path and relationship pair are indexed for
  the edit and loops are checked once at its end, so a build of `JWM` (3,560 WBS, 11,426 activities, 32,407
  relationships, 3,393 assignments; 50,808 operations) applies in about 2 s.
- MCP `notifications/cancelled` (or `cancel_job` for a job) stops `open_file`, `save` and `schedule` between their
  phases and `monte_carlo` at once, with error `cancelled`: nothing is kept, no file is written, the memory is freed.

**Breaking changes for MCP clients (2026-10-20)**, made to protect unsaved work:

- `close` refuses with `unsaved_changes` while a project has unsaved changes; pass `discard: true` to close anyway.
- `job_status` for a failed or cancelled job is an error (`isError`), not a successful answer with a failed status.
- `save` with `format: mspdi` or `mpx` on a file holding several projects is refused (`bad_input`) unless `project`
  names one; it no longer writes the first project silently.

Tools: `open_file`, `new_project` (`must_finish_by?`), `list_open`, `server_status`, `job_status`, `cancel_job`, `edit`, `schedule`
(`data_date`, with `project` for one project only; `options` overrides the schedule options for that run;
`break_loops: true` leaves out the links that close loops and returns them in `broken_links`; `loops` lists each
loop's activities either way), `activity_table` (every activity's computed dates, floats, critical and driving flags
and working-day offsets from the data date, as `columns` + `rows`, paged by `offset` / `limit` with no cap),
`compute_schedule` (no handle, nothing kept: start, calendars, activities with predecessors, constraints, milestones
and progress, options; answers the `activity_table` rows plus `loops` and `broken_links`),
`update_progress`, `level_resources` (`within_float`, `over_allocation_pct`, `priority_by` early_start / total_float /
priority, `resources`, `activity_priority` [IDs placed first], `dry_run: true` = the leveled dates `moved` and
per-resource `peaks` with nothing committed), `monte_carlo` (P10-P90, histogram, milestone percentiles, criticality,
sensitivity, risk events from the register or inline `events` [{name, probability, delay_days, activities?}] where no
activities means a project-level delay, `sampler` ratio_normal {mean, std, min_ratio, max_ratio} (default 1.12, 0.28, clipped to [0.3, 4]) or ratio_empirical
{ratios, weight, normal?} (with probability weight a ratio bootstrapped from ratios when there are at least 10, else
the normal: the platform's blended slippage sampler, draw for draw), `re_anchor` (three-point means rescaled to the remaining durations), `deadline` (its probability),
`working_days` from the data date with sigma marks; seeded, the project is not changed; progress in job_status and as
notifications/progress for a progressToken, stopped by notifications/cancelled), `evaluate` (a what-if: `overrides`
edit operations, `options`, `data_date` on a scratch state with no undo entry; finish and its delta, the critical set,
became / no longer critical and the changed rows), `validate`, `review`, `project_summary`,
`find_activities`, `get_activity`, `list_wbs`, `critical_path`, `schedule_health`, `resource_summary`, `list_projects`,
`list_dictionaries` (baselines, codes, UDFs, accounts, calendars, curves, EPS, OBS, roles), `earned_value`,
`trace_logic`, `undo`, `redo`, `save` (XER 5.0-24.12, P6 XML, Microsoft Project XML `format: mspdi`, or MPX; `project`
writes one project, and is required for mspdi/mpx when the file holds several), `export_pdf`,
`export_excel`, `import_excel`, `compare` (`mode: computed`: per activity duration delta, start / finish shift, float
delta, became / no longer critical), `list_reports`, `run_report`, `create_report`, `close`. Schedule analysis: `check_schedule` (P6 Professional's 14 checks), `dcma_14` (profiles, baseline, status date,
contract finish, critical path test, CPLI decided by the contract finish with the baseline figure beside it, BEI), `lint`
(with fixes as edit operations), `float_paths` (P6 multiple float paths, near-critical, paths between two activities),
`progress_curves` (PV, EV, AC, remaining early and late, SPI/CPI per period), `resource_histogram`; `schedule` returns
the P6 schedule log with `log: true`. Recovery: `evaluate_batch` (many what-ifs, the base scheduled once),
`crash_schedule` (least-cost cut sets across parallel paths, every step, `apply`), `optimize_schedule` (the embedded
reasoner; `objective: min_crash_cost` runs crash_schedule). Delay analysis: `windows_analysis` (contemporaneous or
half-step over handles, files, baselines or progress at a data date) and `tia` (fragnet, `keep`); `compare` takes
`baseline` to compare with a baseline in the same file and matches renumbered activities by name. Read-only tools carry
the `readOnlyHint` annotation. Results come back as JSON (`structuredContent` as well as text).

**4D** (an IFC model linked to the schedule; see `docs/4d-extension-plan.md` and `docs/4d-switch-over.md`): `open_model`
(IFC2X3 / IFC4, cached by content; geometry in a child process with web-ifc, which ships in `ifc/` beside the bundle),
`list_elements`, `element_info`, `quantities`, `link_elements` (built / removed / temporary), `link_by_rules`
(property, scope and selection-set rules, `dry_run` first), `link_status`, `set_4d_keys`, `export_4d` (Navisworks
search sets + TimeLiner CSV, SYNCHRO, IFC4 4D in the Bonsai style, links CSV), `import_4d` (IFC 4D, Navisworks search
sets, TimeLiner CSV / xlsx, the TimeLiner inside .nwf / .nwd, SYNCHRO .sp 5.1-6.5, read without those programs),
`simulate_4d` and `compare_4d` (by date, against any saved baseline, with PV / EV by zone), `set_element_status`,
`render_4d` (a viewer page, PNGs or an MP4 / WebM; the page renders on the GPU of whoever opens it, so a GPU-less
server needs no Chromium: the platform's client render drives its `WHIQ4D_EXPORT` hooks), `relink_model` (links survive a
model revision that changes GlobalIds). The links travel with the schedule in `<file>.4d.json`. Optional: `synchro_cloud`
(Bentley iTwin Schedules API, dormant until `BENTLEY_CLIENT_ID` / `BENTLEY_CLIENT_SECRET` are set) and a Navisworks add-in
in `addins/navisworks` (source and build script; needs a Navisworks licence, untested without one).
Server settings for 4D: `P6CLONE_CHROMIUM` (a Chromium or Chrome for `render_4d` images and video on the server; a
tool argument never names a program), `P6CLONE_FFMPEG` (turns a WebM recording into MP4), `P6CLONE_MODEL_CACHE`
(the parsed-model cache, default the OS temp folder) with `P6CLONE_MODEL_CACHE_DAYS` (14) and `P6CLONE_MODEL_CACHE_MB`
(10240). Models count in the memory budget. There is no model size limit of the clone's own: the index streams; a model bigger than `P6CLONE_GEOM_CHUNK_MB` (300),
or one too big for a single web-ifc run (its WebAssembly memory stops at 4 GB), is cut into chunks, each meshed on its
own and merged; past `P6CLONE_VIEW_BATCH` (50,000) elements the display model merges them into a few meshes coloured
per element, and past `P6CLONE_VIEW_MAX_MB` (1024) it draws the most detailed elements as boxes (a 1.7 GB IFC of 2.5
million elements: meshed in 6 chunks in about 4 minutes, a 1.1 GB display model a browser draws). What
bounds a model is the server's memory: give the Node process a heap to match (`--max-old-space-size`,
`P6CLONE_MEM_BUDGET_MB`). Revit `.rvt` files are read once exported to IFC.

Baselines: any number per project (P6 keeps any number; BL1-BL3 are only the ones assigned for display). Tools that
take a baseline accept any saved baseline by name. Microsoft Project XML brings Baseline and Baseline1-10 in as saved
baselines (Baseline as the project baseline, 1-3 as BL1-BL3) and writes them back.

### Other commands

```bash
node cli/p6clone.ts validate "Sample XERs/Tower-A.xer" --json
```

```bash
node cli/p6clone.ts schedule my.xer --data-date 2026-11-01 --out scheduled.xer --version 19.12
```

```bash
node cli/p6clone.ts progress my.xer --data-date 2026-12-01 --out progressed.xer
```

```bash
node cli/p6clone.ts compare Rev0.xer RevA.xer
```

Also `level` and `export --format xer|xml --version <v>`. `validate` exits 0 (P6 would import), 1 (P6 import fails or drops data), 2 (P6 rejects the file).

## How faithful is it

- **XER format**: field layouts per version are taken from 25 real P6 exports in `Sample XERs/` (v5.0–7.0, plus a modern P6 build writing "6.2" format). All 25 re-export byte-for-byte identical. Layouts for 8.x–24.x come from that modern build; tables it never contained fall back to 7.0 layouts (flagged in the Export wizard).
- **Scheduling**: rescheduling the 25 real P6 files reproduces every early/late date and total/free float P6 stored, value for value, on **20 of 25** files (including 11,426- and 5,608-activity programmes). The other 5 were edited after P6 last scheduled them, so no scheduler (P6 included) can reproduce their stored dates; the evidence for each is in [docs/stale-sample-files.md](docs/stale-sample-files.md). `tests/oracle-baseline.json` counts wrong values per file and the test fails if any file gets even one more wrong.
- **Validator** rules were calibrated so every real P6 export imports clean, while agent output is checked for things like misspelled key fields (`taskpred_id`), `%E` written mid-file, invented enum codes, missing project WBS node, malformed calendars, LF line endings, unknown ERMHDR versions.

## Develop

Install the dependencies first (after every pull that changes `package-lock.json`): the schedule reasoner's tests
and `build-cli` need `onnxruntime-web`.

```bash
npm ci
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run e2e
```

Layout: `core/` (pure TypeScript engine: XER, XML, calendars, CPM, progress, resources, leveling, costs, reports), `cli/`, `main/` (Electron), `renderer/` (React UI), `tests/`, `scripts/` (`oracle.ts`, `survey.ts`, `extract-schema.ts`, `explain.ts`, `trace.ts` for investigating scheduling differences; `audit.ts` and `reconstruct-calendar.ts` for proving a file is stale; `package.mjs`).
