# 4D switch-over: the platform's custom tools to the clone's MCP tools (M5)

Status: mapping and comparison done 2026-10-21. The platform's custom 4D tools are not retired yet; this is the input for
that step. Platform code read from White Hat IQ `origin/33-chat-only` (`03 Shared Platform Agents/app/server/tools/bim.ts`,
`export_4d_video.ts`, `model_history.ts`, `shared/ifc`, `shared/schedule-core/cpm.ts`,
`shared/chat-engine/server/engines/craftSupervisor.ts`, `skills/01-scheduler/4d-scheduling.md`).

The draft replacement skill is in [platform/4d-scheduling-skill.md](platform/4d-scheduling-skill.md).

## How the platform calls the clone

- The clone runs as the platform engine `p6clone`; each tool is registered as `mcp__p6clone__<tool>`.
- Every 4D tool takes the project `handle`. A handle comes from `open_file` (XER, P6 XML, Microsoft Project XML, MPX) or
  `new_project` (when there is only a model). `owner_key` is needed only for `save`, `close` and undoing other callers'
  changes; the 4D edits (`open_model`, `link_*`, `set_4d_keys`, `import_4d`, `set_element_status`, `relink_model`) need
  only the handle, and each is one undoable change.
- The platform supervisor stops a call after 300 s (`WHIQ_ENGINE_CALL_TIMEOUT_S`). Pass `async: true` (then
  `job_status`) for `open_model` on a large model and for `render_4d` video.
- Answers longer than 400,000 characters come back as `{truncated: true, preview}`. Page `list_elements` at 1,000 or
  fewer (a 2,000-element page of Schependomlaan is 448,323 characters).

### `whiq/files`

The supervisor stages the files a call reads into the process's `in/` folder, from the tools/list annotation
`_meta["whiq/files"]` (`mcp/fourd.ts:49`, `mcp/server.ts:560`):

| Tool | Reads | Opens a document |
|---|---|---|
| `open_model` | `path` (the IFC) | no |
| `import_4d` | `path` (IFC 4D, search-set XML, TimeLiner CSV/xlsx, .nwf/.nwd, SYNCHRO .sp) | no |
| `relink_model` | `path` (the revised IFC) | no |

The folder arguments of `export_4d`, `render_4d` and `simulate_4d` (snapshots) are written inside the write root
(`out/`), which the supervisor mirrors into the chat outputs. Two things to know:
- `export_4d` (navisworks, synchro, ifc4d) reads the IFC again from the path `open_model` was given, which is the staged
  copy in `in/`. It is not annotated because it is not an argument. If the engine process was restarted and the staged
  copy is gone, the answer is `model_missing`; run `open_model` again.
- The `<file>.4d.json` sidecar written by `save` holds that same path.

## Tool mapping

The platform has 9 custom 4D tool slots (10 names: `model_history` and `ifc_diff` share one).

