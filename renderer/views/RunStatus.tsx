// The progress of a panel's tool run (renderer/views/toolRun.ts): the tool's own progress line, with a bar when it knows its total.
import type { Progress } from './toolRun.ts';

export function RunStatus({ progress, waiting }: { progress: Progress | null; waiting: string }) {
  return (
    <span className="muted">
      {progress && progress.total > 0 && <progress value={progress.done} max={progress.total} style={{ width: 140, verticalAlign: 'middle' }} />} {progress?.message ?? waiting}
    </span>
  );
}
