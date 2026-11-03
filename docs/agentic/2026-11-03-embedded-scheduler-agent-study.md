# Embedding the platform's scheduler agent in the clone: study

Date: 2026-11-03. Platform read at `origin/33-chat-only` (White-Hat-IQ-2, fetched today, nothing checked out). Clone at master 8b33035.

## 1. Goal (owner's words, condensed)

The clone's right-side AI panel becomes another copy of the platform's **scheduler agent**:

- the same harness;
- every scheduler-specific and general skill and tool;
- the same external engines (Word, Excel, PowerPoint, PDF/OCR, DWG, and the clone itself).

It still works on the open schedule in front of the user, with the moving cursor, which stays. Nothing is taken away. The platform's front end does **not** come along: the panel stays a small right-side chat. It gains composer buttons:

- **Attach.**
- **Working folder.** Created files go there. If no folder is chosen when the first file is written, the user is asked to pick one.

## 2. What exists today

### Clone's embedded agent (`renderer/ai/`, `main/ai.ts`)

- **Loop.** One tool loop in the renderer, about 530 lines.
- **Provider calls.** Made in the main process, Anthropic or OpenAI-compatible, with the key kept in main.
- **Chat history.** Kept on disk.
- **Tools.** 23 in all:
  - 11 schedule queries (`core/query/tools.ts`);
  - 12 "live" tools that drive the visible UI with the gliding cursor: `ui_menu`, `ui_click`, `ui_type`, `edit_project`, the report tools, `undo`, and others.
- **Missing.** No skills, no sub-agents, no memory, no file reading or writing, no working folder.

### Platform scheduler agent

- **Harness.** `shared/chat-engine/server/`, about 49k lines, published as the package `@whiq/chat-engine`. Apps plug in through a `ChatProduct` manifest (`docs/CHAT_ENGINE_MERGE.md`). The scheduler is the `scheduler` module of `03 Shared Platform Agents/app` (manifest `product.ts`, prompt `modulePrompt.ts`, skills `moduleCommands.ts` + `product/promptSkills.ts`).
- **Loop.** `agentLoop.ts runTurn`, with:
  - a cache-friendly prompt;
  - streamed events over SSE;
  - a trust gate (auto / ask / refuse);
  - result caps;
  - self-healing of malformed calls;
  - deferred tool loading (`load_tools`);
  - the **stop ladder** for continuity (step cap, stuck, circling, open steps, …), which escalates: steer → different route → advisor → ask the user;
  - pace checks;
  - two-step context clearing, then compaction.
- **Seats and sub-agents** (`childAgents.ts`). research / work / handover / review (skeptic) / advisor (senior guidance) / fast / vision / RLM, each with step budgets, spawned by `dispatch_agents`, `handover`, `consult_advisor`, the reviewer tools and `summon_council`.
- **Effort.** `MATCH_THE_EFFORT` and `WORK_IN_TIERS`: Tier 1 is the complete deliverable; Tier 2 is "Refine:" steps. These are the 80/20 rule already in prompt form.
- **Notes and memory.** Pads (Findings, Plan notes, personal) and an org memory store.
- **Skills.** Prompt templates loaded with `use_skill`.
  - Scheduler: baseline_scheduling, progress_report(_audited), lookahead_readiness, lob-scheduling, delay_recovery, what_if_analysis, programme_compliance, phasing-strategy, site-logistics-plan, permit-matrix, early-works-plan, mobilization-checklist, 4d-scheduling.
  - General: optimize, reading-large-pdfs, handover, review, the compare-* family, senior-review, and others.
- **Tools.**
  - Scheduler pack: create / edit / run CPM / verify / skeptic / progress / recover / export / import / basis of schedule, wiki, and analysis wrappers over the clone.
  - General: files and documents, drawings, `run_code`, OCR / retrieval, planning, children, memory, history, web search, browser, publish, tasks.
