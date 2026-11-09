# whiq-v0.1.65: 4L-13 round 1 (Extensions screens, live proof)

Built on the platform's master 4dab7a7. No engine or MCP code was changed: no listed live proof failed.
"Equal" below means the whole answer is equal, leaving out only elapsed and resumed/redone counts (as `same()` in tests/mc-resume.test.ts).

## Extensions screens
New panels: Monte Carlo, Check schedule, Review, Float paths, Progress curves, Resource histogram, Level resources (report only, on a copy), Evaluate one change, Compare (another project, a file, or a baseline). Export… is on every analysis panel, existing ones included, and on the Risks view. The 4D panel has none: no 4D tool takes `export`.

Export… asks for a folder and runs the real tool with `export` in a child process (`main/analysis-export.ts`, bundle `dist/p6clone-mcp-app.cjs`), on a snapshot of the app's saved database. XER was not used because it drops the `_` tables, so the Monte Carlo estimates would be lost.
- One export at a time; it can be cancelled; the child ends with the app.
- Each export has a private temp folder, removed however it ends. Nobody can resume an in-app Export, so a cancelled one keeps no work.
- With a blank seed box, Export passes the seed of the result on screen, so the files reproduce the screen.

Tests: `tests/e2e/extensions.ts` 125 pass, 0 fail; `tests/e2e/analysis.ts` 18 pass, 0 fail. One blind review; its findings in the new code are fixed.

Screenshots are in [2026-11-09-screens/](2026-11-09-screens/): one per new panel and one per Export… button (for example [Monte Carlo](2026-11-09-screens/monte-carlo.png), [Resource histogram](2026-11-09-screens/resource-histogram.png), [Compare](2026-11-09-screens/compare.png), [Export toast](2026-11-09-screens/risks-export-toast.png)).

Packaged exe: Monte Carlo Export wrote its 10 files; `compare` with an `.mpp` through the child found the shipped MPXJ.

JWM (11,426 activities), click to result, Playwright overhead about 1.5 s:

| | Panel | Longest UI block | Export |
|---|---|---|---|
| Monte Carlo, 200 iterations | 29 s | 1.0 s | 33 s |
| Check schedule | 1.8 s | ~0 | 3.0 s |
| Review | 2.0 s | ~0 | 2.8 s |
| Float paths | 1.9 s | ~0 | 2.9 s |
| Progress curves | 1.9 s | ~0 | 2.9 s |
| Resource histogram | 1.9 s | ~0 | 2.9 s |
| Level resources | 10.6 s | 8.8 s | 11.3 s |
| Evaluate one change | 2.4 s | ~0 | 3.4 s |
| Compare with a file | 1.7 s (parse 2.3 s) | ~0 | 2.9 s |

Existing panels' exports on JWM: DCMA 2.6 s, lint 4.4 s, crashing 5.8 s, what-ifs 3.8 s, TIA 3.8 s. The reasoner refused JWM in its own words (11,425 remaining activities, it takes up to 3,000). Windows analysis and LOB exports were not run on JWM (they need two projects and a plan); they ran on the smaller samples.

## Live proof (this PC, the real `dist-cli/p6clone-mcp.cjs` over MCP stdio, headless Chrome on the RTX 4090, ffmpeg 9.0.1)

