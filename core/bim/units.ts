// The length units a caller can state for a model's numbers (open_model length_unit). Imports nothing: the desktop's renderer reads them
// too (link4d.ts, import4d.ts), where the model reader's Node code cannot load.

/** The units, in metres. */
export const LENGTH_UNITS = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 } as const;
export type LengthUnit = keyof typeof LENGTH_UNITS;
export const isLengthUnit = (u: unknown): u is LengthUnit => typeof u === 'string' && Object.hasOwn(LENGTH_UNITS, u);
/** A model's cache key with the caller's length unit: a model read by another unit is another model (its geometry and tiles differ). */
export const unitKey = (hash: string, unit?: LengthUnit) => (unit ? `${hash}.${unit}` : hash);
