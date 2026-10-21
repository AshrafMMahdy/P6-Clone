# Plan: schedule analysis tools for the MCP server

Status: built 2026-10-21 (commits 8ca4597, 62539aa, 5fd2244, 06357f9, 28ecde7, 2d311f2), MCP and desktop
(Tools > Check Schedule Report, Schedule Options > Advanced, Activity Usage Profile, Tools > Extensions). Where the
build differs from this plan:
- Check Schedule has P6 Professional's 14 checks; the dangling start/finish checks (EPPM only) are in `lint`.
- `tia` `against` became `baseline`: the TIA always runs on the current project and reports the impacted variance to
  the chosen baseline's finish (a stored baseline is a snapshot and is not edited).
- `windows_analysis` progress-form updates start from the last update that is a schedule of its own (or the current
  project), never from a stored baseline.
- The reasoner's answer is checked through the clone's P6 leveler and compared with P6 default leveling.

White Hat IQ is moving its own scheduling tools into the clone, so its agent does everything through MCP. Six areas are
missing. The rule for each: **match real P6 first**, then add the platform's extras where they are worth keeping, then
expose it over MCP (and in the desktop app where P6 has it). LOB is out of scope here (after 4D, before the embedded
agent).

Sources: Oracle P6 docs (Check Schedule, Schedule Options, Schedule Log, usage profiles), DCMA PAM 200.1 as quoted by
Deltek Acumen / Bentley / ScheduleReader, AACE 29R-03 and 52R-06, textbook crashing (Kelley–Walker), plus surveys of
the clone and of the platform's code (`dcmaAssessment.ts`, Bellator `dcma14Point.ts`, `scheduleLint.ts`,
`crashGreedy.ts`, `delayRecoveryService.ts`, `claims.ts`, `analyse_paths.ts`, `kpiCalculator.ts`,
`resourceAnalysis.ts`).

## Summary

