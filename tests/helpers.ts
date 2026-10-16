import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLES_DIR = join(import.meta.dirname, '..', 'Sample XERs');

const AGENT_USERS = ['White Hat IQ Scheduler', 'NordBuild', 'NordBuild Oy', 'NordBuild Scheduling', 'AuroraSubA', 'Polaris DC-1', 'P6 User', 'ECC-BK-CS'];

/** Files known to be corrupted (bit flips) — real P6 exports damaged in transit. */
export const CORRUPT = ['CCA R03 dt 24Oct11SC.xer'];

export interface Sample { name: string; bytes: Uint8Array; realP6: boolean }

export function samples(): Sample[] {
  return readdirSync(SAMPLES_DIR).filter((f) => f.toLowerCase().endsWith('.xer')).sort().map((name) => {
    const bytes = new Uint8Array(readFileSync(join(SAMPLES_DIR, name)));
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 400)).split(/\r?\n/)[0].split('\t');
    const realP6 = head[0] === 'ERMHDR' && head[1] !== '12.0' && !AGENT_USERS.includes(head[5] ?? '') && !AGENT_USERS.includes(head[4] ?? '') && !/^20(2[5-9])/.test(head[2] ?? '');
    return { name, bytes, realP6 };
  });
}

export function realSamples(): Sample[] {
  return samples().filter((s) => s.realP6 && !CORRUPT.includes(s.name));
}

export function xer(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\n/g, '\r\n'));
}
