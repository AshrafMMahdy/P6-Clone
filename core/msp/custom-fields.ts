// P6 custom fields (user-defined fields: UDFTYPE / UDFVALUE) in Microsoft Project XML. Real P6 carries them to Microsoft
// Project only when the user maps each one by hand in a template; the clone does it by itself: an activity's field goes
// into a free custom field of the same kind on the Task, a resource's into one on the Resource, each under its P6 name
// (<Alias>), and the same definitions read back make the same P6 fields. The slots are Microsoft Project's own: its
// FieldIDs (the values MPXJ, the library the clone reads .mpp files with, uses for them; Task Text1..5 and Number1 and
// Resource Text1 are also what real files and the clone's earlier files carry) and FieldNames. The format has a fixed
// number of slots of each kind; the fields that do not fit are named in the save's answer (planCustomFields' notes).
import { rows, type Db, type Row } from '../db.ts';
import { writeValue, type Ctx } from './values.ts';

export type CfSubject = 'Task' | 'Resource';
export type CfKind = 'Text' | 'Number' | 'Cost' | 'Start' | 'Finish' | 'Date';
export const CF_KINDS: CfKind[] = ['Text', 'Number', 'Cost', 'Start', 'Finish', 'Date'];
/** UDFTYPE.table_name of the subjects Microsoft Project has custom fields for. */
const TABLE: Record<CfSubject, string> = { Task: 'TASK', Resource: 'RSRC' };

/** The FieldID of each slot (Text1 is the first of the Text list...), by subject and kind. */
export const CF_SLOTS: Record<CfSubject, Record<CfKind, number[]>> = {
  Task: {
    Text: [188743731, 188743734, 188743737, 188743740, 188743743, 188743746, 188743747, 188743748, 188743749, 188743750, 188743997, 188743998, 188743999, 188744000, 188744001, 188744002, 188744003, 188744004, 188744005, 188744006, 188744007, 188744008, 188744009, 188744010, 188744011, 188744012, 188744013, 188744014, 188744015, 188744016],
    Number: [188743767, 188743768, 188743769, 188743770, 188743771, 188743982, 188743983, 188743984, 188743985, 188743986, 188743987, 188743988, 188743989, 188743990, 188743991, 188743992, 188743993, 188743994, 188743995, 188743996],
    Cost: [188743786, 188743787, 188743788, 188743938, 188743939, 188743940, 188743941, 188743942, 188743943, 188743944],
    Start: [188743732, 188743735, 188743738, 188743741, 188743744, 188743962, 188743964, 188743966, 188743968, 188743970],
    Finish: [188743733, 188743736, 188743739, 188743742, 188743745, 188743963, 188743965, 188743967, 188743969, 188743971],
    Date: [188743945, 188743946, 188743947, 188743948, 188743949, 188743950, 188743951, 188743952, 188743953, 188743954],
  },
  Resource: {
    Text: [205520904, 205520905, 205520926, 205520927, 205520928, 205520993, 205520994, 205520995, 205520996, 205520997, 205521121, 205521122, 205521123, 205521124, 205521125, 205521126, 205521127, 205521128, 205521129, 205521130, 205521131, 205521132, 205521133, 205521134, 205521135, 205521136, 205521137, 205521138, 205521139, 205521140],
    Number: [205521008, 205521009, 205521010, 205521011, 205521012, 205521101, 205521102, 205521103, 205521104, 205521105, 205521106, 205521107, 205521108, 205521109, 205521110, 205521111, 205521112, 205521113, 205521114, 205521115],
    Cost: [205521019, 205521020, 205521021, 205521062, 205521063, 205521064, 205521065, 205521066, 205521067, 205521068],
    Start: [205520998, 205520999, 205521000, 205521001, 205521002, 205521116, 205521117, 205521118, 205521119, 205521120],
    Finish: [205521003, 205521004, 205521005, 205521006, 205521007, 205521086, 205521087, 205521088, 205521089, 205521090],
    Date: [205521069, 205521070, 205521071, 205521072, 205521073, 205521074, 205521075, 205521076, 205521077, 205521078],
  },
};

