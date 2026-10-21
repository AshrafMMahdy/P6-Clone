<!--
DRAFT for the White Hat IQ platform agent. Replaces the LOB parts of skills/01-scheduler (the takt_planning skill and
the LOB chain build_lob_wbs ... place_lob_geometry) once the platform's LOB tools are retired. Every tool below is the
P6 clone's, registered on the platform as mcp__p6clone__<name>. Mapping and known gaps: docs/lob-switch-over.md.
Not yet tested inside the platform.
-->
# /lob-scheduling

> Plan repetitive work as Line of Balance (location-based): trades moving through locations as flowlines, crews kept
> continuous, collisions avoided, optionally on a takt. Use when the work repeats over floors, units, zones or
> chainage, when the user mentions LOB, flowline, takt, Vico, Tactplan or location-based scheduling. Design,
> procurement and close-out stay CPM in the same file; LOB and CPM link either way.

- **Usage:** `/lob-scheduling [scope, e.g. "the 3 towers' fit-out from level 2, 9 floors each, on a 5-day takt"]`

## Steps

1. **The file.** Open the programme (`open_file`) or start one (`new_project`). Keep the handle and owner_key.
2. **The plan in one call.** `lob_create {id, start, locations, tasks, links}`:
   - locations: `{levels: ["Tower", "Floor"], grid: [3, 9]}` (codes T1, T1F2...), or a tree for irregular buildings;
   - tasks: per trade, the quantity per location (or one for all), the consumption in hours per unit, the crew size;
     the driver says what is held when something changes (crew by default);
   - links: `{pred, succ}` waits in each location for the predecessor there; `location_lag: 1` waits for it one
     location further on as well (on floor n, the predecessor's floor n+1 done: e.g. the slab above poured);
     `buffer_days` for a buffer in time, `buffer_locations` in locations;
     `{pred: <CPM activity>, project: <CPM project>, succ: <task>}` to start a trade after a CPM milestone.
   The answer is the scheduled plan.
3. **Look before you change.** `lob_view`: dates and float per trade, the critical trades, `collisions` (two trades in
   one location at once: add a link or a buffer), `gaps` (a crew waiting: pace it, or change its crew), and `svg` for a
   picture to show the user.
4. **Change in small steps.** `lob_edit {operations}`; read `changes` (every value that moved) and say them. A refusal
   names the value the task's driver holds: change the driver (`set_driver`) or that value, never guess.
   - a faster crew above a floor: `split {task, at}` then `set_crew {task, segment: 2, ...}`;
   - a fixed duration: `set_driver {driver: "duration"}` then `set_duration`; the crew follows in whole people and the
     answer says the reachable total;
   - harder or easier locations: `set_factor` / `set_location_duration`.
5. **Takt (when asked, or when the work is uniform).** `lob_edit set_takt {takt_days, train, buffer_periods}`, then
   `lob_takt` (the balance check: which trade × zone does not fit and what would fit it), then `lob_takt {apply: true}`.
6. **Progress and control.** Progress goes on the activities `<task>-<location>` (`update_progress`, `edit`);
   `lob_forecast` gives each trade's forecast from its actual production and the alarms, nearest first.
7. **Hand-over.** `save` writes the XER (real P6 opens the LOB project as a linked, schedulable project; the plan travels
   inside it) and `<file>.lob.json` beside it. For Tactplan: `lob_export {path}`; from Vico or Tactplan: `lob_import`.

## Checks before you report

- No collisions left unexplained; every crew gap is intended (an ASAP trade) or removed.
- Critical trades named; the finish compared with the CPM milestones it feeds.
- Every number you quote comes from a tool answer (changes, lob_view), never computed by you.
