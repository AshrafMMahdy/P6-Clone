# Plan: an agentic layer for the AI assistant

Status: brainstorm plan, nothing built yet. Written 2026-10-20.

## Goal

The in-app assistant stays what it is now: a teacher that explains P6 and does the work on screen with the virtual
cursor. On top of that it gets the tools a scheduler needs to plan from real documents and to hand over real
deliverables:

- **Read**: contracts, BOQs, specs, programmes and drawings from folders the user picks (PDF, Word, Excel, DWG/DXF),
  including scanned pages (OCR) and looking at pages and drawings (vision).
- **Remember**: a knowledge base per project, as plain Markdown files.
- **Produce**: a Basis of Schedule (Word), productivity and duration calculations and the Monte Carlo results (Excel), a
  short presentation (PowerPoint), and PDF markups.

## Principles

1. **Same engines as White Hat IQ.** The clone runs the exact binaries the platform pins in its `engines.lock`
   (WordCraft, GridCraft, DeckCraft, and PdfCraft and CadCraft once their forks are pinned), from the same releases and
   with the same SHA256 checks. A document made in the clone and one made on the platform come from the same engine
   version.
2. **The engines talk MCP; the clone hosts them.** The Electron main process starts each engine headless over stdio,
   like the platform's `craftSupervisor`, and passes the same contract flags (read and write roots, memory cap, idle
   eviction). The assistant sees their tools next to its own. The clone does not import the platform's agent loop:
   that loop is tied to the platform's gateway, database and router, and changes too often to copy.
3. **Local first, hosted later, one interface.** Documents come through a `DocumentSource`. In the exe it is folders and
   files the user grants on the PC (no upload). Hosted, it is the platform's storage mirrored into a working folder,
   which the platform already does. Tools never touch paths directly.
4. **Every agentic step is visible.** When the assistant reads a page, it opens it in a preview. When it builds a
   workbook or a document, the file appears in a Deliverables list. The cursor keeps teaching.
5. **The teaching assistant keeps working without any of this.** Missing engines or a model without vision make those
   tools unavailable, with one clear message; nothing else breaks.

## Project workspace

One folder per project: `<data>/workspaces/<Project ID>/`.

| Folder | Holds |
|---|---|
| `sources.json` | the folders and files the user granted (read-only to the engines) |
| `cache/` | extracted text and OCR per page, rendered page images, the search index |
| `kb/` | the knowledge base: Markdown files |
| `out/` | deliverables (docx, xlsx, pptx, pdf), the engines' write root |

The chat history stays where it is (`ai-chats/`, per project, append-only).

## Steps

### Phase 0: foundations

- **0.1 Pinned engines.** Add an `engines.lock` in the same format as the platform's, plus a fetch script that
  downloads the Windows builds, checks the SHA256 against the release's `SHA256SUMS`, runs `--version` and one smoke
  (an Arabic line, as the platform does), and places them under `release/engines/<name>/`. `npm run package` fails if
  a pinned engine cannot be fetched or started.
- **0.2 Engine host (main process).** An MCP stdio client (the official SDK) that:
  - starts one process per (project, engine, document), with `--automation-read-root` set to the project's granted
    sources and `--automation-write-root` set to `out/`;
  - caps memory, closes idle processes (the engines auto-save before eviction), and restarts a crashed one once;
  - gives the engine a minimal environment: the provider API keys never reach it.
