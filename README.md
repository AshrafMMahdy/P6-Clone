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
- **Project > Project Details**: General, Notebook (project notebook topics: WBSMEMO on the project's root WBS), Dates, Defaults, Settings, Codes (project codes, PROJPCAT).
- **Project > Maintain Baselines**: save/assign/restore/delete baselines; baseline bars and BL columns/variance.
- **Enterprise**: EPS, Resources (rates, max units, calendars, roles), Roles, OBS, Activity Codes, UDFs, Calendars (work week + holidays/exceptions, base calendar inheritance), Cost Accounts, Currencies.
- **Resource Assignments** window with usage profile/spreadsheet; **Reports** (schedule by WBS, critical, lookahead, baseline variance, resource assignments, cost & earned value by WBS, cost by account) → print, PDF, CSV.
- **Activity Details** also has **Steps** (weighted steps; with Project Details > Calculations "Activity percent complete based on activity steps" they set a physical-% activity's % complete), **Feedback**, **WPs & Docs** (work products and documents with reference number and file/link) and **Risks** (links to the risk register). **Project Details** has **Calculations** (P6's activity and resource-assignment calculation settings) and **UDFs** tabs; the Resources window has a **Codes** tab.
- **Tools > Global Change**: saved change definitions; "If" conditions pick activities like a filter, "Then" sets a column or changes a number (+ - x /); Apply Change shows the Global Change Report (every activity, column, old and new value) and Commit Changes applies it as one undoable step. **Enterprise > Project Codes / Resource Codes**: code types and values.
- **Cut and Paste move activities** like P6 (same Activity IDs, relationships, assignments, codes, steps and notes; new IDs only if they clash in another project). Right-click menus in the table and Gantt chart include Cut / Copy / Paste, Link, Dissolve, Fill Down, Assign Activity Codes and Renumber Activity IDs.
- **Reports** (Tools > Reports): P6's standard reports in groups (Schedule, Progress, Earned Value, Cost, Resources): schedule by WBS, critical, late, not started / in progress / completed, started or finished in the last 30 days, starting in the next 30 days, lookahead, milestones, total float, negative float, constraints, open ends, relationships (with relationship free float and driving), baseline variance, earned value by activity and by WBS, activity cost, WBS cost, cost by account, resource list, assignments by resource and by activity, resource usage by month. **Report Wizard** (subject area: activities, resource assignments, WBS, resources or relationships; columns; filter, including your own filters; group and sort; title and group) saves your reports with the project (Modify, Copy, Delete; one undoable step). **Run Report** outputs as in P6: Print Preview, Direct to Printer, HTML File, ASCII Text File (CSV), plus PDF and Excel; printed reports use Page Setup and print every row with column titles on each page.
- **Earned value** as P6 calculates it (baseline budget at completion; planned value from the baseline dates at the data date; earned value from % complete; actual cost; ETC = remaining cost; EAC, SV, CV, SPI, CPI, VAC, schedule and performance % complete) as activity columns and in the built-in **Earned Value Layout** (View > Layout > Open; also Baseline Comparison and Cost Loading layouts). New default filters: Late Activities, Constrained, Started / Finished in the Last 30 Days, Starting / Finishing in the Next 30 Days.
- **Any language in the schedule**: P6 writes XER in the Windows code page of the computer that exported it (Windows-1256 on Arabic Windows, 1251 Cyrillic, 1253 Greek, 1255 Hebrew, 1250 Central European, GBK / Big5 / Shift_JIS). The clone recognises the code page from the text (so Arabic P6 exports read correctly) and lets you choose it in the import wizard (CLI `--encoding`, MCP `open_file` `encoding`). Exports write the code page P6 would use for the text (Windows-1252, or e.g. 1256 when there is Arabic; UTF-8 only when no single code page holds it), selectable in the export wizard (CLI `--out-encoding`, MCP `save` `encoding`). P6 XML, Excel and HTML are Unicode; report CSVs carry a byte-order mark for Excel. PDFs from the CLI/MCP embed a TrueType font for non-Latin text, with Arabic letters joined and right-to-left text in visual order (the CLI and MCP ship DejaVu Sans in `fonts/`, copied to `dist-cli/fonts/` by `npm run build:cli`: keep that folder beside the bundles; `--font` / `settings.font_path` / `P6CLONE_FONT` choose another .ttf, e.g. a CJK font, and system fonts are tried last). The desktop app's own printouts use the system's fonts directly.
- **Big files**: an XER of any size up to and beyond 512 MB opens and saves (it is read and written in pieces, never as one string). A parsed file takes about 2x its size in memory; opening it with P6's import checks (validation and the saved-dates comparison) peaks at about 4-5x plus ~175 MB for Node itself. `node scripts/measure-memory.ts [file.xer ...]` prints heap and peak memory per stage.
- **Printing and PDF** (File > Page Setup / Print Preview / Print / Save as PDF): the Activities window prints the whole layout, every row on as many pages as needed, like P6. Page Setup chooses the paper (Letter to A1), orientation, margins and text size; what to print (columns and Gantt chart side by side with an adjustable split, columns only, or Gantt chart only); which columns (any column, in any order, independent of the screen layout); relationship lines, baseline bars, legend, grid lines and the timescale range; header and footer bands (left / center / right) with variables such as [Project Name], [Data Date] and [Page] of [Pages]. Column titles and the timescale repeat on every page. Other windows print what is on screen.
- **Excel** (File > Export to Excel / Import from Excel): P6-style workbook with TASK (activities), TASKPRED (relationships), RSRC (resources) and TASKRSRC (assignments) sheets, field names in row 1 and titles in row 2, durations in days and real Excel dates. Edit it and import it back: new and changed activities, relationships, resources and assignments, "Y" in Delete This Row deletes; the import lists what will change, asks first and is one undoable step. Calculated columns (status, dates, float) are ignored like P6 ignores them.
- **Microsoft Project**: File > Import / Export also read and write MSPDI XML and MPX; .mpp goes through your installed Microsoft Project (it converts to/from XML in the background).
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

That writes `dist-cli/p6clone.cjs` and `dist-cli/p6clone-mcp.cjs` (about 250 KB each, no dependencies).

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
Durations and lags are in days (`--hours-per-day`, default 8). Dates are `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.

| op | Fields |
|---|---|
| `add_project` | `id, name, start, must_finish_by?, calendar?` |
| `copy_project` | `from, id, name?, start?, keep_progress?`: copies WBS, activities, logic, assignments, codes, UDFs and notebooks with new internal IDs; by default progress is cleared and `start` moves every planned date by the same amount |
| `set_project` | `project?, name?, data_date?, planned_start?, must_finish_by?, calendar?` |
| `add_calendar` | `name, work_week?: {sat: [["07:00","12:00"],["13:00","16:00"]], ...}, holidays?: [dates], work_exceptions?: {date: periods}` |
| `add_holidays` | `calendar, dates` |
| `add_wbs` | `code, name?, parent?` |
| `delete_wbs` | `code, keep_logic?` (default true): removes the WBS element, its children and their activities, linking the predecessors of the removed work to its successors so the chain stays closed (e.g. removing floors from a copied project) |
| `add_activity` | `id?, name, wbs?, duration_days?, type?, calendar?, constraint?: {type, date}, secondary_constraint?, priority?, start?` |
| `update_activity` | `id, new_id?, name?, wbs?, duration_days?, remaining_days?, type?, calendar?, constraint?, start?, finish?, actual_start?, actual_finish?, percent_complete?, expected_finish?, priority?` |
| `delete_activity`, `dissolve_activity` | `id` (dissolve links its predecessors to its successors, like P6) |
| `add_relationship`, `update_relationship`, `delete_relationship` | `pred, succ, type?: FS\|SS\|FF\|SF, lag_days?` (update: `new_type?`). P6 keeps one relationship per pair: adding a second (any type) is skipped and listed in the result's `warnings` |
| `add_resource` | `id, name?, type?: labor\|nonlabor\|material, units_per_day?, max_units_per_day?, price_per_unit?, calendar?` |
| `assign_resource`, `unassign_resource` | `activity, resource, units_per_day?, units?` |
| `update_assignment` | `activity, resource, units?, units_per_day?, remaining_units?, curve?` (resource curve name, `""` = linear) |
| `update_wbs` | `code, new_code?, name?, parent?` (move; `""` = top level) |
| `add_code_type`, `add_code_value`, `assign_code` | activity, project or resource codes (`subject`): `name, scope?, max_length?` (default 20, at most 60; a longer value is refused, never cut)`, values?: [{code, name?, parent?}]`; `type, code, name?, parent?`; `type, value` (`""` removes) on an `activity`, `project` or `resource` |
| `add_udf`, `set_udf` | `name, subject?: activity\|wbs\|project\|resource\|assignment, data_type?: text\|number\|integer\|cost\|start_date\|finish_date`; `udf, value` on an `activity`, `wbs`, `project` or `resource` |
| `set_notebook` | `activity, text, topic?` (default Notes; `""` text removes) |
| `add_cost_account`, `add_expense`, `update_expense`, `delete_expense` | `id, name?, parent?`; `activity, name, account?, budgeted_cost?, actual_cost?, remaining_cost?, units?, price_per_unit?, vendor?, po_number?, description?` |
| `add_step`, `update_step`, `delete_step` | `activity, name, new_name?, weight?, percent_complete?, completed?, description?` (physical % from weighted steps, like P6) |
| `set_estimates` | `activity, min_days?, most_likely_days?, max_days?, distribution?: triangle\|betapert\|uniform\|none` or `clear: true` (for `monte_carlo`) |
| `save_baseline`, `assign_baseline`, `delete_baseline`, `restore_baseline` | `name?, assign_as?`; `baseline, as?: project\|bl1\|bl2\|bl3` (the project baseline P6 stores, and the primary/secondary/tertiary user baselines) |
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

Endpoint `POST http://127.0.0.1:8765/mcp` (`GET /health` for liveness). Limits come from the environment:
`P6CLONE_MAX_HANDLES` (8), `P6CLONE_MEM_BUDGET_MB` (3072), `P6CLONE_IDLE_MINUTES` (30), `P6CLONE_MEM_FACTOR` (3: memory reserved per byte of file; a parsed XER takes about 2x). Give Node a heap above the budget; opening a file peaks at about 5x its size for a moment.

**Sharing without dead stops**

- `open_file` / `new_project` return an unguessable `handle` (for any call) and an `owner_key`. In HTTP mode `save`,
  `close` and `undo` with `any_caller: true` need the owner key.
- Calls on one handle run one at a time, in order; a call that waits too long gets `busy` with `retry_after`.
- Pass `caller` (the bridge stamps it; the HTTP session is the fallback): `undo` and `redo` take back only your own
  changes, and are refused (`undo_conflict`) only when someone else's later change touched the same items.
- At the handle or memory limit the least recently used project is written to a recovery file in
  `<root>/.p6clone-recovery` (unsaved work included) and comes back by itself on its next call, with a `_notice`.
  Idle projects go the same way after 30 minutes. Nothing is discarded; `list_open` and `server_status` show where it is.
- Every error is `{error: {code, message, hint, retry_after?}}`: the hint says what to do next. Long work (a big
  `open_file`, `monte_carlo`) can run with `async: true` and `job_status`; any call still running after 25 s turns into
  a job by itself. Oversized results come back as a preview with a note on how to ask for less.
- MCP `notifications/cancelled` (or `cancel_job` for a job) stops `open_file`, `save` and `schedule` between their
  phases and `monte_carlo` at once, with error `cancelled`: nothing is kept, no file is written, the memory is freed.

Tools: `open_file`, `new_project`, `list_open`, `server_status`, `job_status`, `cancel_job`, `edit`, `schedule`
(`data_date`, with `project` for one project only),
`update_progress`, `level_resources`, `monte_carlo` (P10-P90, histogram, milestone percentiles, criticality,
sensitivity, risk events; seeded, the project is not changed), `validate`, `review`, `project_summary`,
`find_activities`, `get_activity`, `list_wbs`, `critical_path`, `schedule_health`, `resource_summary`, `list_projects`,
`list_dictionaries` (baselines, codes, UDFs, accounts, calendars, curves, EPS, OBS, roles), `earned_value`,
`trace_logic`, `undo`, `redo`, `save` (XER 5.0-24.12, P6 XML, Microsoft Project XML `format: mspdi`, or MPX; `project`
writes one project, and is required for mspdi/mpx when the file holds several), `export_pdf`,
`export_excel`, `import_excel`, `compare`, `list_reports`, `run_report`, `create_report`, `close`. Read-only tools carry
the `readOnlyHint` annotation. Results come back as JSON (`structuredContent` as well as text).

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
