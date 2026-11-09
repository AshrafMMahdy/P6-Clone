# 4D display tiles: the contract with the White Hat IQ platform

Status: built in the clone (INDEX_FORMAT 11, tiles format `p6c-4d-tiles` version 1). This is what the platform serves
and listens for; the platform side is not changed by the clone. Code: `core/bim/tiles.ts` (layout),
`core/bim/geomTiles.mjs` (writer), `viewer4d/viewer.ts` (the page), `core/bim/render4d.ts` (what render_4d writes),
`core/bim/model.ts` (memory).

## 1. What render_4d writes

The model's display geometry is a folder of tiles, one folder per model, beside the page, referenced by relative paths.
`<hash16>` is the first 16 hex digits of the IFC's content hash (sha-256).

| Call | Files (in `path`) |
|---|---|
| `kind: viewer` | `index.html`, `viewer4d.js`, `model-<hash16>/manifest.json`, `model-<hash16>/elements.txt`, `model-<hash16>/tile-00000.glb` … |
| `kind: viewer, embed: true` | `<project>-4D.html` only (tiles inline as base64). Refused as `too_big_to_embed` past `P6CLONE_EMBED_MAX_MB` (64) of tiles |
| `kind: video` (or `images`) **without** a server Chromium (the client route) | small model (tiles ≤ 64 MB): `<project>-4D-render.html` only, self-contained, exactly as before. Bigger: `<project>-4D-render.html` (the viewer script inline) **plus** `model-<hash16>/…` |
| `kind: video` with a server Chromium | the video only (`<file_name or project-4D>.mp4`); the page and tiles are written to a temp folder, served to the Chromium over 127.0.0.1, deleted after |
| `boxes: true` (any kind) | the page draws each element as its bounding box from `model-<hash16>/boxes.bin` (or inline). Only when the caller asks: never a silent stand-in |

The client-route answer (no server Chromium), unchanged in shape, with three new fields when there is a folder:

```json
{ "kind": "video", "rendered": false, "viewer": "<out>/P1-4D-render.html",
  "written": ["<out>/P1-4D-render.html", "<out>/model-0123456789abcdef/manifest.json", "<out>/model-…/elements.txt", "<out>/model-…/tile-00000.glb", "…"],
  "display": { "tiles": 36, "mb": 1103, "triangles": 30000000, "instances": 500000 },
  "client_render": { "artifact": "<out>/P1-4D-render.html", "hooks": "WHIQ4D_EXPORT", "step": 7, "width": 1280, "height": 720,
                     "model_folder": "<out>/model-0123456789abcdef", "files": ["…every file of the folder…"], "contract": "docs/4d-tiles-contract.md (p6c-4d-tiles v1)" } }
```

`written` lists every tile file. The supervisor's `p6RenderGapIn` already collects `written`, so `keepUnoffered` fences
the tiles out of the chat outputs with no platform change (they are the page's data, not the user's result).

## 2. The tile folder

```
model-<hash16>/
  manifest.json      the list below
  elements.txt       GlobalIds by element ordinal, one a line (the interactive viewer's picking and highlighting)
  tile-00000.glb     GLB 2.0 tiles, in element order, numbered from 00000 with no gaps
  tile-00001.glb
  …
  boxes.bin          only with boxes: true (float32 min x, y, z, max x, y, z per ordinal, metres, NaN = no geometry)
```

`manifest.json`:

```json
{ "format": "p6c-4d-tiles", "version": 1,
  "elements": 2500000, "meshed": 2500000, "scale": 1,
  "bbox": [minx, miny, minz, maxx, maxy, maxz],
  "bytes": 1156579328, "vertices": 31000000, "triangles": 30000000, "instances": 500000,
  "tiles": [{ "file": "tile-00000.glb", "bytes": 33554000, "elements": 75000, "vertices": 900000, "triangles": 870000, "instances": 15000, "bbox": [ … ] }, …],
  "guids": "elements.txt" }
```

- **Sizes**: each tile is at most `P6CLONE_TILE_MB` (32 MB) plus its JSON (a few KB), except a single element bigger
  than that, which gets a tile of its own. A GLB may be 4 GB and a browser's ArrayBuffer 2 GB; 32 MB keeps a fetch,
  a parse and a GPU upload small, and the platform's mirror (which reads a file whole) bounded.
- **Element ordinal**: an element's place in the model index (express-id order). The page's timeline and the tiles
  both count by it.
