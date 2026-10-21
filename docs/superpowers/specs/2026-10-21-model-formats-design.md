# Revit and Navisworks models in the clone (for 4D and for every agent)

Status: approved by the user 2026-10-21 ("Ok you can build them"). Built in stages: RVT first, then NWD.

## Why

A 4D schedule needs the model's elements: identity (GlobalId / Revit ElementId), class or category, level, family and
type, material, parameters, and quantities. Projects share them as Revit `.rvt` files and as Navisworks `.nwd`/`.nwc`
files (the federated model BIM coordinators, contractors and MEP engineers publish), not only as IFC. The platform's
other agents (QS, Procurement...) read the same files through the clone's MCP server, so opening a model must not need a
schedule.

Not the goal: a 3D viewer. Geometry matters only for quantities (derived volumes, areas) and the 4D video.

## Decisions

1. **One pipeline.** A Revit or Navisworks file is turned into IFC4 on open (cached by its content hash), and the
   existing IFC pipeline does the rest: element index, properties, storeys, quantities, links, 4D, exports. Every tool
   that works on an IFC works on these files, with no new tool.
2. **Revit through rvt-rs** (github.com/DrunkOnJava/rvt-rs, Apache-2.0, clean-room): its WebAssembly build, compiled
   from a pinned commit, ships in the release beside web-ifc (`ifc/rvt/`), run in its own process (`rvtWorker.mjs`) so
   a bad file cannot take the server down. No Revit, no Python, no native binary; the file never leaves the machine.
   - Fidelity follows the Revit version (rvt-rs: element geometry measured on 2023-2025 projects, other versions
     experimental, family geometry not decoded). The open_model answer says which, with rvt-rs's own diagnostics
     (what was approximated or skipped), never more than it read.
   - Element GlobalIds are those Revit's own IFC export writes (measured: 132 of 132 on the user's 2023 project), so
     links made on an RVT survive swapping in Revit's IFC export and back (relink_model).
   - Most Revit parameters are not read by rvt-rs yet: the gap is reported, not hidden.
3. **Navisworks through our own clean-room reader** (no usable open reader: the one public C++ reader has no licence;
   the ODA SDK is commercial). Built only from byte observations of files we may use (`sample 4D/`, the user's own),
   never from Autodesk or third-party reader code. Stages: (a) container, model tree, element identity (GUIDs, Revit
   ElementIds), categories and properties; (b) geometry (triangle data) for quantities and video; (c) TimeLiner tasks.
   Measured on the user's 2016 villa: the NWC carries the RVT's Revit ElementIds (192 of 200 sampled).
4. **Model without a schedule.** `open_model` without a handle opens the file into a new model-only workspace (an
   empty project named after the file) and answers its handle and owner_key; list_elements, element_info and
   quantities work on it. `P6CLONE_TOOLSETS=core,4d` gives an agent the model tools only.

## Limits

- rvt-rs runs in 32-bit WebAssembly (4 GB). A model past that is refused with a clear error; rvt-rs's native CLI is
  the fallback to add when a real file needs it.
- Older Navisworks stream revisions (lichunk-007, revision 103) and compressed geometry variants may lag; each open
  says what was read.