**0. Saving a part fails.** Windows does not stop an open handle when a folder is made read-only or denied: with an `icacls` deny, the run finished and only removing its kept file failed, as a `note`. So the fault used is an exclusive byte-range lock taken by another process (for IFC, a locked file at the chunk's temporary name).

| Tool | Status | Kept | Cause | Resume after the lock |
|---|---|---|---|---|
| monte_carlo | failed, `partial_failure` | 433 of 2000 | `EBUSY: resource busy or locked, write` | equal to an uninterrupted run |
| evaluate_batch | failed, `partial_failure` | 7 of 40 | same | equal |
| render_4d | failed, `render_failed` | 144 of 333 frames | same | 189 drawn, 333 decoded, 0 errors |
| IFC meshing | failed, `model_unreadable` | 8 of 20 chunks | `EPERM` on the chunk's temporary file | chunks 9 to 20 meshed, 20 tiles |

**1. Monte Carlo** (Enppi.xer, 886 activities, 2,000 iterations, seed 42)

| | Stopped at | Resumed | Result |
|---|---|---|---|
| Cancel | 1,015 | 1,015 | equal |
| Process killed | ~1,001 | 1,030 (new process) | equal |
| Save, close, reopen | 1,020 | 1,020 | equal |

Second run on the same file: `run_busy` with the running `job_id`. No variance on a real 19.12 XER (1,000 iterations): P10, P50, P80, P90, mean, min and max are all 2027-10-29 08:00, `schedule`'s date, standard deviation 0. Every finished run deleted its parts.

**2. evaluate_batch** (JWM, 20 scenarios): cancel 11 kept, kill 10 kept (new process), save-close-reopen 11 kept; each equals an uninterrupted run.

**3. IFC** (Schependomlaan, 49 MB, 3,721 elements, `P6CLONE_GEOM_CHUNK_MB=1` to get 20 chunks; the default of 300 MB would make one)
- Cancel: 4 of 20 chunks kept, with the continue and discard wording.
- Reopen with a 10 GB program running: took in 4, meshed 5 to 9, cancelled. Program stopped, reopen took in 9, meshed 10 to 20. 4 + 5 + 11 = 20.
- `geometry:false` kept 4. `discard_kept: true` removed 3 of 3 in a second cache.
- Equal to a clean open: 20 tiles byte-identical (6,772,807 B), `.geom` identical, all 3,721 element lines identical, `list_elements` same sha256.
- render_4d cancelled while meshing: 5 of 20 kept.
- The branch "does not fit the memory free, so meshed from scratch" was not exercised: 1 MB chunks fit with 10 GB held.

**4. render_4d** (duplex, 333 frames)

| | Result |
|---|---|
| Busy `.parts` | `render_busy` with the `job_id` |
| Join | 45,884 polls during a 4 s window saw only the temporary name, 0 saw `joined.mp4` |
| `render.json` locked | `resume_not_readable_now`, nothing removed, resume works after |
| Cancel, resume | 240 kept (cancelled at 176 by progress, 53 %; the encoder's chunks ran ahead), 93 drawn, ffprobe 333 = frames_total, 0 errors |
| Encoder A, B, A | **not proven with a real second encoder** (below) |

Every encoder available here writes the same decoder config (f3f8190377143a3c): Chrome 156, Edge 157, Puppeteer Chrome 131, GPU and processor. The evidence is the unit tests plus a live run with the encoder name edited in `render.json`: a stale run of the encoder in use came back as `reused`, runs of another encoder were redrawn, 333 decoded with 0 errors.

**5. Export.** The 18 tools with `export` wrote 76 files into one folder; no tool changed another's files (hashed after each). In real Excel (three CSVs), Arabic names are text with the right characters, and `=SUM(1,2)`, `+1 crew`, `@home` are text, no formula. Monte Carlo `iterations.csv` sorted gives the reported P10/P50/P80/P90 (2026-07-14 13:33, 07-17 10:46, 07-21 11:15, 07-23 10:34). A new project saved with no version starts `ERMHDR 7.0`. No real P6 is available here: it was imported into the P6 Clone (6 activities, same finish, [screenshot](2026-11-09-screens/import-new-xer.png)), and its 7 tables have every field, in the same order, of the 7.0 XER `DHBL-24FEB13_VER-7.0.xer`.

**6. Extensions screens.** Above.

**7. Liveness under load.** 64 CPU burners on 32 logical cores; a PowerShell reading took 1.3 to 20.6 s (one 45 s outside the cases). A working job (75.8 s, no progress ticks) and a job printing progress with idle CPU (63.5 s) were not ended. A frozen job (windowless, blocked, no CPU) was ended as idle after 2 windows, at 35.7 s. It stands in for a modal dialog, which would have appeared in front of the owner.

## Test runs
- Linux full suite: 850 tests, 0 fail, 141 skipped.
- Windows, the changed tests (mc-resume, batch-resume, ifc-chunks-kept, open-model-kept, render-resume, mcp-export, xer-new-stamp, liveness-slow-reading, compute-frozen, compute-stop, partial-work-kept, review-v044), one at a time: 114 tests, 108 pass, 5 skipped, 1 fail. The failure is the test's own clean-up in mcp-export.test.ts:326: Windows cannot delete a folder that a process has as its working directory (`EPERM`). The liveness tests in review-v044 pass when not run beside the render tests.
- Release smoke (Windows): ok, 76 tools.

## For the platform agent (found, not changed)
1. A render without `resume` over a folder whose `render.json` is locked answers `internal`, "This is a bug in the server". Nothing is lost; the code is wrong.
2. A failed save of an IFC chunk answers `model_unreadable`, "Cannot read the model". Cause and kept count are right; the code and first sentence mislead.
3. Three existing panels calculate differently from their tools, so their Export can differ from the screen: What-ifs and Time impact analysis use `calendarDays: false` (the tools use each activity's calendar), and Crashing does not lock LOB activities as `crash_schedule` does. The brief said to change nothing else on the screens. Should the panels follow the tools?
4. Excel shows the apostrophe of a protected cell (`'=SUM(1,2)`): it is text, as asked, but visible. Acceptable?
5. tests/mcp-export.test.ts:326 fails on Windows (above).
6. Level resources on JWM holds the window 8.8 s (it runs on the screen thread, as the existing panels do). Should it move to a worker?
7. Float paths has no `between` on the screen: `pathsBetween` is private to mcp/analysis.ts.
