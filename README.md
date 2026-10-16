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
- **Activities** window: WBS-banded table + Gantt (actual blue, remaining green, critical red, baseline yellow, data date line, relationship lines; drag from one bar to another to link FS). Bottom tabs: General, Status (Started/Finished, actual dates, remaining duration, % complete, constraints), Resources, Relationships, Predecessors, Successors, Codes, Notebook, Expenses, Summary. Edit cells inline (double-click / F2), Insert adds an activity, Delete deletes.
- **Tools > Schedule (F9)**: data date + Options (Retained Logic / Progress Override / Actual Dates, float type, lag calendar, open-ended critical, ignore external links, expected finish, critical = float or longest path). **Tools > Schedule Log** shows the P6-style log (open ends, out-of-sequence, constraint violations, negative float, loops).
- **Tools > Update Progress**: moves the data date, auto-statuses activities from planned dates, recomputes remaining durations and resource actuals, then reschedules.
- **Tools > Level Resources**: serial leveler (priority by early start / float / priority, within float, overallocation %).
- **Project > Maintain Baselines**: save/assign/restore/delete baselines; baseline bars and BL columns/variance.
- **Enterprise**: EPS, Resources (rates, max units, calendars, roles), Roles, OBS, Activity Codes, UDFs, Calendars (work week + holidays/exceptions, base calendar inheritance), Cost Accounts, Currencies.
- **Resource Assignments** window with usage profile/spreadsheet; **Reports** (schedule by WBS, critical, lookahead, baseline variance, resource assignments, cost & earned value by WBS, cost by account) → print, PDF, CSV.
- **Microsoft Project**: File > Import / Export also read and write MSPDI XML and MPX; .mpp goes through your installed Microsoft Project (it converts to/from XML in the background).
- **Timesheets** window (periods, entry, submit/approve/reject) and **Tools > Apply Actuals**; **Risks** window (register, probability/impact matrix, Monte Carlo schedule risk analysis); **Enterprise > Project Portfolios**.
- **Resource curves**: an assignment's curve (Resources tab, Curve column) shapes how its units are spread in usage profiles and spreadsheets.
- **File > Export**: XER (choose P6 version 5.0 … 24.12) or P6 XML. After writing, the clone re-reads the file and validates it.

## CLI (for your agent)

Same engine as the app, no GUI:

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