/** The Flag and Duration custom fields of a task: slots the clone does not carry P6 custom fields in (P6 has no flag or duration custom field to put in them), listed so a file's
 *  format stamp (mspdi.ts) can take any custom field that is free, whatever its kind. FieldIDs as MPXJ numbers them: FieldTypeHelper.getFieldID(TaskField.FLAG1..FLAG20 /
 *  DURATION1..DURATION10) in the jar the clone reads .mpp files with (the Text, Number, Cost, Start, Finish and Date lists above are the same function's values). */
const STAMP_ONLY: { kind: string; ids: number[] }[] = [
  { kind: 'Flag', ids: [188743752, 188743753, 188743754, 188743755, 188743756, 188743757, 188743758, 188743759, 188743760, 188743761, 188743972, 188743973, 188743974, 188743975, 188743976, 188743977, 188743978, 188743979, 188743980, 188743981] },
  { kind: 'Duration', ids: [188743783, 188743784, 188743785, 188743955, 188743956, 188743957, 188743958, 188743959, 188743960, 188743961] },
];
/** Every custom field of a task, as [FieldID, FieldName], Text first, then Number, Cost, Start, Finish, Date, Flag, Duration: the places the format stamp can go. */
export const taskFieldSlots = (): { id: string; name: string }[] => [
  ...CF_KINDS.flatMap((k) => CF_SLOTS.Task[k].map((id, i) => ({ id: String(id), name: slotName(k, i + 1) }))),
  ...STAMP_ONLY.flatMap((g) => g.ids.map((id, i) => ({ id: String(id), name: `${g.kind}${i + 1}` }))),
];

const SLOT_OF = new Map<string, { subject: CfSubject; kind: CfKind; n: number }>();
for (const s of ['Task', 'Resource'] as const) for (const k of CF_KINDS) CF_SLOTS[s][k].forEach((id, i) => SLOT_OF.set(String(id), { subject: s, kind: k, n: i + 1 }));
/** The slot a FieldID names (undefined: not a custom field the clone carries: Flag, Duration, another entity's). */
export const slotOfField = (fieldId: string) => SLOT_OF.get(fieldId);
export const slotName = (kind: CfKind, n: number) => `${kind}${n}`;

/** The P6 data type a Microsoft Project kind reads as. */
export const TYPE_OF_KIND: Record<CfKind, string> = { Text: 'FT_TEXT', Number: 'FT_FLOAT_2_DECIMALS', Cost: 'FT_MONEY', Start: 'FT_START_DATE', Finish: 'FT_END_DATE', Date: 'FT_DATE' };
/** The Microsoft Project kind a P6 data type is written as, and (`as`) what the type loses when it has no kind of its own. */
function kindOfType(logical: string): { kind: CfKind; as?: 'integer' | 'indicator' | 'code' | 'other' } {
  // every number type with decimals (FT_FLOAT, FT_FLOAT_2_DECIMALS ...: P6 and the clone's XML reader/writer name them FT_FLOAT*) is a Number field
  if (/^FT_FLOAT/.test(logical)) return { kind: 'Number' };
  switch (logical) {
    case 'FT_TEXT': return { kind: 'Text' };
    case 'FT_INT': return { kind: 'Number', as: 'integer' };
    case 'FT_MONEY': return { kind: 'Cost' };
    case 'FT_START_DATE': return { kind: 'Start' };
    case 'FT_END_DATE': return { kind: 'Finish' };
    case 'FT_DATE': return { kind: 'Date' };
    case 'FT_STATICTYPE': return { kind: 'Text', as: 'indicator' };
    case 'FT_CODE': return { kind: 'Text', as: 'code' };
    default: return { kind: 'Text', as: 'other' };
  }
}

export interface CfField { type: Row; subject: CfSubject; kind: CfKind; fieldId: string; fieldName: string; alias: string; as?: 'integer' | 'indicator' | 'code' | 'other'; column?: ValueColumn }
/** The value columns of a UDFVALUE row, and the Microsoft Project kind each is carried as when the field's data type says nothing of its kind. */
type ValueColumn = 'udf_text' | 'udf_number' | 'udf_date' | 'udf_code_id';
const COLUMNS: Record<ValueColumn, CfKind> = { udf_text: 'Text', udf_number: 'Number', udf_date: 'Date', udf_code_id: 'Text' };
export interface CfPlan { fields: CfField[]; notes: string[] }

