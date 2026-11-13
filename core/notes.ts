// The shared wording of the notes the schedule tools put in their answers. A note exists only when something was left out, replaced by a default or repaired
// (including "not assessed" with its reason), a list was cut, the call was refused, P6's own schedule log says it, or an edit confirms what it changed.
// One plain sentence each, said once, and the SAME sentence in every tool: the families below are the only place that spells them. A tool that needs one calls the
// function here; it never words its own. (Answers carry them in one field, `notes`, a list of these sentences.)

/** "1 activity", "0 activities", "2 activities": the count and its noun, grammar right for 0, 1 and many. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** P6's names for the constraint codes (the one place that spells them). */
export const CSTR_NAME: Record<string, string> = {
  CS_MSO: 'Start On', CS_MSOA: 'Start On or After', CS_MSOB: 'Start On or Before',
  CS_MEO: 'Finish On', CS_MEOA: 'Finish On or After', CS_MEOB: 'Finish On or Before',
  CS_MANDSTART: 'Mandatory Start', CS_MANDFIN: 'Mandatory Finish', CS_ALAP: 'As Late As Possible',
};
/** A constraint by its P6 name (an unknown code is given as it is). */
export const cstrName = (code: string): string => CSTR_NAME[code] ?? code;

/** Work minutes as days on a calendar with `hoursPerDay` hours in its day, at most two decimals ("-96", "0.5"). */
export const minutesToDays = (minutes: number, hoursPerDay: number): number => Math.round((minutes / 60 / (hoursPerDay || 8)) * 100) / 100;
/** A number of days as text: "1 day", "-4 days", "0.5 days". */
export const daysText = (days: number): string => `${days} ${Math.abs(days) === 1 ? 'day' : 'days'}`;
/** Hours as days on a calendar with `hoursPerDay` hours in its day, as text. */
export const hoursAsDays = (hours: number, hoursPerDay: number): string => daysText(Math.round((hours / (hoursPerDay || 8)) * 100) / 100);

// AGREED LIMIT (owner, 2026-11-12): 25 — activities and fixes an analysis answer lists per check, and per ranked list of the Monte Carlo answer (criticality, sensitivity, milestones) — fixed, no agent argument — why: enough examples to see the pattern; a round number with no calculation behind it; harmless because the full lists are always written to the result file and named in the answer — arbitrary by agreement.
// The same constant is also the list size of: the activities and fixes per check of lint, dcma_14 and check_schedule; the resources resource_histogram lists; the changed activities of evaluate and evaluate_batch; the activities per window of windows_analysis; the worst lists of earned_value; the Monte Carlo S-curve points and ranked lists; the activity names in crash_schedule's notes.
export const LISTED = 25;
/** Names in a sentence (a refusal, a reason) by the list rule: the first LISTED, then how many more and the total. Short lists are given whole. */
export const namesText = (names: string[]): string => (names.length > LISTED ? `${names.slice(0, LISTED).join(', ')} and ${names.length - LISTED} more (${names.length} in total)` : names.join(', '));

/** A condition of the DATA that stops a tool (a project with no activities, a schedule that cannot be calculated): the tool answers it as a plain refusal that names the cause and the next step, never as a fault of the server. */
export class DataError extends Error {
  code: string; hint: string;
  constructor(code: string, message: string, hint: string) { super(message); this.code = code; this.hint = hint; }
}


// ---- the families (one function each; tests/notes-rule.test.ts walks every tool's answer against them) ----

/** The first letter capital ("opens", "Opens"): a sentence starts a note. */
export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** A list of parts as words: "a", "a and b", "a, b and c". */
export const andList = (parts: string[]): string => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** Missing baseline, as the reason of a part that is not assessed. `argument`: the tool takes a `baseline` argument. `notInFile`: one IS assigned, and the file was exported without it. */
export const baselineReason = (proj: string, argument: boolean, which = 'project', notInFile = false, saved: string[] = []): string => (notInFile
  ? `the ${baselineWord(which)} of ${proj} is not in this file (the file was exported without it); export the file with its baselines${argument ? ', or pass baseline to name one that is in it' : ''}`
  : saved.length ? `no ${which === 'project' ? 'baseline' : baselineWord(which)} is assigned to ${proj}; ${savedText(saved)}: assign ${saved.length === 1 ? 'it' : 'one'} with edit assign_baseline${argument ? `, or pass ${saved.length === 1 ? 'it' : 'one'} as baseline` : ''}`
  : `no ${which === 'project' ? 'baseline' : baselineWord(which)} is assigned to ${proj}; assign one with edit assign_baseline${argument ? ', or pass baseline' : ''}`);
