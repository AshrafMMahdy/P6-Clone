// Text schedule log in the spirit of P6's SCHEDLOG.TXT.
import { formatP6Date } from '../dates.ts';
import type { Finding } from '../findings.ts';
import type { Row } from '../db.ts';
import type { SchedOptions, ScheduleStats } from './cpm.ts';

interface LogInput {
  projects: Row[];
  dataDate: number | null;
  opts: SchedOptions;
  findings: Finding[];
  stats: ScheduleStats;
  acts: { code: string; name: string }[];
}

const SECTIONS: [string, string][] = [
  ['SCHED_LOOP', 'Errors: Circular relationships (loops)'],
  ['SCHED_CALENDAR', 'Errors: Calendars'],
  ['SCHED_CAL_INVALID', 'Warnings: Invalid calendars'],
  ['OPEN_START', 'Warnings: Activities without predecessors'],
  ['OPEN_FINISH', 'Warnings: Activities without successors'],
  ['OUT_OF_SEQUENCE', 'Warnings: Out of sequence activities'],
  ['CONSTRAINT_VIOLATED', 'Warnings: Activities with constraints that cannot be met'],
  ['ACTUAL_AFTER_DD', 'Warnings: Activities with actual dates after the data date'],
  ['NEGATIVE_FLOAT', 'Warnings: Activities with negative float'],
];

export function buildScheduleLog(i: LogInput): string {
  const L: string[] = [];
  const o = i.opts;
  L.push('Scheduling / Leveling Report', '', `Scheduled on .............. ${formatP6Date(Date.now() / 60000)}`);
  for (const p of i.projects) L.push(`Project ................... ${p.proj_short_name}${p.proj_name ? ' - ' + p.proj_name : ''}`);
  L.push('', 'Settings', '--------',
    `Data date ................................... ${formatP6Date(i.dataDate)}`,
    `Logic for progressed activities ............. ${o.logic === 'retained' ? 'Retained Logic' : o.logic === 'override' ? 'Progress Override' : 'Actual Dates'}`,
    `Calendar for relationship lag ............... ${{ predecessor: 'Predecessor Activity Calendar', successor: 'Successor Activity Calendar', '24h': '24 Hour Calendar', project: 'Project Default Calendar' }[o.lagCalendar]}`,
    `Total float computed as ..................... ${{ start: 'Start Float = Late Start - Early Start', finish: 'Finish Float = Late Finish - Early Finish', smallest: 'Smallest of Start Float and Finish Float' }[o.floatType]}`,
    `Make open-ended activities critical ......... ${o.openEndedCritical ? 'Yes' : 'No'}`,
    `Ignore relationships to/from other projects . ${o.ignoreExternal ? 'Yes' : 'No'}`,
    `Use Expected Finish Dates ................... ${o.useExpectedFinish ? 'Yes' : 'No'}`,
    `Critical activities ......................... ${o.criticalBy === 'longestPath' ? 'Longest Path' : `Total Float <= ${o.criticalFloatHrs} h`}`,
    '', 'Statistics', '----------',
    `Activities .................................. ${i.stats.activities}`,
    `  Not Started ............................... ${i.stats.notStarted}`,
    `  In Progress ............................... ${i.stats.inProgress}`,
    `  Completed ................................. ${i.stats.completed}`,
    `Relationships ............................... ${i.stats.relationships}`,
    `Scheduled finish ............................ ${formatP6Date(i.stats.finish)}`, '');
  for (const [code, title] of SECTIONS) {
    const fs = i.findings.filter((f) => f.code === code);
    if (!fs.length) continue;
    L.push(`${title} (${fs.length})`, '-'.repeat(title.length + String(fs.length).length + 3));
    for (const f of fs) L.push(`  ${f.message}`);
    L.push('');
  }
  L.push('End of report');
  return L.join('\r\n');
}
