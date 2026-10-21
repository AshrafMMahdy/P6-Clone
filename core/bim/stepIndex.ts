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
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { IfcElement, IfcIndex, IfcOwner, QuantityKind } from './parse.ts';

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
interface Product { id: number; cls: string; guid: string; name: string; oh?: number }
interface Rel { targets: number[]; relating: number }

export interface StepIndexResult { index: IfcIndex; /** express ids of the products, for the geometry worker's node extras */ products: Map<number, { guid: string; ifcClass: string }> }

export async function stepIndex(absIfcPath: string): Promise<StepIndexResult> {
  const products: Product[] = [];
  const isProduct = new Set<number>();
  const storeyName = new Map<number, string>();                 // IfcBuildingStorey / other spatial containers
  const spatialName = new Map<number, string>();
  const aggregates: Array<{ parent: number; children: number[] }> = [];
  const contained: Rel[] = [];
  const relMaterial: Rel[] = [];
  const relType: Rel[] = [];
  const relGroup: Rel[] = [];
  const relProps: Rel[] = [];
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
  const quantSets = new Map<number, number[]>();
  const quantValue = new Map<number, [string, number]>();
  const quantMeta = new Map<number, { kind: QuantityKind; unit?: number }>();
  const propMeasure = new Map<number, { kind: QuantityKind; unit?: number }>();
  const quantSetName = new Map<number, string>();
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
      case 'IFCRELDEFINESBYPROPERTIES': { const a = parseArgs(argText); const d = ref(a[5]); if (d !== undefined) relProps.push({ targets: refs(a[4]), relating: d }); return; }
      case 'IFCPROPERTYSET': { const a = parseArgs(argText); psets.set(id, { name: strOf(a[2]) || 'Pset', props: refs(a[4]) }); return; }
      case 'IFCPROPERTYSINGLEVALUE': { const a = parseArgs(argText); const v = scalar(a[2]); if (v !== undefined) propValue.set(id, [strOf(a[0]), v]);
        // a value typed as a measure (IFCVOLUMEMEASURE(1.2)) is a figure of that kind
        const mk = typeof v === 'number' ? /\bIFC([A-Z]+)MEASURE\(/.exec(argText)?.[1] : undefined; if (mk && MEASURE_KIND[mk]) propMeasure.set(id, { kind: MEASURE_KIND[mk], unit: ref(a[3]) }); return; }
      case 'IFCELEMENTQUANTITY': { const a = parseArgs(argText); quantSets.set(id, refs(a[5])); quantSetName.set(id, strOf(a[2]) || 'Quantities'); return; }
      case 'IFCQUANTITYLENGTH': case 'IFCQUANTITYAREA': case 'IFCQUANTITYVOLUME': case 'IFCQUANTITYCOUNT': case 'IFCQUANTITYWEIGHT': case 'IFCQUANTITYTIME': { const a = parseArgs(argText); const v = a[3]; if (typeof v === 'number' && Number.isFinite(v)) { quantValue.set(id, [strOf(a[0]), v]); quantMeta.set(id, { kind: QTY_KIND[type], unit: ref(a[2]) }); } return; }
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
        products.push({ id, cls: type, guid: m[1], name, oh }); isProduct.add(id);
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

  // ── resolve relationships (same rules as the web-ifc pass) ──────────────────────────────────────
  const parentOf = new Map<number, number>();
  for (const ag of aggregates) for (const c of ag.children) parentOf.set(c, ag.parent);
  const resolvedStorey = new Map<number, string>();
  const resolveStorey = (structId: number): string => {
    const hit = resolvedStorey.get(structId); if (hit !== undefined) return hit;
    let id: number | undefined = structId; let name = '';
    for (let hop = 0; hop < 8 && id !== undefined; hop++) { const s = storeyName.get(id); if (s) { name = s; break; } id = parentOf.get(id); }
    if (!name) name = storeyName.get(structId) ?? spatialName.get(structId) ?? `#${structId}`;
    resolvedStorey.set(structId, name); return name;
  };
  const storeyOf = new Map<number, string>();
  const storeys: string[] = [];
  for (const rel of contained) { const s = resolveStorey(rel.relating); if (!storeys.includes(s)) storeys.push(s); for (const t of rel.targets) storeyOf.set(t, s); }
  const storeyFor = (id: number): string => { let cur: number | undefined = id; for (let hop = 0; hop < 8 && cur !== undefined; hop++) { const s = storeyOf.get(cur); if (s) return s; cur = parentOf.get(cur); } return ''; };

  const materialOfDef = (m: number): string | undefined => {
    const direct = materialName.get(m); if (direct) return direct;
    const usage = layerSetUsage.get(m); const setId = usage ?? (layerSet.has(m) ? m : undefined);
    if (setId !== undefined) { const ls = layerSet.get(setId); if (ls) { if (ls.name) return ls.name; for (const l of ls.layers) { const mm = layerMaterial.get(l); const nm = mm !== undefined ? materialName.get(mm) : undefined; if (nm) return nm; } } }
    const pu = profileSetUsage.get(m); const psId = pu ?? (profileSet.has(m) ? m : undefined);
    if (psId !== undefined) { const ps = profileSet.get(psId); if (ps) { if (ps.name) return ps.name; for (const p of ps.profiles) { const mm = profileMaterial.get(p); const nm = mm !== undefined ? materialName.get(mm) : undefined; if (nm) return nm; } } }
    const list = materialList.get(m); if (list) for (const mm of list) { const nm = materialName.get(mm); if (nm) return nm; }
    return undefined;
  };
  const materialOf = new Map<number, string>();
  for (const rel of relMaterial) { const nm = materialOfDef(rel.relating); if (!nm) continue; for (const t of rel.targets) if (!materialOf.has(t)) materialOf.set(t, nm); }
  const typeOf = new Map<number, string>();
  for (const rel of relType) { const nm = typeName.get(rel.relating); if (!nm) continue; for (const t of rel.targets) typeOf.set(t, nm); }
  const systemOf = new Map<number, string>();
  for (const rel of relGroup) { const nm = groupName.get(rel.relating); if (!nm) continue; for (const t of rel.targets) if (!systemOf.has(t)) systemOf.set(t, nm); }
  const propsOf = new Map<number, Record<string, string | number | boolean>>();
  const authoredOf = new Map<number, Record<string, number>>();
  const quantityInfoOf = new Map<number, NonNullable<IfcElement['quantityInfo']>>(), measuresOf = new Map<number, NonNullable<IfcElement['measures']>>();
  const unitOf = (u: number | undefined) => (u != null ? unitLabel.get(u)?.label : undefined);
  for (const rel of relProps) {
    const ps = psets.get(rel.relating);
    if (ps) {
      const pmap: Record<string, string | number | boolean> = {}, mmap: NonNullable<IfcElement['measures']> = {};
      for (const pid of ps.props) { const pv = propValue.get(pid); if (pv && pv[0]) { pmap[`${ps.name}.${pv[0]}`] = pv[1]; const m = propMeasure.get(pid); if (m) mmap[`${ps.name}.${pv[0]}`] = { kind: m.kind, ...(unitOf(m.unit) ? { unit: unitOf(m.unit) } : {}) }; } }
      if (Object.keys(pmap).length) for (const t of rel.targets) propsOf.set(t, { ...(propsOf.get(t) ?? {}), ...pmap });
      if (Object.keys(mmap).length) for (const t of rel.targets) measuresOf.set(t, { ...(measuresOf.get(t) ?? {}), ...mmap });
      continue;
    }
    const qs = quantSets.get(rel.relating);
    if (qs) {
      const qmap: Record<string, number> = {}, imap: NonNullable<IfcElement['quantityInfo']> = {}, set = quantSetName.get(rel.relating) ?? 'Quantities';
      for (const qid of qs) { const qv = quantValue.get(qid); if (qv && qv[0]) { qmap[qv[0]] = qv[1]; const m = quantMeta.get(qid)!; imap[qv[0]] = { kind: m.kind, set, ...(unitOf(m.unit) ? { unit: unitOf(m.unit) } : {}) }; } }
      if (Object.keys(qmap).length) for (const t of rel.targets) { authoredOf.set(t, { ...(authoredOf.get(t) ?? {}), ...qmap }); quantityInfoOf.set(t, { ...(quantityInfoOf.get(t) ?? {}), ...imap }); }
    }
  }
  const ownerCache = new Map<number, IfcOwner | undefined>();
  const ownerOf = (ohId: number | undefined): IfcOwner | undefined => {
    if (ohId === undefined) return undefined;
    if (ownerCache.has(ohId)) return ownerCache.get(ohId);
    const oh = ownerHist.get(ohId); const o: IfcOwner = {};
    if (oh) {
      const po = oh.user !== undefined ? personOrg.get(oh.user) : undefined;
      const pn = po?.person !== undefined ? person.get(po.person) : undefined; if (pn) o.author = pn;
      const on = po?.org !== undefined ? org.get(po.org) : undefined; if (on) o.organization = on;
      const an = oh.app !== undefined ? application.get(oh.app) : undefined; if (an) o.application = an;
      if (oh.when) o.when = new Date(oh.when * 1000).toISOString();
      if (oh.action) o.action = oh.action;
    }
    const out = Object.keys(o).length ? o : undefined; ownerCache.set(ohId, out); return out;
  };

  // ── elements ─────────────────────────────────────────────────────────────────────────────────────
  products.sort((a, b) => a.id - b.id);
  const elements: IfcElement[] = [];
  const classCounts: Record<string, number> = {};
  const productMap = new Map<number, { guid: string; ifcClass: string }>();
  for (const p of products) {
    const props = propsOf.get(p.id) ?? {};
    const tn = typeOf.get(p.id); const mat = materialOf.get(p.id); const sys = systemOf.get(p.id);
    const hashable = { props: Object.fromEntries(Object.entries(props).sort(([x], [y]) => x.localeCompare(y))), typeName: tn ?? '', material: mat ?? '', name: p.name };
    const psetHash = createHash('sha1').update(JSON.stringify(hashable)).digest('hex').slice(0, 16);
    classCounts[p.cls] = (classCounts[p.cls] ?? 0) + 1;
    const owner = ownerOf(p.oh);
    elements.push({
      guid: p.guid || `express-${p.id}`, expressId: p.id, ifcClass: p.cls, name: p.name, storey: storeyFor(p.id),
      ...(mat ? { material: mat } : {}), ...(tn ? { typeName: tn } : {}), ...(sys ? { system: sys } : {}),
      discipline: disciplineOf(p.cls, props, sys),
      authored: authoredOf.get(p.id) ?? {}, props, psetHash, geom: null, derivedVolumeM3: null,
      ...(quantityInfoOf.has(p.id) ? { quantityInfo: quantityInfoOf.get(p.id) } : {}), ...(measuresOf.has(p.id) ? { measures: measuresOf.get(p.id) } : {}),
      ...(owner ? { owner } : {}),
    });
    productMap.set(p.id, { guid: p.guid, ifcClass: p.cls });
  }
  const units: Record<QuantityKind, string> = { ...DEFAULT_UNITS };
  { const assigned = (projectUnits != null ? unitAssignments.get(projectUnits) : undefined) ?? [...unitAssignments.values()][0] ?? [];
    const u = assigned.find((x) => lengthUnits.has(x));
    if (u != null) { lengthScale = lengthUnits.get(u)!; lengthScaleSource = 'unit-assignment'; }
    for (const x of assigned) { const l = unitLabel.get(x); if (l?.kind) units[l.kind] = l.label; } }
  const index: IfcIndex = {
    sourcePath: absIfcPath, schema, lengthScale, lengthScaleSource, elements, storeys, classCounts,
    geometryFailures: 0, quantifiedElements: elements.filter((e) => Object.keys(e.authored).length > 0).length, units,
    header, parsedAt: new Date().toISOString(),
  };
  return { index, products: productMap };
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
      if (carry.length > 64 * 1024 * 1024) { rs.destroy(new Error('STEP entity longer than 64 MB — not an IFC file?')); }
    });
    rs.on('error', reject);
    rs.on('end', () => resolve());
  });
}