- **Tile content** (any glTF reader opens a tile; the page reads its own extras):
  - batch nodes: one mesh of many elements, positions float32 relative to `node.translation` (double precision in the
    JSON, so a georeferenced model keeps its millimetres), uint32 indices, at most 2 million vertices a mesh;
    `node.extras.p6c = { kind: "batch", ranges: <bufferView: uint32 triples ordinal, first vertex, vertex count>, elements }`;
  - instance nodes: a mesh placed many times (`EXT_mesh_gpu_instancing` TRANSLATION / ROTATION / SCALE, float32,
    relative to `node.translation`); `node.extras.p6c = { kind: "instances", ordinals: <bufferView: uint32 per instance>, instances }`.
    A mesh placed at least 4 times in a run is instanced (at most 1,024 instanced meshes a tile); a placement that
    shears is merged instead.
  - `extras.p6c` of the file: `{ format: 1, elements, vertices, triangles, instances, bbox }`.
- **Full geometry**: every triangle of every meshed element is in the tiles (tested element by element). The old
  rule that drew the most detailed elements as boxes past `P6CLONE_VIEW_MAX_MB` is gone (`P6CLONE_VIEW_MAX_MB` and
  `P6CLONE_VIEW_BATCH` are no longer read).
- **Format-neutral**: the tiler (`geomTiles.mjs`) reads a mesh stream, not IFC: `geoms.bin` (each distinct mesh once,
  float32 positions then uint32 indices), `geoms.meta` (float64 posOffset, vertexCount, idxOffset, indexCount per
  mesh), `places.bin` (float64 ordinal, mesh number, 4×4 column-major placement per placed mesh, an element's
  placements consecutive), `elems.meta` (float64 ordinal, vertices, triangles, volume, bbox 6, centroid 3 per element).
  `geomWorker.mjs` writes it from web-ifc; an RVT or NWD reader that writes the same four files gets the same tiles,
  fingerprints and viewer. Navisworks files (`.nwd` / `.nwc` / `.nwf`, the clone's own reader, `nwd/native.ts`) do
  exactly that: no IFC in between. The reader (`nwdWorker.ts`, its own process) writes the index (the records an IFC
  of the model gives, element k as express id k + 1, Y up as web-ifc gives meshes) and these four files (each
  geometry block once, every piece placed), and the tiler makes the same tiles; an IFC4 is written, streamed, only
  for the exports that deliver one. Its memory is estimated from the sizes of the model sections it holds as objects
  (`navisworksNeed`: a fixed 200 MB, 40× the biggest model's compressed tree, 9× all of them; the index 3×), and
  `open_model` answers its measured peak (`source.peak_memory_mb`). Measured (Windows, Node 24.14.0): a 509 MB
  federation (`scripts/make-federation.ts`: 160 copies of test.nwd, 262,400 elements, 320 million triangles) opens
  through the MCP server at `P6CLONE_MEM_BUDGET_MB=2048` in 6.8 minutes: server 360 MB, reader 1,270 MB, every process
  together 1,647 MB (`scripts/measure-federation.mjs`); the IFC4 of 20 of those copies (1.6 GB) is written with the
  reader at 727 MB. Revit files (`.rvt` / `.rfa`, rvt-rs with `core/bim/rvt/p6clone.patch`) are made into an IFC4
  first, in rvt-rs's own process, written to disk a piece at a time; the index (linking, keys, exports, the agents'
  element data) is then streamed from it, and only the video's tiles mesh it, in chunks. What reading takes is the
  file and its element partition unpacked, which rvt-rs scans as a whole: about 8× the file in all
  (`REVIT_MEMORY_PER_BYTE` in `core/bim/rvt.ts`, the one measured constant: 173, 225 and 264 MB for 7, 12 and 19 MB
  projects on rvt-rs 0.10.0; `revitNeed` = 128 MB + 8× the file); a file past `P6CLONE_REVIT_MAX_MB` (450 = 4 GB / 8
  with a margin) is refused before it runs, and one that runs the reader out of memory under that is `model_too_large`
  too (never a lesser conversion); a full disk is `model_unreadable` with the cause. Both point first to an NWC, NWD or
  IFC export of the same model already in the project, and only then to the user. A half-written conversion of a dead
  reader (`*.pid.tmp`) is removed on the next start, and the old `-rvt1` conversion when the current one is written.

## 3. What the page fetches

The page is `P` (served at some URL with a query string `?Q`). It fetches, relative to its own URL and **carrying its
own query string** (`new URL(rel, location.href)` with `search = location.search`):

1. `model-<hash16>/manifest.json?Q`
2. `model-<hash16>/tile-00000.glb?Q`, then `tile-00001.glb?Q`, … one at a time, each uploaded to the GPU before the
   next is fetched
3. `model-<hash16>/elements.txt?Q` (interactive viewer only; never for a render page)
4. `model-<hash16>/boxes.bin?Q` (only with boxes: true, instead of 2)

Nothing else: the render page carries its viewer script inline, the timeline inline (`window.P6C4D.timeline`, with
`start` / `finish` as before).

**The platform's one change for big models**: the client route loads the page from
`/api/render-job/<id>/page?chatId=…&token=…[&as=…]`, so the tiles arrive at
`/api/render-job/<id>/model-<hash16>/<file>?chatId=…&token=…[&as=…]`. One route serves them:

```ts
r.get('/:id/:folder(model-[0-9a-f]{16})/:file', (req, res) => {
  const job = jobFor(req, res, true);            // the owner token, as /page
  if (!job) return;
  if (!/^(manifest\.json|elements\.txt|boxes\.bin|tile-\d{5}\.glb)$/.test(req.params.file)) { res.status(404).end(); return; }
  res.sendFile(join(dirname(job.pageAbs), req.params.folder, req.params.file));
});
```

(`job.pageAbs` is the staged page; the folder is its sibling in out/.) A small model needs no route: its render page
is self-contained, as today. After the video is made the supervisor offers the page; offering the folder too (each
file in `client_render.files`) makes the page in the outputs viewable; leaving it fenced keeps the outputs small.

## 4. What the page signals

As soon as the viewer script starts, before any fetch:

- `window.parent.postMessage({ type: 'whiq4d:started', version: 1, status }, '*')`
- `window.WHIQ4D_EXPORT` exists, with `started: true` and `status()`.

Then `{ type: 'whiq4d:progress', status }` after the manifest and after each tile, `{ type: 'whiq4d:ready', status }`
when every tile is on the GPU, or `{ type: 'whiq4d:error', code, message, status }`.

```ts
status = { state: 'loading' | 'ready' | 'failed',
           tiles: { loaded, total }, bytes: { loaded, total }, elements,
           error?: { code, message } }
```

Hooks (`WHIQ4D_EXPORT`): `started` (true), `status()`, `ready()` (true once every tile is on the GPU; **throws**
`"[code] message"` when the browser could not hold the model), `max()`, `setStep(days)`, `frame(dayOffset)` (throws
until ready, and on failure). `P6C4D_API` has the same `ready()` / `status()` and `setDate`, `setSource`, `highlight`,
`encode`, `png`. Frames are drawn only after every tile needed for the view (the whole model) has loaded.

Error codes: `webgl_context_lost`, `gpu_out_of_memory`, `browser_out_of_memory`, `tile_missing`, `bad_tile`,
`load_failed`. The message names the size, e.g. *"The browser could not hold the 4D model, 1,103 MB of geometry in 36
tiles (2,500,000 elements, 30,000,000 triangles): out of GPU memory at tile 21 of 36, with 640 MB loaded. Render it
where there is more GPU memory, or ask for boxes (each element drawn as its bounding box)."*
On the server (`render_4d`) these come back as the tool error `render_failed` with the code in `data.reason`.

The server's headless Chromium draws on the machine's graphics card when it has one (`P6CLONE_RENDER_GPU`: auto, the
default; on; off), else with the processor (SwiftShader); a render the graphics card cannot finish goes again in
software, once, and the answer's `renderer` says which drew it. Measured on a 509 MB federation (320 million
triangles, 24 frames at 1280x720): 60 minutes in software (about 2 million triangles a second), 34 seconds on this
machine's graphics card (about 400 million); a 6 million triangle model, 73 s and 4 s. `quality` (images, video): standard (full geometry, 1280x720),
high (1920x1080), draft (854x480, each element its bounding box), or auto (the default): standard unless
`renderMinutes` estimates more than `AUTO_DRAFT_MINUTES` (5, owner decision 2026-10-27; `P6CLONE_RENDER_DRAFT_MINUTES`
overrides it, `quality` per call) where it is drawn, then draft. Where it is drawn: this server's graphics card or
processor, or, with no Chromium on the server, the user's own graphics card (the client render: estimated as a graphics
card, and the note says so). The estimate counts `boxes: true`, `layout: side_by_side` (the model drawn twice a frame)
and a custom `width` / `height`. The answer gives `quality`, `estimated_minutes`, `renderer` and, when the user should
hear it, `quality_note`.

