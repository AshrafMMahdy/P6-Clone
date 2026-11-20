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
  const big = new Uint8Array(8 * 1024 * 1024).fill(0x20);
  const t0 = Date.now();
  assert.equal(xmlRootName(big), null);
  assert.ok(Date.now() - t0 < 5000, 'one pass over a file with no element');
});
