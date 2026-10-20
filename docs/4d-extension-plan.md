# Plan: 4D extension (Navisworks TimeLiner / SYNCHRO style)

Status: research and plan, nothing built yet. Written 2026-10-20. Sources are listed at the end.

## What it is

An **Extensions** tab with a **4D** extension:

1. Load an IFC model next to the schedule.
2. Link activities to model elements:
   - by hand (pick in 3D or in the model tree, then attach to the selected activity);
   - by rules (like Navisworks Auto-Attach and SYNCHRO Auto-Matching);
   - later by the AI agent (on hold).
3. Play the construction sequence on a timeline in step with the Gantt chart.
4. Render an MP4 video.
5. Export packages that open in real Navisworks, SYNCHRO and Bonsai with the links already in place, ready to keep editing there.

Note: a video can't be edited in Navisworks or SYNCHRO, so the MP4 is the deliverable. What stays editable there is the linked model package (IFC + schedule + sets or matching keys).

## How real 4D planners do it (what we are copying)

**Navisworks TimeLiner**
1. Append the IFC model.
2. Build search sets: saved queries such as "IFC GlobalId = …" or "Level = L3 and Category = Walls".
3. Add the schedule as a data source. Navisworks cannot read XER or P6 XML: it reads CSV, MPX or MS Project, or connects to the P6 database or Web Services.
   - Map the fields once: Task Name, **Synchronization ID** (must never change), Display ID, start and finish, Task Type, User 1–10.
   - Then click **Rebuild Task Hierarchy**.
4. **Auto-Attach Using Rules**, for example "Selection Sets by Task Name, column Display ID", or "items whose property X equals task column Y".
5. Task types: Construct (green, then shown as built), Demolish (red, then hidden), Temporary.
6. Simulate, and save as an NWF. Later schedule updates use **Synchronize**: links survive because the Synchronization ID is stable.
7. Export Animation produces AVI or an image sequence only, not MP4.

**SYNCHRO 4D Pro**
1. Import the P6 XML (baseline), then import the IFC.
2. Turn the 3D objects into **resources**.
3. **Auto-Matching**: text in a task field (Activity ID, a user field or an activity code) equals text in a resource field (name, or a field from IFC properties).
4. Appearance profiles: Install, Maintain, Remove, Temporary.
5. Updates use **Synchronize From** with a new P6 XML, keeping Project ID, WBS codes and Activity IDs stable.

**The trick both rely on:** the schedule carries a **4D key** per activity, and the model elements carry the same key, or are grouped into a set named after it. A rule then links them with no clicking per element.

## The parts we write ourselves vs what is closed

| Thing | Status | Our route |
|---|---|---|
| Navisworks NWD/NWF file format | closed (no spec; only the commercial ODA BimNv SDK writes it, and TimeLiner writing is only on its roadmap) | Generate the inputs Navisworks rebuilds from (IFC, search-set XML, CSV or MPX), so about 5 actions give a linked model. Optionally a small Navisworks add-in that builds the NWD in the background on a PC with a Navisworks licence (`Roamer.exe -NoGui`, official .NET TimeLiner API). |
| Search-set XML | export/import is official; the schema isn't published (community-known structure) | We write it. Capture one export from the user's Navisworks version to match its category/property names and flags exactly. |
| TimeLiner CSV / MPX | official | We already write MPX; CSV is trivial. |
| SYNCHRO .SP / .SPX | closed | P6 XML plus IFC with a shared 4D key, then Auto-Matching (official). Later: the iTwin Schedules REST API for SYNCHRO's cloud (technical preview). |
| IFC4 4D (IfcWorkSchedule, IfcTask, IfcTaskTime, IfcRelSequence, IfcRelAssignsToProduct/Process) | open standard | We write it: it opens fully linked in Bonsai and is an open archive copy. |
| MP4 | open | Our own renderer, WebCodecs, and the mediabunny muxer. |

## Building blocks (licences checked)

- **web-ifc** (MPL-2.0): IFC parsing and writing in WebAssembly, GlobalId, property sets.
- **That Open components / Fragments** (MIT): viewer, picking, model tree, fast instanced format for big models.
- **mediabunny** (MPL-2.0) with WebCodecs `VideoEncoder`: MP4 in Chromium/Electron. Use H.264 when `isConfigSupported` says yes, else VP9/AV1.
- Avoid **xeokit** (AGPL).
- Reference implementation to learn from: **Bonsai / IfcOpenShell** 4D (data model, linking by selection queries, animation colours and keyframes).

## Data in the clone

- `_4DLINK` (private table, never in the XER): activity, then element GlobalIds, plus the link kind: output (built) or input (demolished or consumed), as in IFC4 and Bonsai.
- `_4DTYPE`: task types / appearance profiles with start/active/end colour, transparency and visibility, defaulting to Navisworks' Construct / Demolish / Temporary.
- The IFC file path per project, and a cached Fragments file for fast reopening.
- A **4D Key** per activity, written as a P6 UDF or activity code so it travels in the XER and P6 XML (default: the Activity ID).

## Steps

### Phase 1: viewer, manual linking, playback
- An Extensions tab (a framework for future extensions), with 4D as the first one.
- Load IFC with a progress bar (convert to Fragments and cache). A model tree by storey, class and type. Property panel. Select, isolate and hide.
- Link by hand: select elements, then "Attach to activity" (or drag onto a Gantt row). Show linked/unlinked counts, "select unlinked", and "show this activity's elements".
- Timeline: a date slider bound to the Gantt's date line, play/pause, speed, colours from the task types, planned vs actual.
- Teaching: the AI assistant's cursor can drive all of this later, through the same live tools it uses today.

