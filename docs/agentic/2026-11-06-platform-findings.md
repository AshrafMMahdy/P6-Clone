# For the platform agent: findings from embedding the scheduler agent in the P6 clone (2026-11-06)

One list, nothing counted twice. References are at White-Hat-IQ-2 `33-chat-only` `fe0ad77f`. The clone carries a
workaround for most as a patch in `AshrafMMahdy/P6-Clone/patches/whiq-agent/` (named per item); take them, or fix in
your own way. Items 1-4 show up when the platform runs locally (desktop or self-hosted), but 1 matters everywhere.

## Bugs

1. **Security: local servers trust any caller (an API key can be stolen).** `06 LLM Router/server.mjs:1223` (`isAdmin`)
   and `:306` trust a client-sent `x-org-role: master`; `shared/chat-engine/server/identity.ts:147` trusts `x-cowork-as`;
   neither server (`server.mjs:1227`, `03 .../app/server.ts:122`) checks Host or Origin. Reproduced: with a DNS-rebinding
   Host header, `/api/agent/send` ran the agent, and `PUT /api/config` (with `x-org-role: master`) redirected a
   provider's baseUrl so the next chat sent the real key to a listener. Fix: refuse any Origin and any Host other than
   `127.0.0.1:<port>` / `localhost:<port>`; never take roles from client headers without a token. (Clone: a preload in
   `main/whiq-host.ts`, no patch.)
2. **Security: `09 Local Sandbox/service.py` checks neither Host nor Origin** (`do_GET` :429, `do_POST` :434): a web
   page can run code in the jail. Fix: as in clone patch `04` (`foreign()`).
3. **Node engines never start under Electron.** `engines/craftSupervisor.ts:548` drops `ELECTRON_RUN_AS_NODE` from the
   engine environment, and `engines.ts:116` runs a `kind: node` engine with `process.execPath` (electron.exe in a desktop
   app), so the p6clone engine opens as a windowless app and every start times out (-32001). Patch `03`.
4. **Local code and transcription tools are gated on the E2B key.** `03 .../tools/index.ts:395` and
   `tools/shared/index.ts:104` hide `run_code` / `save_sandbox_file` / `transcribe_audio` without `E2B_API_KEY` in local
   mode, even with `VM_SANDBOX=on`. Also: `transcribe_audio` does not need a sandbox at all (it goes through the router's
   `stt` seat), so its gate should be "the stt seat is set". And `run_code`'s description (`run_code.ts:41`) always
   promises E2B (pip, ImageMagick, Docker), wrong for a local jail. Patch `02` (VM_SANDBOX gate, `WHIQ_STT_SEAT`,
   `WHIQ_SANDBOX_NOTE`).
5. **A local-sandbox restore cannot work (found by reading).** `sandbox/e2bClient.ts` stages snapshot parts at
   `/tmp/__whiq_state.*` (113, 133, 162) through `/write`; `service.py` `path()` (:127) maps `/tmp/x` to
   `<home>/tmp/x`, while the restore code in the jail reads the jail's real `/tmp`.
6. **Snapshots cover only sandboxes the platform ends itself.** `e2bClient.ts` snapshots in `destroyForChat` (:492)
   after its own idle (:42); a local service that ends a session (idle, memory, crash) leaves the platform on an empty
   replacement whose later snapshot can overwrite the good one. (The clone's Pyodide service snapshots its own.)
7. **PQ-VAE sidecar limits.** `pqvae/sidecar.py` `/review_schedule` (:414) index-errors past 256 activities and
   `/trajectory` (:526) past 120 periods; JWM (11,404 activities) takes about 216 s, over `pqvaeClient.ts:344`'s 180 s
   client timeout (the sidecar keeps computing, later calls queue). Your call on limits; the clone's Node port windows
   past 256, abandons work when the client goes, and shares readings for names differing only in digits above 3,000
   never-read names (with a notice).
8. **PQ-VAE text readings are re-read after every idle stop** (efficiency, no accuracy change). `textenc.py` `_cache`
   is memory-only and dropped when the sidecar stops after 600 s (`PQVAE_IDLE_S`). Port the clone's disk cache
   (P6-Clone commit `dee95f2`, `main/pqvae/textCache.ts`; Node, so port rather than cherry-pick). Language-neutral
   layout: `<root>/<sha256(model id)[:16]>/model.txt` (`name@revision:variant#sha12`) and 256 shards `<xx>.bin`
   (xx = first byte of sha256(text)) of 1,568-byte records: sha256 of the UTF-8 text (32) + 384 float32 LE.
   Append-only; a short last record is ignored. Hosted: the root must be on storage that survives a redeploy.
9. **No Researcher or Handover seat.** `childAgents.ts:40` `KIND_SEAT` has no `research`; a handover always goes to
   the next tier. Patch `01` (`research` seat; `WHIQ_HANDOVER_TIER`).
10. **Provider extra headers only in the config file** (a gateway token in plain text beside env-held keys). Patch
    `04` (`headersEnv`, resolved in `withResolvedKey`, `server.mjs:551`).
11. **Wording:** the "No web-search provider configured" refusal (`tools/web_search.ts:271`) points to "Admin → AI
    Providers", which a desktop or self-hosted run does not have; and a search seat set to a provider that cannot
    search (`provider_not_searchable` 424) shows that same refusal instead of naming the provider.

## Additions the clone made that the platform may want

12. **Memories as Markdown files** (patch `05`, `memoryMarkdown.ts`): with `WHIQ_MEMORY_DIR`, one file per memory,
    `<dir>/<General | project>/<Facts | Preferences | People and parties | Decisions | Other | Project introduction>/`;
    hand edits, deletions and additions picked up; unset = your JSON store unchanged. Note: deleting a recursively
    watched folder makes Node spin the CPU on Windows; the store closes its watcher when the folder goes.
13. **Projects without the Database** (patch `06`): in local mode a chat takes `localProjectId` / `localProjectName`
    (no bucket check); memory and `project_intro` are scoped to it; nothing of a Database project turns on.
14. **Web search through an Anthropic provider** (patch `07`): `searchAnthropic` in the router (`web_search_20250305`
    server tool), so an Anthropic key alone gives web search.
