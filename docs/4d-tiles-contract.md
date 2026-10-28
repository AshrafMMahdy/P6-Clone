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

A render has **no fixed time limit** (owner rules 2026-10-27, 2026-10-28). It is alive while tiles load and frames arrive; the
browser's processor time is **not** life (a render loop that spins without drawing a frame is stuck). It is stuck
(`render_stuck`) after two windows in a row without a tile or a frame, a window being 4 times the longest gap between tiles or
frames this render has shown, never under 2 minutes. The first frame has no measured gap yet: it is one opaque call, bounded by
10 times the estimate (`frameMs`, `renderplan.ts`), then the measured gaps rule. The browser's start-up has a window of its own
(`P6CLONE_STARTUP_WINDOW_MS`, 60 s, two in a row; the renderer probe too). Only the graphics card's failures fall back to
software (`webgl_context_lost`, `gpu_out_of_memory`, `gpu_process_crashed`, `webgl_unavailable`): quality and
`estimated_minutes` are then worked out again for the processor (auto may now draw a draft) and the note says it took longer.
Every other failure (`browser_out_of_memory`, `disk_full`, `render_stuck`) is `render_failed` with the cause and the next step: a
smaller quality first. A card that failed is remembered for the process (driver-level failures for good; running out of memory
for models that size). The answer's `drawn` is what was actually drawn (`{geometry: "full" | "boxes", width, height}`: `quality`
names the picture size, and `boxes: true` at standard size is still boxes), and `quality_note` is set whenever boxes are drawn.
WebM to MP4 (ffmpeg) is watched by ffmpeg's own `-progress` frames; the desktop app's video render (`main/bim.ts`) by the same
watch as the server's (`inPage` in `headless.ts`: tiles loaded, frames drawn, a page whose process is gone ends it at once).

**How a job is judged stuck** (`core/bim/liveness.ts` `judge`, `core/bim/heartbeat.mjs`). Two layers, one rule for every worker:

1. *A loop we own reports progress* (geometry reader: every mesh callback; chunker: every 4 MB scanned, every product, every
   window written; tiler: every placed element and every tile written; Navisworks reader: every tree object, fragment, piece,
   element and copied chunk; Revit: every 8 MiB of IFC written; render: every tile and frame; ffmpeg: every frame). Stuck = no
   tick for two windows, a window being 4 times the longest gap between ticks THIS job has shown (measured in the worker, every
   100 ms, not guessed from 5 s heartbeats), never under 2 minutes (`P6CLONE_WORKER_FLOOR_MS` shortens that for tests). A job that is
   slow but keeps ticking is never ended. Processor time is not life. Where the loop knows its `done` and `total`, a tick counts only
   if `done` advanced: going round again with the same count is silence. A step that knows its whole work (the geometry run: its IFC's
   size x rate) lets ONE tick take as long as 10 x that work, never less than two windows: one heavy element is an opaque call bounded
   by the size of what it works on, which cannot be known before it is done, so by the run's size.
2. *An opaque call that cannot tick* (web-ifc `OpenModel`, one inflate of a whole Navisworks section, rvt-rs's unpack, Microsoft
   Project's COM open/save) declares its expected time, input size x the rate measured on this machine, and is ended past
   **10 x** that (`BOUND_MULTIPLE`), never under the floor. Each Revit unpack attempt (the three modes share one WebAssembly instance,
   so a retry's memory may stay flat) is such a call with its own bound. Memory growth (Revit) and output growth (Microsoft Project's
   save) extend the clock only up to that bound, never alone. The rate is the slower of the reference rate (below) scaled by a
   300 ms start-up benchmark (`machineFactor`, 1 to 5; `P6CLONE_MACHINE_FACTOR` replaces it) and this job's own measured rate on its
   earlier chunks or models (`noteRate`). Inside a ticking step, a huge single element cannot keep silent longer than the step's
   own work bound.

   | Call | Reference rate | Where it comes from |
   |---|---|---|
   | web-ifc `OpenModel` + meshing (`GEOMETRY_S_PER_MB`) | 0.4 s per MB of the run's IFC | section 6: 0.24, 0.39, 0.38, 0.29 s/MB (105 MB to 1.87 GB models, chunker and tiler included), the worst rounded up |
   | Navisworks section inflate (`NAVISWORKS_S_PER_MB`) | 0.8 s per MB of file | the 509 MB federation opens in 6.8 min (above): 0.80 s/MB for the whole open |
   | rvt-rs unpack (`REVIT_S_PER_MB`) | 2 s per MB of .rvt, **provisional** | not measured in time: the "8x" is memory. Watched by memory growth meanwhile (a growing read is never ended for being slow) |
   | Microsoft Project COM (`MSPROJECT_S_PER_MB`) | 2 s per MB, **provisional** | not measured |
   | IFC index, in the server's own process (`INDEX_S_PER_MB`) | 0.1 s per MB of IFC | section 6 "open (index only)": 0.095, 0.096, 0.098 s/MB |
   | Chromium first frame | `renderMinutes` (2.1 M triangles/s software, 400 M/s card) | section 4 (509 MB federation) |

   **To update a rate**: edit the one named constant at the top of `core/bim/heartbeat.mjs` and the row above. The Revit and Microsoft
   Project figures are waiting for a measurement on the owner's PC (the Helsinki .rvt projects; two or three .mpp files).

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

**The server's own process** (`core/bim/serverWatch.ts`, `heartbeat.mjs` `startServerWatch`). The sections that read input inside the
MCP server are declared (`watched()`): the IFC index (`stepIndex`: a tick per 1 MB read, a work bound for the pass after the scan), the
cached model index (read and write), the 4D file readers (`import_4d`). A thread of the server judges them by the same rule. Stuck while
the event loop still turns (waiting on something that never comes): the job is cancelled with the reason and the server goes on. Stuck
while the main thread is blocked in a synchronous loop: V8 cannot interrupt it, so the thread writes `stuck.json` into the server's
recovery folder and ends the process; every project is checkpointed on disk shortly after its last change and comes back under its
handle on the next start, which prints the reason and reports it in `server_status` `recovery.previous_server_ended_stuck`.
`P6CLONE_SERVER_WATCH=off` turns the watch off. Undeclared work is never judged. Not declared, with the reason: the analysis and LOB
engines (Monte Carlo, crash, optimize, windows analysis, LOB plans) have no measured rate to size a bound from and tick between steps only,
so a long legitimate step would be a false kill of the whole server (they are ended by `cancel_job`); the O(elements) passes (links,
exports, quantities) are finite array loops of milliseconds per 100,000 elements and cannot hang.

Every stuck error carries the facts as data, besides the words: the tool error's `stuck` (`{step, kind, silent_ms, window_ms, windows,
longest_gap_ms | bound_ms, expected_ms, done, total, tried, alternatives}`) with `reason: "stuck"` for a model that cannot be read
(`model_unreadable`), `import_4d` (`bad_input`) and a render (`render_failed`, `data.stuck`); `open_model` answers `geometry_stuck` beside
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
  `INDEX_PER_BYTE` 0.4, `INDEX_KNEE` 256 MB and `INDEX_FIXED` 160 MB (a small file costs about its own size while it is
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