/** The baselines saved in the file and not assigned, as a clause. */
const savedText = (saved: string[]): string => `${namesText(saved)} ${saved.length === 1 ? 'is' : 'are'} saved in the file`;
/** Missing baseline, a check left out. */
export const baselineLeftOut = (part: string, proj: string, argument: boolean, which = 'project'): string => notAssessed(part, baselineReason(proj, argument, which));
/** Missing baseline, the current budget and dates stood in. */
export const currentPlanUsed = (projs: string[], argument = false, notInFile = false, saved: string[] = []): string => (notInFile
  ? `The project baseline of ${projectsText(projs)} is not in this file (the file was exported without it): the current budget and dates were used; export the file with its baselines to measure against it.`
  : `No baseline is assigned to ${projectsText(projs)}: the current budget and dates were used; ${saved.length ? `${savedText(saved)}: assign ${saved.length === 1 ? 'it' : 'one'}` : 'assign one'} with edit assign_baseline${argument ? ', or pass baseline' : ''}.`);
/** No project baseline is assigned and another assigned one stood in (the primary baseline, BL1): which one. */
export const baselineChosen = (proj: string, baseline: string, which: string): string => `No baseline is assigned to ${proj}: ${baseline}, ${which}, was used.`;
/** A baseline by its argument value (`project`, `bl1`, a saved name) for the sentences above. */
export const baselineWord = (which: string): string => (which === 'project' ? 'project baseline' : /^bl\d$/i.test(which) ? `${which.toUpperCase()} baseline` : `baseline ${which}`);

/** No data date and no planned start: nothing can be calculated. The one state sentence for every tool: a refusal where the tool calculates (the two halves below), a note where it only reads. `arg`: the date argument the tool takes. */
export const noDateNoStartWrong = (ids: string[]): string => `${projectsText(ids)} ${ids.length === 1 ? 'has' : 'have'} no data date and no planned start: nothing can be calculated`;
export const noDateNoStartInstead = (arg = 'data_date'): string => `set one with edit set_project (planned start) or pass ${arg}`;
export const noDateNoStart = (ids: string[], arg = 'data_date'): string => `${noDateNoStartWrong(ids)}; ${noDateNoStartInstead(arg)}.`;
export const noDateNoStartRefusal = (ids: string[], arg = 'data_date'): { message: string; hint: string } => refusal(noDateNoStartWrong(ids), noDateNoStartInstead(arg));
/** No data date: the planned start stood in (null: there is none either: the state sentence). */
export const noDataDateUsed = (proj: string, plannedStart: string | null): string => (plannedStart == null ? noDateNoStart([proj]) : `${proj} has no data date: the planned start ${plannedStart} was used. Set one with schedule data_date.`);
/** No data date, said by a tool that only reports it (the schedule, not this tool, uses the planned start). */
export const noDataDateWouldUse = (proj: string, plannedStart: string | null): string => (plannedStart == null ? noDateNoStart([proj]) : `${proj} has no data date: schedule uses the planned start ${plannedStart}. Set one with schedule data_date.`);
/** A save wrote the planned start a schedule had assumed as the data date. */
export const dataDateWritten = (proj: string, date: string): string => `${proj} had no data date: ${date} (its planned start) was written as the data date.`;
/** The reason a part that needs a data date is not assessed. `proj`: the Project IDs, joined as projectsText does. */
export const noDataDateReason = (proj: string, arg: string | null = 'status_date'): string => `${proj} has no data date; ${arg ? `pass ${arg}` : 'set one with schedule data_date'}`;
/** No data date, in a tool that needs one and takes `status_date`: the part that is not assessed, with its reason. The one sentence for every such tool. */
export const noDataDateNotAssessed = (proj: string, part = 'checks that need a data date', arg: string | null = 'status_date'): string => notAssessed(part, noDataDateReason(proj, arg));
/** Projects with different data dates: which date was used. `dates` is "<Project ID> <date>" pairs. */
export const differentDataDates = (dates: { proj: string; date: string }[], used: string): string => `${projectsText(dates.map((d) => d.proj))} have different data dates (${namesText(dates.map((d) => d.date))}): ${used} was used; pass project to work on one.`;
/** Project IDs in a sentence: "A", "A and B", then the list rule (the first LISTED, how many more, the total). */
export const projectsText = (ids: string[]): string => (ids.length === 2 ? andList(ids) : namesText(ids));