| Platform tool (key inputs) | Clone tool(s) and argument mapping | What changes in the result |
|---|---|---|
| `parse_bim_model {path}` | Get a handle first (`open_file` on the schedule, or `new_project {id, start}`), then `open_model {handle, path, geometry?, async?}` | No `model_key`: the model is attached to the project (one per project; a new one replaces it and keeps the links whose elements are still there). `class_counts` is `classes`. `quantity_coverage` (text) is `quantified_elements` (a number). `length_unit` reads `"0.001 m"` or `"1 m (assumed-m)"`. `geometry` is a status word (`ok`, `skipped`, `unavailable`) plus `meshed_elements`, `geometry_failures`, `geometry_note`. New: `header`, `dropped_links`. No `path`/`src` preview fields: the platform must show the model in the Preview pane itself. |
| `list_bim_elements {model_key, storeys[], classes[], limit, offset}` | `list_elements {handle, storey, class, where[], linked, fields[], limit, offset}` | One storey and one class per call (several storeys: several calls). **Class filter changed**: the platform matches the upper-case class exactly (`IFCWALL` does not include `IFCWALLSTANDARDCASE`); the clone matches a prefix in any case (`IfcWall` includes `IfcWallStandardCase`). `total_matches` is `total`; no `returned` or `next_offset` (use `offset + elements.length < total`). Each element adds `type` and `activities`; a missing storey is `""`, not `null`. Default page 200 (platform 500); keep pages at 1,000 or fewer. New filters: `where` on any property (`=`, `!=`, `contains`, `like`), `linked: true / false / <Activity ID>`. |
| `bim_takeoff {model_key, group_by, classes[], storeys[]}` | `quantities {handle, group_by, classes[], storeys[]}` | `group_by` adds `activity` and `wbs`. `classes` is a prefix match. Rows are `{group, count, volume_m3, authored{}}` instead of `{group, elements, authored_quantities, derived_volume_m3, unquantified_elements, provenance, volume_deviation_pct, flag}`. Group keys: `IfcWall \| Level 1` (was `IfcWall @ Level 1`), `(none)` (was `(no storey)` / `(no material)`). `volume_m3` is `0` when there is no geometry (the platform gave `null`). No `unit_caveat` or `totals`. The clone sums exactly; the platform rounded the running sum at each element (see Comparison). |
| `create_4d_links {title, links[{activity_id, guids, rule, confidence}]}` | `link_by_rules {handle, rules, dry_run}` first; `link_elements {handle, links[{activity, guids, role?, profile?}], mode}` for the residue | Links live in the project, not in a `reg_*` register, and are saved beside the file as `<file>.4d.json`. Every activity ID and GlobalId is checked: unknown ones come back as `unknown_activities` / `unknown_guids`. An element may be on several activities (`role`: built, removed, temporary). Review with `link_status` and `list_elements {linked}` instead of `read_register`; correct with `link_elements mode replace/remove` or `undo` instead of `edit_canvas`. Per-link `rule` and `confidence` are not stored (the applied rules are). |
| `simulate_4d {model_key, schedule_id, links_register_id, project_start_date, data_date, title, progress{}}` | `schedule {handle, data_date?}` (F9), then `simulate_4d {handle, date \| from, to, step, source, by}` for the numbers, `compare_4d {handle, against, date, late_means, by}` for behind/ahead, `render_4d {handle, kind: viewer, path, embed?}` for the page | No `schedule_id`, `links_register_id` or `project_start_date`: the handle carries the schedule, the links and the start. Dates come from F9 with calendars, constraints, actuals and the data date (the platform ignored the calendar, see Comparison). The `progress{activity: pct}` map has no equivalent: put progress in the schedule (`edit` `update_activity` with `percent_complete`, `actual_start`, `actual_finish`, then `schedule {data_date}`), or per element with `set_element_status`. "Behind" is now `compare_4d` against a saved baseline (`edit` `save_baseline`), not a % below the planned share. `simulate_4d` returns `{source, frames[{date, counts{not_started, in_progress, complete, removed, temporary, unlinked}, by?, active[]}], step_days}`; the HTML comes from `render_4d` (`index.html`, `viewer4d.js`, `model.glb`, `timeline.json`, or one file with `embed: true`). The platform's `artifact`, `window`, `unmatched_activities` are gone. |
| `export_4d_video {artifact, step: day/week/month, seconds_per_frame, width, height, filename}` | `render_4d {handle, kind: video, path, step: 1/7/30 (days), seconds_per_frame or fps, file_name, format: mp4 \| webm, width, height, layout, left, right, compare, overlays, growth}` | Takes the handle, not an artifact. The Chromium comes from the server's `P6CLONE_CHROMIUM` only (no tool argument names a program). With it: `{rendered: true, written: [<file_name or project-4D>.mp4], frames, mime, fps, size}`, progress per frame, stopped by `cancel_job`. MP4 everywhere: a Chromium without H.264 records WebM, which the server's `P6CLONE_FFMPEG` converts; without ffmpeg the WebM comes back with a `note`. A failed start is `render_failed`. Without a Chromium: `{rendered: false, viewer, client_render: {artifact, hooks: "WHIQ4D_EXPORT", step, width, height}}`; the platform renders that page in the user's browser (its `clientRender4d` drives the same `ready/max/setStep/frame` hooks), and the page carries `WHIQ_4D`. New: side-by-side baseline vs current, comparison colours, growth, Gantt strip and S-curve overlays. |
| `export_4d_timeliner {model_key, schedule_id, links_register_id, project_start_date, title, ifc_path}` | `set_4d_keys {handle}` (once), then `export_4d {handle, target: navisworks, path, planned?, key?}` | Writes `<model>-4D.ifc` (same `WHIQ_4D` property set, `Task` = the 4D key, the Activity ID by default), `<project>-4D-sets.xml` (one search set per activity), `timeliner.csv` (UniqueId = P6 task_id, User 1 = key, planned and actual dates) and `README.txt`. No `-guids.csv` audit list: use `export_4d {target: csv}`. Result `{target, written, activities, elements_tagged, key, planned}` instead of `{files, tasks, elements_tagged, guids_not_in_model, user_steps, limitation}`. `planned: <baseline name>` puts the baseline in Planned and the current dates in Actual. |
| `export_4d_synchro {same as above}` | `set_4d_keys`, then `export_4d {handle, target: synchro, path}` | The schedule is **P6 XML** (`<project>.xml`) carrying the "4D Key" field, not an XER. For an XER, `save {path: "x.xer"}` (the field travels in it). Auto-Matching uses the 4D Key field rather than the task ID. |
| native IFC 4D (skill step 8: `run_code` + ifcopenshell) | `export_4d {handle, target: ifc4d, path, baselines[]}` | One call; no sandbox. IFC4 models only: an IFC2X3 model is refused (`bad_input`). Result `{target, written, tasks, element_links}`. |
| `model_history {path}` | none | Stays on the platform (bucket versions). |
| `ifc_diff {pathA, pathB \| path, versionA, versionB, tolerance_mm, filename}` | `relink_model {handle, path, dry_run: true, tolerance_m}` | Only the summary of the diff (`model_diff`: added, removed, modified, re-identified counts) plus what happens to the links (`kept`, `matched` by name+storey or shape, `lost`). No per-element change list, HTML or JSON report. |
| none | `element_info`, `set_4d_keys`, `import_4d`, `compare_4d`, `set_element_status`, `relink_model` | New. |