A render has **no fixed time limit** and is never ended while it works (the owner's rule: no fixed time limits, progress and
liveness; judged by the platform's rule, owner decision 2026-11-08). It is alive while tiles load and frames arrive, or while the
browser's process tree uses the processor. It is ended (`render_stuck`) only when frozen: two windows of 5 s in a row with no tile,
no frame and no processor time (with no processor reading at all, three). A render loop that spins without drawing is NOT ended: its
job line says "using CPU, no progress since …" and the agent is woken once (below) and decides. `frameMs` (`renderplan.ts`) is only
an estimate in the messages. Only the graphics card's failures fall back to's failures fall back to
software (`webgl_context_lost`, `gpu_out_of_memory`, `gpu_process_crashed`, `webgl_unavailable`): quality and
`estimated_minutes` are then worked out again for the processor (auto may now draw a draft) and the note says it took longer.
Every other failure (`browser_out_of_memory`, `disk_full`, `render_stuck`) is `render_failed` with the cause and the next step: a
smaller quality first. A card that failed is remembered for the process (driver-level failures for good; running out of memory
for models that size). The answer's `drawn` is what was actually drawn (`{geometry: "full" | "boxes", width, height}`: `quality`
names the picture size, and `boxes: true` at standard size is still boxes), and `quality_note` is set whenever boxes are drawn.
WebM to MP4 (ffmpeg) is watched by ffmpeg's own `-progress` frames; the desktop app's video render (`main/bim.ts`) by the same
watch as the server's (`inPage` in `headless.ts`: tiles loaded, frames drawn, a page whose process is gone ends it at once).