/** A list cut: n of N shown, the file that holds all of them (none: said without a file). */
export const listCut = (shown: number, total: number | string, file?: string): string => `${shown} of ${total} shown${file ? `; all ${total} in ${file}` : ''}.`;
/** A part of an analysis that could not be computed, with its reason (a trailing full stop of the reason is dropped). */
export function notAssessed(part: string, reason: string): string { return `${cap(part)} not assessed: ${reason.replace(/\.$/, '')}.`; }
/** The notes of an answer as they are told: each sentence once, and the parts that are not assessed for the same reason in one sentence ("A, B and C not assessed: reason."). */
export function tidyNotes(list: string[]): string[] {
  // a project with no data date and no planned start has its state sentence: the "has no data date; pass status_date" reasons of the same project are not said again
  const stateIds = new Set(list.flatMap((n) => { const m = /^(.+?) (?:has|have) no data date and no planned start: nothing can be calculated; /.exec(n); return m ? [m[1]] : []; }));
  list = list.filter((n) => { const m = /^.+ not assessed: (.+) has no data date; pass status_date\.$/.exec(n); return !(m && stateIds.has(m[1])); });
  const seen = new Set<string>(), out: (string | { parts: string[]; reason: string })[] = [], by = new Map<string, { parts: string[]; reason: string }>();
  for (const n of list) {
    if (typeof n !== 'string' || !n || seen.has(n)) continue;
    seen.add(n);
    const m = /^(.+?) not assessed: (.+)\.$/.exec(n);
    if (!m || /^Not$/.test(m[1]) ) { out.push(n); continue; }
    let g = by.get(m[2]);
    if (!g) { g = { parts: [], reason: m[2] }; by.set(m[2], g); out.push(g); }
    g.parts.push(m[1]);
  }
  return out.map((x) => (typeof x === 'string' ? x : `${cap(andList(x.parts))} not assessed: ${x.reason}.`));
}
/** A call that is refused: what is wrong, and what to send instead (one sentence, said once). */
export const refused = (wrong: string, instead: string): string => `Refused: ${wrong}; ${instead}.`;
/** A refusal as the two halves of an error answer: what is wrong, and what to send instead (said once each). */
export const refusal = (wrong: string, instead: string): { message: string; hint: string } => ({ message: `Refused: ${wrong}.`, hint: `${cap(instead)}.` });
/** A refusal sentence ("Refused: wrong; instead." or a plain sentence) taken apart. */
export function splitRefusal(sentence: string): { wrong: string; instead: string } {
  const t = sentence.replace(/^Refused: /, '').replace(/\.$/, ''), i = t.indexOf('; ');
  return i < 0 ? { wrong: t, instead: '' } : { wrong: t.slice(0, i), instead: t.slice(i + 2) };
}
/** A refusal because the schedule cannot be calculated: `what` stopped, the reasons are the scheduler's own sentences ("Refused: wrong; instead." or a plain sentence), said once each: what is wrong in the message, what to do in the hint (none: no hint). */
export function scheduleRefusal(what: string, reasons: string[]): { message: string; hint: string | null } {
  const parts = reasons.map(splitRefusal);
  const instead = [...new Set(parts.map((p) => p.instead).filter(Boolean))].join('; ');
  return { message: `Refused: ${what}: ${parts.map((p) => p.wrong).join('; ')}.`, hint: instead ? `${cap(instead)}.` : null };
}
/** A repaired copy opened. */
export const openedRepaired = (file: string, repairs: number): string => `Opened a repaired copy: P6 would refuse ${file} as given; ${plural(repairs, 'repair')} made in memory, written only by save.`;
/** A finding's message without the advice it ends with ("; save with repair: true adds it", "; open_file lenient: true repairs it"): for a place that says what is wrong and leaves the next step to a note. */
export const withoutAdvice = (message: string): string => message.replace(/; (?:save with repair|open_file lenient|edit )[^;]*$/, '').replace(/([^.])$/, '$1.');
/** A fault the repair did not touch. */
export const notRepaired = (fault: string, how: string | null = 'save with repair: true fixes it'): string => `Not repaired: ${fault.replace(/\.$/, '')}${how ? `; ${how}` : ''}.`;
/** What a save to a format with no place for it did not write. `kinds` is "<kind> (<n>)". */
export const droppedOnSave = (format: string, kinds: string[], file?: string | null): string => `Not written to ${format}: ${kinds.join(', ')}; save as XER to keep ${kinds.length === 1 ? 'it' : 'them'}${file ? `; each field is listed in ${file}` : ''}.`;
/** A calendar the file does not define. */
export const defaultCalendarWeek = (name: string): string => `Calendar ${name} has no work week in the file: the default 5-day week (no holidays) is used.`;
/** The saved dates are not current (a tool that reads them). */
/** A project whose open activities carry no calculated dates at all (never scheduled). */
export const datesNotStored = (proj: string): string => `${proj} has no calculated dates for its open activities; run schedule first.`;
/** The saved dates of a project are not what a recalculation gives (edited since the last calculation, written by another tool, or levelled). The sentence states the fact and how to recalculate; it does not
 *  order a recalculation, which on a levelled programme throws the levelling away (owner 2026-11-13). `figures`: the answer judges from those dates (an analysis), so it says what its figures are of. */