- **0.3 Tool bridge.** Discovered tools become assistant tools named `<engine>__<tool>`, with their annotations
  (read-only, destructive) deciding when to ask the user first. Rarely used tool groups load on demand (a
  `load_tools` tool, the platform's pattern), so the prompt stays small.
- **0.4 Images in the conversation.** Tool results can carry images (PNG) to providers that accept them (Anthropic,
  OpenAI, OpenRouter vision models). The settings show whether the chosen model has vision; without it the image tools
  answer with text only.

Done when the assistant can call a WordCraft tool from the chat and the file lands in `out/`.

### Phase 1: documents in

- **1.1 Sources.** A Documents tab: "Add folder…" / "Add files…" (native pickers), shown as a tree with type, pages and
  size. The grants are stored per project. Hosted later: the same tab lists the platform storage.
- **1.2 Reading tools.**
  - `list_documents`
  - `read_document`: a page range, a sheet or a section, as text, so the model reads only what it needs instead of
    the user pasting whole contracts.
  - `search_documents`: a local full-text index over the extracted text, with document and page in every hit.
  - Text comes from PdfCraft (`text`), GridCraft and WordCraft (read), and CadCraft (layers, blocks, text).
- **1.3 Vision.** `view_page` (PdfCraft renders a PDF page to PNG), `view_drawing` (CadCraft renders a DWG/DXF view or
  layout to PNG, with zoom to a window), and `view_app` (a screenshot of the clone, so the assistant can check its own
  on-screen work).
- **1.4 OCR.** Scanned pages are read with PdfCraft's OCR. The text is cached per page in `cache/` and becomes
  searchable like any other text.
- **1.5 Teaching view.** When the assistant reads or looks at a page, the preview opens on that page with the passage
  highlighted, and the cursor points at it.

Done when, given a folder with a contract PDF, a BOQ workbook and a scanned drawing, the assistant answers "what are the
milestones and liquidated damages, and how much concrete is in the BOQ?" with document and page references.

### Phase 2: knowledge base per project

- **2.1 Markdown folder.** `kb/` holds plain Markdown: `project.md` (scope, parties, key dates), `assumptions.md`,
  `decisions.md`, `sources.md` (which document says what), `risks.md`. It is readable and editable outside the app and
  can be synced or committed.
- **2.2 Tools.** Use notes-mcp (the server the platform is moving to) once it is chosen, so both sides share one
  format. Until then, four small native tools: `kb_list`, `kb_read`, `kb_write` (append or replace a section) and
  `kb_search`.
- **2.3 Capture.** The assistant records every assumption and decision with its source (document, page, or "user
  said"), and reads the knowledge base before planning. Clear context empties the chat, not the knowledge base.
- **2.4 Visible.** A Knowledge tab shows the files; edits there are what the assistant reads next time.

### Phase 3: schedule from documents

- **3.1 Playbooks.** Scheduling playbooks in Markdown (contract → milestones, liquidated damages, working calendar,
  access dates; BOQ → quantities per work package; specs → sequences and hold points), starting from the platform's
  `skills/01-scheduler` at a pinned commit.
- **3.2 Duration basis.** Every activity records where its duration came from (quantity × productivity ÷ crew, an
  analogous past project, a quote, judgement) in a "Duration Basis" UDF and its notebook, with the source reference.
  This follows the platform's `durationBasis` idea.
- **3.3 Productivity workbook as the source of truth.** GridCraft builds `out/<Project> - Durations.xlsx`: quantities
  from the BOQ, rates, crews, and duration formulas. The schedule takes its durations from the workbook (through the
  existing Excel import or edit operations). When the user changes a rate in Excel, the assistant re-imports.
- **3.4 On screen.** The plan is built in the app as today (`edit_project`, cursor, schedule F9), with past projects
  and `copy_project` still available.

### Phase 4: deliverables out

- **4.1 Basis of Schedule** (WordCraft, docx). Sections:
  - scope and sources;
  - calendars and working assumptions;
  - WBS and coding;
  - the duration basis table;
  - logic and constraints;
  - critical path;
  - risks and Monte Carlo results;
  - exclusions.

  Tables come from the schedule data; figures are Gantt images from the existing print engine.
- **4.2 Calculations and risk workbook** (GridCraft, xlsx). The productivity workbook, plus a Monte Carlo sheet: P10 to
  P90, the histogram, milestone percentiles, criticality and sensitivity, all from the existing Monte Carlo engine.
- **4.3 Presentation** (DeckCraft, pptx), 6 to 10 slides: key dates, critical path, the P50/P80 finish, top risks,
  assumptions, next steps.
- **4.4 PDF markups** (PdfCraft): review comments on drawings or contract pages, optional.
- **4.5 Deliverables list.** Everything in `out/` is listed in the app and opens in the default program. The assistant
  reports what it made.

### Phase 5: packaging and optional capability packs

- **5.1 Size.** Today's Windows builds are about 43 + 44 + 35 MB (Word, Excel, PowerPoint), about 82 MB (PdfCraft
  portable) and about 57 MB (CadCraft portable): roughly 260 MB compressed on top of the app.
- **5.2 Packs.** Ship the app with the Office pack, and offer the PDF and CAD packs as downloads from the same pinned
  releases, verified by SHA256. The engine host asks for a missing pack when the assistant needs it ("Drawings need the
  CAD pack: install it?").
- **5.3 Licences.** Include each engine's licence (MIT / Apache-2.0) and the craft fonts' licences in the install.

### Phase 6: hosted, and "do it with White Hat IQ"

- **6.1 Hosted clone.** The renderer is already web code. The main-process parts (files, keys, engine host) move to a
  server, and `DocumentSource` points at the platform's storage. The platform's `craftSupervisor` already does the
  engine hosting, so it can be reused there.
- **6.2 Hand-off to the platform.** A "Continue in White Hat IQ" action sends the project, its workspace and its
  knowledge base to the platform, where the platform agent takes over (it already uses the clone as its P6 engine over
  MCP). This is how users grow from the free desktop tool to the full platform.
- **6.3 The platform drives the app (later).** Expose the assistant's on-screen tools (menus, clicks, typing, select
  activity) over MCP when the desktop app is running. The platform agent, which can already connect external MCP
  servers, could then teach and operate the user's open app with the cursor.

## Suggested order

0 → 1 → 4.1 and 4.2 (the first visible deliverables) → 2 → 3 → 4.3 → 5 → 6. Each phase ships on its own and keeps the
current assistant working.

## Open questions

1. **PdfCraft and CadCraft forks.** Will they get `-whiq` forks with the same contract flags and `whiq-release.yml` as
   the Office crafts? PdfCraft's OCR is not described in the upstream README yet, so the fork would expose it as MCP
   tools.
2. **Knowledge base server.** Which notes-mcp, and whether the platform will read the same `kb/` layout.
3. **Confidential documents.** Must everything work with a local model (LM Studio)? Then vision and OCR quality depend
   on the local model, and PdfCraft's OCR matters more.
4. **Packs.** Which engines ship in the base install, and which download on demand?
5. **Templates.** Is there a house template for the Basis of Schedule and the deck (fonts, logo, sections)?