## What the platform has that the clone lacks

1. **Model version log** (`model_history`). The clone has no file store; this stays on the platform.
2. **Full model diff report** (`ifc_diff`): per-element changes (geometry, placement, properties, type, material) by
   discipline and storey, quantity deltas per class, the exporter's author per change, an HTML and a JSON report. The
   clone has the same diff code (`core/bim/diff.ts`) but only shows its counts inside `relink_model`.
3. **Takeoff honesty fields** in `bim_takeoff`: `provenance` (authored / derived / missing), `unquantified_elements`,
   the authored-vs-derived volume flag above 10 %, `unit_caveat` and `totals`. `quantities` returns the sums only.
4. **A reviewable register** for links (`read_register`, `edit_canvas`) with a `rule` and `confidence` per row. The
   clone keeps the applied rules, not which rule made which link, and no confidence.
5. **A typed progress map** for the picture (`progress{activity: pct}`). The clone takes progress only from the
   schedule or from `set_element_status`.
6. **Video timing and naming**: done in v0.1.23 (`seconds_per_frame`, `file_name`).
7. **Preview events**: the platform tools emit `preview_update` and publish to `Artifacts/`. The clone writes files into
   the write root; the platform must surface them. A viewer written as a folder (`index.html` plus three files) needs
   the folder served together; `embed: true` gives one file for the Preview pane.
8. **.mpp schedules**: the clone's MCP reads .mpp too (`open_file`, `compare`), through MPXJ with the Java runtime shipped in
   `mpxj/` beside the bundle; no Microsoft Project needed. Saving stays XER, P6 XML, MSP XML or MPX (Project opens MSP XML).
9. **The `WHIQ_4D` check**: the platform's `export_4d_video` refuses an HTML file without the text `WHIQ_4D`. The clone's
   page has the `WHIQ4D_EXPORT` hooks but not that text, so the existing `export_4d_video` cannot be pointed at a
   `render_4d` page as it is. Either the platform starts its client-render job directly from `render_4d`'s
   `client_render` request, or the clone adds the marker. **Done in the clone:** the page carries
   `<meta name="generator" content="WHIQ_4D viewer (P6 clone)">`, so `export_4d_video` accepts it as it is.
10. **Both engines shared three IFC defects**; the clone has fixed them (see Comparison, "Shared defects"). The platform's
    `@whiq/ifc` still has them.