**A render that can be continued** (`render_4d`, `kind: video` or `images`, with a server Chromium; `core/bim/renderParts.ts`). Beside the
output, in `<path>/<file_name>.parts/`, `render.json` holds the arguments, a fingerprint of everything that changes the picture (model,
schedule and links, source, size, boxes, quality, dates, step, fps, growth, overlays, view; not how the video is cut), `frames_total`, and
what is done. There are no segments sized by the tile memory budget any more: **a video is streamed**. Each encoder session is a *run*:
the page encodes a fragmented MP4 (`fastStart: 'fragmented'`) or an append-only WebM through a Mediabunny `StreamTarget`, with the library's
own fragment and key-frame defaults (no number of ours), and hands out only *whole* chunks (the header, then each fragment or cluster, each
starting on an encoder key frame: `P6C4D_API.drain()`); Node reads them every half second and appends them to `run-N.mp4` / `run-N.webm`.
After each whole chunk `render.json` is rewritten with the run's entry `{file, first, frames, bytes, config}`: `bytes` is the length that is
whole, `frames` what those bytes hold, `config` a hash of the decoder configuration (codec string and description bytes). The page never
holds the video, and a killed process leaves everything up to the last whole chunk. `encode` without `stream: true` (the desktop app) still
returns the whole file.

