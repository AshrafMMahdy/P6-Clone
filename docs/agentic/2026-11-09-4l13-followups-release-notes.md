# whiq-v0.1.66: 4L-13 round 1 follow-ups (live proof)

Built on the platform's master b405007 (its fixes 6bc35bc to b405007 for the v0.1.65 notes). No engine, MCP or screen code was changed here: no live proof failed.

## Live proof (this PC, the real `dist-cli/p6clone-mcp.cjs` over MCP stdio, headless Chrome on the RTX 4090; the screens in the app through Playwright, in the background)

**1. render_4d without `resume` over locked parts** (duplex, 333 frames)

A byte-range lock does not stop Windows deleting a file (with one on `render.json` the render simply ran and replaced the parts). The fault used is another program holding the file open without sharing delete.

| Locked file | Answer | On disk after | After the lock |
|---|---|---|---|
| `render.json` | `parts_not_replaceable_now`, "Nothing was lost or removed", `locked` = the `render.json` path, hint offers `resume` | same 2 files, same sizes, same sha256 | `resume`: 144 kept + 189 drawn, 333 decoded, 0 errors, parts removed |
| `run-0001.mp4` | `parts_not_replaceable_now`, "Their render.json was removed, so that earlier render can no longer be continued" | `render.json` gone, the mp4 unchanged | a render without `resume` ran to the end: 333 decoded, 0 errors, parts removed |

**2. IFC chunk that cannot be kept** (Schependomlaan, `P6CLONE_GEOM_CHUNK_MB=1`, 20 chunks; another program holds the chunk's `.tmp` name)
- Answer: `chunk_not_kept`, "chunk 9 of 20 … was finished but could not be kept", data `cause` (`EPERM, Permission denied` on the `.tmp`), `chunk` 9, `chunks_total` 20, `kept_chunks` 8, `discard_with`. Chunks 1 to 8 stayed on disk.
- `open_model` again: meshed 9 to 20, done, 3,721 elements, 20 tiles. Tiles (6,772,807 B) and `.geom` are byte-identical to a clean open; the element file differs in one line, the `parsedAt` time.

**3. What-ifs, Time impact analysis, Crashing: the screen equals the Export**

Sample: project P on a 10 h/day calendar with activities on a 6 h/day, 6-day calendar (hours-per-day setting left at 8), and an LOB tower (2 trades × 6 floors, 12 LOB activities) that drives the file's finish. "Old" is the calculation before the fix, run on the same database outside the app.

| Panel | Figure | Screen | Export | Old |
|---|---|---|---|---|
| What-ifs | B 20 → 26 d | finish 2026-04-29, +5 d | same | 2026-05-11, +12.8 d |
| What-ifs | A 10 → 6 d, D 12 → 30 d | finish 2026-04-29, +5 d, D became critical | same | 2026-05-08, +12 d |
| TIA | 10 d fragnet between A and B | impacted 2026-05-06 15:00, delay 10 d | same | 2026-05-05 15:00, 9 d |
| Crashing | target 5 d | EXHAUSTED, 1.15 d gained, 3 steps, only A crashed, cost 3 | same | 38 steps, 4.09 d, A, B and three LOB activities crashed, cost 8.07 |

No LOB activity is crashed on screen. Crashing on P alone (no LOB plan) gives old = new, so the LOB file is what exercises the change. Screenshots: [What-ifs](2026-11-09-followup-screens/what-ifs.png), [TIA](2026-11-09-followup-screens/tia.png), [Crashing](2026-11-09-followup-screens/crashing.png).

TIA was run on the file with P only: with two projects open the TIA screen refuses (item 2 below).

**4. Level resources on JWM (11,426 activities), packaged exe**

Measured while other proofs were running on the PC.

| | Before (v0.1.65) | Now |
|---|---|---|
| Longest window block while leveling | 8.8 s | 65 to 234 ms over five runs |
| Click to result | 10.6 s | 10.4 to 10.8 s (first run 16.0 s) |

- The window reacts during the run: Cancel shows its hover state, and Export… answers "A run of level_resources is already running: wait for it, or cancel it."
- Cancel: the Level button is back in 0.4 to 1.5 s, toast "The level_resources run was cancelled; nothing was changed.", no result shown, the child process is gone (0 before, 1 during, 0 after), its private temp folder is removed. Leveling again after a cancel runs to the end (11.7 s).
- Screen equals Export: 10,837 delayed and 10,837 moved on both; all 10 resource peaks equal; the 500 moved rows the screen lists equal the JSON and the CSV (the screen lists the first 500 and says how many more the Export holds, as in v0.1.65).
- Screenshots: [running](2026-11-09-followup-screens/level-resources-running.png), [result](2026-11-09-followup-screens/level-resources-result.png).

**5. Float paths "between"** (from A to C on the sample): the screen shows "Paths between A and C (2)": A, B, C 42.5 d and A, D, C 36.5 d, lowest float 0 on both; `float_paths.json` `between` holds the same two paths. One box only: "Between needs from and to Activity IDs of this project. Give both, e.g. A1000 and A9000." [Screenshot](2026-11-09-followup-screens/float-paths-between.png).

**6. tests/mcp-export.test.ts on Windows:** 13 tests, 12 pass, 0 fail, 1 skipped: the deleted start folder test, "Windows cannot delete a running process's working folder, so a deleted start folder cannot happen there".

## Test runs
- Windows, the six changed test files one at a time (analysis-crash, extensions-as-tools, float-paths, mcp-export, open-model-kept, render-resume): 74 tests, 73 pass, 0 fail, 1 skipped. The video-encoder tests in render-resume pass here (37 of 37).
- Linux full suite: 857 tests, 0 fail, 141 skipped.
- Type-check clean; the packaged exe was rebuilt from b405007.

## For the platform agent (found, not changed)
1. render_4d with a locked `run-*.mp4`: the code and the wording are right, but `data.locked`, the message and the next step name the `.parts` folder (the `EPERM` came from removing the folder), not the mp4 that is held.
2. The Time impact analysis screen has no project box: with more than one project open (for example P and an LOB tower) it refuses with "Several projects are in the file; say which with "project"", as the tool does when no project is named. Should the screen pass the open project?
3. Reopening after `chunk_not_kept` printed "kept from an earlier meshing" for 2 of the 8 kept chunks only (chunks 2 and 7). The result is right (only 9 to 20 were meshed); the progress notes may be thinned on purpose.
