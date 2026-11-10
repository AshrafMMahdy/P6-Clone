// The progress of a panel's tool run (renderer/views/toolRun.ts): the tool's own progress line, with a bar when it knows its total.
import type { Progress } from './toolRun.ts';

export function RunStatus({ progress, waiting, asked }: { progress: Progress | null; waiting: string; asked?: boolean }) {
  return (
    <span className="muted">
      {asked && <b>Asked to stop; click Cancel again to end the run (its work is then not kept). </b>}
      {progress && progress.total > 0 && <progress value={progress.done} max={progress.total} style={{ width: 140, verticalAlign: 'middle' }} />} {progress?.message ?? waiting}
    </span>
  );
}