| # | Area | Real P6 | Clone today | Platform today | New MCP tools |
|---|---|---|---|---|---|
| 1 | Schedule quality | Tools > Check Schedule (16 checks) | `review`: 10 of 14 DCMA, 10 examples | two DCMA versions (Bellator's with profiles) | `check_schedule`, `dcma_14` |
| 2 | Recovery | none (manual) | `evaluate` (one scenario) | greedy crash loop, optimiser | `crash_schedule`, `evaluate_batch` |
| 3 | Delay analysis | none (copies, baselines, Claim Digger) | `compare` computed, `trace_logic` | windows (no driving path), no TIA | `windows_analysis`, `tia` |
| 4 | Float paths | Schedule Options > multiple float paths | longest path only | all paths between two activities | `float_paths` (+ F9 option) |
| 5 | Lint | Schedule Log | loops, open ends (hidden from MCP) | graded lint with fix lists | `lint`, full schedule log |
| 6 | Curves | Activity / Resource Usage profiles | EV snapshot only | EV snapshot, cash S-curve | `progress_curves`, `resource_histogram` |

## 1. Schedule quality: P6 Check Schedule and DCMA 14-point

**What P6 does.** **Tools > Check Schedule Report…** in P6 Professional (Actions > Check Schedule in EPPM). The user
picks checks and targets and gets a report: projects checked, a summary (check, target, %, found, examined, fail flag),
then one section per check listing Project ID, Activity ID and Activity Name. A View > Check Schedule filter shows the
failing activities.

The 16 checks and their default targets:

| Check | Default target |
|---|---|
| Logic | <5% |
| Negative lags | <1% |
| Lags | <5% |
| Long lags (>352 h) | <5% |
| Relationship types | >90% FS |
| Hard constraints (Mandatory Start/Finish) | <1% |
| Soft constraints | <5% |
| Large float (>352 h) | <1% |
| Negative float | <1% |
| Large durations (remaining >352 h) | <5% |
| Invalid progress dates | <1% |
| Resource/Cost | <1% |
| Late activities | <5% |
| BEI | ≥0.95 |
| Dangling start | — |
| Dangling finish | — |

Oracle documents each check's exact population. For example, completed and WBS-summary activities are excluded;
started activities and start milestones need no predecessor; thresholds are in hours from the admin hours per period.
P6 does **not** do Missed Tasks, the Critical Path Test or CPLI.

**DCMA 14-point** (PAM 200.1) differs from P6 in places:
- hard constraints include Start/Finish On and the On-or-Before constraints, not only Mandatory;
- high duration uses baseline duration;
- Missed Tasks: finish later than baseline finish, among tasks baselined to finish by the status date;
- Critical Path Test: add a large slip (e.g. 600 days) to an early critical task, reschedule, and pass only if the
  finish moves by exactly that amount;
- CPLI = (CPL + total float to the baseline or contract finish) ÷ CPL, in working days;
- BEI = tasks completed ÷ tasks baselined to finish by the status date.

**Clone today.** `review` has 10 of the 14 checks, missing Missed Tasks, CPT, CPLI and BEI. It returns up to 10
examples per check and none for leads, lags and relationship types. `schedule_health` repeats it with slightly
different rules. The baselines BEI and missed tasks need are already stored (the project baseline and BL1–BL3).

**Worth keeping from the platform** (Bellator):
- threshold **profiles**: PAM 200.1 base, strict, relaxed, GAO-16-89G, AACE RP 92R-19, NASA, plus per-check overrides
  reported with where each threshold came from;
- leads, lags and relationship types counted per relationship, not per activity;
- evidence ID lists;
- the dynamic float and duration threshold, as an option.

**Tools**
- **`check_schedule`** `{handle, checks?, targets?, project?}`: P6's Check Schedule exactly, with P6's populations and
  defaults. The desktop app gets the same report and filter under Tools.
- **`dcma_14`** `{handle, profile?: pam200|strict|relaxed|gao|aace|nasa, thresholds?, baseline?: project|bl1|bl2|bl3,
  status_date?, target_finish?, cpt_slip_days?: 600, max_ids?}`. All 14 checks. Each returns metric, threshold, its
  source, pass/fail, numerator and denominator, and the offending activities (paged). CPT runs on a scratch copy.
  CPLI uses the baseline or `target_finish`.
- `review` stays and becomes a thin wrapper over `dcma_14`; `schedule_health` is folded in.
- DECM (DCMA's newer 142-test metric set) is left out for now. Its scheduling tests need update history, and the
  official test texts were not available.

## 2. Recovery: crashing and many what-ifs

**What P6 does.** Nothing built in: planners crash by hand (Global Change on durations or units). The standard method
is least-cost crashing:
- cost slope = (crash cost − normal cost) ÷ (normal − crash duration);
- each step shortens the cheapest **cut set**: the activity or activities that shorten **every** critical path at
  once, comparing a shared activity's slope against the sum of one activity per path;
- each step is as long as the smaller of the remaining crash capacity and the float of the next near-critical path;
- stop at the target, when a critical path is fully crashed, or when total cost (direct + indirect + liquidated
  damages) starts rising.

**Clone today.** `evaluate`: one what-if per call (base and scenario CPM inside a journal, rolled back). No crashing.

**Platform today.** `recover_schedule` and `crashGreedy`: shorten the cheapest critical activity by 1 day, reschedule,
repeat. It has a crew floor, locked activities, 5 exit states (SUCCESS / PLATEAU / EXHAUSTED / CAP / ALREADY_MET),
delay classification and a basis-of-recovery note. Weak points:
- no handling of parallel critical paths;
- only final durations come back, not the steps;
- calendar days.

**Tools**
- **`crash_schedule`** `{handle, target_finish | target_days, activities: [{id, min_days, cost_per_day} | {id,
  crash_days, crash_cost}], indirect_cost_per_day?, ld_per_day?, locked?, max_steps?, apply?: false}`:
  - textbook least-cost crashing with cut sets across parallel critical paths;
  - on working calendars;
  - respects progress (only remaining work is crashed);
  - returns **every step** {activities, days, cost, new finish, cumulative direct cost, total cost};
  - stop reason in the platform's 5 states;
  - `apply: true` writes the durations as one undoable change.
- **`evaluate_batch`** `{handle, scenarios: [{name, overrides}], metrics?: [finish, cost, critical, …], top?}`:
  - schedules the base once, then each scenario on a rolled-back journal;
  - returns one compact row per scenario and full details for the best `top`;
  - no MCP round trip per scenario.
- **`optimize_schedule`**: the platform's HRM reasoner, embedded (see below), so no export, run and re-import cycles.

## 3. Delay analysis: windows and time impact

**What P6 does.** No wizard. Planners keep update copies (Maintain Baselines, project copies), compare them (Claim
Digger, baseline variance columns) and set data dates in F9. The standards:
- **AACE 29R-03 MIP 3.3, windows / contemporaneous:** slip per window = forecast completion (or key milestone) in
  update *n* − update *n−1*. The slip is attributed to the activities on the window's driving path that lost time.
- **MIP 3.4, half-step:** update *n−1* with only update *n*'s progress applied. This splits the slip into "from
  progress" and "from logic or duration revisions".
- **AACE 52R-06 time impact analysis:** take the last update before the event, insert a fragnet, reschedule at the same
  data date. Delay = impacted − unimpacted completion.

**Platform today.**
- `analyze_delay_windows`: slip per window from progress logs, but no driving path, calendar days, and responsibility
  left to the agent.
- No TIA tool (done through scenarios).
- `compare_asbuilt_schedule`: variance per activity with a match-by-name fallback.

**Tools**
- **`windows_analysis`** `{handle, windows: [{data_date, progress?: ops} | {update: handle|path|baseline}], milestone?,
  method?: contemporaneous|half_step}`:
  - per window: finish before and after, slip in working days, the driving path at the window's start (real driving
    relationships), the activities on it that lost time, and with half-step the progress/revision split;
  - totals that add up.
- **`tia`** `{handle, fragnet: ops, data_date?, against?: current|baseline:<name>, milestone?, keep?: false}`:
  unimpacted and impacted finish, delay in working days, the path the fragnet drives, activities that became critical.
  The project is unchanged unless `keep`, which saves the impacted schedule as a baseline copy.
- `compare` (computed) gains a match-by-name fallback and can compare against a baseline inside the same file.

## 4. Near-critical paths: P6 multiple float paths

**What P6 does.** **Schedule Options > Advanced:**
- "Calculate multiple float paths", using **Total Float** or **Free Float**;
- "Display multiple float paths ending with" an activity (default: the open end with the most critical float);
- "Number of paths to calculate" (Oracle suggests 10 or fewer).

The results go to the **Float Path** (1 = most critical) and **Float Path Order** columns. Each activity belongs to the
first path that claims it. The algorithms:
- **Total Float:** from the end activity, go back along the predecessor with the most critical relationship total
  float, then forward along the most critical relationship successor total float. Repeat for the next paths.
- **Free Float:** path 1 equals Longest Path (driving relationships back from the latest early finish).

**Clone today.** Longest path and relationship free float are computed. Float Path only shows imported values.

**Platform today.** `analyse_paths` lists every path between two activities and gives near-critical (TF ≤ threshold),
orphans and open ends. Its "driving path" ignores relationship type and lag.

**Tools**
- The F9 option (desktop Schedule Options > Advanced and MCP `schedule` options) fills Float Path and Float Path Order
  exactly as P6 does.
- **`float_paths`** `{handle, count?: 10, end_activity?, method?: total_float|free_float}`: paths with their activities
  in order, path float and finish. Plus `near_critical` (TF ≤ threshold) and, from the platform, `paths_between {from,
  to}` as an extra.

## 5. Lint and the full schedule log

**What P6 does.** The Schedule Log reports:
- **Errors:** loops;
- **Warnings:** no predecessor, no successor, out of sequence, actuals after the data date, milestones with invalid
  relationships;
- **Exceptions:** critical activities, unsatisfied constraints and relationships, external dates;
- **Settings and Statistics** sections.

Check Schedule adds **dangling start** (start not driven by an FS/SS predecessor) and **dangling finish** (finish
drives no FS/FF successor).

**Clone today.** Loops, open ends, out of sequence, Mandatory Start/Finish violations and actuals after the data date
are found, but the MCP `schedule` tool hides the info-level findings. Missing:
- dangling start and finish;
- FS links that could overlap;
- WBS elements with no activities;
- constraint checks beyond MSO/MEO.

**Platform today.** `schedule_lint`:
- a graded score (A+ to F) from network metrics;
- the **ladder rule**: repeated FS chains that should overlap, with a suggested SS + lag and the days saved, simulated
  by CPM;
- disguised orphans: activities hung off the project start;
- redundant links;
- SS abuse.

No empty-WBS or milestone-duration checks. "The five P6 rules from W4.4.14" is dropped: the platform agent confirmed
they are P6's own scheduling behaviour, which F9 already implements.

**Tools**
- MCP `schedule` returns the **full schedule log** (all sections, P6 wording), with each finding's activities.
- **`lint`** `{handle, checks?, profile?: p6|platform, max_ids?}`. P6-grounded checks:
  - dangling start and finish;
  - an FS link that should be SS+lag (an FS with a lead; an SS whose lag is at least the predecessor's duration should
    be FS);
  - WBS with no activities;
  - a milestone with a duration, or a 0-duration task that should be a milestone;
  - all constraint types;
  - LOE or WBS-summary activities on the critical path;
  - lags on a different calendar.

  `profile: platform` adds the graded score, the ladder fixes with CPM-simulated days saved, disguised orphans and
  redundant links.

## 6. Curves and histograms

**What P6 does.**
- **Activity Usage Profile and Spreadsheet** (cost or units, by week or month, per period and cumulative): budgeted,
  actual, remaining early and late (the "banana"), plus **Planned Value and Earned Value curves**.
- **Resource Usage Profile and Spreadsheet:** budgeted or planned, actual, remaining early and late, limit,
  over-allocation, available units.
- How P6 spreads values:
  - actuals evenly from the actual start to the data date, unless stored financial-period data exists (Tools > Store
    Period Performance, which XER holds as financial-period tables);
  - remaining work from the remaining early or late dates, following resource curves;
  - the earned-value admin preference decides the PV basis.
- SPI and CPI are cumulative columns; per-period values are ΔEV/ΔPV and ΔEV/ΔAC.

**Clone today.**
- Earned value at the data date only;
- resource usage per day, week or month in the desktop app, but over MCP only a monthly report;
- the Activity Usage Profile menu opens the wrong pane.

**Platform today.** EV at one status date (with TCPI and VAC), a cash S-curve from caller-supplied numbers, a manpower
histogram in the export workbook, and over-allocation severity in Bellator. Neither system has per-period SPI or CPI.

**Tools**
- **`progress_curves`** `{handle, period: week|month, from?, to?, units?: cost|hours, baseline?}`:
  - per period and cumulative: PV, EV, AC, remaining early and late, per-period and cumulative SPI and CPI, plus TCPI,
    EAC and VAC at the data date;
  - computed with P6's spreading rules, using stored financial-period values when the XER has them;
  - optional PNG chart and Excel output.
- **`resource_histogram`** `{handle, resources?, roles?, period, show?: [budgeted, actual, remaining_early,
  remaining_late], cost?}`: per period units or cost, limit, over-allocation (with the platform's severity) and
  available units; optional chart.
- Desktop: fix the Activity Usage Profile and add the PV/EV curves.

## Order

1. **Quality** (`check_schedule`, `dcma_14`): mostly assembling what exists, and the first thing the platform calls on
   every schedule.
2. **Lint and the full log**: shares populations with item 1.
3. **Float paths and true driving paths**: needed by delay analysis and crashing.
4. **Curves and histograms.**
5. **`evaluate_batch`, then `crash_schedule`**: crashing runs on the batch evaluator.
6. **`windows_analysis` and `tia`**: build on driving paths, baselines, compare and evaluate.

Each step comes with tests against real P6 output where we have it (the sample XERs with stored float paths and
progress), then a switch-over on the platform.

## Platform switch-over

| Platform tool | Replaced by |
|---|---|
| `dcma_assess`, `bellator_dcma14` | `dcma_14` (and `check_schedule`) |
| `schedule_lint` | `lint` with `profile: platform` |
| `recover_schedule` (crash part), `crashGreedy` | `crash_schedule` |
| `apply_schedule_scenario`, what-if loops | `evaluate`, `evaluate_batch` |
| `analyze_delay_windows` | `windows_analysis` |
| fragnet scenarios | `tia` |
| `compare_asbuilt_schedule` | `compare` (computed, name fallback) |
| `analyse_paths` | `float_paths` |
| `compute_execution_status` EVM | `earned_value` + `progress_curves` |
| `bellator_resource_analysis` | `resource_histogram` |
| `forecast_finish` | `monte_carlo` (P10–P90, deadline probability, ratio samplers matching the platform's, since v0.1.14–16) |
| the platform's `optimize_schedule` (reasoner over onnxruntime-node) | the clone's `optimize_schedule` (the same model, embedded; `objective: min_crash_cost` through `crash_schedule`) |
| `recover_schedule`, non-crash parts | **stays on the platform**: delay classification and the basis-of-recovery note are LLM reasoning and narrative. Their inputs come from the clone: `windows_analysis` (which activities lost time and why), `crash_schedule` (the recovery steps and costs), `evaluate_batch` (re-sequencing options) |
| Bellator `health_score` | `lint` with `profile: platform` (weighted score and grade) and `dcma_14`; Bellator's own 0–100 number stays an optional external second opinion |
| Bellator `logic_audit` | `lint` (open starts and finishes, FS links that should overlap, leads, constraints, redundant links with delete fixes, criticality share) + `check_schedule` (logic, lags, hard constraints) + `schedule` with `log: true` (out-of-sequence progress) |
| Bellator `progress_audit` | `check_schedule` `invalid_progress_dates` and `dcma_14` `invalid_dates` (actuals after the data date, forecasts before it), `validate` (finish before start, in-progress work without an actual start), `schedule` `log` (out-of-sequence) |
| Bellator `planning_horizon` | **stays on the platform**: readiness scoring weighs approvals and forecast stability, which are not schedule data in P6 |
| Bellator `change_tracking` | `compare` (computed) between consecutive updates (actual-date, duration, remaining and float changes, renumbered activities by name) and `windows_analysis` across all updates; DECM rule codes (06A504a/b) and the change narrative stay on the platform |
| Bellator `baseline_compare` | BEI in `check_schedule` / `dcma_14`, and `compare` with `baseline` (variance per activity). SPI(t) (earned schedule) is not built: it stays on the platform until it is |
| Bellator `risk_index` | **stays external** (Bellator's composite benchmark); the clone's own measures are `monte_carlo` and `dcma_14` |
| Bellator `forensic_package` | the evidence comes from `windows_analysis` (half-step, driving paths, lost time) and `tia`; the claim package and its narrative stay on the platform (LLM) |
| `evm_compute` | `earned_value` and `progress_curves` when the costs are in the schedule; EVM over the platform's own budget register (rows that are not schedule data) **stays on the platform** |
| `cashflow_scurve` | `progress_curves` for the schedule's cost curves; a cash S-curve from certified or paid amounts supplied per period **stays on the platform** (it is arithmetic over the user's figures, not schedule data) |
| `reduce_redundant_links` | `lint` (`profile: platform`) `redundant_links`: each fix is a `delete_relationship` op to pass to `edit` |
| `record_progress_update` | `update_progress` (P6's Update Progress to a data date) or `edit` (`update_activity` actual_start / actual_finish / remaining_days / percent_complete) then `schedule` with `data_date` |

Staying on the platform for now: the bid reasoner (Python + PyTorch, not scheduling), DECM and LOB, and the rows above
marked so (LLM reasoning or narrative, or data that is not in a P6 schedule).

## DCMA without Bellator

Bellator is a subscription, so the clone implements DCMA 14-point itself, from the PAM 200.1 definitions. Bellator's good
ideas (profiles, per-relationship counts, evidence lists) are rebuilt, not called. An optional Bellator connection can
come later, never as the only path.

## The HRM schedule reasoner, embedded

- **The model:** `reasoner.onnx` is 1.3 MB. Its inputs are features `[1,n,9]`, a bias `[1,n,n]`, a mode mask and a pad.
  The wrapper code is about 380 lines (`reasonerOnnx.ts`, `reasonerFeatures.ts`, `sgs.ts`).
- **The runtime:** the platform uses `onnxruntime-node`, a ~60 MB native binary per operating system. The clone uses
  **`onnxruntime-web` (WebAssembly)** instead, which runs the same model in Node (MCP and CLI) and in the desktop app
  with no native parts.
- **The tool:** `optimize_schedule {handle, objective?, samples?, seed?, apply?}`. It runs on the open project and
  returns a proposal with its finish and changes; `apply` makes it one undoable edit. It can also run inside
  `evaluate_batch` and `crash_schedule`, so there are no export/import loops.
- **Fixes on the way in:**
  - features come from the clone's real resources and calendars;
  - the "minimum crash cost" objective works (today it returns null), through `crash_schedule`;
  - the sample count and seed are parameters;
  - a model that is missing or fails to load gives a clear error, not a silent `{available: false}`.
- **The bid reasoner** (`bidbrain`, Python + PyTorch) stays on the platform. It is tender strategy, not scheduling;
  converting it to ONNX would be a separate project.

## Weaknesses found in the platform's tools, fixed in the clone versions

| Platform tool | Weakness | Fix |
|---|---|---|
| all of these | calendar days for progress, CPLI, windows, recovery | working calendars, like F9 |
| `dcma_assess` | no offending activities; all activities counted (completed included); leads and lags per activity; hard constraints never assessed; CPLI always "warn"; missed tasks use the current finish, not the baseline; critical path test guesses the start and end milestones by position | P6 and DCMA populations, per-relationship counts, ID lists, all constraint types, real CPLI, BEI and missed tasks from the chosen baseline, a real critical path test (600-day slip on a scratch copy) |
| Bellator DCMA | leads and negative float always report "not overridden" | provenance on every threshold |
| `crashGreedy` / `recover_schedule` | ignores parallel critical paths; returns only final durations; 1-day steps; non-standard slope formula `cost/(d·(d−1))` | cut sets across parallel paths, every step returned, steps sized to the next near-critical path, slope = (crash − normal cost) ÷ (normal − crash days) |
| progressed CPM (recovery, windows) | remaining = ceil(duration × (1 − %)) with a minimum of 1, ignoring the real remaining duration | the clone's F9 with actual dates, remaining durations and retained logic |
| `optimize_schedule` | makespan only; min-crash-cost returns null; fixed sample count | objectives and samples as parameters; cost through `crash_schedule` |
| `analyze_delay_windows` | no driving path; responsibility left to the agent | the driving path per window and the activities on it that lost time; half-step split |
| (none) | no TIA tool | `tia` |
| `analyse_paths` | "driving path" ignores relationship type and lag; enumerating every path can explode | real driving relationships; P6 multiple float paths; capped path enumeration |
| `schedule_lint` | no empty-WBS, milestone-duration or constraint checks; settings live in a wiki page | added; settings as tool input |
| `kpiCalculator` (EVM) | AC silently falls back to EV (CPI = 1); PV linear; no per-period values | AC = 0 when unknown, with a warning; PV and EV time-phased by P6's rules; per-period SPI/CPI |
| `bellator_resource_analysis` | capacity defaults to 1; demand counted as tasks, not units | resource limits and units from the schedule |
| `forecast_finish` | promises P80 but never returns it | the clone's `monte_carlo` already returns P10–P90 |

## Desktop: everything is usable without an agent

What real P6 has goes where P6 has it:
- Tools > Check Schedule Report;
- multiple float paths in Schedule Options and the Float Path columns;
- the full schedule log;
- the Activity and Resource Usage profiles with PV and EV curves.

Everything P6 does not have goes in a new **Extensions** tab, each with its own screen, so a planner can run it without
an agent:
- DCMA 14-point, with a profile picker and drill-down to the activities;
- Crash to target, a step table with an "Apply" button;
- What-if scenarios;
- Windows analysis and TIA;
- Lint with fix suggestions;
- the HRM optimiser;
- 4D, and later LOB.

The AI assistant drives these screens with the cursor, as it does today.

## Open questions

1. **CPLI target finish:** baseline finish by default, or the contract finish when given?
2. **Check Schedule thresholds in P6 Professional:** the EPPM defaults are documented; Professional's may differ. Real
   P6 output would settle it.
