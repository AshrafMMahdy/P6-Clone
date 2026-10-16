// MPP bridge. Like Primavera P6, the clone cannot read or write the binary .mpp format itself: it asks an installed
// Microsoft Project (COM automation, "MSProject.Application") to convert between .mpp and Microsoft Project XML.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as absolute } from 'node:path';

export const MSP_REQUIRED = 'Microsoft Project must be installed to import/export .mpp files (Primavera P6 has the same requirement)';
export const CONVERT_TIMEOUT_MS = 120_000;

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

/** Human message for a failed conversion. */
export function convertError(direction: ConvertDirection, code: number | null, stderr: string, timedOut: boolean): string {
  const what = direction === 'mppToXml' ? 'import the .mpp file' : 'save the .mpp file';
  const detail = stderr.replace(/\s+/g, ' ').trim().slice(0, 400).replace(/[.\s]+$/, '');
  if (timedOut) return `Microsoft Project did not finish within ${CONVERT_TIMEOUT_MS / 1000} s, so the clone could not ${what}. ${MSP_REQUIRED}.`;
  if (code === EXIT.noProject || /MSPROJECT_NOT_AVAILABLE|ENOENT/.test(detail)) return `${MSP_REQUIRED}. Microsoft Project could not be started on this computer${detail ? ` (${detail.replace(/^MSPROJECT_NOT_AVAILABLE:\s*/, '')})` : ''}.`;
  if (code === EXIT.open) return `Microsoft Project could not open the file, so the clone could not ${what}${detail ? `: ${detail.replace(/^OPEN_FAILED:\s*/, '')}` : ''}.`;
  if (code === EXIT.save || code === EXIT.missingOutput) return `Microsoft Project could not write the converted file, so the clone could not ${what}${detail ? `: ${detail.replace(/^SAVE_FAILED:\s*/, '')}` : ''}.`;
  return `Converting with Microsoft Project failed (exit code ${code ?? 'none'}), so the clone could not ${what}${detail ? `: ${detail}` : ''}. ${MSP_REQUIRED}.`;
}

function runConvert(direction: ConvertDirection, inPath: string, outPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error(`${MSP_REQUIRED}. Microsoft Project only runs on Windows.`)); return; }
    if (!existsSync(inPath)) { reject(new Error(`Input file not found: ${inPath}`)); return; }
    // absolute paths: Microsoft Project resolves relative ones against its own folder
    const script = buildConvertScript(direction, absolute(inPath), absolute(outPath));
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (err?: Error) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(); };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`${MSP_REQUIRED}. PowerShell could not be started: ${(e as Error).message}`));
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); done(new Error(convertError(direction, null, stderr, true))); }, CONVERT_TIMEOUT_MS);
    child.stdout?.on('data', () => { /* drain */ });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => done(new Error(convertError(direction, null, (e as Error).message, false))));
    child.on('close', (code) => {
      if (timedOut) return;
      if (code === 0 && existsSync(outPath)) done();
      else done(new Error(convertError(direction, code ?? null, stderr, false)));
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
