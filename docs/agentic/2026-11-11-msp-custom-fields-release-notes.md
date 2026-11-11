# Microsoft Project XML carries P6 custom fields (next release)

**What changed for the platform.** A Microsoft Project XML the clone writes now carries the P6 custom fields (UDFs) of activities and resources, and opening a Microsoft Project XML (or an .mpp, which is read through MPXJ as Microsoft Project XML) turns its aliased custom fields into P6 custom fields. XER to Microsoft Project XML to open again gives the same fields (names, values) back. Code: `core/msp/custom-fields.ts` (slot table, allocation, notes), `core/msp/mspdi.ts`, `core/msp/shared.ts`, `core/msp/keep.ts`; tests: `tests/msp-custom-fields.test.ts`.

**Slots.** Activities go to the Task's Text1-30 / Number1-20 / Cost1-10 / Start1-10 / Finish1-10 / Date1-10, resources to the Resource's, by the P6 data type (text: Text; number, integer: Number; cost: Cost; start date: Start; finish date: Finish; date: Date; indicator, code: Text). The clone's own fields keep Task Text1-6 and Resource Text1. A customer's file's own slots are never taken. A field keeps its slot through save, open, save.

**Notes a caller now sees in `save` (format mspdi), under `notes`:**
- `Custom fields NOT carried to the Microsoft Project XML: activity <Kind> fields "A", "B" (Microsoft Project has N <Kind> custom fields on a task: ... none was free).` Every field that did not fit, by name.
- `Custom fields NOT carried ...: project / WBS / resource assignment / activity expense / role custom fields "..." (<why>).` Those subjects have no Microsoft Project custom fields the clone can use.
- `Custom fields written as Microsoft Project Number fields: activity "..." (integer ...)` and `... Text fields: ... (indicator / code fields ...)`: the type has no Microsoft Project kind of its own, so it opens again as number / text.
- On open, an info finding `MSP_CUSTOM_FIELD_KIND` names the aliased flag, duration and outline-code fields, which stay in the file untouched.
- On open, an info finding `MSP_CUSTOM_FIELD_SUMMARY` when summary tasks (or the project summary task) carry custom field values: it names the fields and how many summary tasks carry values, and says they stay in the Microsoft Project file but are not in the P6 data, so an XER / P6 XML made from it does not have them. Summary tasks are WBS elements here; no WBS mapping was built.
- On open, an info finding `MSP_CUSTOM_FIELD_UNNAMED` names the fields that were read under their Microsoft Project field name (for example `activity Text8`) because the file gives them no alias.
- `Custom field text longer than 255 characters: activity "Long" (2 values). Microsoft Project's Text custom fields hold 255 characters, so it shows the first 255 of each of these values; the file holds the whole value and nothing was cut.` (the 255 is Microsoft Project's field size, the constant `MSP_TEXT_FIELD_SIZE`, not a limit of the clone's).
- `Custom field "Room": the value on activity "A1010" was edited, so it is written as a plain value; the lookup-table link the file held for it (ValueGUID) was dropped.` In a customer's file saved in place, the custom field elements of a task whose value did not change go back exactly as the file had them (lookup links included); only an edited field's element is made anew.

**Which fields get a slot (order).** (1) fields read from the file keep their slot; (2) fields with a value in the project being written, in UDF type ID order; (3) only when writing a NEW file, declared fields with no value, in ID order, while slots remain. A customer's file saved in place gets no definition of a field that has no value in that project, and says nothing of it. What gets no slot in (2) or (3) is named in the first note above.

**Number types.** Every `FT_FLOAT*` P6 type is written as a Number field. An integer field comes back from Microsoft Project as a number field; the schedule reasoner's "WHIQ leveling rank" check accepts a number field as well as an integer one (any other type is still refused; a missing one is still created as integer).

**Aliases.** A customer's alias is written back as it was unless the user renamed the field (two aliases that differ only by case no longer get a `(Number1)` suffix in the file).

**The platform's own note must be updated when this release is pinned:** the note that "a Microsoft Project XML file written by the P6 clone does not carry ... custom fields ..." is no longer true. It carries them, except what the notes above name (more fields of a kind than the format has slots; project, WBS, assignment, expense and role fields; integer, indicator and code fields come back as number / text).

**Cost fields** are written in hundredths of the currency unit (1234.50 as 123450), the scale Microsoft Project and MPXJ use for a custom Cost field. The clone's other Microsoft Project cost elements (Cost, ActualCost ...) are written and read in plain units; that was not changed here.

## Microsoft Project money, rates and material units: one definition of the format's value types (next release)

**What was wrong.** Microsoft Project XML stores each kind of value its own way: currency in hundredths of the currency unit (1234.50 is `123450`;
`<CurrencyDigits>` only says how many decimals Project shows), durations and work as ISO strings, slack and lag in tenths of a minute. The reader and the
writer converted each value by hand where it was read or written, and the assignment costs (`Cost`, `ActualCost`, `RemainingCost`) were never given their
type: they were read and written as plain numbers. So every cost from a Microsoft Project file (an `.mpp` through MPXJ, or XML) was 100 times too high in the
clone (`AIStudio App schedule.mpp`: assignment `<Cost>2000000</Cost>` showed as a target cost of 2000000 and a rate of 10000 per quantity), and every cost the
clone wrote was 100 times too low in Microsoft Project. It stayed hidden because the hand-made fixture `tests/fixtures/rich-mspdi.xml` had plain-unit costs,
so the tests agreed with the code. The reference check (below) found two more of the same kind: a **rate** is per hour whatever `<StandardRateFormat>` says
(the format only names the unit Project shows it in), but the clone divided or multiplied it by the unit of the format; and a **material** assignment's
`<Units>` is its quantity (500 % is 5 units), which the clone wrote as a fraction per hour.

