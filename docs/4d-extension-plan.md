# Plan: 4D in the P6 clone, MCP first

Status: research done, nothing built. Updated 2026-10-20.

## Goal and order

4D means an IFC model linked to the schedule: playing the build sequence, comparing progress against baselines,
rendering videos, and handing ready-linked packages to Navisworks and SYNCHRO.

1. **First, MCP tools.** White Hat IQ's agent does 4D today with its own 9 custom tools. Because the platform already
   writes XER through the clone over MCP, 4D moves into the clone's MCP server the same way, and the custom tools are
   retired one for one.
2. **Later, the desktop app.** An Extensions tab (viewer, linking, timeline, side-by-side) and the built-in assistant use
   the same core code. Nothing in the MCP design depends on them.

The research is kept in `sample 4D/` (untracked: some sources are study-only or academic-only): `SOURCES.md`,
`BINARY-NOTES.md` and a `NOTES.md` per format.

## What the platform does today, and what the clone fixes

| Today (platform tool) | Problem found | In the clone |
|---|---|---|
| `parse_bim_model`, `list_bim_elements`, `bim_takeoff` (web-ifc, GLB cache) | cache keyed on path and modified time; about a 150 MB ceiling | `open_model`, `list_elements`, `quantities`, with the model attached to the project handle and counted in the memory budget |
| `create_4d_links`: rows the LLM writes | no matcher; element and activity IDs not checked; one activity per element (last row wins) | `link_elements` (checked, many-to-many, built/removed/temporary) and `link_by_rules` (a real matcher with preview) |
| `simulate_4d`: HTML file with the model inside as base64 | dates computed **without calendars** while the XER uses them; progress only as a typed % map; no baselines, no actual dates | dates from the clone's own F9 (calendars, actuals, data date), baselines BL1–BL3 and the project baseline, a separate model file |
| `export_4d_video`: two render paths (server Chromium screenshot, browser composite) | frames differ between paths; render jobs held in one process's memory; large files | one renderer, async job, single and side-by-side layouts |
| `export_4d_timeliner`, `export_4d_synchro` | IFC tag property set only; native IFC 4D left to the agent's own script; no import | `export_4d` (Navisworks, SYNCHRO, IFC4 4D) and `import_4d` |
| `model_history`, `ifc_diff` | moved/re-exported elements not re-linked | `relink_model` after a model revision |

## The MCP tools

All tools take the project `handle` and follow the server's existing rules: error codes and hints, `async` jobs for
long work, per-caller undo for link changes, paths inside the roots, and `owner_key` for writes where needed.

### Model
- **`open_model`** `{handle, path, replace?}`: parses the IFC (web-ifc, MPL-2.0) and caches it by content hash. Returns
  schema, element count, storeys, classes, units, geometry status and warnings. Large models run as an `async` job.
- **`list_elements`** `{handle, storey?, class?, where?: [{property, op, value}], linked?: true|false|<activity>,
  fields?, limit, offset}`: each element's GlobalId, class, storey, name, type, material and requested properties.
- **`element_info`** `{handle, guids}`: every property set of the given elements.
- **`quantities`** `{handle, group_by: class|storey|class+storey|material|activity|wbs}`: authored quantities and
  derived volumes. Grouping by activity feeds productivity and duration checks against the BOQ.

### Linking
- **`link_elements`** `{handle, links: [{activity, guids, role?: built|removed|temporary}], mode: add|replace|remove}`:
  - every ID is checked, and the unknown ones are listed;
  - an element may belong to several activities (formwork, then concrete, then finishes);
  - one undoable change.
- **`link_by_rules`** `{handle, rules, dry_run?}`, modelled on Navisworks Auto-Attach and SYNCHRO Auto-Matching:
  - *property equals activity field*: an element property equals the activity's ID, 4D Key UDF, an activity code or
    the name (for example `Pset_X.TaskCode = {activity_id}`);
  - *scope to activity*: a storey plus class (plus a name pattern) goes to an activity or WBS element;
  - *set name*: a Navisworks search set named after the activity.

  `dry_run` returns what each rule would link, conflicts and leftovers, before anything changes.
