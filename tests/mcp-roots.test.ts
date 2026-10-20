import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathArg, setRoots, ToolError } from '../mcp/runtime.ts';

test('MCP roots: a read root alone still fences writing', () => {
  const read = mkdtempSync(join(tmpdir(), 'p6read-'));
  setRoots(read, null);
  assert.equal(pathArg('plan.xer', 'path', 'read'), join(read, 'plan.xer'));
  for (const p of ['out.xer', join(tmpdir(), 'elsewhere.xer')]) {
    assert.throws(() => pathArg(p, 'path', 'write'), (e: unknown) => e instanceof ToolError && e.code === 'path_outside_root' && /write-root/.test(e.hint ?? ''));
  }
});
