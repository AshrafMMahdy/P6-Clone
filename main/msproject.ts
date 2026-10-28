// MPP bridge. Like Primavera P6, the clone cannot read or write the binary .mpp format itself: it asks an installed
// Microsoft Project (COM automation, "MSProject.Application") to convert between .mpp and Microsoft Project XML.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve as absolute } from 'node:path';
import { expectedMs } from '../core/bim/heartbeat.mjs';
import { cpuCovering, externalWatch, pidsNamed, StuckError, workerFloorMs, type StuckInfo } from '../core/bim/liveness.ts';

export const MSP_REQUIRED = 'Microsoft Project must be installed to import/export .mpp files (Primavera P6 has the same requirement)';
// No fixed time limit on the conversion (owner rule 2026-10-28; it was 120 s whatever the file's size). Microsoft Project is opaque
// (a COM call reports nothing), so it is watched from outside (liveness.ts externalWatch): ended past a work bound (the input's
// size x MSPROJECT_S_PER_MB in heartbeat.mjs x this machine's factor x 10, never under the floor; the output growing while it saves
// resets the clock), or when neither PowerShell nor Project (WINPROJ.EXE, started through COM: not PowerShell's child) used
// processor time and nothing was written for two windows: Project waits on a dialog nobody can see.
/** The process Microsoft Project runs as. */
export const MSPROJECT_EXE = 'WINPROJ.EXE';

export type ConvertDirection = 'mppToXml' | 'xmlToMpp';

/** Quote a value as a PowerShell single-quoted literal (no variable or backtick expansion inside). */
export function psQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, "''")}'`;
}

// Exit codes the script uses so the caller can explain what went wrong.
const EXIT = { noProject: 3, open: 4, save: 5, missingOutput: 6 } as const;

/**
 * PowerShell that opens `inPath` in a hidden Microsoft Project and saves it as `outPath` (XML or MPP).
 * One line, single quotes only, so it survives being passed to `powershell.exe -Command` as one argument.
 */
export function buildConvertScript(direction: ConvertDirection, inPath: string, outPath: string): string {
  const toXml = direction === 'mppToXml';
  // Named COM arguments: PowerShell cannot bind Project's long optional-parameter lists positionally.
  const open = toXml
    ? "$ok = & $call 'FileOpenEx' @($in, $true) @('Name', 'ReadOnly')"
    : "$ok = & $call 'FileOpenEx' @($in, $false, 'MSProject.XML') @('Name', 'ReadOnly', 'FormatID')";
  const save = toXml
    ? "[void](& $call 'FileSaveAs' @($out, 'MSProject.XML') @('Name', 'FormatID'))"
    : "[void](& $call 'FileSaveAs' @($out, 'MSProject.MPP') @('Name', 'FormatID'))";
  return [
    "$ErrorActionPreference = 'Stop'",
    `$in = ${psQuote(inPath)}`,
    `$out = ${psQuote(outPath)}`,
    '$call = { param($name, [object[]]$vals, [string[]]$names) $app.GetType().InvokeMember($name, [Reflection.BindingFlags]::InvokeMethod, $null, $app, $vals, $null, $null, $names) }',
    '$app = $null',
    `try { $app = New-Object -ComObject MSProject.Application } catch { [Console]::Error.WriteLine('MSPROJECT_NOT_AVAILABLE: ' + $_.Exception.Message); exit ${EXIT.noProject} }`,
    'try {',
    '$app.Visible = $false',
    '$app.DisplayAlerts = $false',
    `try { ${open} } catch { [Console]::Error.WriteLine('OPEN_FAILED: ' + $_.Exception.Message); exit ${EXIT.open} }`,
    `if ($ok -eq $false) { [Console]::Error.WriteLine('OPEN_FAILED: Microsoft Project could not open the file'); exit ${EXIT.open} }`,
    `try { ${save} } catch { [Console]::Error.WriteLine('SAVE_FAILED: ' + $_.Exception.Message); exit ${EXIT.save} }`,
    '$app.FileCloseEx(0)',
    `if (-not (Test-Path -LiteralPath $out)) { [Console]::Error.WriteLine('SAVE_FAILED: no output file was written'); exit ${EXIT.missingOutput} }`,
    '} finally {',
    'if ($app -ne $null) { try { $app.FileCloseEx(0) } catch {} ; try { $app.Quit(0) } catch {} ; [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) }',
    '}',
    'exit 0',
  ].join('; ').replace(/\{; /g, '{ ').replace(/; \}/g, ' }');
}