### Phase 2: rules and exports to the real tools
- Rules editor, modelled on Navisworks and SYNCHRO:
  - property equals the activity's 4D key (or Activity ID or a code);
  - set name equals the key;
  - level plus category to a WBS element.
  - A preview shows what each rule links before applying it.
- **Navisworks package**: `model.ifc` (with a `4D` property set holding each element's key), `4D_searchsets.xml` (one search set per activity, OR'ed GlobalIds), `timeliner.csv` (SyncID = P6 task_id, Display ID = Activity ID, name, dates, task type, User 1 = 4D key) and `timeliner.mpx`, plus a one-page "open it in Navisworks" checklist.
- **SYNCHRO package**: `schedule.xml` (P6 XML with the 4D key UDF / activity code) and `model.ifc` (same key in a property set), plus an Auto-Matching checklist.
- **IFC4 4D**: `model_4d.ifc` with the schedule and links inside, which opens linked in Bonsai.
- **Import back**: Navisworks search-set XML and TimeLiner CSV exports, and IFC4 4D, become links in the clone.

### Phase 3: video
- Camera viewpoints and a camera path, a date/activity overlay, an optional Gantt strip and legend, resolution and frame rate. Encode to MP4 off screen, frame by frame, so speed never drops frames.

### Phase 4: automation (optional)
- A Navisworks add-in plus a `Roamer.exe -NoGui` call that turns our package into a fully linked NWD (tasks, attachments, task types). This needs a Navisworks licence on the same PC.
- SYNCHRO cloud through the iTwin Schedules API, once binding resources to elements is confirmed there.

### Phase 5: the AI agent links elements (on hold)
- It reads element properties plus the schedule, proposes rules and links, and the user approves them on screen.

## To check on a real installation (needs the user's Navisworks / SYNCHRO)

1. Export one search set (OR of two GlobalIds) from your Navisworks version. This gives the exact category/property internal names and condition flags. Since Navisworks 2025 the IFC loader calls the field GlobalId under "IFC Attributes"; the older loader called it IfcGUID.
2. Is MPX still offered as a TimeLiner data source in Navisworks 2025/2026? CSV always is.
3. In SYNCHRO: does it import XER directly, and how do its IFC objects become resources and expose property fields for Auto-Matching?
4. How Navisworks behaves with thousands of GlobalId conditions in one search set.

## Sources

- Navisworks file types: https://help.autodesk.com/cloudhelp/2020/ENU/Navisworks/files/GUID-C6936A0B-1597-4880-83F9-7041894A4204.htm
- TimeLiner workflow and NWF: https://help.autodesk.com/cloudhelp/2026/ENU/Navisworks-Timeliner/files/GUID-96D92B8A-CD9D-4E25-A549-0EB2BF15B5CE.htm
- TimeLiner CSV field mapping: https://help.autodesk.com/cloudhelp/2026/ENU/Navisworks-Timeliner/files/GUID-AFE7BC80-7481-48CD-9BAD-A5D804EDF65A.htm
- Data sources, Rebuild and Synchronize: https://help.autodesk.com/cloudhelp/2016/ENU/Navisworks/files/GUID-4CFA1F1B-AE51-41CC-93AD-45952F38C415.htm
- Auto-Attach rules: https://help.autodesk.com/cloudhelp/2026/ENU/Navisworks-Timeliner/files/GUID-2678DD24-97E7-4D7B-80D4-77A448884599.htm
- Search sets export/import: https://help.autodesk.com/cloudhelp/2020/ENU/Navisworks/files/GUID-D4B6B835-499E-4C10-BA70-46353B90A0D0.htm
- Search-set XML sample: https://forums.autodesk.com/t5/navisworks-api-forum/create-a-custom-selectionset-which-selects-only-objects/m-p/12576106
- Task types: https://help.autodesk.com/cloudhelp/2025/ENU/Navisworks-Timeliner/files/GUID-102BBA3C-0C3B-46E7-AE9D-238794E0123B.htm
- Export Animation (AVI / images): https://help.autodesk.com/cloudhelp/2020/ENU/Navisworks/files/GUID-164E5676-EECE-46B5-8027-0699B5A4DECB.htm
- TimeLiner API (attach sets to tasks): https://blog.autodesk.io/attach-search-or-selectionset-to-a-timeliner-task/
- Running Navisworks headless: https://forums.autodesk.com/t5/navisworks-api-forum/calling-navisworks-with-command-line-switches/td-p/11102188
- ODA BimNv SDK: https://www.opendesign.com/products/bimnv.md
- Navisworks IFC loader (GlobalId vs IfcGUID): https://aps.autodesk.com/blog/model-derivative-api-ifc-svf2-translation-method-v4-and-migration-tips
- SYNCHRO P6 import: https://communities.bentley.com/products/construction/w/synchro-4d-wiki/41568/how-do-i-import-baseline-data-from-primavera-p6
- SYNCHRO Auto-Matching: https://communities.bentley.com/products/construction/w/synchro-4d-wiki/68682/auto-matching
- SYNCHRO SP/SPX import: https://communities.bentley.com/products/construction/w/synchro-4d-wiki/68582/import-sp-spx-synchro-project-formats
- iTwin Schedules API: https://developer.bentley.com/apis/schedules/
- IfcOpenShell sequence API (4D): https://github.com/IfcOpenShell/IfcOpenShell/tree/v0.8.0/src/ifcopenshell-python/ifcopenshell/api/sequence
- web-ifc: https://github.com/ThatOpen/engine_web-ifc · Fragments: https://github.com/ThatOpen/engine_fragment · mediabunny: https://github.com/Vanilagy/mediabunny
