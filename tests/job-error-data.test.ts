// 4L-13 review H4: a job that fails keeps its error's data. A render run as a job (any render over ~25 s) answers job_status
// with frames_done / frames_total / kept_segments / resume — what was kept and how to continue — not only the hint text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError, jobView, startJob } from '../mcp/runtime.ts';

test('a failed job carries its error\'s data (what a render kept and how to resume)', async () => {
  const kept = { frames_done: 120, frames_total: 400, kept_segments: ['a.parts/seg-1.mp4'], resume: 'a.parts/render.json', cause: 'gpu_lost' };
  const job = startJob('render_4d', undefined, Promise.reject(new ToolError('render_failed', 'The page stopped drawing.', 'Continue with resume.', { data: kept })));
  await new Promise((r) => setTimeout(r, 20));
  const v = jobView(job) as { status: string; error: Record<string, unknown> };
  assert.equal(v.status, 'failed');
  for (const [k, x] of Object.entries(kept)) assert.deepEqual(v.error[k], x, k);
  assert.equal(v.error.code, 'render_failed', 'the error\'s own code is never overwritten by its data');
  assert.equal(v.error.next_step, 'Continue with resume.');
});

// The release of whiq-v0.1.82 failed on a slow runner: a render that failed as a job answered reason = the message, where the
// same failure of a call that ended in time answers reason = the cause's code (test_failure, webgl_context_lost, disk_full).
test('a failed job says the same reason as the call would have: the error\'s own, else its message', async () => {
  const withReason = startJob('render_4d', undefined, Promise.reject(new ToolError('render_failed', 'The page lost its WebGL context.', 'Continue with resume.', { data: { reason: 'webgl_context_lost', frames_done: 6 } })));
  const without = startJob('render_4d', undefined, Promise.reject(new ToolError('render_failed', 'The page stopped drawing.', 'Continue with resume.')));
  await new Promise((r) => setTimeout(r, 20));
  const a = jobView(withReason) as { error: Record<string, unknown> }, b = jobView(without) as { error: Record<string, unknown> };
  assert.equal(a.error.reason, 'webgl_context_lost');
  assert.equal(a.error.message, 'The page lost its WebGL context.');
  assert.equal(b.error.reason, 'The page stopped drawing.');
  // and through the tool, as an agent reads it
  const { callTool, toolResult } = await import('../mcp/server.ts');
  const r = await callTool('job_status', { job_id: withReason.id });
  const d = toolResult(r.out, r.isError).structuredContent as { error: Record<string, unknown> };
  assert.equal(r.isError, true);
  assert.equal(d.error.reason, 'webgl_context_lost');
  assert.equal(d.error.code, 'render_failed');
});
