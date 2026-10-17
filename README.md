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
- **Activities** window: WBS-banded table + Gantt (actual blue, remaining green, critical red, baseline yellow, data date line, relationship lines; drag from one bar to another to link FS). Bottom tabs: General, Status (Started/Finished, actual dates, remaining duration, % complete, constraints), Resources, Relationships, Predecessors, Successors, Codes, Notebook, Expenses, Summary. Edit cells inline (double-click / F2), Insert adds an activity, Delete deletes. Edit > Link Activities links the selected activities finish-to-start in the order you selected them; Edit > Fill Down (Ctrl+E) copies the current column of the top selected activity to the rest; Edit > Find Next (F3) repeats the last Find. View > Columns also offers each activity code type and activity UDF of the database (Activity Codes: / User Defined Fields:) and the remaining early/late dates, suspend/resume, external dates, float path and leveling priority. View > Filters > New... builds a user filter (Parameter / Is / Value rows, all or any must match; any column including codes and UDFs), saved in the database with the layouts.
- **Tools > Schedule (F9)**: data date + Options (Retained Logic / Progress Override / Actual Dates, float type, lag calendar, open-ended critical, ignore external links, expected finish, critical = float or longest path). **Tools > Schedule Log** shows the P6-style log (open ends, out-of-sequence, constraint violations, negative float, loops).
- **Tools > Update Progress**: moves the data date, auto-statuses activities from planned dates, recomputes remaining durations and resource actuals, then reschedules.
- **Tools > Level Resources**: serial leveler (priority by early start / float / priority, within float, overallocation %).
- **Project > Maintain Baselines**: save/assign/restore/delete baselines; baseline bars and BL columns/variance.
- **Enterprise**: EPS, Resources (rates, max units, calendars, roles), Roles, OBS, Activity Codes, UDFs, Calendars (work week + holidays/exceptions, base calendar inheritance), Cost Accounts, Currencies.
- **Resource Assignments** window with usage profile/spreadsheet; **Reports** (schedule by WBS, critical, lookahead, baseline variance, resource assignments, cost & earned value by WBS, cost by account) → print, PDF, CSV.
- **Microsoft Project**: File > Import / Export also read and write MSPDI XML and MPX; .mpp goes through your installed Microsoft Project (it converts to/from XML in the background).
- **Timesheets** window (periods, entry, submit/approve/reject) and **Tools > Apply Actuals**; **Risks** window (register, probability/impact matrix, Monte Carlo schedule risk analysis); **Enterprise > Project Portfolios**.
- **Resource curves**: an assignment's curve (Resources tab, Curve column) shapes how its units are spread in usage profiles and spreadsheets.
- **AI assistant** (optional, off by default): Edit > AI Assistant Settings: provider (Anthropic, OpenAI, OpenRouter, LM Studio, Ollama or any OpenAI-compatible server), URL, model, API key, plus optional extra headers ("Name: value" per line, stored encrypted) and extra request parameters as JSON (temperature, top_p, max_tokens, ...). The key is encrypted with Windows' protection and kept by the app's background process (never in the project database). When enabled, a strip on the right edge (Ctrl+Shift+A) opens a chat over the Gantt; the assistant reads the open project through lookups (summary, activity search, activity details, WBS, critical path, schedule health, resources), so it works on very large programmes, and activity IDs in its answers jump to the activity. It also teaches: ask how to do something and it gives the steps with this app's real menu paths and explains the P6 idea behind them. With "Let the assistant operate the app" on (the default), ask it to do the task and you watch it happen: a labelled cursor moves to each control, menus open on screen with the item highlighted, fields are typed in, and edits use the same operations as the headless CLI. Every change is one undoable step (Ctrl+Z) and deletions ask first. Project data goes to the provider you choose; use a local server to keep it on your computer.
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
| `query <xer> summary \| find \| activity <ID> \| wbs [code] \| critical \| health \| resources [ID] [--json]` | Read-only lookups (`find` filters: `--text --status --critical --not-critical --wbs --resource --starts-after --starts-before --finishes-after --finishes-before --code [TYPE=]value --max-float --min-float --milestones --sort --limit`; `activity` includes activity codes and UDFs) | 0, 66 not found |
| `review <xer> [--json]` | Planning-reviewer checks (DCMA-style thresholds) graded pass / warn / fail | 0 pass, 1 warnings, 3 failures |
| `validate <xer> [--json]` | What real P6 would do on import, plus saved dates P6 would change on F9 | 0 imports, 1 P6 would fail or drop data, 2 P6 rejects |
| `schedule`, `progress`, `level`, `export`, `diff` | F9, Update Progress, Level Resources, write XER/XML, compare two files | |