export const datesNotCurrent = (proj: string, differ: number, open: number, figures = false): string => `The saved dates of ${proj} are not what a recalculation gives (${differ} of ${open} open ${open === 1 ? 'activity' : 'activities'} ${differ === 1 ? 'differs' : 'differ'})${figures ? ': these figures are of the saved dates' : ''}; run schedule to recalculate them.`;
/** A loop. */
export const loopNote = (ids: string[]): string => `${namesText(ids)} ${ids.length === 1 ? 'is' : 'are'} in a loop.`;
/** Resources that are Material: a material is a quantity, not a crew, so its over-allocation is not judged. `ids` are Resource IDs. */
export const materialNote = (ids: string[]): string => `${plural(ids.length, 'resource')} ${ids.length === 1 ? 'is' : 'are'} Material: over-allocation is not assessed for a Material resource: ${namesText([...ids].sort())}.`;
/** Labor / Nonlabor resources with no Max Units/Time (0 or blank): their over-allocation is not judged. `ids` are Resource IDs. */
export const noLimitNote = (ids: string[]): string => `${plural(ids.length, 'resource')} ${ids.length === 1 ? 'has' : 'have'} no Max Units/Time, so ${ids.length === 1 ? 'its' : 'their'} over-allocation is not assessed: ${namesText([...ids].sort())}.`;
/** The two sentences above for a pair of lists, each only when it has a resource. */
export const notJudgedNotes = (x: { material: string[]; noLimit: string[] }): string[] => [...(x.material.length ? [materialNote(x.material)] : []), ...(x.noLimit.length ? [noLimitNote(x.noLimit)] : [])];
/** An actual date after the data date. */
export const actualAfterDataDate = (id: string, kind: 'start' | 'finish' | 'start and finish', dates: string, dataDate: string): string => `${id} has an actual ${kind} ${dates} after the data date ${dataDate}.`;
/** An activity that started before its predecessor finished. */
export const outOfSequence = (id: string, pred: string): string => `${id} started before its predecessor ${pred} finished.`;
/** No resource is assigned to any activity: as the reason of a part that is not assessed, and as the sentence of a tool that then has nothing to do (`verb`: chart, level). */
export const NO_RESOURCE_ASSIGNED = 'no resource is assigned to an activity';
export const noResourceAssigned = (verb: string): string => `${cap(NO_RESOURCE_ASSIGNED)}: nothing to ${verb}.`;
/** A duplicate row. `did` is what the tool did with it ("scheduled once", "counted once"). */
export const duplicateRow = (id: string, did: string): string => `Activity ${id} appears twice in the file; it was ${did} once; save with repair: true fixes it.`;
/** Whether a sentence is one of those (an answer that already names the repeated rows in full does not say them again). */
export const isDuplicateRowNote = (s: string): boolean => /^Activity .+ appears twice in the file; it was .+ once; save with repair: true fixes it\.$/.test(s);
/** A run that was cancelled. */
export const cancelledAfter = (done: number, total: number | null, steps: string, nothingChanged = true): string => `Cancelled after ${done}${total != null ? ` of ${total}` : ''} ${steps}: the result covers those only${nothingChanged ? '; nothing was changed' : ''}.`;
/** A job that is still running. */
export const stillWorking = (jobId: string): string => `Still working: call job_status with job_id ${jobId} for the result.`;
/** An answer too large to return whole: where all of it is. */
export const tooLarge = (chars: number, file: string | null, ask: string): string => file ? `The answer is too large to return (${chars} characters); all of it is in ${file}${ask}.` : `The answer is too large to return (${chars} characters) and could not be written to a file${ask}.`;
/** A tool given an argument it does not have. */
export const argumentNotUsed = (tool: string, arg: string, has: string[]): string => `${tool} has no argument "${arg}"; the call ran without it. Its arguments are: ${has.join(', ')}.`;

