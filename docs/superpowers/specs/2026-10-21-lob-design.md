# LOB (location-based scheduling) in the P6 clone: design

Status: built (whiq-v0.1.26): core in `core/lob/`, MCP in `mcp/lob.ts`, desktop in `renderer/views/LobView.tsx`; the platform map in `docs/lob-switch-over.md`. Written 2026-10-21. Research behind it is in the session scratchpad
(`lob-research/vico.md`, `platform.md`, `tactplan.md`); the main sources are listed at the end.

## Intent

Planners build repetitive construction (floors, units, zones, chainage) as Line of Balance: each trade moves through
the locations as a flowline, and the plan is about keeping crews continuous and trades from running into each other.
The tools that did this well are gone or closed: Trimble stopped Vico Office (support ended 2024), Tactplan (Vico's
successor) has no P6 exchange, and Asta's LOB is only a picture of a CPM schedule. Nobody offers a P6-native LOB.

The clone already has everything a planner uses around LOB (calendars, baselines, compare, progress, codes, UDFs,
reports, XER/XML/MSP files, MCP). LOB adds a different engine input (locations, quantities, crews, flowline logic) and
different views (flowline, takt grid), on the same data. It is built in the clone, through MCP and in the desktop app
together, and replaces the White Hat IQ platform's own LOB tools, which the user retires after review.

The user's own experience with Vico (a master's project: 2 parts × 9 floors, 14 trades, converted from an MS Project
CPM schedule, optimised and compared) gives the three things to get right:

1. **Changing the rate partway up a line.** Splitting a flowline at a floor so the floors above run at another rate
   was awkward in Vico.
2. **Rates and crews overwriting each other silently.** Duration = quantity × consumption ÷ (crews × crew size ×
   productivity × hours per day). Changing the crew silently changed the rate, or the other way round, and the user
   had to redo the work more than once.
3. **The interface.** Vico's was dense and dated. The clone looks like P6 elsewhere, but the LOB views should be clean
   and minimal (Tactplan is the reference: white canvas, thin lines, labels along the line, a trade palette).

## Goals

- An LOB project is a project in the clone like any other, kept in the same XER as its CPM projects. Real P6 opens that
  XER and sees ordinary, fully linked projects that schedule to the same dates; the clone sees the LOB model.
- Projects drive each other in any direction: CPM → LOB, LOB → LOB (chain or parallel), LOB → CPM, at task level or
  at location level. One engine schedules them all together.
- Every number that changes because another changed is reported, in the app and in MCP answers.
- An agent builds and edits an LOB plan in a few small calls on a handle, never passing big arrays back and forth.
- Takt planning is supported as options on LOB, with a takt grid view.

## Non-goals (this round)

- Writing Vico `.dpp` files (nothing new reads them). Reading them is in scope (below).
- Mobile progress capture, photos, Last Planner constraints (Tactplan Control territory).
- Locations assigned from the BIM model. Noted as a later tie-in: LOB locations ↔ IFC storeys/zones would give 4D by
  location for free.
- A second scheduling engine. LOB uses the clone's CPM (see Engine).

## Anti-goals (would make it a failure even if it works)

- Any value changing without the user or agent being told.
- LOB dates that disagree with what real P6 computes from the exported XER.
- An XER that real P6 rejects or imports with errors because of LOB data.
- A dense, toolbar-heavy LOB screen.
- A tool chain where the agent copies large JSON from one call into the next (the platform's tools do this, and a
  field-name mismatch between two of them drops the logic between trades).

## Decisions

### Data model