**Since when.** Commit `07c6485` (2026-10-16, "Microsoft Project formats: MSPDI XML and MPX import/export ..."): the same commit that first read and wrote the
assignment costs, the rate format switch and the material units. The custom Cost fields (commits `ae7f264`, `9a5bda5`) had their own private copy of the
currency rule and were right; that copy is gone.

**The method.** `core/msp/values.ts` is the one definition: a small codec per value type (read the text into the model value, the model value into text) and a
table that says which element of Project / Task / Resource / Assignment / PredecessorLink / Baseline / ExtendedAttribute is which type. The reader and writer
(`mspdi.ts`, `shared.ts`, `baselines.ts`, `custom-fields.ts`) take every conversion from it and do no unit arithmetic of their own; an element that is not in the
table is an error, not a text. Currency elements the clone neither reads nor writes (task and resource `Cost`, `FixedCost`, overtime and earned-value
elements, baseline `Cost`, timephased values) stay in a file as written; they are listed in `KEPT_AS_WRITTEN` there. The `.mpp` path (MPXJ to Project XML) and
`baselines.ts` go through the same module. MPX (the old text format) has plain amounts by its own definition and is unchanged.

**What changes for a caller.**
- Costs read from a Microsoft Project file are right (hundredths read as the currency); costs the clone writes open right in Microsoft Project.
- Rates of resources whose rate format is minute, day, week or month are read as the per-hour rate the file holds (before: converted again).
- A material's quantity is written as the assignment's `<Units>` (and its `<Work>` as before).
- A file the clone wrote before this release has its currency in plain units and no format stamp. The writer now stamps the revision in the alias of the
  "P6 Schedule Rules" custom field definition (`P6 Schedule Rules 25.0 legacy, format 2`). A file is read as plain units, with one info finding
  (`MSP_OLD_CLONE_FILE`), only when its bytes are the OLD CLONE WRITER's own (all of: `<Author>Primavera P6 Clone</Author>`; the project's own elements exactly the
  old writer's list in its order; the first Task, Resource and Assignment having only the elements the old writer wrote; the file's first six custom field
  definitions the clone's own, in its order; no stamp). Microsoft Project and MPXJ add elements to every project, task, resource and assignment on every save
  (`CurrencyDigits`, `CurrencySymbol`, `FYStartDate`, `CurrentDate`, `Active`, `Manual`, `PeakUnits`, `PercentWorkComplete` ...), so a re-saved file no longer matches;
  an `.mpp` (or any XML MPXJ made of one: the server passes `converted: true`) is never read as an old file. Saving a file read this way writes Microsoft Project's
  representation and the stamp. A file not written by the clone is read by the format's rule. (Not detectable, by nature: a file Microsoft Project saved from a
  clone file that the old writer had edited in place holds the old writer's plain costs for the assignments it edited next to Project's own hundredths.)
- The stamp does not depend on a free Text field: it stays on the clone's own slot (Task Text6) when the file has it; otherwise it goes into the first custom field
  of any kind the file does not use (Text, Number, Cost, Start, Finish, Date, Flag, Duration of a task; FieldIDs as MPXJ numbers them) and is read by its alias
  wherever it is. When none of the 120 task fields is free the save of a file of the old writer is refused (`msp_no_free_custom_field`: not saved; no free custom
  field left to mark it as written in the current format; free one custom field of the tasks, or save as XER or P6 XML); any other file is saved and the save's
  notes say the stamp was not written.
- Money is written as MPXJ writes it: an assignment's costs with at most 4 decimals of the hundredths and a custom Cost field's value with at most 2 (12.345 is
  `1234.5`, 0.004 is `0.4`, 1e9 is `100000000000`, -5.5 is `-550`; half-even rounding), a custom Number field as stored (no rounding).
- A P6 custom field whose data type the clone does not know is no longer written from its text column alone: it is written as the Microsoft Project kind of the
  one value column its rows hold (text, number, date, code); with values in more than one column it is not carried and the save's notes name it, its data type
  and the reason.

**The reference check.** `tests/msp-reference.test.ts` asks MPXJ itself (the pinned jars of `scripts/mpxj-files.mjs`, the same Java process as `core/msp/mpp.ts`,
writing its JSON) for every task, resource and assignment of a file and compares each quantity with the clone's: costs (budget, actual, remaining), work and
units, rates, durations and remaining durations, lag, total and free slack, percent complete, start / finish / actual dates. READ: six sample `.mpp` files (with
money, progress, slack, lags, work and material resources), the hand-made XML fixture (percentage and elapsed lags) and a project with every rate format and a
non-default day, week and month. WRITE: a P6 project (`130 TRIAL.xer`: costs, material, progress, lags), a hand-computed assignment, and an old-format file saved
again. Compared exactly except where the converted file carries less (whole minutes for durations, tenths of a minute for slack, four decimals for units), stated
in the test. It skips, saying why, where Java or the jars are missing, unless `P6CLONE_REQUIRE_REFERENCE=1`, which turns every skip into a failure with the same message; the release workflow (`whiq-release.yml`) sets it for its test step and installs Temurin 21 (`actions/setup-java@v4`) after fetching the jars. Also compared: custom Number and Cost fields of tasks and each saved baseline's start, finish and duration (read), and the text of every written amount against MPXJ's own re-save (write). Calibration on Microsoft Project's own XML (the MPXJ project's generated test data, run locally, not committed): the hundredths rule, the per-hour rate rule and the lag rule held on every file; see the report of that change. Before this change it failed on costs (READ and WRITE), on rates and on material units;
everything else it compares (durations, slack, lags, percent, dates, work, units) already agreed.