## Comparison

Scripts and outputs are kept in the session scratchpad
(`C:\Users\ashra\AppData\Local\Temp\claude\C--Users-ashra-Downloads-Primavera-P6-Clone\806d7eaf-e86e-466c-8006-e93c5e9f3d6f\scratchpad\m5`):
`compare-models.ts` (index and quantities), `calendar-demo.ts` (dates), `aurora-job.ts` (a platform job replayed),
`edge-cases.ts`, `missed-products.ts`, `missed-walls.ts`, `mm-scale.ts`. The platform side is its own code run with
Node 24: `shared/ifc` (index, geometry worker with web-ifc 0.0.77, class names) and `shared/schedule-core/cpm.ts`, copied
into the scratchpad with only the relative import extensions changed. `bim_takeoff`'s grouping was copied into the
script. The clone side is its MCP tools called in-process (`callTool`).

### Models

| Model | Schema | Elements (platform / clone) | Storeys | Classes that differ | Quantified elements | Meshed | Derived volume m³ (platform / clone) | Authored NetVolume m³ (platform / clone) |
|---|---|---|---|---|---|---|---|---|
| Duplex A (`tests/fixtures/4d/Duplex_A_20110907.ifc`, Revit 2011) | IFC2X3 | 251 / 239 | 4, same names, 0 elements on another storey | platform also counts 6 IfcDoorLiningProperties, 6 IfcWindowLiningProperties | 21 / 21 | 215 / 215 | 1,332.90 / 1,332.88 | none |
| Schependomlaan (`sample 4D/ifc-models/schependomlaan/IFC Schependomlaan.ifc`, ArchiCAD, mm) | IFC2X3 | 3,595 / 3,595 (the file has 3,721) | 6, same | none | 3,318 / 3,318 | 3,504 / 3,504 | 0 / 0 (unit applied twice, below) | 3,378.58 / 3,378.77 |
| FZK-Haus (`sample 4D/ifc-models/ifcopenshell/AC20-FZK-Haus.ifc`, ArchiCAD 20; same file as the platform's `test-projects/ifc-samples/archicad20-fzk-haus.ifc`) | IFC4 | 106 / 89 | 2, same | platform also counts 4 IfcDoorLiningProperties, 5 IfcDoorPanelProperties, 3 IfcWindowLiningProperties, 5 IfcWindowPanelProperties | 89 / 89 | 83 / 83 | 137.07 / 137.12 | 602.50 / 602.49 |
| Aurora Tower (platform `shared/ifc/fixtures/aurora-tower.ifc`, identical to the seed chat's `AT-BIM-001_Aurora_Tower.ifc`) | IFC4 | 464 / 464 | 15, same | none | 0 / 0 | 464 / 464 | 6,537.87 / 6,536.74 | none |
| bSI `construction-scheduling-task.ifc` (STEP comments) | IFC4 (platform: `IFC?`) | 1 / 5 | platform `#265`, clone `Ground Level` | platform loses all 4 IfcWallStandardCase | 0 / 0 | 6 / 6 | 5.44 / 16.76 | none |
| Revit 2021 example (platform `test-projects/ifc-samples/revit2021-example.ifc`, EDM header comment) | IFC2X3 | 116 / 116 | 2, same | none | 0 / 0 | 115 / 115 | 77.99 / 77.93 | none |

Every element both engines index has the same GlobalId, class and storey in both, except on the bSI file, where the
platform names the storey `#265`. Geometry is the same code in both (one web-ifc worker), so meshes and per-element
volumes are identical.

What differs, and why:

- **Property definitions counted as elements: confirmed.** The platform's selection rule (`NOT_ELEMENT` in
  `shared/ifc/stepIndex.ts`) does not exclude `Ifc*Properties`, which carry a GlobalId first. Duplex gets 12 extra
  "elements" (door and window linings), FZK-Haus 17. They have no storey and no geometry, so they show up as unlinked
  residue in the platform's 4D picture and in `list_bim_elements`. The clone excludes them (`[A-Z]*PROPERTIES`).
  Schependomlaan has 37 such definitions; the platform does not count them only because of the line-break defect below.
- **Comment with an apostrophe drops entities: confirmed, and worse than thought.** None of the four named models has a
  STEP comment. On a copy of Duplex with one line `/* Bob's export, checked */` after `DATA;`, the platform indexes **0
  elements and 0 storeys** (the apostrophe opens a string that never closes); the clone indexes 239. A wider platform
  problem shows on a real file: the platform's scanner keeps a comment inside the next statement, so the entity that
  follows any comment is skipped. On buildingSMART's `construction-scheduling-task.ifc` it loses 4 of 5 elements, the
  storey name (it reports `#265`), the schema (`IFC?`) and the unit line (`assumed-m`). The clone skips comments.
- **Derived volume totals** differ by rounding only. The platform's `bim_takeoff` rounds the running sum to 0.01 m³ at
  every element (`r2(g.derivedVolumeM3 + e.derivedVolumeM3)`), so many small elements drift: Aurora IfcColumn 161.72
  vs 160.99 (260 columns), FZK-Haus IfcMember 3.36 vs 3.41, Revit example IfcBeam 0.70 vs 0.63. The same drift is in
  the authored sums (Schependomlaan IfcWall NetVolume 187.45 vs 187.57). The clone sums exactly and rounds once.
- **Speed**: parsing took 0.2–2 s on either side; the clone answers a second time from its content-hash cache.

### Shared defects (both engines; found in this comparison; fixed in the clone, still in the platform)

- **The length unit is applied twice on non-metre models.** web-ifc 0.0.77 already puts the unit factor in each mesh's
  placement matrix (Schependomlaan: column scale 0.001, wall vertices in mm), so the worker's coordinates are metres;
  `parse.ts` then multiplies by the IFC length unit again. On Schependomlaan a wall with an authored NetVolume of
  0.0423 m³ gets a derived volume of 4.2e-11 m³; every derived volume in the model rounds to 0, bounding boxes and
  centroids are 1,000 times too small, and so is the viewer model. Clone: `core/bim/parse.ts:116-125`, `:204`, `:231`.
- **Products with a line break before their Name are missed.** The product test is a regex that allows no whitespace
  between GlobalId, OwnerHistory and Name. Schependomlaan writes some entities as `#224= IFCWALLSTANDARDCASE('…',#25,`
  then the name on the next line: 126 real products are missing from both indexes (101 IfcWallStandardCase, 12
  IfcBuildingElementProxy, 13 IfcDistributionElement; 3,721 in the file, 3,595 indexed). They cannot be listed, linked
  or quantified, and their meshes reach the viewer without a GlobalId. Clone: `core/bim/stepIndex.ts:183`.
  The other eight sample IFCs checked (Duplex A and MEP, FZK-Haus, Aurora, the bSI file, the Revit example, the
  Schependomlaan 4D IFC, the bridge) have no such misses.
- **Conversion-based units are not read.** The bSI file is in inches (`IfcConversionBasedUnit` over METRE); the clone
  reports `1 m` from the METRE unit the inch is built on. Geometry is still right (web-ifc converts), but the reported
  unit and the authored quantities' unit are wrong.

### Calendars: one schedule, platform dates vs the clone's F9

The platform's `simulate_4d` (and `export_4d_timeliner`) call `calculateScheduleWithMetrics(rows, start)` with two
arguments, so the schedule's calendar is ignored: every activity runs Monday to Friday with no holidays.
(`export_4d_synchro` passes the calendar to its XER, so the platform's own SYNCHRO and TimeLiner packages can disagree.)

Schedule: Schependomlaan `Uitvoering Schependomlaan 18-02-2015.xml` (MS Project, 157 activities, 48 relationships, 146
start-on-or-after constraints, project calendar "Prognosekalender verlof / rv / vv" with the builders' summer holiday,
public holidays and rain and frost days). The same activities, durations, logic and constraints were run through the
platform's CPM and through the clone's F9:

| | Clone F9 (calendar) | Platform (`simulate_4d` path) | Clone F9, every activity on a plain Mon–Fri calendar |
|---|---|---|---|
| Project finish | 2015-12-17 | 2015-12-16 | 2015-12-16 |
| Activities with the same finish as the platform | 136 of 157 | — | 157 of 157 |
| Largest finish shift | 67 days | — | 0 |

The control column matches the platform exactly, so the whole difference is the calendar. Examples: "Installateurs"
(A1930), "Metselwerk" (A2120) and "Plaatsen scharnierkap" (A2170) finish 21 days later in the clone (the three-week
summer holiday); "Einde fijne afbouw" (A2510) 67 days later (it starts on 2015-11-10, not 2015-09-07). In the 4D
picture on 2015-10-01 the platform shows 142 activities complete, the clone 139.

### A platform job replayed through the clone: Aurora Tower

Platform seed chat `chat-brfpr3zxng`: the `simulate_4d` artifact it published (`…pasila-helsinki-ntp-.html`, 450 linked
elements on 36 activities) and the XER it wrote through the clone. In the clone: `open_file` (that XER), `schedule`,
`open_model`, `link_elements` with the platform's links, `link_status`, `simulate_4d`, `render_4d`, `export_4d`.

- **An unchecked GlobalId.** The platform's register links `sKYBmGRp7SaN9xzepmL6ls`; the model's element is
  `sKYBmGRp7SoN9xzepmL6ls` (one character mistyped when the links were written). The platform drew 450 "linked"
  elements; the clone linked 449 and reported the bad one in `unknown_guids`. `link_status` then lists 15 unlinked
  elements (9 IfcSlab, 5 IfcColumn, 1 IfcWall) and 115 activities with no elements (design, procurement, MEP).
- **Dates**: all 36 linked activities have the same start and finish (the XER's calendar is a plain 5-day week with no
  holidays). The state counts by date agree except the one phantom element.
- **Outputs**: viewer as four files (`index.html` 45 KB, `viewer4d.js` 855 KB, `model.glb` 516 KB, `timeline.json`
  44 KB) against the platform's single 1.38 MB HTML; without Chromium, `render_4d` video returns the 1.6 MB
  self-contained page and a `client_render` request with the `WHIQ4D_EXPORT` hooks (no `WHIQ_4D` text, see gap 9);
  `export_4d navisworks` tagged 449 elements on 36 activities.
- The seed chat has a second, earlier artifact whose work starts 13 days sooner (2027-06-03 against 2027-06-16, both
  with `project_start_date` 2026-05-20). The XER matches the later one, so that is the one compared.

### Clone defects found (all fixed in whiq-v0.1.21)

Re-checked after the fixes: Schependomlaan indexes all 3,721 products in metres (`tests/ifc-index.test.ts`).

| Where | What | Severity |
|---|---|---|
| `core/bim/parse.ts:116-125`, `:204`, `:231` | Length unit applied twice on mm models (above). Effects in the clone: `quantities` volume 0 and `element_info` geometry 1,000× small on Schependomlaan; `relink_model`'s shape match (`core/bim/relink.ts:29`, 0.05 m size tolerance and 0.5 m centroid window) becomes 50 m / 500 m in real terms, so a lost element can be "matched by shape" to any same-class element of similar size; the diff's 5 mm tolerance becomes 5 m; the viewer model is 1,000× small with the camera about 0.05 m away and a 0.1 m near plane (`viewer4d/viewer.ts:109`, `:132`), so it is probably clipped (not checked in a browser). Inherited from the platform. | high, fixed |
| `core/bim/stepIndex.ts:183` | Products with whitespace or a line break between GlobalId, OwnerHistory and Name are not indexed (126 on Schependomlaan). Inherited from the platform. | high, fixed |
| `core/bim/stepIndex.ts:322` | The comment-stripping regex runs over the whole statement, strings included: a name `'Wall /* old */ 138584'` becomes `'Wall  138584'` (constructed test). The scanner itself handles this case correctly. | low, fixed |
| `mcp/fourd.ts:91` | `list_elements` accepts `limit` up to 5,000, but an answer over 400,000 characters becomes a truncated preview (`mcp/server.ts:543`); on Schependomlaan 2,000 elements already do. | low, fixed |
| `core/bim/render4d.ts:27` | The page has no `WHIQ_4D` text, which the platform's `export_4d_video` requires (gap 9). | low, fixed |
| `core/bim/stepIndex.ts:149` (`IFCSIUNIT` case) | Conversion-based length units (inch, foot) reported as metres. Inherited. | low, fixed |
