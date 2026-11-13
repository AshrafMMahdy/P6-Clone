// The shared wording of the notes the schedule tools put in their answers: one plural helper, one constraint-naming function, one unit
// helper (work minutes to days on the activity's calendar) and the sentences several tools say the same way (no baseline, no data date).

/** "1 activity", "0 activities", "2 activities": the count and its noun, grammar right for 0, 1 and many. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** The noun alone for a count: "activity" for 1, "activities" otherwise. */
export const noun = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
/** "is" / "are" for a count. */
export const isAre = (n: number): string => (n === 1 ? 'is' : 'are');

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

/** One sentence for a missing baseline, the same in every tool: what is missing and the clone's own ways to give one. `argument` is true for a tool that takes a `baseline` argument. */
export const noBaseline = (argument: boolean, what = 'No project baseline is assigned'): string =>
  `${what}. Assign one with edit assign_baseline${argument ? ', or name a saved baseline in this tool’s baseline argument' : ''}.`;

/** The one sentence for a file with no data date: the planned start stood in for it. `argument` is the tool's own argument that sets one (none: the sentence ends after the date). */
export const noDataDateUsed = (plannedStart: string, argument?: string): string =>
  `The file has no data date: the planned start ${plannedStart} was used${argument ? `; give ${argument} to set one` : ''}.`;

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

/** The one sentence about a resource with no limit set (Max Units/Time 0): what THIS tool does with it, and the call that sets a limit. The tools differ in what they do; each says it the same way. */
export const noLimitSentence = (does: string): string => `A resource with no limit set (Max Units/Time 0) ${does}. Set a limit with edit update_resource max_units_per_day.`;

/** The missing-baseline sentence for a baseline by its argument value (`project`, `bl1` ...): the same words in every tool, with the clone's own ways to give one. */
export const noBaselineOf = (which: string, argument: boolean): string => noBaseline(argument, `No ${which === 'project' ? 'project' : which.toUpperCase()} baseline is assigned`);
