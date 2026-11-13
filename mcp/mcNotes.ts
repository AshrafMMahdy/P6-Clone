// The notes of the Monte Carlo answer's ranked lists: a list that is cut says it the one way every list says it (core/notes.ts listCut): "<n> of <N> shown; all <N> in <file>."
// `file`: the CSV that holds every row (absent when the result file could not be written: then no file is named). Undefined when the list is not cut.
import { listCut } from '../core/notes.ts';

/** shown: rows listed; total: all activities (criticality_total). How many were critical in every run, or in any, are fields of the answer. */
export const criticalityNote = (shown: number, total: number, file?: string): string | undefined => (total > shown ? listCut(shown, total, file) : undefined);
export const sensitivityNote = (shown: number, total: number, file?: string): string | undefined => (total > shown ? listCut(shown, total, file) : undefined);
