# Navisworks add-in (optional, M7)

**Optional and untested against Navisworks.** It needs a PC with a Navisworks Manage or Simulate licence, which the
clone's tests and the platform's VM do not have. Everything else in the clone's 4D works without it; the normal route
to Navisworks is the package from `export_4d` (target `navisworks`) and its README's manual steps.

What it does: turns that package into a ready-linked NWD without clicking through Navisworks.

1. `export_4d {target: "navisworks", path: <folder>}` (or Extensions > 4D > Export in the desktop app).
2. On the Navisworks PC: `.\build.ps1` (needs the .NET SDK; pass `-NavisworksDir` for another version). Installing
   into Navisworks' `Plugins` folder may need an administrator prompt.
3. `Runner\bin\Release\net48\P6Clone4DRunner.exe <folder>` starts Navisworks hidden, appends `*-4D.ifc`, and runs the
   add-in. For each row of `timeliner.csv` the add-in saves a search set (WHIQ_4D / Task = the 4D key in User 1, named
   like the task) and adds a TimeLiner task with its planned and actual dates, task type and elements. It saves
   `<model>-4D.nwd` in the folder.

The add-in also appears inside Navisworks (Add-Ins tab, "P6 clone 4D"): run it on an open model with the package
folder as its parameter.

API used: `Autodesk.Navisworks.Api` (Search, SelectionSets), `Autodesk.Navisworks.Api.Timeliner` (DocumentTimeliner,
TimelinerTask) and `Autodesk.Navisworks.Api.Automation` (NavisworksApplication). Written for Navisworks 2025; the
same calls exist back to 2016.