const byId = (a: Row, b: Row) => Number(a.udf_type_id) - Number(b.udf_type_id) || a.udf_type_id.localeCompare(b.udf_type_id);
/** Why each subject without custom fields in Microsoft Project is not carried. */
const NO_PLACE: Record<string, [word: string, why: string]> = {
  PROJECT: ['project', 'a Microsoft Project file has no place for custom values on the project itself'],
  PROJWBS: ['WBS', 'a WBS element is written as a summary task, and the clone carries no custom fields on summary tasks'],
  TASKRSRC: ['resource assignment', 'Microsoft Project\'s Custom Fields dialog defines fields for tasks, resources and the project only, not for assignments'],
  PROJCOST: ['activity expense', 'Microsoft Project has no activity expenses'],
  ROLES: ['role', 'Microsoft Project has no roles'],
};
const quoted = (l: string[]) => l.map((x) => `"${x}"`).join(', ');

/**
 * Which Microsoft Project custom field each P6 custom field of an activity or a resource is written into. Deterministic
 * (the fields in the order of their UDF type ID take the first free slot of their kind) and stable across a save, open,
 * save: a field read from a Microsoft Project file keeps the slot it had there (`_msp_field` on its UDFTYPE row).
 * The order of allocation: (a) the fields pinned to a slot by the file they were read from; (b) the fields that have a value in the project
 * being written (`valued`: their UDF type IDs), in UDF type ID order; (c) only for a NEW file (`newFile`), the declared fields with no value
 * in that project, in UDF type ID order, while slots remain. In a customer's own file saved in place, a field with no value in the project is
 * not added to the file (it was never that file's) and is not reported as not carried.
 * `reserved`: slots the clone uses for its own fields; `used`: every FieldID the file this project was read from already
 * has (a customer's own fields: never taken); `own`: whether a name is one the clone's own fields go by.
 */
