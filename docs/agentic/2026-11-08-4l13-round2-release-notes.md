# whiq-v0.1.64: render_4d round 2 (platform review of whiq-v0.1.61)

(v0.1.62 and v0.1.63 failed CI on two test assumptions, an H.264 browser; nothing was published under them. v0.1.64 = the same code.)

Items: H6 streaming, H5 decoder config, M3, M4, L1-L5, M2 wording, image paths relative to the write root.
Not ours: H1, H3, M1, H2 (platform), H4 (23c7bdf) and M5 (ab2d274), both by the platform agent in this repo.

## What changed
- **H6 streaming.** Each encoder run streams a fragmented MP4 (or an append-only WebM) to `<x>.parts/run-N.<ext>`, cut at
  the encoder's own key frames (the library default the code already used; no number of ours). render.json records each
  run's whole bytes and frames after every chunk. A torn tail is cut back once a resume is accepted. The tile-budget
  segments are gone (`segmentFrames`, `renderSegment`).
- **H5.** Each run stores a hash of its decoder config. The reference is the config of the first run this call encodes, or
  the newest kept run when nothing is missing. Runs that differ are marked stale: they stay listed (`stale_segments`), are not
  counted in `frames_done` / `kept_segments`, are redrawn in one pass, and are retired once covered. A redrawn run that still
  differs refuses with `render_failed` / `decoder_config_differs`, with the kept report and no retry. The join refuses mixed
  configs.
- **M3.** Load only reads. A refusal at any stage (fingerprint, frames_total, codec, decoder config) changes no file.
  Loaded parts are never replaced: only a fresh start (no resume) replaces a folder.
- **M4.** A second render on a `.parts` folder in use answers `render_busy` with the job id.
- **L1.** The `.parts` folder goes on every success path. A folder that cannot be removed is a note, not an error.
- **L2.** Every error and cancel after kept work (stale included) carries frames_done, frames_total, kept_segments | kept,
  stale_segments, resume, redrawn.
- **L3.** Test hooks are an exported `testHooks` object in mcp/fourd.ts (no environment variables).
- **L4.** `resume` given with no Chromium: the note says it was not used and the parts are untouched.
- **L5.** The resume path is compared resolved, and case-folded on Windows.
- **M2.** Every such answer: `to continue, call render_4d again with the same arguments and resume: "<x>.parts/render.json";
  a call without resume starts over`.
- **Images.** render.json stores each kept frame relative to the write root. The place check compares folded relative paths.
  Entries outside the root are dropped and listed in `redrawn`.

## Review
Two blind reviews by fresh agents; every finding was fixed:
- A refusal after `settle()` cut files.
- A stale flip-back counted frames twice.
- Two new numbers (a timer and a tolerance).
- Image case folding.
- A stale-only kept report.

## Tests
- Windows (real Chrome and ffmpeg): render-resume, fourd-m23, review-v044, fourd-review3, ifc-tiles, job-error-data,
  partial-work-kept, compute-stop, a5-round2, whiq-job-pulses: 89 tests, 82 pass, 5 skipped (Windows-only skips).
  - 2 failures are platform M5 liveness tests in review-v044, and they are load-sensitive. "a worker that progresses slowly
    but steadily…" and "the Revit reader and the geometry worker are watched the same way…" fail only when run in parallel with
    the render tests on Windows. Both pass alone, with and without this change.
- Linux (WSL, real Chromium), the full suite: 800 tests, 0 fail, 141 skipped.

## Live proof (owner's laptop, real engine `dist-cli/p6clone-mcp.cjs` over MCP stdio, Chrome on the GPU, ffmpeg)
The model is the buildingSMART duplex, 1,500 one-day activities linked to it, rendered at 1920x1080 (frames_total 333).
Every final video was checked with `ffmpeg -v error … -f null` (0 errors) and ffprobe `-count_frames`.

| # | What | Result |
|---|---|---|
| 1 | Run as a job, cancelled at ~50 % | `cancelled`, frames_done 192/333, 1 run kept. The resume drew 141 frames, and the final video decodes 333/333 with 0 errors. |
| 2 | The engine process tree killed at ~50 %, resumed by a new process in another folder (parts copied) | 170 drawn at the kill, 144 kept (the frames after the last whole chunk were lost). The resume drew 189 frames: 333/333 decoded, 0 errors. |
| 3 | GPU fails part way (test hook, as WebGL losing its context), processor finishes | The GPU drew 192 frames and SwiftShader the rest, in 2 runs. The decoder configs were equal, so nothing was redrawn. 333/333 decoded, 0 errors. |
| 4 | Killed late | This build: killed at 333/333 (drawing done, join pending), the resume only joined, 333/333 decoded. Previous build of the same streaming code: killed at 316, 288 kept, 45 drawn, 333/333 decoded. |
| 5 | evaluate_batch on JWM (12 scenarios) cancelled during scenario 3 | `cancelled`, partial, the 3 finished rows returned at once. |

Release smoke (Windows, Chrome, ffmpeg): ok, 76 tools.
