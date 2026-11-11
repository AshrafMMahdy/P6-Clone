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
