# Microsoft Project XML carries P6 custom fields (next release)

**What changed for the platform.** A Microsoft Project XML the clone writes now carries the P6 custom fields (UDFs) of activities and resources, and opening a Microsoft Project XML (or an .mpp, which is read through MPXJ as Microsoft Project XML) turns its aliased custom fields into P6 custom fields. XER to Microsoft Project XML to open again gives the same fields (names, values) back. Code: `core/msp/custom-fields.ts` (slot table, allocation, notes), `core/msp/mspdi.ts`, `core/msp/shared.ts`, `core/msp/keep.ts`; tests: `tests/msp-custom-fields.test.ts`.

**Slots.** Activities go to the Task's Text1-30 / Number1-20 / Cost1-10 / Start1-10 / Finish1-10 / Date1-10, resources to the Resource's, by the P6 data type (text: Text; number, integer: Number; cost: Cost; start date: Start; finish date: Finish; date: Date; indicator, code: Text). The clone's own fields keep Task Text1-6 and Resource Text1. A customer's file's own slots are never taken. A field keeps its slot through save, open, save.

**Notes a caller now sees in `save` (format mspdi), under `notes`:**
- `Custom fields NOT carried to the Microsoft Project XML: activity <Kind> fields "A", "B" (Microsoft Project has N <Kind> custom fields on a task: ... none was free).` Every field that did not fit, by name.
- `Custom fields NOT carried ...: project / WBS / resource assignment / activity expense / role custom fields "..." (<why>).` Those subjects have no Microsoft Project custom fields the clone can use.
- `Custom fields written as Microsoft Project Number fields: activity "..." (integer ...)` and `... Text fields: ... (indicator / code fields ...)`: the type has no Microsoft Project kind of its own, so it opens again as number / text.
- On open, an info finding `MSP_CUSTOM_FIELD_KIND` names the aliased flag, duration and outline-code fields, which stay in the file untouched.

**The platform's own note must be updated when this release is pinned:** the note that "a Microsoft Project XML file written by the P6 clone does not carry ... custom fields ..." is no longer true. It carries them, except what the notes above name (more fields of a kind than the format has slots; project, WBS, assignment, expense and role fields; integer, indicator and code fields come back as number / text).

**Cost fields** are written in hundredths of the currency unit (1234.50 as 123450), the scale Microsoft Project and MPXJ use for a custom Cost field. The clone's other Microsoft Project cost elements (Cost, ActualCost ...) are written and read in plain units; that was not changed here.
