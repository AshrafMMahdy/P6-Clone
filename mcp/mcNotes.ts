// The notes of the Monte Carlo answer's ranked lists (owner 2026-11-12: the platform's own tool is removed, so this tool says what the platform's
// pass-through said). Built exactly as the platform's monteCarloLists builds them: the criticality note says what the rows shown are (ranked
// first by how often critical, then, when fewer activities than are shown were ever critical, filled up with ones that never were), with the two
// exact counts the answer carries; the sensitivity note says how many activities have a varying duration. `file`: the CSV that holds every row
// (absent when the result file could not be written: then no file is named).
const acts = (n: number): string => `${n} ${n === 1 ? 'activity' : 'activities'}`;
const were = (n: number): string => (n === 1 ? 'was' : 'were');
const are = (n: number): string => (n === 1 ? 'is' : 'are');

/** shown: rows listed; total: all activities (criticality_total); everyRun / anyRun: critical_in_every_run / critical_in_any_run. Undefined when the list is not cut. */
export function criticalityNote(shown: number, total: number, everyRun: number, anyRun: number, file?: string): string | undefined {
  if (!(total > shown)) return undefined;
  const S = shown, A = anyRun, E = everyRun, T = total;
  const inFile = file ? `; all ${T} activities are in ${file}` : '';
  return A > S
    ? `${S} of the ${acts(A)} that ${were(A)} critical in at least one run ${are(S)} shown, highest first (${E} critical in every run)` + inFile +
      (E > S ? `; the ${S} shown ${are(S)} all critical in every run, in activity-code order` : '')
    : A > 0
    ? `${A === 1 ? 'the 1 activity' : `all ${A} activities`} that ${were(A)} critical in at least one run ${are(A)} shown${S > A ? ' first' : ''} (${E} critical in every run)` +
      (S > A ? `, then ${S - A} that never ${S - A === 1 ? 'was' : 'were'}` : '') + inFile
    : `no activity was critical in any run; the first ${S} of ${T} activities ${are(S)} shown${file ? `; all ${T} are in ${file}` : ''}`;
}

/** Undefined when the list is not cut. */
export function sensitivityNote(shown: number, total: number, file?: string): string | undefined {
  return total > shown ? `${shown} of ${total} activities with a varying duration shown, strongest first${file ? `; all ${total} in ${file}` : ''}` : undefined;
}
