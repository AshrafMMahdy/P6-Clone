// Ported from the White Hat IQ platform's @whiq/ifc (shared/ifc, branch 33-chat-only).
/**
 * Streaming STEP (ISO 10303-21) index of an IFC — no web-ifc, no geometry.
 *
 * Why: the index (identity, storey, class, material, type, system, property sets, authored quantities,
 * owner) comes from a few relationship entity types. web-ifc loads the WHOLE file into WASM and our old
 * pass called GetLine millions of times; a 350 MB model aborted at ~4 GB (pilot, 2026-09-17). This reads
 * the file once as a stream, fully parses only the entity types the index needs, and keeps a 40-byte
 * record per product. Memory follows the element count, not the file size.
 *
 * Geometry (fingerprint + viewer GLB) is a separate concern — see geomWorker.mjs / parse.ts.
 */
import { createReadStream } from 'node:fs';
import type { IfcElement, IfcIndex, IfcOwner, QuantityKind } from './parse.ts';
import { compactHeap, Element, ExtrasTable, Interner, newGeomStore, ownString } from './element.ts';
import { IFC_CLASS_NAMES } from './ifcClasses.ts';

// ── STEP attribute parser ──────────────────────────────────────────────────────────────────────────
export type StepValue = string | number | boolean | null | undefined | { ref: number } | { enum: string } | StepValue[];

const CONVERSION: Record<string, number> = { INCH: 0.0254, FOOT: 0.3048, YARD: 0.9144, MILE: 1609.344 };
const QTY_KIND: Record<string, QuantityKind> = { IFCQUANTITYLENGTH: 'length', IFCQUANTITYAREA: 'area', IFCQUANTITYVOLUME: 'volume', IFCQUANTITYCOUNT: 'count', IFCQUANTITYWEIGHT: 'weight', IFCQUANTITYTIME: 'time' };
const UNIT_KIND: Record<string, QuantityKind> = { LENGTHUNIT: 'length', AREAUNIT: 'area', VOLUMEUNIT: 'volume', MASSUNIT: 'weight', TIMEUNIT: 'time' };
const MEASURE_KIND: Record<string, QuantityKind> = { LENGTH: 'length', POSITIVELENGTH: 'length', NONNEGATIVELENGTH: 'length', AREA: 'area', VOLUME: 'volume', MASS: 'weight', COUNT: 'count', TIME: 'time' };
const SI_PREFIX: Record<string, string> = { MILLI: 'm', CENTI: 'c', DECI: 'd', KILO: 'k' };
const SI_NAME: Record<string, string> = { METRE: 'm', SQUARE_METRE: 'm²', CUBIC_METRE: 'm³', GRAM: 'g', SECOND: 's' };
/** The SI unit IFC assumes when the project assigns none. */
const DEFAULT_UNITS: Record<QuantityKind, string> = { length: 'm', area: 'm²', volume: 'm³', count: 'no.', weight: 'kg', time: 's' };

/** A statement without its comments; a comment marker inside a string is text, not a comment. */
function stripComments(s: string): string {
  if (!s.includes('/*')) return s;
  let out = '', str = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) { out += c; if (c === "'") str = false; continue; }
    if (c === "'") { str = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; continue; }
    out += c;
  }
  return out;
}

/** Parse the argument list text of one entity ("'a',#12,$,(1.,2.),IFCLABEL('x'),.T."). Typed values unwrap to their inner value. */
export function parseArgs(text: string): StepValue[] {
  let i = 0;
  const n = text.length;
  const skipWs = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) i++; };
  const readString = (): string => {
    // text[i] === "'"
    i++;
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === "'") { if (text[i + 1] === "'") { out += "'"; i += 2; continue; } i++; break; }
      out += c; i++;
    }
    return decodeStepString(out);
  };
  const readValue = (): StepValue => {
    skipWs();
    const c = text[i];
    if (c === "'") return readString();
    if (c === '#') { i++; let s = i; while (i < n && text[i] >= '0' && text[i] <= '9') i++; return { ref: Number(text.slice(s, i)) }; }
    if (c === '$') { i++; return null; }
    if (c === '*') { i++; return undefined; }
    if (c === '.') { i++; const s = i; while (i < n && text[i] !== '.') i++; const e = text.slice(s, i); i++; return e === 'T' ? true : e === 'F' ? false : { enum: e }; }
    if (c === '(') {
      i++; const list: StepValue[] = [];
      for (;;) { skipWs(); if (text[i] === ')') { i++; break; } list.push(readValue()); skipWs(); if (text[i] === ',') i++; else if (text[i] === ')') { i++; break; } else break; }
      return list;
    }
    if ((c >= '0' && c <= '9') || c === '-' || c === '+') {
      const s = i; i++;
      while (i < n && /[0-9.eE+-]/.test(text[i])) i++;
      return Number(text.slice(s, i));
    }
    // typed value: IFCLABEL('x') / IFCBOOLEAN(.T.) / IFCREAL(1.) → inner
    if ((c >= 'A' && c <= 'Z') || c === '_') {
      while (i < n && text[i] !== '(' && text[i] !== ',' && text[i] !== ')') i++;
      if (text[i] === '(') { i++; const inner = readValue(); skipWs(); if (text[i] === ')') i++; return inner; }
      return null;
    }
    i++; return null;
  };
  const out: StepValue[] = [];
  for (;;) { skipWs(); if (i >= n) break; out.push(readValue()); skipWs(); if (text[i] === ',') i++; else if (i >= n) break; else i++; }
  return out;
}