export function planCustomFields(db: Db, o: { reserved: Record<CfSubject, Set<string>>; used: Set<string>; own: (name: string) => boolean; valued: Set<string>; newFile: boolean }): CfPlan {
  const fields: CfField[] = [], notes: string[] = [];
  const unfit: { subject: CfSubject; kind: CfKind; names: string[] }[] = [];
  const clash: string[] = [], unknownType: string[] = [];
  const all = rows(db, 'UDFTYPE');
  // the value columns each field's rows hold (text, number, date, code)
  const valueColumns = new Map<string, Set<ValueColumn>>();
  for (const v of rows(db, 'UDFVALUE')) for (const c of Object.keys(COLUMNS) as ValueColumn[]) if (v[c]) (valueColumns.get(v.udf_type_id) ?? valueColumns.set(v.udf_type_id, new Set()).get(v.udf_type_id)!).add(c);
  for (const subject of ['Task', 'Resource'] as const) {
    const types = all.filter((u) => u.table_name === TABLE[subject]).sort(byId);
    const held = new Set<string>(), placed = new Map<Row, CfField>();
    const make = (u: Row, kind: CfKind, id: number, as: CfField['as']): CfField => ({ type: u, subject, kind, fieldId: String(id), fieldName: slotName(kind, CF_SLOTS[subject][kind].indexOf(id) + 1), alias: u.udf_type_label, ...(as ? { as } : {}), ...(kinds.get(u)?.column ? { column: kinds.get(u)!.column } : {}) });
    const kinds = new Map<Row, { kind: CfKind; as?: CfField['as']; column?: ValueColumn }>();
    const todo = types.filter((u) => {
      if (o.own(u.udf_type_label)) { clash.push(`${subject === 'Task' ? 'activity' : 'resource'} "${u.udf_type_label}"`); return false; }
      const k: { kind: CfKind; as?: CfField['as']; column?: ValueColumn } = kindOfType(u.logical_data_type);
      if (k.as === 'other') {
        // a data type the clone does not know: nothing is dropped. The field is carried as the kind of the value column its values are held in
        // (the one column a value of any type lives in on the row: P6 XML and XER write the column the row holds); several columns, or no way to say: not carried
        const cols = (valueColumns.get(u.udf_type_id) ?? new Set<ValueColumn>());
        if (cols.size > 1) { unknownType.push(`${subject === 'Task' ? 'activity' : 'resource'} "${u.udf_type_label}" (data type ${u.logical_data_type || '(none)'}: its values are held in more than one value column (${[...cols].map((c) => c.replace('udf_', '')).join(', ')}), so which one is the field's cannot be established)`); return false; }
        if (cols.size === 1) { const [c] = cols; k.kind = COLUMNS[c]; k.column = c; }
      }
      kinds.set(u, k);
      return true;
    });
    // a field read from the file keeps its slot (when it is still the kind of that slot and nothing else holds it)
    for (const u of todo) {
      const { kind, as } = kinds.get(u)!, pin = u._msp_field;
      if (!pin || o.reserved[subject].has(pin) || held.has(pin) || !CF_SLOTS[subject][kind].includes(Number(pin))) continue;
      held.add(pin);
      placed.set(u, make(u, kind, Number(pin), as));
    }
    const taken = (id: number) => o.reserved[subject].has(String(id)) || o.used.has(String(id)) || held.has(String(id));
    const rest = todo.filter((u) => !placed.has(u));
    for (const u of [...rest.filter((u) => o.valued.has(u.udf_type_id)), ...(o.newFile ? rest.filter((u) => !o.valued.has(u.udf_type_id)) : [])]) {
      const { kind, as } = kinds.get(u)!, id = CF_SLOTS[subject][kind].find((x) => !taken(x));
      if (id == null) {
        let g = unfit.find((x) => x.subject === subject && x.kind === kind);
        if (!g) unfit.push(g = { subject, kind, names: [] });
        g.names.push(u.udf_type_label);
        continue;
      }
      held.add(String(id));
      placed.set(u, make(u, kind, id, as));
    }
    fields.push(...todo.filter((u) => placed.has(u)).map((u) => placed.get(u)!));
  }
  // what the answer says: every field not carried, and every field carried as another kind, by name
  const word = (s: CfSubject) => (s === 'Task' ? 'activity' : 'resource');
  const as = (a: CfField['as']) => fields.filter((f) => f.as === a).map((f) => `${word(f.subject)} "${f.alias}"`);
  const [ints, inds, codes, others] = [as('integer'), as('indicator'), as('code'), as('other')];
  if (ints.length) notes.push(`Custom fields written as Microsoft Project Number fields: ${ints.join(', ')} (integer fields; Microsoft Project has no integer-only custom field, so they open again as number fields with the same values).`);
  if (inds.length) notes.push(`Custom fields written as Microsoft Project Text fields: ${inds.join(', ')} (indicator fields; Microsoft Project has no indicator custom field, so the text holds P6's icon code, UDF_G0 to UDF_G4, and they open again as text fields).`);
  if (codes.length) notes.push(`Custom fields written as Microsoft Project Text fields: ${codes.join(', ')} (code fields; Microsoft Project has no code-list custom field here, so the text holds the code value and they open again as text fields).`);
  if (others.length) {
    const label = (f: CfField) => `${word(f.subject)} "${f.alias}" (${f.type.logical_data_type || 'no data type'}, written as a ${f.kind} field)`;
    notes.push(`Custom fields written as Microsoft Project fields of the kind of the value column their values are held in, because their data type has no Microsoft Project kind: ${fields.filter((f) => f.as === 'other').map(label).join(', ')}.`);
  }
  if (unknownType.length) notes.push(`Custom fields NOT carried to the Microsoft Project XML: ${unknownType.join(', ')}.`);
  for (const g of unfit) {
    const total = CF_SLOTS[g.subject][g.kind].length, carried = fields.filter((f) => f.subject === g.subject && f.kind === g.kind).length;
    notes.push(`Custom fields NOT carried to the Microsoft Project XML: ${word(g.subject)} ${g.kind} fields ${quoted(g.names)} (Microsoft Project has ${total} ${g.kind} custom fields on a ${g.subject.toLowerCase()}: ${carried} carry P6 custom fields here and ${total - carried} are in use by the clone's own fields or by fields already in the file, so none was free).`);
  }
  if (clash.length) notes.push(`Custom fields NOT carried to the Microsoft Project XML: ${clash.join(', ')} (the name is one the clone uses for its own custom field in a Microsoft Project file; rename the field to carry it).`);
  for (const [table, [w, why]] of Object.entries(NO_PLACE)) {
    const names = all.filter((u) => u.table_name === table).sort(byId).map((u) => u.udf_type_label);
    if (names.length) notes.push(`Custom fields NOT carried to the Microsoft Project XML: ${w} custom fields ${quoted(names)} (${why}).`);
  }
  const other = all.filter((u) => u.table_name !== 'TASK' && u.table_name !== 'RSRC' && !(u.table_name in NO_PLACE)).sort(byId);
  if (other.length) notes.push(`Custom fields NOT carried to the Microsoft Project XML: ${other.map((u) => `${u.table_name} "${u.udf_type_label}"`).join(', ')} (Microsoft Project has no place for custom fields of those subjects).`);
  return { fields, notes };
}

