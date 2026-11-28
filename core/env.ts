/** A setting from the environment: absent or empty is the default; anything else must be a number in its range (above 0; with `zero`, 0 too;
 *  with `whole`, a whole number), or it is refused in words naming the setting (item 26: a mis-set value never runs as the default without a word). */
export function envNumber(name: string, d: number, o: { zero?: boolean; whole?: boolean } = {}): number {
  const v = process.env[name];
  if (v == null || v === '') return d;
  const n = Number(v);
  if (Number.isFinite(n) && (n > 0 || (o.zero === true && n === 0)) && (o.whole !== true || Number.isInteger(n))) return n;
  const what = `${o.zero ? '0 or a' : 'a'} positive ${o.whole ? 'whole number' : 'number'}`;
  throw new Error(`${name}=${JSON.stringify(v)} is not ${what}: set it to one, or unset it for the default (${d}).`);
}