- **Engines** (`engines.lock`, `craftSupervisor.ts`). All are stdio MCP processes pinned by GitHub release tag with a sha256 check: wordcraft, gridcraft, deckcraft, cadcraft, pdfcraft, and **p6clone (this repo, `whiq-v0.1.55`)**.
- **Model calls.** All go through the **06 LLM Router** (localhost:5009, `llm-router.json`), which owns the keys, the seats (agent, skeptic, senior_guidance, vision_ocr, web_search, decide, …) and the tiers per module.
- **Local and offline support already exists.** `local-mode/` (PGlite, roster login), `electron-shell/` (spawns the gateway), and standalone working-dir mode (`POST /api/working-dir/set`, which matches the owner's working-folder idea).

## 3. Recommended architecture: same engine, new product manifest

**Run the platform's own chat engine inside the clone, rather than porting it.** The engine was designed to plug into other apps, and a port would mean copying about 50k lines that would then drift from the platform with every fix.

```
Electron main (clone)
 ├─ spawns: agent server  = @whiq/chat-engine + scheduler module, product "clone-embedded", standalone mode,
 │                          JSON stores under the app's user-data folder
 ├─ spawns: LLM Router    = 06 router, config generated from the clone's AI settings (keys never leave the PC)
 ├─ engines               = wordcraft / gridcraft / deckcraft / cadcraft / pdfcraft fetched by engines.lock
 │                          (first use or in the installer), run by the engine's craftSupervisor
 └─ "live clone" engine   = an MCP endpoint served BY THE RUNNING APP instead of spawning p6clone-mcp:
                            the 76 clone MCP tools act on the OPEN project (a live handle on the app's store,
                            every change undoable), plus the 12 on-screen tools with the cursor
Renderer: the existing right panel, now a client of the engine's SSE stream (tokens, tool calls, status,
          ask_user / approvals, files written, sub-agents running), plus composer buttons Attach / Working folder.
```

**Why the "live clone" engine.** The platform's scheduler already reaches the clone through `mcp__p6clone__*` and the scheduler pack. Pointing that same engine name at the running app means:

- every platform scheduler tool and skill works unchanged, but on the schedule the user is looking at;
- the cursor stays for on-screen actions.

**Keeping in sync (owner rule, 2026-11-03).** The platform repo gets nothing for this: no second harness, no release, no publishing. A clone-side script fetches the platform's agent code read-only from GitHub at a pinned commit into a gitignored folder of the clone (`vendor/whiq-agent/`) and builds it there; updating means bumping the pinned commit and fetching again. The embedded agent is desktop-app only: it is never part of the clone's MCP release (`dist-cli`, the `p6clone` engine the platform downloads), so the platform never receives a second harness either way.

### Platform pieces: keep, adapt, or switch off

| Piece | In the clone |
|---|---|
| agentLoop, stop ladder, self-heal, compaction, seats / children, pads, prompts, skills, trust gate | as-is |
| Engines + `engines.lock` / fetch | as-is (Windows binaries) |
| LLM Router | as a child process; config built from clone settings |
| Identity | standalone dev identity (single local user) |
| Working dir, uploads, outputs | a plain folder (standalone working-dir mode); bucket bridge off |
| Memory, history DB, wiki, checklists | JSON / files under user data |
| Right pane (preview, subagents) | replaced by compact items in the panel: file chips (open / show in folder) and one "working: research 3/75" line per sub-agent |
| 02 Database buckets, collab, field records, agent_comms, Channels, public-try, Clerk, Replit storage | off (platform-only) |
| E2B sandbox (run_code, query_documents, transcribe) | decision 2 |
| PQ-VAE sidecar (torch) | decision 3 |
| Bellator | off unless a key is set |

## 4. Decisions for the owner

1. **How the clone gets the agent engine.** Decided by the owner: fetched read-only from the platform's GitHub at a pinned commit into a gitignored folder of the clone; nothing added to or published from the platform; never in the clone's MCP release.
2. **Code execution on Windows** (`run_code`, `query_documents`, `transcribe_audio`). (a) WSL plus 09 Local Sandbox. (b) A local Python/Node process without isolation. (c) Off. (b) runs agent-written code with the user's rights, which is a real security risk. **Recommend (a)**, with (c) automatically when WSL is absent.
3. **PQ-VAE (`review_programme`, `forecast_outcome`).** It needs Python and torch (large). Bundle it, download it on demand, or leave it out.
4. **Model setup.**
   - The panel today takes one key.
   - The router supports separate seats and tiers (strong, flash, efficient) per module.
   - **Recommend:** one key with automatic tier mapping per provider, plus an "advanced" JSON for seats.
   - Web search and OCR seats need their own providers or keys.
5. **Engines download.** In the installer (bigger download, works offline at once) or on first use (smaller).

## 5. Build order (each phase ends usable)

1. **Spike.** Electron main runs the chat engine (scheduler product, standalone) and the router from the clone's key. The panel shows the stream. Plain chat and skills work.
2. **Live clone engine.** The MCP tools on the open project, plus the on-screen tools with the cursor. The platform's scheduler pack and skills act on the open schedule. All undoable.
3. **Files.** Working-folder button, prompt on first write, Attach (copied into `00_INPUTS/`), the five craft engines, file chips.
4. **Seats in the panel.** Sub-agent lines, ask_user and approval prompts, the pads / Needs-you note, memory.
5. Code execution, web search and OCR seats, per decisions 2–4. Then tests (the existing clone e2e plus an agent smoke), packaging, and the lock bump flow.

## 6. Risks

- **Two codebases meet.** The chat engine's Node version and dependencies run beside the clone's main process. Keep them as separate child processes, which the platform already does with the gateway.
- **Scheduler pack assumptions.** Platform storage for "the schedule" (`create_schedule` / `get_schedule`) must map onto the open project. This is the main adapter to write and test.
- **Size.** The engines (about 10–30 MB idle each) and the chat engine add to the installer. The clone already ships Java and the reasoner.
