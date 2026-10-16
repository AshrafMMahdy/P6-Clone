// Print validation summary for every sample: node scripts/survey.ts [--real] [--codes]
import { parseXer } from '../core/xer/parse.ts';
import { validateXer } from '../core/xer/validate.ts';
import { samples } from '../tests/helpers.ts';

const onlyReal = process.argv.includes('--real');
for (const s of samples()) {
  if (onlyReal && !s.realP6) continue;
  const r = parseXer(s.bytes);
  const f = validateXer(r.db, r.findings);
  const counts: Record<string, number> = {};
  for (const x of f) counts[x.severity] = (counts[x.severity] ?? 0) + 1;
  console.log(`${s.realP6 ? 'P6 ' : 'AGT'} ${s.name}: ${JSON.stringify(counts)}`);
  for (const x of f.filter((x) => x.severity === 'fatal' || x.severity === 'error').slice(0, process.argv.includes('--codes') ? 50 : 4)) {
    console.log(`     ${x.severity} ${x.code} ${x.message}`);
  }
}