/** The size of a Microsoft Project Text custom field: 255 characters. It is Microsoft Project's field size, not a limit of ours: a longer
 *  value is written whole, the file holds all of it, and the save's notes say Microsoft Project shows only the first 255. */
export const MSP_TEXT_FIELD_SIZE = 255;

/** The value a P6 custom field holds on a row, as the text of the Microsoft Project element (undefined: none). `date` formats a P6 date.
 *  The reader's `long` counts, by field, the text values it gave out that are longer than MSP_TEXT_FIELD_SIZE. */
export function valueReader(db: Db, fields: CfField[], ctx: Ctx): ((f: CfField, fk: string) => string | undefined) & { long: Map<CfField, number> } {
  const long = new Map<CfField, number>();
  const byType = new Map<string, Map<string, Row>>(fields.map((f) => [f.type.udf_type_id, new Map<string, Row>()]));
  for (const v of rows(db, 'UDFVALUE')) byType.get(v.udf_type_id)?.set(v.fk_id, v);
  const codes = new Map(rows(db, 'UDFCODE').map((c) => [c.udf_code_id, c.short_name || c.udf_code_name]));
  const read = (f: CfField, fk: string) => {
    const v = byType.get(f.type.udf_type_id)?.get(fk);
    if (!v) return undefined;
    const t = f.type.logical_data_type;
    const n = v.udf_number !== '' && Number.isFinite(Number(v.udf_number)) ? v.udf_number : null; // (as stored: a Number field is written unchanged, a Cost field by the currency codec)
    const w = (kind: CfKind, value: string | number | null) => writeValue('ExtendedAttribute', `Value:${kind}`, value, ctx);
    const x = f.kind === 'Number' ? w('Number', n) : f.kind === 'Cost' ? w('Cost', n == null ? null : Number(n))
      : f.kind === 'Text' ? (t === 'FT_CODE' || f.column === 'udf_code_id' ? (v.udf_code_id ? codes.get(v.udf_code_id) ?? '' : '') : w('Text', v.udf_text ?? ''))
      : w(f.kind, v.udf_date ?? '');
    if (f.kind === 'Text' && typeof x === 'string' && x.length > MSP_TEXT_FIELD_SIZE && [...x].length > MSP_TEXT_FIELD_SIZE) long.set(f, (long.get(f) ?? 0) + 1);
    return x === '' || x == null ? undefined : x;
  };
  return Object.assign(read, { long });
}

/** The save's note for the text values longer than a Microsoft Project Text field holds (none: undefined). */
export function longTextNote(long: Map<CfField, number>): string | undefined {
  if (!long.size) return undefined;
  const list = [...long].map(([f, n]) => `${f.subject === 'Task' ? 'activity' : 'resource'} "${f.alias}" (${n} value${n === 1 ? '' : 's'})`).join(', ');
  return `Custom field text longer than ${MSP_TEXT_FIELD_SIZE} characters: ${list}. Microsoft Project's Text custom fields hold ${MSP_TEXT_FIELD_SIZE} characters, so it shows the first ${MSP_TEXT_FIELD_SIZE} of each of these values; the file holds the whole value and nothing was cut.`;
}