**Operations** (`edit --ops`, and the MCP `edit` tool) are a JSON array. Activities are addressed by Activity ID, WBS by
code (or `A.B` path), resources by resource ID, calendars by name, projects by project ID (only needed when the file has
several). Durations and lags are in days (`--hours-per-day`, default 8). Dates are `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.

| op | Fields |
|---|---|
| `add_project` | `id, name, start, must_finish_by?, calendar?` |
| `set_project` | `project?, name?, data_date?, planned_start?, must_finish_by?, calendar?` |
| `add_calendar` | `name, work_week?: {sat: [["07:00","12:00"],["13:00","16:00"]], ...}, holidays?: [dates], work_exceptions?: {date: periods}` |
| `add_holidays` | `calendar, dates` |
| `add_wbs` | `code, name?, parent?` |
| `add_activity` | `id?, name, wbs?, duration_days?, type?, calendar?, constraint?: {type, date}, secondary_constraint?, priority?, start?` |
| `update_activity` | `id, new_id?, name?, wbs?, duration_days?, remaining_days?, type?, calendar?, constraint?, start?, finish?, actual_start?, actual_finish?, percent_complete?, expected_finish?, priority?` |
| `delete_activity`, `dissolve_activity` | `id` (dissolve links its predecessors to its successors, like P6) |
| `add_relationship`, `update_relationship`, `delete_relationship` | `pred, succ, type?: FS\|SS\|FF\|SF, lag_days?` (update: `new_type?`) |
| `add_resource` | `id, name?, type?: labor\|nonlabor\|material, units_per_day?, max_units_per_day?, price_per_unit?, calendar?` |
| `assign_resource`, `unassign_resource` | `activity, resource, units_per_day?, units?` |

Activity types: `task`, `resource_dependent`, `start_milestone`, `finish_milestone`, `level_of_effort`, `wbs_summary`.
Constraints: `start_on`, `start_on_or_after`, `start_on_or_before`, `finish_on`, `finish_on_or_before`,
`finish_on_or_after`, `mandatory_start`, `mandatory_finish`, `alap`, `none`. Edits behave like P6: a typed start sets a
Start On or After constraint, a typed finish changes the duration, a new duration moves the activity's own finish at
once, and relationships that would make a loop are refused.

### MCP server

Configure your agent with a stdio server:

```json
{ "mcpServers": { "p6-clone": { "command": "node", "args": ["/path/to/dist-cli/p6clone-mcp.cjs"] } } }
```

Tools: `open_file`, `new_project`, `list_open`, `edit`, `schedule`, `update_progress`, `level_resources`, `validate`,
`review`, `project_summary`, `find_activities`, `get_activity`, `list_wbs`, `critical_path`, `schedule_health`,
`resource_summary`, `undo`, `save` (XER in any version 5.0-24.12, or P6 XML for a `.xml` path), `close`.
Every tool except `open_file`, `new_project` and `list_open` takes the `handle` they return. Results come back as JSON
(`structuredContent` as well as text). The server reads and writes files where the agent runs, so run it inside the
agent's sandbox.

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
node cli/p6clone.ts diff before.xer after.xer --json
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
