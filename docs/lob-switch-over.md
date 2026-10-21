# LOB switch-over: the platform's LOB tools to the clone's MCP tools

The White Hat IQ platform plans Line of Balance with its own chain of tools (origin/33-chat-only,
`03 Shared Platform Agents/app/server/tools/scheduler.ts`, engine `shared/schedule-core/lob.ts`). The clone now does
LOB in its MCP server (`mcp/lob.ts`), on its own scheduler, inside the same file as the CPM projects. This page maps
one to the other and says what changes for the platform agent.

## How the work changes

The platform's chain is 7+ calls, each passing large JSON arrays from one tool to the next (WBS, atoms, lines, band
resolutions, classifications, geometry). The clone keeps the plan on the handle: `lob_create` takes the location tree
and the tasks in one call, `lob_edit` changes it with small operations, and every answer lists exactly what moved.
Locations are a hierarchy (up to 6 levels), tasks carry quantities, consumption and crews (durations are computed),
each task holds one driver (crew, rate or duration), and logic has Vico's five layers (task links in every shared
location, coarser-level links, continuity, location lag, location-to-location links) with buffers.

## Tool map

| Platform | Clone | Notes |
|---|---|---|
| `build_lob_wbs {location_axis, construction_groups, domain}` | `lob_create {locations: {levels, grid \| tree \| list}}` | A real hierarchy (Part > Floor > Zone), not a flat axis with display groups. Design and procurement stay a CPM project in the same file. |
| `decompose_lob_activities {activities[{name, trade, band_first, band_last, per_band_duration}]}` | `lob_create {tasks: [...]}` / `lob_edit add_task` | A task gives quantity and consumption (hours per unit) and a crew; the duration per location is computed, not typed. A typed duration: `set_location_duration`, or `driver: duration`. |
| `group_lob_lines`, `prepass_lob_bands`, `reconcile_lob_bands` | (not needed) | Tasks are already one line per trade; locations are named, so there is nothing to reconcile. |
| `sequence_lob_construction {classifications[{line_id, kind, predecessor_line_id}]}` | `lob_edit add_link {pred, succ, type, lag_days, location_lag, buffer_days, buffer_locations, precision, pred_location, succ_location, project}` | Several predecessors per task, any type, lags and buffers; links to a CPM activity (`project`) in either direction. |
| `place_lob_geometry {lines, classifications, axis, anchor}` | (automatic) | Every `lob_create` / `lob_edit` expands the plan into activities and relationships and schedules it with the clone's F9 (calendars, data date, actuals), then makes paced trades continuous. Anchor to a CPM activity: `add_link {pred: <activity>, project: <CPM project>, succ: <task>}`. |
| `apply_schedule_scenario` (LOB rates, starts, sequence) | `lob_edit` (it is undoable) or `evaluate` on the file | A what-if on the LOB activities: `evaluate` with overrides, or an `lob_edit` then `undo`. |
| `crash_lob_schedule {target_makespan}` | `lob_edit set_crew` / `set_duration` on the critical trades (`lob_view critical`) | crash_schedule leaves LOB activities alone (their durations are the plan's); a trade is shortened through its crew or duration, and the answer lists what moved. |
| `record_progress_update`, `compute_execution_status` (LOB handles) | `update_progress` / `edit` (progress on the LOB activities) and `lob_forecast` | Progress is entered on the activities (`<task>-<location>`); `lob_forecast` forecasts from actual production and raises alarms ranked by days to react. |
| Excel "LOB Graph" sheet (`export_workbook`) | `lob_view {svg: path}` | A flowline picture, one line per trade segment, critical trades thicker, data date in red. |
| `skills/01-scheduler/takt_planning.md` (no tool) | `lob_edit set_takt`, `lob_takt` | The balance check names each trade × zone that does not fit and what would fit it; `apply` sizes crews, holds zones to the takt, paces, links the train with buffers. |
| (none) | `lob_import`, `lob_export` | Vico `.dpp` (read) and Tactplan CSVs (both ways). |

Anonymised export of a file with an LOB plan: the plan in the notebook (and `.lob.json`) holds the task, trade, item,
unit, location and level names, so scrub them with `lob_edit rename` (the activities, Location / Trade codes, notebook
and sidecar follow; the old trade values go), not with `edit` renames of the activities or codes, which the next
`lob_edit` puts back. `clear_udfs` keeps the plan's own UDFs unless `udf` names one; `set_project new_id` and
`regenerate_guids` are safe.

`whiq/files`: `lob_import` reads `path`. Read-only: `lob_view`, `lob_forecast`.

## What a P6 user sees

The LOB project is an ordinary P6 project: activities `<task>-<location>` (e.g. `PW-P1F3`) with their durations,
relationships for the plan's logic, start-on-or-after constraints where crews are kept continuous, the activity codes
Location (a hierarchy) and Trade, UDFs LOB Task / Quantity / Consumption / Crew, a project UDF `Schedule Method` =
`LOB (P6 clone)`, and a notebook topic `LOB model (P6 clone)` holding the plan. Real P6 schedules it to the clone's dates.

## Defects found in the platform's LOB tools (for whoever keeps them until the switch)

1. `sequence_lob_construction` returns `{kind, predecessor_line_id}` but `assembleAndPlace`, the skeptic and the
   exporters read `{relationship, predecessor}`: hard links between trades are dropped when the agent follows the tool.
2. The exported dates add the anchor offset a second time (`exports.ts addDays(offset + s)`), and count working days as
   calendar days.
3. The rate multiplier's meaning contradicts itself (one message says above 1 is faster, the tool and skill say below
   1 is faster).
4. The exported CPM links only each package's first band to its predecessor, so a slip on floor 5 of one trade does not
   move floor 5 of the next.

## Gaps on the clone's side

- No LOB-specific crash tool: crash_schedule skips LOB activities; a trade is crashed with `set_crew` / `set_duration`.
- `optimize_schedule` (the reasoner) is not LOB-aware: run it on CPM projects, not to re-sequence an LOB plan.
- Vico logic is not read from `.dpp` files (the samples carry none); timing mode and location direction are not decoded.
- Tactplan's column layouts come from its import dialogs and one real export; the CSV delimiter and quoting were not
  confirmed on a real file (the reader accepts comma, semicolon and tab).
- Real P6 was not available to confirm the notebook survives P6's own re-export; the model is checksummed, rebuilt from
  the activities when damaged, and kept in the `.lob.json` sidecar too.