/** A conversion ended as stuck: the words and the structured fields (StuckError.stuck). */
export function mspStuck(direction: ConvertDirection, stuck: StuckInfo): StuckError {
  const open = direction === 'mppToXml' ? 'opening the .mpp and saving it as Microsoft Project XML' : 'saving the XML as an .mpp';
  return new StuckError({ ...stuck, step: `Microsoft Project: ${open}` }, {
    what: 'Microsoft Project (through COM)', tried: 'one conversion in a hidden Microsoft Project; there is no second way to read or write an .mpp',
    next: direction === 'mppToXml'
      ? 'open the .mpp once in Microsoft Project yourself (a dialog, such as a read-only prompt, a repair prompt or a licence message, may be waiting there), save it as Microsoft Project XML (File > Save As) and import that XML; or export the schedule from the source tool as XER or XML; or split a very large project'
      : 'open Microsoft Project once yourself (a dialog may be waiting there), then retry; or save the schedule as Microsoft Project XML and let the receiver open that in Project; or export it as XER or XML',
  }, '', ` ${MSP_REQUIRED}.`);
}

/** Human message for a failed conversion. */
export function convertError(direction: ConvertDirection, code: number | null, stderr: string, stuck: StuckInfo | null = null): string {
  const what = direction === 'mppToXml' ? 'import the .mpp file' : 'save the .mpp file';
  const detail = stderr.replace(/\s+/g, ' ').trim().slice(0, 400).replace(/[.\s]+$/, '');
  if (stuck) return mspStuck(direction, stuck).message;
  if (code === EXIT.noProject || /MSPROJECT_NOT_AVAILABLE|ENOENT/.test(detail)) return `${MSP_REQUIRED}. Microsoft Project could not be started on this computer${detail ? ` (${detail.replace(/^MSPROJECT_NOT_AVAILABLE:\s*/, '')})` : ''}.`;
  if (code === EXIT.open) return `Microsoft Project could not open the file, so the clone could not ${what}${detail ? `: ${detail.replace(/^OPEN_FAILED:\s*/, '')}` : ''}.`;
  if (code === EXIT.save || code === EXIT.missingOutput) return `Microsoft Project could not write the converted file, so the clone could not ${what}${detail ? `: ${detail.replace(/^SAVE_FAILED:\s*/, '')}` : ''}.`;
  return `Converting with Microsoft Project failed (exit code ${code ?? 'none'}), so the clone could not ${what}${detail ? `: ${detail}` : ''}. ${MSP_REQUIRED}.`;
}

async function runConvert(direction: ConvertDirection, inPath: string, outPath: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error(`${MSP_REQUIRED}. Microsoft Project only runs on Windows.`);
  if (!existsSync(inPath)) throw new Error(`Input file not found: ${inPath}`);
  // the Project instances running before: only one that this script starts is ever ended (the user may have their own open)
  const before = new Set((await pidsNamed(MSPROJECT_EXE)) ?? []);
  return new Promise<void>((resolve, reject) => {
    // absolute paths: Microsoft Project resolves relative ones against its own folder
    const script = buildConvertScript(direction, absolute(inPath), absolute(outPath));
    let stderr = '';
    let stuck: StuckInfo | null = null;
    let settled = false, stopWatch = () => {};
    const done = (err?: Error) => { if (settled) return; settled = true; stopWatch(); err ? reject(err) : resolve(); };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`${MSP_REQUIRED}. PowerShell could not be started: ${(e as Error).message}`));
      return;
    }
    const sizeOf = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
    stopWatch = externalWatch({
      step: `converting (${direction})`, floorMs: workerFloorMs(), expectMs: expectedMs(sizeOf(inPath), 'msproject'),
      output: () => sizeOf(outPath), // a save writes the output as it goes: bytes are progress
      // the idle rule needs a reading that COVERS Project (the process table, with WINPROJ.EXE running): where only PowerShell can be
      // seen (tasklist fall back, Project not found yet) there is no idle rule, and the size bound alone ends a conversion
      cpu: () => cpuCovering(child.pid ?? 0, [MSPROJECT_EXE]),
      onStuck: async (i) => {
        stuck = i;
        // end the script, and the Project instance IT started (a new WINPROJ.EXE; one already running is the user's and stays)
        try { child.kill(); } catch { /* gone */ }
        for (const pid of (await pidsNamed(MSPROJECT_EXE)) ?? []) if (!before.has(pid)) { try { process.kill(pid); } catch { /* gone */ } }
        done(mspStuck(direction, i));
      },
    });
    child.stdout?.on('data', () => { /* drain */ });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => done(new Error(convertError(direction, null, (e as Error).message, null))));
    child.on('close', (code) => {
      if (stuck) return;
      if (code === 0 && existsSync(outPath)) done();
      else done(new Error(convertError(direction, code ?? null, stderr, null)));
    });
  });
}

/** Convert an .mpp file to Microsoft Project XML using the installed Microsoft Project. */
export function mppToXml(mppPath: string, xmlOutPath: string): Promise<void> {
  return runConvert('mppToXml', mppPath, xmlOutPath);
}

/** Convert a Microsoft Project XML file to .mpp using the installed Microsoft Project. */
export function xmlToMpp(xmlPath: string, mppOutPath: string): Promise<void> {
  return runConvert('xmlToMpp', xmlPath, mppOutPath);
}
