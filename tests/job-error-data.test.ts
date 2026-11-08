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