A failure or cancel keeps what is whole; the `render_failed` error (or the cancelled job's partial answer) carries `frames_done`, `frames_total`,
`kept_segments` (video: the run files) or `kept` (images: the frames), `resume` (the render.json), `redrawn`, and says: *to continue, call
render_4d again with the same arguments and resume: "<x>.parts/render.json"; a call without resume starts over* (a call without resume
replaces the old parts of that name, render.json first; a file in them another program holds answers `parts_not_replaceable_now`, naming it:
nothing was removed when it is render.json, so that render can still be continued, else render.json was removed and the answer says so). The tool reads exactly the resume path given (compared as a path: resolved, case-folded on Windows)
and never searches for one. On a resume, the manifest is checked (shape, names, ranges, that each run reads back as its frames and decoder
configuration up to its `bytes`) and **nothing is changed on disk until the resume is accepted**: a refused resume (`resume_mismatch`,
`resume_unreadable` when there is no render.json of a render there, `resume_not_readable_now` when one is there but cannot be read now: a
lock, a scan; call again with the same resume, never afresh, which would replace it) removes, cuts and rewrites nothing; once accepted, a run file longer than its `bytes` (a chunk being written when the
process died) is cut back, a run that does not check out is left out of the manifest (its file is overwritten only when its frames are drawn
again), and those frames are drawn again. The encoder in use is the one this call draws with: the first run it encodes sets the `config` every run must have, or, when nothing is
missing, the newest kept run's (the runs are numbered in the order they were drawn). A run whose `config` differs cannot be joined to
those of this encoder; it is marked `stale` in `render.json` (listed, not counted in `frames_done`, its frames missing), drawn again in the
same pass, and dropped from the manifest once runs in use cover its frames (its file stays until the parts are removed); `redrawn` says
which and why. A call cannot know its encoder's configuration before it draws, so the frames no run holds (in use or stale) are drawn first;
once the first chunk gives the configuration, a stale run with that configuration (an encoder that flipped back: A, then B, then A) is used
again where no run in use, nor the run being drawn, holds any of its frames, the newest first, so no frame is counted twice; `reused` lists
them. The answer lists stale runs apart,
as `stale_segments`; `kept_segments` is exactly the work `frames_done` counts. Nothing is retried: if a run drawn in this call still
differs from the reference (an unstable encoder, or an encoder that changed since the newest kept run when nothing was missing), the join is
refused as `render_failed` with `reason: decoder_config_differs` and the kept report; the next resume converges (its reference is then the
newest run, and the older ones are the stale ones). Parts loaded for a resume are never replaced or removed by a refusal or a failure (a
changed picture or `frames_total` is a `resume_mismatch`); only a call without resume replaces them. Any listed run, live or stale, is kept
work: the failure answer carries the report, `resume` and the wording. A manifest image entry that resolves outside the write root is not
followed, and `redrawn` says so. The runs are joined by copying packets (a refusal if their configurations differ) into
`joined.<ext>.p6clone-tmp` in the `.parts` folder (a temporary name a mirror skips, until it is checked and moved into place), the result is
checked frame by frame, and the `.parts` folder is removed after every successful render (video MP4, WebM converted to MP4 with ffmpeg, images).
Images are written straight into the output folder as they are made; `render.json` lists each by its path **relative to the write root**
(the output folder when the server has none), so a tree copied to another root (an engine restart) is the same render and its frames are not
drawn again; an entry resolving outside the root is ignored. A second `render_4d` in the same `.parts` folder while one is still working in it
(a cancelled job answers before it has stopped) is refused as `render_busy`, with `job_id` when it is a job (one started with `async: true`
or one the soft timeout turned into a job). With no Chromium here (the client
route) nothing is rendered and `resume` is not used; the note says so and the parts are left as they are.

**How a job is judged frozen** (`core/bim/liveness.ts`, `core/bim/heartbeat.mjs`): the platform's rule, one for every watch (owner
decision 2026-11-08; the earlier gap multiple, floor, start-up windows and 10 x work bound are gone — they were never the owner's).
Every window (5 s; `P6CLONE_LIVENESS_WINDOW_MS` shortens it for tests) a watch asks: did the work make progress (a tick, a unit done,
a new step, output written)? Alive. Else did it use the processor (10 ms or more in the window: a worker's process tree, the browser's,
ffmpeg's, Microsoft Project's, a compute thread's own `Worker.cpuUsage`)? Alive — a job that works is never ended, however long.
Neither, two windows in a row: frozen (waiting on a dialog nobody can see, a dead lock), and ended with the step, how long, what was
tried and the alternatives (`stuckMessage`). No processor reading to be had: frozen after three windows with no progress.
Ticks (what counts as progress): geometry reader every mesh callback; chunker every 4 MB scanned, every product, every window written;
tiler every placed element and tile; Navisworks reader every tree object, fragment, piece, element and copied chunk; Revit every 8 MiB
of IFC written; render every tile and frame; ffmpeg every frame. Where a loop knows its `done` and `total`, only `done` advancing counts.

**What the agent is told** (`mcp/runtime.ts` `noteSilence`): while a job uses the processor without progress, its progress line says
"using CPU, no progress since 10:42 (12 min) — cancel it if that is not expected". Once per job, when the silence first passes the job's
OWN longest gap between progress points (or, before it has shown one, the step's expected time below) — that measured value, no
multiplier — the job pulses `no_progress` (a `notifications/job` with `event: "no_progress"` and the facts) and the platform wakes the
agent. After that only when the agent asks: `job_status` `wake_after_s`. Nothing is stopped by it; the agent decides (cancel_job, or wait).

   *Expected times* (the second basis above, and the messages): an opaque call that cannot tick (web-ifc `OpenModel`, one inflate of a
   whole Navisworks section, rvt-rs's unpack, Microsoft Project's COM open/save) names its expected time, input size x the rate
   measured on this machine. The rate is the slower of the reference rate (below) scaled by a 300 ms start-up benchmark
   (`machineFactor`, 1 to 5; `P6CLONE_MACHINE_FACTOR` replaces it) and this job's own measured rate on its earlier chunks or models
   (`noteRate`). It is an estimate, never a limit.

   | Call | Reference rate | Where it comes from |
   |---|---|---|
   | web-ifc `OpenModel` + meshing (`GEOMETRY_S_PER_MB`) | 0.4 s per MB of the run's IFC | section 6: 0.24, 0.39, 0.38, 0.29 s/MB (105 MB to 1.87 GB models, chunker and tiler included), the worst rounded up |
   | Navisworks section inflate (`NAVISWORKS_S_PER_MB`) | 0.8 s per MB of file | the 509 MB federation opens in 6.8 min (above): 0.80 s/MB for the whole open |
   | rvt-rs unpack (`REVIT_S_PER_MB`) | 0.3 s per MB of .rvt | measured below (Revit table): worst 0.28 s/MB, the Helsinki model |
   | Microsoft Project COM (`MSPROJECT_S_PER_MB`) | 13 s per MB of .mpp | measured below: worst 12.9 s/MB, a 0.46 MB file (Project's 3.5 s start dominates small files) |
   | MPXJ .mpp to XML (`MPXJ_S_PER_MB`; MCP `open_file` of a .mpp) | 1.8 s per MB of .mpp | measured below: worst 1.74 s/MB, a 0.40 MB file (Java's 0.6 s start) |
   | IFC index (`INDEX_S_PER_MB`; `indexWorker.ts`) | 0.1 s per MB of IFC | section 6 "open (index only)": 0.095, 0.096, 0.098 s/MB |
   | Chromium first frame | `renderMinutes` (2.1 M triangles/s software, 400 M/s card) | section 4 (509 MB federation) |

   **To update a rate**: edit the one named constant at the top of `core/bim/heartbeat.mjs` and the row above.

   **Revit, Microsoft Project and MPXJ, measured 2026-10-28** on the owner's PC (Windows 11, `benchmarkMs` 261 ms, so
   `machineFactor` 1: the figures are the reference rates as they stand). Three runs of each file, seconds and seconds per MB:

   | Reader | File | Size | Runs (s) | s/MB |
   |---|---|---|---|---|
   | Revit (`rvtWorker.mjs`, whole read to IFC) | Helsinki: Architecture Model Reference.rvt | 11.41 MB | 3.2, 3.2, 3.2 | 0.28, 0.28, 0.28 |
   | Revit | 01.2 ConREM 2nd year.rvt | 17.83 MB | 2.5, 2.0, 2.0 | 0.14, 0.11, 0.11 |
   | Revit | Starting Revit Modell_2.Class.rvt | 5.66 MB | 1.2, 1.0, 1.0 | 0.21, 0.18, 0.18 |
   | Revit | Project1ashraf.rvt | 5.27 MB | 1.2, 1.1, 1.1 | 0.23, 0.21, 0.21 |
   | Microsoft Project COM (`main/msproject.ts`, .mpp to XML) | Sample MPPs: Dabur Architecture (crashed baseline) | 4.94 MB | 4.3, 3.6, 3.5 | 0.87, 0.73, 0.72 |
   | Microsoft Project COM | FARM FRITES-addendum-2 | 4.23 MB | 3.6, 3.6, 3.5 | 0.86, 0.85, 0.83 |
   | Microsoft Project COM | grok trial 1 (aurora tower) | 0.58 MB | 3.5, 3.5, 5.7 | 6.09, 6.10, 9.83 |
   | Microsoft Project COM | AIStudio CoT Gemini | 0.46 MB | 6.0, 5.7, 5.6 | 12.91, 12.20, 12.16 |
   | Microsoft Project COM | XML to MPP gemini trial 2 | 0.40 MB | 3.6, 3.6, 3.6 | 8.99, 9.08, 9.17 |
   | MPXJ (`core/msp/mpp.ts`, .mpp to XML) | Dabur Architecture | 4.94 MB | 0.9, 0.9, 0.9 | 0.18, 0.18, 0.18 |
   | MPXJ | FARM FRITES-addendum-2 | 4.23 MB | 0.8, 0.8, 0.8 | 0.18, 0.19, 0.19 |
   | MPXJ | grok trial 1 (aurora tower) | 0.58 MB | 0.8, 0.8, 0.8 | 1.35, 1.39, 1.39 |
   | MPXJ | AIStudio CoT Gemini | 0.46 MB | 0.6, 0.6, 0.6 | 1.29, 1.30, 1.30 |
   | MPXJ | XML to MPP gemini trial 2 | 0.40 MB | 0.7, 0.7, 0.7 | 1.72, 1.71, 1.74 |

   Each constant is the worst s/MB rounded up. Small files are dominated by the program's start (Project about 3.5 s, Java
   0.6 s), so the per-MB figure is generous for large files; the bound is ten times it and never under the worker floor.

When a job is ended the error says: the **step** ("meshing products (1,200 done)"), how long with no progress and the windows, or
the work bound that was passed and its value, **what was tried** (graphics card, then processor; the reader's modes), and the
**alternatives** (draft quality or boxes; an NWC, NWD or IFC export; split the model; for Microsoft Project, open the file once in
Project and save it as XML). Microsoft Project (`main/msproject.ts`) is watched from outside: PowerShell and `WINPROJ.EXE` (not
PowerShell's child; found by name) with PowerShell / wmic / tasklist (`treeCpuMs`); output written while saving is progress; no
processor time and no output for two windows is "waiting on a dialog", and only the Project instance the script started is ended.
The Navisworks reader's tiler child passes its steps and ticks on to the reader's own heartbeat (a long tiling is not an idle
reader). `P6CLONE_NWD_MINUTES`, which was a fixed 60-minute kill, is only an optional cap an administrator may set (unset: none).
Microsoft Project's idle rule needs a reading of the process table that lists `WINPROJ.EXE` (`cpuCovering`); where only PowerShell can be
seen (tasklist fall back), only the size bound applies.

**The server never ends itself** (owner rule 2026-10-28: customer data survives). A stuck loop on the server's main thread could only be
ended by ending the process, and with it every open project's session (up to one checkpoint interval of edits in each), so nothing
the server waits on runs there. The sections that read input run in a process of their own (`core/bim/jobWorker.ts` `inWorker`),
judged by the same heartbeat rule as the geometry worker, and a stuck one ends only its worker and its call, with the reason:
the IFC index (`indexWorker.ts`: `stepIndex`, a tick per 1 MB read, a work bound of size x `INDEX_S_PER_MB` for the pass after the scan; the
index comes back to the server as the index file the cache uses, read by `readIndex`), and another tool's 4D file (`read4dWorker.ts`: one
opaque call of the file's size x the Navisworks rate x 10). Without the bundled worker (an Electron app) they run in the app's process,
unwatched. A worker is judged by its own heartbeat times: a stalled event loop of the server (busy with another handle's long step)
is not its silence. The root cause of one call freezing the others is heavy synchronous work on the single thread that serves every handle,
so the long engines are off it too (`mcp/compute.ts`): the analysis tools (check, DCMA, lint, float paths, curves, what-if batches, crash,
optimise, windows and time-impact analysis), Monte Carlo, levelling, F9 and progress updates, `evaluate`, the LOB plan tools, and the PDF,
Excel and report files run on a COPY of their project in a worker thread (the server's own code, started with `workerData.p6Compute`), and
hand back their answer and their changes as a patch (`core/journalPatch.ts`) that the main thread applies as one undoable change of the handle.
The main thread only routes; other handles' calls, `job_status` and `cancel_job` are never behind a run. Cancelling a call ends its worker at once
(`terminate()`, even in a synchronous loop), which is safe because it works on a copy. `P6CLONE_COMPUTE_WORKERS` sets the number of workers
(default CPUs - 1, at least 2; `0` runs everything in the server, for diagnosis). The cost: the main thread serialises the project once per
call (about 70 ms for a 12 MB XER) and the memory budget reserves the copy. What cannot move, and why: opening and saving files (they create
or serialise the session's database, so the main thread would pay for the copy of the whole result), editing, undo and redo (finite, fast
operations on the database itself), the lookups, the 4D tools (they work on models held in the main process, whose heavy parts already run
in worker processes), and reading and writing the cached index (`readIndex`, `writeIndex`: they build or walk the in-memory index the server
holds, which cannot be handed over; finite passes over a file in 16 MB blocks and 4096-element steps). The compute workers have no liveness
watch of their own (the engines have no measured rate to size a bound from): `cancel_job` ends them. There is no self-kill path.

Every stuck error carries the facts as data, besides the words: the tool error's `stuck` (`{step, kind, silent_ms, window_ms, windows,
longest_gap_ms | bound_ms, expected_ms, done, total, tried, alternatives}`) with `reason: "stuck"` for a model that cannot be read
(`model_unreadable`: the IFC index, Revit, Navisworks), `import_4d` (`bad_input`) and a render (`render_failed`, `data.stuck`); `open_model` answers `geometry_stuck` beside
`geometry_note`.

**The platform's change for the pickup window**: `clientRender4d.ts` waits 90 s for `ready()`. A big model's tiles can
take longer. Take `WHIQ4D_EXPORT.started` (or the `whiq4d:started` message) as the page alive, and wait while
`status().tiles.loaded` grows (reset the 90 s on each change), failing with `status().error.message` when
`status().state === 'failed'`. Today's code already fails at once with the page's words, because `ready()` throws.

## 5. Memory (what the clone reserves, and the platform's `p6ModelLimits`)

Measured with `scripts/measure-ifc.ts` (the process tree's RSS every 50 ms: the server, its geometry processes and
the headless Chromium) under `P6CLONE_MEM_BUDGET_MB=1536` and the platform's heap (`--max-old-space-size=2048`).
The estimate (`core/bim/model.ts` `loadNeeds`):

- the index (only when the model is not cached): `min(size, INDEX_PER_BYTE × size + INDEX_KNEE) + INDEX_FIXED`, with
  `INDEX_PER_BYTE` 0.4, `INDEX_KNEE` 256 MB and `INDEX_FIXED` 160 MB (an index-only load adds `INDEX_WORKER_FIXED`, 96 MB, for the index worker's own Node runtime) (a small file costs about its own size while it is
  read; past 256 MB the pass collects every 128 MB read and the live index is about a quarter of the file);
- meshing: one geometry run at a time on a chunk of the IFC, `MESH_PER_BYTE × chunk + MESH_FIXED` with
  `MESH_PER_BYTE` 3.8 and `MESH_FIXED` 330 MB; the chunk is `P6CLONE_GEOM_CHUNK_MB` (300) or smaller, sized to the
  memory left beside the index (never under 16 MB), so a model is refused only when its index, or its index and the
  smallest chunk, do not fit. The refusal (`memory_budget`) names what it needs (index, meshing, chunk), the budget
  and what is free, and says when the same model opens with `geometry: false` (index only: linking, sets, 4D keys and
  every 4D export still work).

The estimate is of what the step adds to the server already running (its own ~130 MB is in "used" already). The
measurements in section 6 show how close it is. For the platform's words: an IFC opens with geometry when
`indexNeed(size) + MESH_PER_BYTE × 16 MB + MESH_FIXED ≤ free`, and with `geometry: false` when
`indexNeed(size) ≤ free`; a model whose index is cached needs only the meshing part (or nothing, when its tiles are
cached too). There is no size limit: these are the only checks.

## 6. Measurements

`scripts/measure-ifc.ts` on this repository's hosted VM, 2026-10-21 (4 vCPUs, 16 GB shared with other sessions, so
wall times are pessimistic), `P6CLONE_MEM_BUDGET_MB=1536`, heap 2048 MB. "Server" is the MCP server's own RSS; "tree"
adds its geometry processes and, for video, the headless Chromium (SwiftShader). All phases run one after another in
one server process, so a later phase's peak includes what earlier ones left for the collector. Models: the IFC2X3
Duplex fixture and synthetic IFC4 models (`scripts/make-ifc.ts`: storeys of walls, slabs, columns, beams, windows,
doors, with property and quantity sets).

| Model | Elements | open (index only) | mesh to tiles | link_by_rules | export csv | navisworks | synchro | ifc4d | video (6 frames, server route) |
|---|---|---|---|---|---|---|---|---|---|
| Duplex, 2 MB | 239 | 133 MB, 0.7 s | 330 tree / 138 server, 3.4 s, 1 tile | 139 MB | 0 s | 142 MB | 140 MB | n/a (IFC2X3: refused in words) | 1284 tree / 156 server, 12 s; MP4 decodes, 6 frames |
| 105 MB | 148,000 | 250 MB, 10 s | 856 / 266, 25 s, 2 tiles (58 MB) | 285 MB | 350 MB | 366 MB | 358 MB | 389 MB | 2041 / 660, 96 s; MP4 decodes |
| 365 MB | 503,000 | 474 MB, 35 s | 1528 / 358, 143 s, 2 chunks, 7 tiles (196 MB) | 377 MB | 487 MB | 585 MB | 702 MB | 784 MB | 2138 / 646, 204 s; MP4 decodes |
| 1.06 GB | 1,430,000 | 821 MB, 106 s | 1603 / 769, 406 s, 5 chunks | 721 MB | 1274 MB | 1456 MB | 1430 MB | 1583 MB | Chromium killed by the host's OOM killer (below) |
| 1.87 GB | 2,500,000 | (in mesh) | 1466 / 1408, 548 s, 26 chunks of ≤ 62 MB | 1468 MB | 1532 MB | 1443 MB | 1676 MB | 1679 MB | not run (below) |

What this shows, and what is still over:

- **Estimate vs measured.** The index estimate (`indexNeed`) is 478 MB for the 365 MB model (measured 474) and
  ~800 MB for the 1.06 GB one (measured 821 with the server's own ~130 MB). Meshing stays one geometry process at a
  time; on the 2.5M model the chunk was sized down to 62 MB so the index plus one geometry run fit, and the tree
  peaked at 1466 MB, under the budget. The 1.06 GB model's mesh tree peak (1603 MB) is 4% over the budget: the
  geometry process of a 223 MB chunk measured ~830 MB against an estimate of 1177 MB; the overrun is the server's own
  RSS (769 MB: the held index plus collector slack), which the budget counts at the index's estimate.
- **Linking and the 4D exports are index-only**: they work on every model above with `geometry: false` and never
  mesh. Past about 1.4M elements, though, the exports peak **over** the 1536 MB budget (1.27–1.68 GB at 1.4M–2.5M
  elements; heap 2048 MB, so they complete): the link rows (one row per element) and the per-activity element lists
  are ordinary objects. The CSV and the IFC copies are streamed; what is left is the link table itself. Not solved
  in this change.
- **Video.** The server-route MP4 with the bundled ffmpeg was made and decoded end to end up to 503,000 elements
  (6 M triangles, 7 tiles). The server stays at ~650 MB; Chromium's SwiftShader GPU process holds the geometry in
  system memory, so the tree reaches 2.0–2.1 GB. At 1.43M elements (20 tiles, ~600 MB of GLB) the host's global OOM
  killer killed Chromium's GPU process (the 16 GB host had ~1.5 GB free with other sessions running); the 2.5M model
  was not tried again for that reason. Such a page now fails at once with `browser_out_of_memory` naming the tiles,
  MB and triangles (it used to wait for the render's old fixed timeout). The client route draws the same tiles on the user's
  GPU, which is the route for models of that size.

## 7. Caches

- `INDEX_FORMAT` 10; cache files `<hash>-v10-t<tileMB>.ndjson` (compact index), `.geom` (fingerprints),
  `.tiles/` (the tile folder).
- Caches of other formats (the GLB of format 9, other tile sizes) are **renamed** into `<cache>/superseded/` the first
  time the model is opened again; the model is then read and meshed afresh. `superseded/` is pruned by age only (the
  same 14 days), never by size.
- Two loads of one file in one server share the one run (the second waits for it); a model whose meshing failed is
  meshed again once per run of the server when geometry is asked for, from its cached index.