- **`link_status`** `{handle}`: elements with no link, by class and storey; activities with no elements; elements on
  several activities; links to elements no longer in the model. These gaps are findings the agent reports.
- **`set_4d_keys`** `{handle, from: activity_id|code:<type>|wbs}`: writes a "4D Key" UDF on every activity so the key
  travels inside XER and P6 XML. It is the shared key Navisworks rules and SYNCHRO Auto-Matching use.
- **`relink_model`** `{handle, path}`: after a model revision, re-links elements whose GlobalId changed, matched by
  class, name, storey and geometry box, and reports what could not be matched.

Links are saved with the project:
- a `<project>.4d.json` beside the saved file holds the model path and hash, the links, the rules, the task types and
  the views;
- the 4D Key UDF goes inside the XER.

### Simulation and progress comparison
- **`simulate_4d`** `{handle, date | {from, to, step}, source?: planned|actual|best|baseline:<name>|late}`:
  - returns, at each date, element counts by state (not started, in progress, complete, removed) per storey and class;
  - optionally returns PNG snapshots from named views, so the agent can *look* at the state with vision;
  - `source` follows SYNCHRO's "dates to use": Best is actuals up to the data date plus the forecast after it.
- **`compare_4d`** `{handle, date, against: baseline:<name>|planned, late_means?: start|finish, by?: storey|class|wbs}`:
  the progress comparison professionals use:
  - each element is *ahead*, *on time*, *late*, *not started* or *complete* against the chosen baseline at that date
    (TimeLiner's Early/Late appearance rules);
  - counts and percentages by zone, the elements and activities behind each figure, and planned value vs earned value
    by zone (from the clone's earned value engine and the quantities);
  - critical-path changes between the baseline and the current schedule, for delay narratives.
- **`set_element_status`** `{handle, guids, status: installed|in_progress|not_installed, date}`: element-level progress
  (from site checks or reality capture). It overrides the activity % for those elements and can propose the activity's %
  complete from installed quantity.

### Output
- **`render_4d`** `{handle, kind: video|images|viewer, layout: single|side_by_side, left: <source>, right?: <source>,
  from, to, step, fps, size, view: preset|<saved view>|orbit, overlays: [date, legend, activity_list, gantt_strip,
  s_curve]}`. Async job. Produces:
  - **MP4**, single or **side by side** (baseline left, current/actual right, one playhead, locked cameras, a date on
    each panel). This is the standard monthly-report and claims deliverable;
  - **PNG** frames;
  - **a viewer**: an HTML page plus a separate model file, not base64 inside the page.
- **`export_4d`** `{handle, target, path}`. The targets:
  - **navisworks**:
    - the IFC with a `4D` property set holding each element's key;
    - a search-set XML with one set per activity. Each set is a single condition on the 4D Key property, rather than
      thousands of GlobalId conditions. The format is confirmed from the official nw-exchange 12.0 schema and real
      files: flag bit 64 starts an OR group; plain conditions are ANDed;
    - `timeliner.csv`: Synchronization ID = P6 task_id (stable through updates), Name, Display ID, Planned and Actual
      Start/End, Task Type, User 1 = 4D Key. Planned dates can be the baseline and Actual the current dates, which is
      the usual way to get Planned vs Actual in TimeLiner;
    - `timeliner.mpx` as an alternative;
    - a README with the short click path (import sets, add data source, Rebuild, Auto-Attach "Selection Sets by Task
      Name", choose a simulation view).
  - **synchro**: P6 XML (or XER) with the 4D Key UDF, the IFC with the same key, and a README for Auto-Matching on that
    field.
  - **ifc4d**: IFC4 with a PLANNED `IfcWorkSchedule`, a BASELINE copy per baseline (linked with
    `IfcRelDefinesByObject`, as IfcOpenShell does), `IfcTaskTime` carrying planned and actual dates, `IfcRelSequence`,
    and `IfcRelAssignsToProduct` / `IfcRelAssignsToProcess`. It opens linked in Bonsai and is an open archive copy.
  - **csv**: link table and state-by-date table.
- **`import_4d`** `{handle, path}`:
  - IFC 4D in both styles found in real files: Bonsai's (each element points to its task) and SYNCHRO's (each task
    lists its elements). SYNCHRO's export renames elements `name_(#id)` and changes GlobalIds, so the import maps them
    back by that suffix;
  - Navisworks search-set XML (each set becomes links through its conditions);
  - TimeLiner CSV.

## Colours and states

Defaults follow Navisworks' task types and are editable per project:

| Task type | During | After |
|---|---|---|
| Construct | green | model colour |
| Demolish | red | hidden |
| Temporary | yellow | hidden |

Not started shows ghosted. Comparison colours: early blue, on time green, late red, not started grey.

Keep to 3–6 states, check them for colour-blind viewers, and say plainly whether "late" means a late start (TimeLiner's
meaning) or a late finish.

## Rendering inside the MCP server

The MCP server is a Node process, often with no GPU. The plan:
- Render with three.js in headless Chromium. Encode inside the page with WebCodecs plus mediabunny (MPL-2.0), so ffmpeg
  is no longer needed. Fall back to VP9/WebM if H.264 is missing.
- Frames are stepped one by one (never real time), so a slow machine gives the same video, only later.
- If no Chromium is available, `render_4d` returns the viewer, and the caller (or the desktop app, which has Electron's
  own Chromium) renders it.
- Open decision: bundle Chromium as an engine like the Office crafts (pinned, SHA-checked, roughly 150 MB), or use the
  one the platform already installs (`--chromium-path`).

## Steps

1. **M1: model, links, exports.** Build `open_model`, `list_elements`, `element_info`, `quantities`, `link_elements`,
   `link_by_rules`, `link_status`, `set_4d_keys`, `export_4d` (navisworks, synchro, ifc4d, csv) and `import_4d`, plus
   the `.4d.json` file. This replaces 6 of the platform's 9 tools and fixes the calendar bug, because dates come from
   the clone's F9.
2. **M2: simulation and comparison.** Build `simulate_4d` (state tables plus PNG snapshots), `compare_4d`,
   `set_element_status`, and the viewer output.
3. **M3: video.** Build `render_4d` single and side-by-side, with date, legend, activity list, Gantt strip and S-curve
   overlays, saved views and an orbit camera. This replaces `simulate_4d` (the platform's) and `export_4d_video`.
4. **M4: model revisions.** Build `relink_model` (the replacement for `ifc_diff`) and make links survive model updates.
5. **M5: platform switch-over.** Map each old tool to the new one, run both on the same jobs (Aurora Tower,
   Schependomlaan, FZK-Haus, Duplex), compare results, then retire the custom tools. Update the platform's
   `4d-scheduling` skill to the new tools.
6. **M6: desktop.** An Extensions tab with the viewer, linking by hand and by rules, a timeline bound to the Gantt's date
   line, side-by-side panes, two-bar Gantt (baseline vs current), and the built-in assistant's tools with the cursor.
7. **M7 (optional): automation.** A Navisworks add-in run headless on a PC with a Navisworks licence, to build a fully
   linked NWD; SYNCHRO cloud through the iTwin Schedules API.

## Test data (in `sample 4D/`)

- **Schependomlaan.** One real project with the design IFC, the schedule (MS Project XML: 157 tasks), SYNCHRO's `.sp`
  and a SYNCHRO-exported 4D IFC (49 tasks covering 2,387 elements). Its as-planned event log (about 7,166
  element–task pairs) is a ready **answer key** for testing `link_by_rules`. Its as-built log only marks each element on
  time or too late per week, with no actual dates.
- **Bridge IFC 4.3** (MIT): 354 tasks, 461 sequence links, crews and a calendar inside the IFC.
- **buildingSMART construction-scheduling example**, FZK-Haus and Duplex (A and MEP).
- **Navisworks search-set XMLs** and the official nw-exchange 4.0/11.0/12.0 schemas.
- **TimeLiner CSV and MPX** samples.
- **Small NWD/NWF/NWC files.** Only headers and names can be read; dates and attachments are binary.

## Still to confirm on a real installation

- Navisworks 2025/2026 IFC property naming in search sets: the newer loader's "IFC Attributes / GlobalId" vs the older
  "IfcGUID", and how a custom property set (our `4D` key) is named.
- Whether MPX is still a TimeLiner data source in Navisworks 2025/2026 (CSV certainly is).
- SYNCHRO: direct XER import, and how IFC objects become resources with fields usable in Auto-Matching.
- Rendering: the speed of software WebGL (SwiftShader) for large models in headless Chromium on the platform's host.

## Sources

- Navisworks TimeLiner simulation settings (Planned, Actual, Planned against Actual, Early/Late):
  https://help.autodesk.com/cloudhelp/2025/ENU/Navisworks-Timeliner/files/GUID-E296880A-1607-4755-9A99-D92ECD43463E.htm
- Task types and appearances:
  https://help.autodesk.com/cloudhelp/2025/ENU/Navisworks-Timeliner/files/GUID-102BBA3C-0C3B-46E7-AE9D-238794E0123B.htm
- Gantt planned vs actual:
  https://help.autodesk.com/cloudhelp/2025/ENU/Navisworks-Timeliner/files/GUID-91B08CFD-0B6B-4A2B-A853-BC8E173BA78C.htm
- CSV field mapping:
  https://help.autodesk.com/cloudhelp/2026/ENU/Navisworks-Timeliner/files/GUID-AFE7BC80-7481-48CD-9BAD-A5D804EDF65A.htm
- Auto-Attach rules:
  https://help.autodesk.com/cloudhelp/2026/ENU/Navisworks-Timeliner/files/GUID-2678DD24-97E7-4D7B-80D4-77A448884599.htm
- Search sets export/import:
  https://help.autodesk.com/cloudhelp/2020/ENU/Navisworks/files/GUID-D4B6B835-499E-4C10-BA70-46353B90A0D0.htm
- SYNCHRO dates to use (Best/Actual/Planned/Baseline/Late): https://blog.bentley.com/?p=55101
- SYNCHRO baseline vs actual in side-by-side 3D windows:
  https://communities.bentley.com/products/construction/w/synchro-wiki/41601/how-do-i-compare-baseline-vs-actual-schedules-in-the-4d-model
- SYNCHRO Auto-Matching: https://communities.bentley.com/products/construction/w/synchro-4d-wiki/68682/auto-matching
- 4D in claims (side-by-side as planned / as built, and its limits):
  https://enr.com/articles/8628-case-closed-use-of-4d-bim-tools-has-limits-with-delay-analysis
- 4D colour schemes (Chen et al., ITcon 2013): https://www.itcon.org/2013/1
- IFC work schedule types and task times:
  https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcWorkScheduleTypeEnum.htm ,
  https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/schema/ifcdatetimeresource/lexical/ifctasktime.htm
- IfcOpenShell sequence API (baselines, assign product/process):
  https://github.com/IfcOpenShell/IfcOpenShell/tree/v0.8.0/src/ifcopenshell-python/ifcopenshell/api/sequence
- Schependomlaan dataset: https://github.com/PlumpMath/DataSetSchependomlaan
- web-ifc: https://github.com/ThatOpen/engine_web-ifc · mediabunny: https://github.com/Vanilagy/mediabunny