- **Locations**: a hierarchy of up to 6 levels (Vico's limit), with named levels (e.g. Part > Floor > Zone). Each
  location has an order, and may have a quantity weight (row height) and a production factor default.
- **Task** (a trade's work): a location **precision** (the level it runs at, e.g. Floor) and its own **location order**
  (default: the tree order; reversible; copyable from another task). A task × location is an **activity**.
- **Quantities**: a task holds one or more items (quantity per location, unit, consumption in hours per unit). Work in
  a location = Σ quantity × consumption. A zero quantity means no work there (the location is skipped; logic passes
  through).
- **Crew**: number of crews × crew size × productivity, and a calendar (the project's by default).
- **Production factor** per location (default 1): learning curve, difficulty. The explicit slack variable, as in
  Tactplan: edit a location's duration and its factor changes; edit the factor and the duration changes.
- **Driver** (the fix for pain 2): each task states which value is held when another changes: `crew` (duration
  follows), `duration` (crew follows, rounded to whole people, the rounding reported), or `rate`. Derived values are
  shown greyed, inherited values in italics (Tactplan's cue). Every edit returns the list of values it changed
  ("crew 14 → 16; duration Floor 1–9 47 → 41 days").
- **The driver matrix** (my call; the core of pain 2). Terms: *rate* = units per working day of the segment (Vico's
  "production rate", e.g. 353.2 m²/day); *crew* = number of crews × crew size × productivity; a location's duration
  = its work ÷ (crew × hours per day) × its production factor, always.

  | Edited value | Driver `crew` | Driver `rate` | Driver `duration` (segment total) |
  |---|---|---|---|
  | crew (count, size, productivity) | rate and durations follow | refused: "the rate is held; change the driver or the rate" | refused, same wording |
  | rate | refused | crew size follows (rounded up to whole people), durations follow | refused |
  | segment duration (incl. dragging the line's end) | crew size follows (rounded up), rate follows | refused | crew size follows; after rounding the total is the nearest reachable one, reported ("asked 41.0, got 40.3") |
  | quantity or consumption in a location | that location's duration follows | crew follows, all durations of the segment follow | crew follows; the other locations' durations change, and each is reported |
  | one location's duration | its production factor follows | same | same |
  | a production factor | that location's duration follows | same | same |

  "Crew follows" changes the crew size; the number of crews changes only when set directly. Every row's answer lists
  each value that moved, old → new. Takt (below) acts as a duration target per location and goes through the
  `duration` column.
- **Segments** (the fix for pain 1): a task's location order can be split at any location boundary into segments,
  each with its own crew, driver values, and timing option; segments can be merged back. Splitting is one click on a
  boundary in the app and one operation in MCP.

### Logic (Vico's five layers)

1. Task-to-task links (FS/SS/FF/SF, lag) apply in every location both tasks share.
2. A link may be coarser than the tasks (e.g. "roof done in the Part before finishes in that Part").
3. Within a task, each location follows the previous in its order; the timing option says how: **ASAP**, **Paced**
   (continuous crew), or **ASAP + Paced** (default: earliest start that keeps the crew continuous).
4. **Location lag** (+1 = the floor below must be done), within vertical stacks.
5. Specific links from one task-location to another (e.g. Part 2 trades start when Part 1 reaches Floor 3).

**Buffers** (in days or in locations) act as lags in planning and in float, and are absorbed in forecasts.
Cross-project links (CPM ↔ LOB, LOB ↔ LOB) are ordinary relationships and can attach to a task's first or last
location, every location, or one location.

### Engine

LOB with one location is exactly CPM. So the LOB model **expands** into activities (task × location) and
relationships in the clone's database, and the clone's F9 schedules all projects together (calendars, constraints,
actuals, data date, cross-project links). Continuity (Paced) is then applied the way Vico does: for each paced task,
shift its locations later so that there are no idle gaps, without moving its last location; and the shift is written
as start-on-or-after constraints on those activities, so real P6 reproduces the same dates from the XER. Float of a
continuous task is the minimum over its locations (criticality applies to the whole trade).

What must agree with real P6 (my call): early start and finish of every activity, and the project finish, for the
XER as exported. Float differs by design: the clone shows a paced trade's float as the minimum over its locations
(Vico's rule), real P6 shows each activity's own; the export notes this. The start-on-or-after constraints are a
snapshot: after progress and F9 in real P6 they may go stale, and the clone recomputes them on re-import.

**Expanded activities inside the clone** (my call): the LOB model owns their structure. In the Activities window, MCP
`edit` and Global Change, an activity's duration, logic, location and trade are read-only, with the message "set by
the LOB plan: edit it in Extensions > LOB (or lob_edit)". Everything else is editable as usual: progress, notes,
codes, resources, UDFs. Activity IDs are stable: built from the task's code and the location's code, so inserting or
reordering locations never renumbers existing activities, and progress, baselines and compare keep matching.

**Forecast** (my call): kept beside the plan, as Vico does, not written into the activities. F9 schedules the plan with
actuals (P6's meaning). The forecast and control actions live in the LOB model (and its notebook), drawn dashed.

### Storage (one XER, read by both)

- The LOB project is a normal project in the same XER as the CPM projects; links between them are cross-project
  relationships.
- **Flag**: a project UDF `Schedule Method` = `LOB (P6 clone)`. Real P6 shows it as a column; the clone opens the
  project in the LOB extension.
- **Model**: the LOB definition (locations, tasks, segments, quantities, crews, drivers, logic layers, takt settings)
  as JSON in a project notebook topic `LOB model (P6 clone)` (`MEMOTYPE` / `WBSMEMO`). Real P6 imports and shows it as
  a notebook entry and ignores it otherwise.
- **Defensive encoding** (no real P6 is available to test against, so the clone is the reference): the JSON is
  base64 inside a plain `<p>`, which survives P6 rewriting memos as HTML. Above 32 KB it is split over numbered topics
  (`LOB model (P6 clone) 1/3`…). It carries a SHA-256, so the clone detects a truncated or altered model. When the
  model is missing or damaged, the clone rebuilds what it can from the activity codes and UDFs below, says what it
  could not recover, and offers the `<file>.lob.json` sidecar, which is always written beside an XER holding an LOB
  project. "Real P6 imports it without errors" stays unverified: the export uses only tables and fields the clone
  already writes for P6, and the import is checked by the clone's own XER validator.
- **Activities**: hierarchical activity codes `Location` and `Trade`, and activity UDFs for quantity, consumption and
  crew, so a P6 user can group and read them, and the clone can match activities to the model.
- **Coming back from real P6**: activities are the truth for dates and progress; the notebook is the truth for
  structure. The clone reconciles on import and lists every mismatch (an activity added in P6 at a location the model
  does not have, a deleted one, changed durations).
- P6 XML and MS Project XML carry the same flag/notebook/code data where those formats allow; otherwise a
  `<file>.lob.json` sidecar beside the file, as 4D does.

### Takt

Options on an LOB project, not a separate engine: **takt zones** (a location level, or a zone set drawn over the
locations), a **takt time** (durations held to whole takt periods), the **train** (trade order), **takt buffers** (empty
periods), and a **balance check** that names each trade × zone that does not fit the takt and what would make it fit
(crews, split, a different zoning). The takt grid view shows zones × periods coloured by trade.

### Control

Progress per task × location through the existing progress tools (they act on the expanded activities). Forecast from
actual production over a recent window (default 3 weeks) with the planned crew going forward. **Alarms** when a
predecessor's forecast runs into a successor (interference), ranked by days left to react. Baselines are the clone's
existing saved baselines (any number), and the flowline shows plan solid, actual dotted, forecast dashed.

### Desktop

Extensions > LOB, one window per LOB project, linked projects listed at the top.

- **Flowline view**: Y = the location tree (each level a narrow column, collapsible), X = time with non-working days
  shaded. Thin lines, labels along the line, trade colours, red data-date line, critical trade in red.
- **Takt grid**, **Gantt** (the existing one, grouped by location or trade), **crew histogram**.
- **Task panel** (right): General, Locations (order, segments), Quantities, Crew (with the driver), Logic, Progress.
- **Direct manipulation**: drag a line's end to change its duration (the driver decides what absorbs it, and a toast
  says what changed); drag its middle to move it (a start constraint, reported); click a location boundary to split;
  select segments to merge; draw from one task-location to another to make a link (location lag set from the gap).
  Every action is one undoable change.
- **Location tree editor** with Excel paste (validated preview), as Tactplan does.

### MCP

One server, all tools listed (no mode switch: CPM or LOB is a property of a project, and an agent often needs both).
LOB tools carry an `lob_` prefix; the existing tools (schedule, compare, baselines, progress, analysis, save, 4D)
work on LOB projects unchanged. An optional `P6CLONE_TOOLSETS` setting (e.g. `core,analysis,4d,lob`) lets a host load
only some groups.

- `lob_create`: a new LOB project from a location tree and tasks, or **from an existing CPM project** (activities
  grouped by a location code and a trade code into tasks; a dry run shows the grouping). Converting makes a new LOB
  project beside the CPM one, which stays as it was, so the two can be compared (my call).
- `lob_edit`: operations on the handle (add/remove/reorder locations, add task, set quantities, crew, driver, timing,
  split/merge segments, links of all five layers, buffers, takt settings). Answers with every value that changed.
- `lob_view`: a compact view an agent can read: tasks × locations with dates, crews, float, the critical trade,
  collisions and idle gaps; optionally the flowline as an image (the same renderer as the app).
- `lob_takt`: balance check and apply.
- `lob_forecast`: forecast and alarms from progress.
- `lob_import`: Vico `.dpp`, Tactplan CSV/clipboard, Excel.

IDs are assigned by the server; agents name things and make judgements, code does the arithmetic (the platform's
good habit, kept).

### Imports

- Vico `.dpp` (the user has a real one: `GraphisoftControl Project`, zlib-compressed). Read-only; it stays out of the
  repo (local test data, skipped when absent, like the other samples).
- Tactplan, both ways. Tactplan is a web app with no project file; it exchanges data as one CSV (or clipboard
  table) per grid: Locations (ID, Name, Level), Grid (tasks with per-location durations, location precision,
  ASAP/Paced), Quantities, Resources, Costs, Tags, with a chosen decimal separator and date format. The clone reads
  and writes that set (a folder of CSVs). Dependencies have no documented import/export in Tactplan, so links do not
  travel either way: the export says so and lists them for re-entry. Layouts (from Tactplan 2.5.1's import
  dialogs and one real 2023 Grid export seen in a training video; notes in the session's `lob-research/tactplan-csv`):
  Locations `Id, Name, Level, Location level`; Grid `Id, Name, Code, Start date, Finish date, Color, ASAP, Paced,
  Milestone, Location precision`, then one duration column per location under a multi-row header (one row per level;
  empty = not in the task, `*` = another subtask's location; one row per subtask); Quantities `Id, Name, Consumption,
  Unit, Location precision`, then one quantity column per location. Colours `#rrggbbaa`, booleans TRUE/FALSE or 1/0,
  dates and decimals per the chosen options. Unconfirmed: the CSV delimiter and quoting; the reader accepts comma,
  semicolon and tab, and matches columns by header when one is present, else by position.
- Excel round-trip for locations and quantities.

### Platform switch-over

As for 4D: a mapping of the platform's LOB tools (`build_lob_wbs` … `crash_lob_schedule`) to the clone's, and a draft
replacement of its takt and LOB skills. The clone does not have to reproduce the platform's LOB results (its engine
differs, and it has known defects); the comparison says where and why they differ (my call).

## Tests to hold it to

- The user's Vico project rebuilt in the clone: 2 parts × 9 floors, the 14 trades with their quantities, consumption
  and crews. Reference data: the `.dpp` at `D:\Backup\Documents\ConREM\2. Semester 3 & 4 Berlin\1. Semester 3\Case
  Studies 2\Term Project 2 Vico\1. Outputs\2. After Optimization\` (local only, never committed) and the user's
  screenshots of 2024-01-17 (in the session's image folder). Logic is taken from the `.dpp`. Pass bar (my call):
  durations equal to 0.1 working day; dates equal to the day where calendar and logic are decoded, any difference
  explained (e.g. Concrete skeleton 14-04-2025 to 13-02-2026, 324 days; façade the only zero-float trade).
- The exported XER opens in the clone as the same LOB plan, and its activities alone (as real P6 would read them)
  schedule to the same dates.
- Every edit in the driver matrix (crew, duration, rate held; quantity, consumption, crew, factor edited) reports
  exactly what changed and changes nothing else.
- An agent builds a 3-part, 10-floor plan with takt in no more than five calls.

## Left to the builder

The order of building (engine and storage first is the natural one), file layout, the renderer's internals, the
reconcile algorithm's details, keyboard shortcuts, the colour palette, and how the takt zone set is drawn over the
location tree.

## Sources

Kenley & Seppänen, *Location-Based Management for Construction* (2010), ch. 5 and 8; Vico Office R4 Help and Vico
Control 2008 User Guide (web.archive.org); Tactplan help centre (support.tactplan.com, 43 articles) and release notes
1.0.8–2.5.4; Asta Powerproject LOB help; Tommelein et al. 2024 on takt methods; the White Hat IQ platform's LOB tools
(`scheduler.ts`, `shared/schedule-core/lob.ts` on origin/33-chat-only).