/** STEP string escapes: \X2\....\X0\ (UTF-16BE hex), \X\hh (ISO 8859-1 byte), \S\c (shifted). */
export function decodeStepString(s: string): string {
  if (!s.includes('\\')) return s;
  return s
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex: string) => { let o = ''; for (let k = 0; k + 4 <= hex.length; k += 4) o += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16)); return o; })
    .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex: string) => { let o = ''; for (let k = 0; k + 8 <= hex.length; k += 8) o += String.fromCodePoint(parseInt(hex.slice(k, k + 8), 16)); return o; })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hh: string) => String.fromCharCode(parseInt(hh, 16)))
    .replace(/\\S\\(.)/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

const ref = (v: StepValue): number | undefined => (v && typeof v === 'object' && !Array.isArray(v) && 'ref' in v) ? v.ref : undefined;
const refs = (v: StepValue): number[] => Array.isArray(v) ? v.map(ref).filter((x): x is number => x !== undefined) : [];
const strOf = (v: StepValue): string => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : (v && typeof v === 'object' && !Array.isArray(v) && 'enum' in v) ? v.enum : '';
const scalar = (v: StepValue): string | number | boolean | undefined => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? v : (v && typeof v === 'object' && !Array.isArray(v) && 'enum' in v) ? v.enum : undefined;

// ── entity selection ───────────────────────────────────────────────────────────────────────────────
/** Rooted entities that are NOT elements of the built asset (spatial containers, relationships, definitions). */
const NOT_ELEMENT = /^IFC(PROJECT|SITE|BUILDING|BUILDINGSTOREY|GRID|GRIDAXIS|ANNOTATION|VIRTUALELEMENT|OPENINGELEMENT|OPENINGSTANDARDCASE|VOIDINGFEATURE|FEATUREELEMENTSUBTRACTION|PROJECTIONELEMENT|SURFACEFEATURE|REL[A-Z]*|PROPERTYSET[A-Z]*|[A-Z]*PROPERTIES|ELEMENTQUANTITY|PROPERTYTEMPLATE|PROPERTYSETTEMPLATE|GROUP|SYSTEM|ZONE|DISTRIBUTIONSYSTEM|BUILDINGSYSTEM|STRUCTURALANALYSISMODEL|STRUCTURAL[A-Z]*ACTION|STRUCTURAL[A-Z]*REACTION|STRUCTURALLOAD[A-Z]*|STRUCTURALRESULTGROUP|STRUCTURALCURVEACTIVITY|STRUCTURALSURFACEACTIVITY|PERFORMANCEHISTORY|CONTEXT|LIBRARYINFORMATION|PROJECTLIBRARY|TASK|PROCEDURE|EVENT|WORKPLAN|WORKSCHEDULE|WORKCALENDAR|ACTOR|OCCUPANT|CONTROL|ACTIONREQUEST|COSTITEM|COSTSCHEDULE|PERMIT|PROJECTORDER|WORKCONTROL|RESOURCE[A-Z]*|[A-Z]*RESOURCE|[A-Z]*TYPE|[A-Z]*STYLE|SPATIALZONE|EXTERNALSPATIALELEMENT|EXTERNALSPATIALSTRUCTUREELEMENT|ALIGNMENT[A-Z]*|POSITIONINGELEMENT|REFERENT|LINEARPOSITIONINGELEMENT)$/;
const GUID_RE = /^[0-9A-Za-z_$]{22}$/;
const MEP_RE = /^IFC(PIPE|DUCT|FLOW|CABLE|DISTRIBUTION|AIRTERMINAL|VALVE|PUMP|FAN|BOILER|CHILLER|COIL|COMPRESSOR|CONDENSER|COOLING|DAMPER|ELECTRIC|ENERGYCONVERSION|EVAPORAT|FILTER|FIRESUPPRESSION|HEAT|HUMIDIFIER|INTERCEPTOR|JUNCTION|LAMP|LIGHT|MOTOR|OUTLET|PROTECTIVE|SANITARY|SENSOR|SOLAR|SPACEHEATER|STACK|SWITCHING|TANK|TRANSFORMER|TUBE|UNITARY|VIBRATION|WASTE|ALARM|ACTUATOR|CONTROLLER|MEDICAL|AUDIOVISUAL|COMMUNICATIONS|BURNER)/;
const STRUCT_RE = /^IFC(BEAM|COLUMN|FOOTING|PILE|MEMBER|PLATE|REINFORC|TENDON|STRUCTURAL)/;
const ARCH_RE = /^IFC(WALL|DOOR|WINDOW|ROOF|STAIR|RAMP|COVERING|RAILING|CURTAINWALL|FURNI|SHADING|CHIMNEY|OPENING|SPACE)/;
const SITE_RE = /^IFC(SITE|GEOGRAPHIC|EARTHWORKS|PAVEMENT|ROAD|KERB|COURSE)/;
export function disciplineOf(ifcClass: string, props: Record<string, unknown>, system?: string): IfcElement['discipline'] {
  const c = ifcClass.toUpperCase();
  if (MEP_RE.test(c) || (system && /(hvac|plumb|electric|drain|water|vent|fire)/i.test(system))) return 'mep';
  if (STRUCT_RE.test(c)) return 'structure';
  if (c === 'IFCSLAB' || c === 'IFCWALL' || c === 'IFCWALLSTANDARDCASE') {
    const lb = props['Pset_SlabCommon.LoadBearing'] ?? props['Pset_WallCommon.LoadBearing'];
    if (lb === true || String(lb).toLowerCase() === 'true') return 'structure';
  }
  if (ARCH_RE.test(c) || c === 'IFCSLAB') return 'architecture';
  if (SITE_RE.test(c)) return 'site';
  return 'other';
}

// ── the streaming pass ─────────────────────────────────────────────────────────────────────────────
interface Rel { targets: number[]; relating: number }

export interface StepIndexResult { index: IfcIndex; /** the products' express ids in index order (sorted): what the geometry worker meshes */ productIds: Uint32Array }

/** STEP upper case to IFC's own spelling (IFCWALLSTANDARDCASE → IfcWallStandardCase); unknown classes keep the STEP text. */
const CLASS_NAME = new Map(IFC_CLASS_NAMES.map((n) => [n.toUpperCase(), n]));
export const canonicalClass = (stepType: string): string => CLASS_NAME.get(stepType) ?? stepType;

export async function stepIndex(absIfcPath: string): Promise<StepIndexResult> {
  // the products, column by column (millions of them: an object each cost more than the element itself)
  const pId: number[] = [], pCls: string[] = [], pGuid: string[] = [], pName: string[] = [], pOh: number[] = [];
  const clsOf = new Map<string, string>();
  const storeyName = new Map<number, string>();                 // IfcBuildingStorey / other spatial containers
  const spatialName = new Map<number, string>();
  const aggregates: Array<{ parent: number; children: number[] }> = [];
  const contained: Rel[] = [];
  const relMaterial: Rel[] = [];
  const relType: Rel[] = [];
  const relGroup: Rel[] = [];
  // IfcRelDefinesByProperties, flat (an exporter writes one per element: millions): relating set, its targets
  const relProps = { relating: [] as number[], start: [] as number[], targets: [] as number[] };
  const materialName = new Map<number, string>();
  const layerSet = new Map<number, { name: string; layers: number[] }>();
  const layerMaterial = new Map<number, number>();
  const layerSetUsage = new Map<number, number>();
  const materialList = new Map<number, number[]>();
  const profileSet = new Map<number, { name: string; profiles: number[] }>();
  const profileMaterial = new Map<number, number>();
  const profileSetUsage = new Map<number, number>();
  const typeName = new Map<number, string>();
  const groupName = new Map<number, string>();
  const psets = new Map<number, { name: string; props: number[] }>();
  const propValue = new Map<number, [string, string | number | boolean]>();
  // element quantity sets and their quantities, flat (one set per element in most exports): id -> slot in the columns
  const quantSets = new Map<number, number>(), qsStart: number[] = [], qsIds: number[] = [], qsName: string[] = [];
  const quantValue = new Map<number, number>(), qName: string[] = [], qVal: number[] = [], qKind: QuantityKind[] = [], qUnit: number[] = [];
  const qNames = new Map<string, string>(); const qn = (x: string) => { let v = qNames.get(x); if (v == null) { v = ownString(x); qNames.set(x, v); } return v; };
  const propMeasure = new Map<number, { kind: QuantityKind; unit?: number }>();
  const unitLabel = new Map<number, { kind?: QuantityKind; label: string }>();
  const ownerHist = new Map<number, { user?: number; app?: number; action?: string; when?: number }>();
  const personOrg = new Map<number, { person?: number; org?: number }>();
  const person = new Map<number, string>();
  const org = new Map<number, string>();
  const application = new Map<number, string>();
  const header: IfcIndex['header'] = {};
  let schema = 'IFC?';
  let projectName = '';
  let lengthScale = 1;
  let lengthScaleSource: IfcIndex['lengthScaleSource'] = 'assumed-m';
  // length units by id; the one the project's IfcUnitAssignment names is the model's (files define others too)
  const lengthUnits = new Map<number, number>();
  const unitAssignments = new Map<number, number[]>();
  let projectUnits: number | undefined;

  const onEntity = (id: number, type: string, argText: string): void => {
    switch (type) {
      case 'IFCPROJECT': { const a = parseArgs(argText); projectName = strOf(a[2]); projectUnits = ref(a[8]); return; }
      case 'IFCUNITASSIGNMENT': { const a = parseArgs(argText); unitAssignments.set(id, refs(a[0])); return; }
      case 'IFCSIUNIT': { const a = parseArgs(argText); if (strOf(a[1]) === 'LENGTHUNIT') { const p = strOf(a[2]); lengthUnits.set(id, p === 'MILLI' ? 0.001 : p === 'CENTI' ? 0.01 : p === 'DECI' ? 0.1 : p === 'KILO' ? 1000 : 1); }
        const nm = SI_NAME[strOf(a[3])]; if (nm) unitLabel.set(id, { kind: UNIT_KIND[strOf(a[1])], label: (SI_PREFIX[strOf(a[2])] ?? '') + nm }); return; }
      case 'IFCCONVERSIONBASEDUNIT': { const a = parseArgs(argText); if (strOf(a[1]) === 'LENGTHUNIT') { const f = CONVERSION[strOf(a[2]).toUpperCase()]; if (f) lengthUnits.set(id, f); }
        if (strOf(a[2])) unitLabel.set(id, { kind: UNIT_KIND[strOf(a[1])], label: strOf(a[2]).toLowerCase() }); return; }
      case 'IFCBUILDINGSTOREY': { const a = parseArgs(argText); storeyName.set(id, strOf(a[2]) || strOf(a[7]) || `#${id}`); return; }
      case 'IFCSITE': case 'IFCBUILDING': case 'IFCSPACE': case 'IFCSPATIALZONE': { const a = parseArgs(argText); spatialName.set(id, strOf(a[2]) || strOf(a[7]) || `#${id}`); break; }
      case 'IFCRELAGGREGATES': { const a = parseArgs(argText); const p = ref(a[4]); if (p !== undefined) aggregates.push({ parent: p, children: refs(a[5]) }); return; }
      case 'IFCRELCONTAINEDINSPATIALSTRUCTURE': { const a = parseArgs(argText); const s = ref(a[5]); if (s !== undefined) contained.push({ targets: refs(a[4]), relating: s }); return; }
      case 'IFCRELASSOCIATESMATERIAL': { const a = parseArgs(argText); const m = ref(a[5]); if (m !== undefined) relMaterial.push({ targets: refs(a[4]), relating: m }); return; }
      case 'IFCMATERIAL': { const a = parseArgs(argText); materialName.set(id, strOf(a[0])); return; }
      case 'IFCMATERIALLAYERSET': { const a = parseArgs(argText); layerSet.set(id, { name: strOf(a[1]), layers: refs(a[0]) }); return; }
      case 'IFCMATERIALLAYER': { const a = parseArgs(argText); const m = ref(a[0]); if (m !== undefined) layerMaterial.set(id, m); return; }
      case 'IFCMATERIALLAYERSETUSAGE': { const a = parseArgs(argText); const s = ref(a[0]); if (s !== undefined) layerSetUsage.set(id, s); return; }
      case 'IFCMATERIALLIST': { const a = parseArgs(argText); materialList.set(id, refs(a[0])); return; }
      case 'IFCMATERIALPROFILESET': { const a = parseArgs(argText); profileSet.set(id, { name: strOf(a[0]), profiles: refs(a[2]) }); return; }
      case 'IFCMATERIALPROFILE': { const a = parseArgs(argText); const m = ref(a[2]); if (m !== undefined) profileMaterial.set(id, m); return; }
      case 'IFCMATERIALPROFILESETUSAGE': { const a = parseArgs(argText); const s = ref(a[0]); if (s !== undefined) profileSetUsage.set(id, s); return; }
      case 'IFCMATERIALCONSTITUENTSET': { const a = parseArgs(argText); materialName.set(id, strOf(a[0])); return; }
      case 'IFCRELDEFINESBYTYPE': { const a = parseArgs(argText); const t = ref(a[5]); if (t !== undefined) relType.push({ targets: refs(a[4]), relating: t }); return; }
      case 'IFCRELASSIGNSTOGROUP': { const a = parseArgs(argText); const g = ref(a[6]); if (g !== undefined) relGroup.push({ targets: refs(a[4]), relating: g }); return; }
      case 'IFCGROUP': case 'IFCSYSTEM': case 'IFCZONE': case 'IFCDISTRIBUTIONSYSTEM': case 'IFCBUILDINGSYSTEM': { const a = parseArgs(argText); groupName.set(id, strOf(a[2])); return; }
      case 'IFCRELDEFINESBYPROPERTIES': { const a = parseArgs(argText); const d = ref(a[5]); if (d !== undefined) { relProps.relating.push(d); relProps.start.push(relProps.targets.length); for (const t of refs(a[4])) relProps.targets.push(t); } return; }
      case 'IFCPROPERTYSET': { const a = parseArgs(argText); psets.set(id, { name: strOf(a[2]) || 'Pset', props: refs(a[4]) }); return; }
      case 'IFCPROPERTYSINGLEVALUE': { const a = parseArgs(argText); const v = scalar(a[2]); if (v !== undefined) propValue.set(id, [strOf(a[0]), v]);
        // a value typed as a measure (IFCVOLUMEMEASURE(1.2)) is a figure of that kind
        const mk = typeof v === 'number' ? /\bIFC([A-Z]+)MEASURE\(/.exec(argText)?.[1] : undefined; if (mk && MEASURE_KIND[mk]) propMeasure.set(id, { kind: MEASURE_KIND[mk], unit: ref(a[3]) }); return; }
      case 'IFCELEMENTQUANTITY': { const a = parseArgs(argText); quantSets.set(id, qsName.length); qsName.push(qn(strOf(a[2]) || 'Quantities')); qsStart.push(qsIds.length); for (const q of refs(a[5])) qsIds.push(q); return; }
      case 'IFCQUANTITYLENGTH': case 'IFCQUANTITYAREA': case 'IFCQUANTITYVOLUME': case 'IFCQUANTITYCOUNT': case 'IFCQUANTITYWEIGHT': case 'IFCQUANTITYTIME': { const a = parseArgs(argText); const v = a[3]; if (typeof v === 'number' && Number.isFinite(v)) { quantValue.set(id, qVal.length); qName.push(qn(strOf(a[0]))); qVal.push(v); qKind.push(QTY_KIND[type]); qUnit.push(ref(a[2]) ?? -1); } return; }
      case 'IFCOWNERHISTORY': { const a = parseArgs(argText); const when = typeof a[4] === 'number' && a[4] > 0 ? a[4] : typeof a[7] === 'number' && a[7] > 0 ? a[7] : undefined; ownerHist.set(id, { user: ref(a[0]), app: ref(a[1]), action: strOf(a[3]) || undefined, when }); return; }
      case 'IFCPERSONANDORGANIZATION': { const a = parseArgs(argText); personOrg.set(id, { person: ref(a[0]), org: ref(a[1]) }); return; }
      case 'IFCPERSON': { const a = parseArgs(argText); person.set(id, [strOf(a[2]), strOf(a[1])].filter(Boolean).join(' ') || strOf(a[0])); return; }
      case 'IFCORGANIZATION': { const a = parseArgs(argText); org.set(id, strOf(a[1])); return; }
      case 'IFCAPPLICATION': { const a = parseArgs(argText); application.set(id, [strOf(a[2]), strOf(a[1])].filter(Boolean).join(' ')); return; }
      default: break;
    }
    // Type definitions carry the type name (IfcWallType etc.) — one string each.
    if (type.endsWith('TYPE') && argText.startsWith("'")) { const a = parseArgs(argText); typeName.set(id, strOf(a[2])); return; }
    // Products: rooted (GlobalId first), not a container / relationship / definition. Cheap regex, no full parse.
    const at = argText.trimStart();
    if (at.charCodeAt(0) === 39 /* ' */ && !NOT_ELEMENT.test(type)) {
      // exporters may break the line or put spaces between the arguments
      const m = /^'([^']{22})'\s*,\s*(#\d+|\$)\s*,\s*('(?:[^']|'')*'|\$)/.exec(at);
      if (m && GUID_RE.test(m[1])) {
        const name = m[3] === '$' ? '' : decodeStepString(m[3].slice(1, -1).replace(/''/g, "'"));
        const oh = m[2] === '$' ? undefined : Number(m[2].slice(1));
        let cls = clsOf.get(type); if (!cls) { cls = ownString(canonicalClass(type)); clsOf.set(cls.toUpperCase(), cls); clsOf.set(type, cls); }
        pId.push(id); pCls.push(cls); pGuid.push(ownString(m[1])); pName.push(ownString(name)); pOh.push(oh ?? -1);
      }
    }
  };

  await scanEntities(absIfcPath, onEntity, (headerLine) => {
    const m = /^(FILE_NAME|FILE_SCHEMA)\s*\((.*)\)\s*;?\s*$/s.exec(headerLine);
    if (!m) return;
    const a = parseArgs(m[2]);
    if (m[1] === 'FILE_SCHEMA') { const s = Array.isArray(a[0]) ? strOf(a[0][0]) : strOf(a[0]); if (s) schema = s; return; }
    header.timestamp = strOf(a[1]) || undefined;
    const authors = Array.isArray(a[2]) ? a[2].map(strOf).filter(Boolean) : [];
    const orgs = Array.isArray(a[3]) ? a[3].map(strOf).filter(Boolean) : [];
    header.author = authors.join(', ') || undefined;
    header.organization = orgs.join(', ') || undefined;
    header.application = strOf(a[5]) || strOf(a[4]) || undefined;
  });
  if (projectName) header.project = projectName;

  // ── the products in express-id order: an element's ordinal is its place in that order ───────────────────────
  const n = pId.length;
  let order: Uint32Array | null = null;
  for (let i = 1; i < n; i++) if (pId[i] < pId[i - 1]) { order = new Uint32Array(n); for (let k = 0; k < n; k++) order[k] = k; order.sort((a, b) => pId[a] - pId[b]); break; }
  const at = (k: number) => (order ? order[k] : k);
  const productIds = new Uint32Array(n);
  for (let k = 0; k < n; k++) productIds[k] = pId[at(k)];
  /** The ordinal of a product's express id, -1 for anything else. */
  const ord = (id: number): number => { let lo = 0, hi = n - 1; while (lo <= hi) { const mid = (lo + hi) >> 1, v = productIds[mid]; if (v === id) return mid; if (v < id) lo = mid + 1; else hi = mid - 1; } return -1; };

  // ── resolve relationships (same rules as the web-ifc pass), into one slot per product ─────────────────────────
  const parentOf = new Map<number, number>();
  for (const ag of aggregates) for (const c of ag.children) parentOf.set(c, ag.parent);
  const resolvedStorey = new Map<number, string>();
  const resolveStorey = (structId: number): string => {
    const hit = resolvedStorey.get(structId); if (hit !== undefined) return hit;
    let id: number | undefined = structId; let name = '';
    for (let hop = 0; hop < 8 && id !== undefined; hop++) { const s = storeyName.get(id); if (s) { name = s; break; } id = parentOf.get(id); }
    if (!name) name = storeyName.get(structId) ?? spatialName.get(structId) ?? `#${structId}`;
    name = ownString(name);
    resolvedStorey.set(structId, name); return name;
  };
  const storeys: string[] = [];
  const storeyNo = new Map<string, number>();
  const storeyOfP = new Int32Array(n), storeyOfOther = new Map<number, number>(); // storey number + 1; 0 = none
  for (const rel of contained) {
    const s = resolveStorey(rel.relating);
    let k = storeyNo.get(s); if (k == null) { k = storeys.length; storeys.push(s); storeyNo.set(s, k); }
    for (const t of rel.targets) { const o = ord(t); if (o >= 0) storeyOfP[o] = k + 1; else storeyOfOther.set(t, k + 1); }
  }
  const storeyFor = (id: number): string => {
    let cur: number | undefined = id;
    for (let hop = 0; hop < 8 && cur !== undefined; hop++) { const o = ord(cur); const k = o >= 0 ? storeyOfP[o] : storeyOfOther.get(cur) ?? 0; if (k) return storeys[k - 1]; cur = parentOf.get(cur); }
    return '';
  };

  const materialOfDef = (m: number): string | undefined => {
    const direct = materialName.get(m); if (direct) return direct;
    const usage = layerSetUsage.get(m); const setId = usage ?? (layerSet.has(m) ? m : undefined);
    if (setId !== undefined) { const ls = layerSet.get(setId); if (ls) { if (ls.name) return ls.name; for (const l of ls.layers) { const mm = layerMaterial.get(l); const nm = mm !== undefined ? materialName.get(mm) : undefined; if (nm) return nm; } } }
    const pu = profileSetUsage.get(m); const psId = pu ?? (profileSet.has(m) ? m : undefined);
    if (psId !== undefined) { const ps = profileSet.get(psId); if (ps) { if (ps.name) return ps.name; for (const p of ps.profiles) { const mm = profileMaterial.get(p); const nm = mm !== undefined ? materialName.get(mm) : undefined; if (nm) return nm; } } }
    const list = materialList.get(m); if (list) for (const mm of list) { const nm = materialName.get(mm); if (nm) return nm; }
    return undefined;
  };
  // names shared by many elements, one copy each: slot = name number + 1 (0 = none)
  const names: string[] = [], nameNo = new Map<string, number>();
  const nameSlot = (s: string) => { let k = nameNo.get(s); if (k == null) { k = names.length + 1; names.push(ownString(s)); nameNo.set(s, k); } return k; };
  const materialOfP = new Int32Array(n), typeOfP = new Int32Array(n), systemOfP = new Int32Array(n);
  for (const rel of relMaterial) { const nm = materialOfDef(rel.relating); if (!nm) continue; const k = nameSlot(nm); for (const t of rel.targets) { const o = ord(t); if (o >= 0 && !materialOfP[o]) materialOfP[o] = k; } }
  for (const rel of relType) { const nm = typeName.get(rel.relating); if (!nm) continue; const k = nameSlot(nm); for (const t of rel.targets) { const o = ord(t); if (o >= 0) typeOfP[o] = k; } }
  for (const rel of relGroup) { const nm = groupName.get(rel.relating); if (!nm) continue; const k = nameSlot(nm); for (const t of rel.targets) { const o = ord(t); if (o >= 0 && !systemOfP[o]) systemOfP[o] = k; } }

  // property and quantity sets: each set read once; an element keeps the list of its sets (in file order), and the
  // elements with the same list share one merged object
  const unitOf = (u: number | undefined) => (u != null ? unitLabel.get(u)?.label : undefined);
  type PSet = { props: Record<string, string | number | boolean>; measures: NonNullable<IfcElement['measures']> | null };
  type QSet = { values: Record<string, number>; info: NonNullable<IfcElement['quantityInfo']> };
  const sets: (PSet | QSet)[] = [], setNo = new Map<number, number>();
  const setOf = (relating: number): number => {
    let k = setNo.get(relating); if (k != null) return k;
    k = -1;
    const ps = psets.get(relating);
    if (ps) {
      const pmap: Record<string, string | number | boolean> = {}, mmap: NonNullable<IfcElement['measures']> = {};
      for (const pid of ps.props) { const pv = propValue.get(pid); if (pv && pv[0]) { const key = ownString(`${ps.name}.${pv[0]}`); pmap[key] = typeof pv[1] === 'string' ? ownString(pv[1]) : pv[1]; const m = propMeasure.get(pid); if (m) mmap[key] = { kind: m.kind, ...(unitOf(m.unit) ? { unit: unitOf(m.unit) } : {}) }; } }
      if (Object.keys(pmap).length) { k = sets.length; sets.push({ props: pmap, measures: Object.keys(mmap).length ? mmap : null }); }
    } else {
      const qs = quantSets.get(relating);
      if (qs != null) {
        const qmap: Record<string, number> = {}, imap: NonNullable<IfcElement['quantityInfo']> = {}, set = qsName[qs];
        for (let k2 = qsStart[qs], e2 = qs + 1 < qsStart.length ? qsStart[qs + 1] : qsIds.length; k2 < e2; k2++) { const q = quantValue.get(qsIds[k2]); if (q == null || !qName[q]) continue; qmap[qName[q]] = qVal[q]; const u = qUnit[q] >= 0 ? unitOf(qUnit[q]) : undefined; imap[qName[q]] = { kind: qKind[q], set, ...(u ? { unit: u } : {}) }; }
        if (Object.keys(qmap).length) { k = sets.length; sets.push({ values: qmap, info: imap }); }
      }
    }
    setNo.set(relating, k); return k;
  };
  const firstSet = new Int32Array(n), moreSets = new Map<number, number[]>(); // set number + 1
  for (let r = 0; r < relProps.relating.length; r++) {
    const k = setOf(relProps.relating[r]);
    if (k < 0) continue;
    for (let j = relProps.start[r], e = r + 1 < relProps.start.length ? relProps.start[r + 1] : relProps.targets.length; j < e; j++) { const t = relProps.targets[j]; const o = ord(t); if (o < 0) continue; if (!firstSet[o]) firstSet[o] = k + 1; else (moreSets.get(o) ?? moreSets.set(o, []).get(o)!).push(k); }
  }
  const ownerCache = new Map<number, IfcOwner | undefined>();
  const ownerOf = (ohId: number | undefined): IfcOwner | undefined => {
    if (ohId === undefined || ohId < 0) return undefined;
    if (ownerCache.has(ohId)) return ownerCache.get(ohId);
    const oh = ownerHist.get(ohId); const o: IfcOwner = {};
    if (oh) {
      const po = oh.user !== undefined ? personOrg.get(oh.user) : undefined;
      const pn = po?.person !== undefined ? person.get(po.person) : undefined; if (pn) o.author = ownString(pn);
      const on = po?.org !== undefined ? org.get(po.org) : undefined; if (on) o.organization = ownString(on);
      const an = oh.app !== undefined ? application.get(oh.app) : undefined; if (an) o.application = ownString(an);
      if (oh.when) o.when = new Date(oh.when * 1000).toISOString();
      if (oh.action) o.action = ownString(oh.action);
    }
    const out = Object.keys(o).length ? o : undefined; ownerCache.set(ohId, out); return out;
  };

  // ── elements ─────────────────────────────────────────────────────────────────────────────────────
  const store = newGeomStore();
  const extras = new ExtrasTable(store);
  const merged = new Map<string, { props: Record<string, string | number | boolean>; measures?: NonNullable<IfcElement['measures']> }>();
  const qinfo = new Interner<NonNullable<IfcElement['quantityInfo']>>();
  const elements: IfcElement[] = new Array(n);
  const classCounts: Record<string, number> = {};
  let quantified = 0;
  for (let k = 0; k < n; k++) {
    const j = at(k), id = pId[j], cls = pCls[j];
    const list = firstSet[k] ? [firstSet[k] - 1, ...(moreSets.get(k) ?? [])] : [];
    const pl = list.filter((x) => 'props' in sets[x]), ql = list.filter((x) => 'values' in sets[x]);
    const pkey = pl.join(',');
    let pm = merged.get(pkey);
    if (!pm) {
      const props: Record<string, string | number | boolean> = {}, measures: NonNullable<IfcElement['measures']> = {};
      for (const x of pl) { const ps = sets[x] as PSet; Object.assign(props, ps.props); if (ps.measures) Object.assign(measures, ps.measures); }
      pm = { props: Object.keys(props).length ? props : (Object.freeze({}) as typeof props), ...(Object.keys(measures).length ? { measures } : {}) };
      merged.set(pkey, pm);
    }
    let authored: Record<string, number> | null = null, info: NonNullable<IfcElement['quantityInfo']> | undefined;
    if (ql.length === 1) { const qs = sets[ql[0]] as QSet; authored = qs.values; info = qinfo.get(qs.info); quantified++; } // its own set: no copy
    else if (ql.length) {
      authored = {}; const im: NonNullable<IfcElement['quantityInfo']> = {};
      for (const x of ql) { const qs = sets[x] as QSet; Object.assign(authored, qs.values); Object.assign(im, qs.info); }
      info = qinfo.get(im); quantified++;
    }
    const mat = materialOfP[k] ? names[materialOfP[k] - 1] : undefined, tn = typeOfP[k] ? names[typeOfP[k] - 1] : undefined, sys = systemOfP[k] ? names[systemOfP[k] - 1] : undefined;
    const x = extras.get({ c: cls, s: storeyFor(id), d: disciplineOf(cls, pm.props, sys), ...(mat ? { m: mat } : {}), ...(tn ? { t: tn } : {}), ...(sys ? { y: sys } : {}), p: pm.props, ...(info ? { q: info } : {}), ...(pm.measures ? { me: pm.measures } : {}), ...(ownerOf(pOh[j]) ? { o: ownerOf(pOh[j]) } : {}) });
    classCounts[cls] = (classCounts[cls] ?? 0) + 1;
    elements[k] = new Element(pGuid[j] || `express-${id}`, id, pName[j], authored, x, k);
  }
  const units: Record<QuantityKind, string> = { ...DEFAULT_UNITS };
  { const assigned = (projectUnits != null ? unitAssignments.get(projectUnits) : undefined) ?? [...unitAssignments.values()][0] ?? [];
    const u = assigned.find((x) => lengthUnits.has(x));
    if (u != null) { lengthScale = lengthUnits.get(u)!; lengthScaleSource = 'unit-assignment'; }
    for (const x of assigned) { const l = unitLabel.get(x); if (l?.kind) units[l.kind] = l.label; } }
  const index: IfcIndex = {
    sourcePath: absIfcPath, schema, lengthScale, lengthScaleSource, elements, storeys, classCounts,
    geometryFailures: 0, quantifiedElements: quantified, units,
    header, parsedAt: new Date().toISOString(),
  };
  // the pass's tables go now: a closure of this function that outlives it (V8 keeps one context for all of them) would
  // otherwise keep every one of them alive with the index
  for (const m of [storeyName, spatialName, materialName, layerSet, layerMaterial, layerSetUsage, materialList, profileSet, profileMaterial, profileSetUsage, typeName, groupName, psets, propValue, quantSets, quantValue, propMeasure, unitLabel, qNames, ownerHist, personOrg, person, org, application, lengthUnits, unitAssignments, parentOf, resolvedStorey, storeyOfOther, setNo, moreSets, merged, ownerCache, clsOf, nameNo] as Map<unknown, unknown>[]) m.clear();
  for (const a of [aggregates, contained, relMaterial, relType, relGroup, relProps.relating, relProps.start, relProps.targets, qsStart, qsIds, qsName, qName, qVal, qKind, qUnit, sets, pId, pCls, pGuid, pName, pOh] as unknown[][]) a.length = 0;
  if (n > 200_000) compactHeap();
  return { index, productIds };
}

/** Stream the file; call onEntity(id, TYPE, argText) per DATA entity and onHeader(line) per HEADER line. Handles
 *  entities spanning lines and ';' inside strings. */
export function scanEntities(absPath: string, onEntity: (id: number, type: string, argText: string) => void, onHeader?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(absPath, { encoding: 'utf8', highWaterMark: Number(process.env.WHIQ_SCAN_HWM) || (1 << 20) });
    let carry = '';
    let inData = false;
    let inString = false;
    let inComment = false; // /* ... */ (an apostrophe in a comment must not start a string)
    let entityStart = 0;
    let read = 0;
    rs.on('data', (chunk: string | Buffer) => {
      const text = carry + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      // Resume AFTER the carry: its characters were scanned with the previous chunk (re-scanning them toggled the
      // string state twice and silently dropped ~2 % of entities per 1 MB chunk).
      let i = carry.length; entityStart = 0;
      const n = text.length;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (inComment) { if (c === 42 && text.charCodeAt(i + 1) === 47) { inComment = false; i += 2; } else i++; continue; }
        if (inString) { if (c === 39) inString = false; i++; continue; }
        if (c === 47 && text.charCodeAt(i + 1) === 42) { inComment = true; i += 2; continue; }
        if (c === 39) { inString = true; i++; continue; }
        if (c === 59 /* ; */) {
          const stmt = stripComments(text.slice(entityStart, i)).trim();
          entityStart = i + 1;
          i++;
          if (!stmt) continue;
          if (!inData) {
            if (stmt === 'DATA') { inData = true; continue; }
            if (onHeader && stmt !== 'HEADER' && stmt !== 'ENDSEC' && stmt !== 'ISO-10303-21') onHeader(stmt + ';');
            continue;
          }
          if (stmt.charCodeAt(0) !== 35 /* # */) continue;
          const eq = stmt.indexOf('=');
          if (eq < 0) continue;
          const id = Number(stmt.slice(1, eq).trim());
          let j = eq + 1; while (j < stmt.length && stmt.charCodeAt(j) === 32) j++;
          const par = stmt.indexOf('(', j);
          if (par < 0) continue;
          const type = stmt.slice(j, par).trim().toUpperCase();
          const close = stmt.lastIndexOf(')');
          onEntity(id, type, close > par ? stmt.slice(par + 1, close) : '');
          continue;
        }
        i++;
      }
      carry = text.slice(entityStart);
      // a big file: the garbage of every 128 MB read goes before the next (the live tables are what stays)
      if ((read += typeof chunk === 'string' ? chunk.length : chunk.length) > 128 * 1048576) { read = 0; compactHeap(); }
      if (carry.length > 64 * 1024 * 1024) { rs.destroy(new Error('STEP entity longer than 64 MB — not an IFC file?')); }
    });
    rs.on('error', reject);
    rs.on('end', () => resolve());
  });
}
