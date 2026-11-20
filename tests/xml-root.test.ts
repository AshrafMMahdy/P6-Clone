// Which kind of .xml a file is, when the first 4,000 bytes do not say: by its root element, however far in it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, xmlRootName } from '../renderer/io.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const MSP = '<Project xmlns="http://schemas.microsoft.com/project"><Name>T</Name></Project>';
const P6 = '<APIBusinessObjects xmlns="http://xmlns.oracle.com/Primavera/P6/V19.12/API/BusinessObjects"><Project/></APIBusinessObjects>';
const pad = `<!--${' padding '.repeat(2000)}-->`;

test('an .xml whose root element stands beyond the first 4,000 bytes is read as what its root says', () => {
  assert.equal(detectFormat('a.xml', enc(`<?xml version="1.0"?>${MSP}`)), 'mspdi');
  assert.equal(detectFormat('a.xml', enc(`<?xml version="1.0"?>${P6}`)), 'xml');
  assert.ok(pad.length > 4000);
  assert.equal(detectFormat('a.xml', enc(`<?xml version="1.0"?>${pad}${MSP}`)), 'mspdi', 'a Microsoft Project file after a long comment (it was read as P6 XML)');
  assert.equal(detectFormat('a.xml', enc(`<?xml version="1.0"?>${pad}${P6}`)), 'xml');
  assert.equal(detectFormat('a.xml', enc(`<?xml version="1.0"?>${pad}<Other><Project/></Other>`)), 'xml', 'a <Project> that is not the root does not make it Microsoft Project\'s');
});

test('xmlRootName: the first element after the declaration, comments and a DOCTYPE', () => {
  assert.equal(xmlRootName(enc(`<?xml version="1.0"?><!-- <Fake> --><!DOCTYPE Project [ <!ENTITY e "a]b"> <!-- it's > here --> ]><p:Project xmlns:p="x"/>`)), 'Project');
  assert.equal(xmlRootName(enc('')), null);
  assert.equal(xmlRootName(enc('<!-- never closed <Project>')), null);
  assert.equal(xmlRootName(new Uint8Array(Buffer.from('<?xml version="1.0" encoding="UTF-16"?><Project/>', 'utf16le'))), 'Project');
  assert.equal(xmlRootName(new Uint8Array(Buffer.from('\ufeff<?xml version="1.0" encoding="UTF-16"?><Project/>', 'utf16le').swap16())), 'Project', 'UTF-16, big end first');
  assert.equal(xmlRootName(enc('\ufeff<!---><Fake>---><Project a="x>y"/>')), 'Project', 'dashes inside a comment');
  assert.equal(xmlRootName(enc(`<!DOCTYPE Project [ <?pi it's ?> <!ELEMENT Project (Name)> ]><Project/>`)), 'Project', 'an apostrophe in a processing instruction of the DOCTYPE');
  assert.equal(xmlRootName(enc('<Project attr="never closed')), 'Project', 'the name is known before the tag ends');
  assert.equal(xmlRootName(enc('plain text')), null);
});

// The first reader copied what it had read at every comment of a DOCTYPE: 400,000 of them (10 MB) did not end in five minutes.
test('xmlRootName is one pass: a DOCTYPE of 400,000 comments, 8 MB of spaces, a 30 MB attribute that never closes', { timeout: 120_000 }, () => {
  const many = enc(`<?xml version="1.0"?><!DOCTYPE Project [${'<!-- c -->\n'.repeat(400_000)}]><Project xmlns="http://schemas.microsoft.com/project"/>`);
  assert.ok(many.length > 4_000_000);
  assert.equal(xmlRootName(many), 'Project');
  assert.equal(detectFormat('a.xml', many), 'mspdi');
  assert.equal(xmlRootName(new Uint8Array(8 * 1024 * 1024).fill(0x20)), null);
  const open = new Uint8Array(30 * 1024 * 1024).fill(0x61); open.set(enc('<!DOCTYPE Project "'), 0);
  assert.equal(xmlRootName(open), null, 'a quote that never closes: the end is reached, once');
});

// open_file read the kind from the file's first 4,000 bytes only: the same file, opened through the tool.
test('open_file opens a Microsoft Project XML whose root element stands beyond the first 4,000 bytes', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const dir = mkdtempSync(join(tmpdir(), 'p6-xmlroot-'));
  try {
    const body = '<Project xmlns="http://schemas.microsoft.com/project"><Name>Far root</Name><StartDate>2026-03-02T08:00:00</StartDate><Tasks><Task><UID>1</UID><ID>1</ID><Name>Dig</Name><Duration>PT40H0M0S</Duration><Start>2026-03-02T08:00:00</Start><Finish>2026-03-06T17:00:00</Finish></Task></Tasks></Project>';
    const near = join(dir, 'near.xml'), far = join(dir, 'far.xml');
    writeFileSync(near, `<?xml version="1.0" encoding="UTF-8"?>${body}`);
    writeFileSync(far, `<?xml version="1.0" encoding="UTF-8"?>${pad}${body}`);
    const open = async (p: string) => { const r = await callTool('open_file', { path: p }); return { err: r.isError, d: toolResult(r.out, r.isError).structuredContent as any }; };
    const a = await open(near), b = await open(far);
    assert.equal(a.err, false, JSON.stringify(a.d).slice(0, 300));
    assert.equal(b.err, false, JSON.stringify(b.d).slice(0, 300));
    assert.equal(b.d.format, a.d.format, 'the same kind as the file with its root at the start');
    assert.equal(JSON.stringify(b.d.projects ?? b.d.project), JSON.stringify(a.d.projects ?? a.d.project), 'and the same project');
    for (const x of [a, b]) await callTool('close', { handle: x.d.handle });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
