import type { Registry } from '@femlab/registry';

// Saves capture immutable snapshots and may finish after later edits; they do not hold this lane.
// These host operations span several engine calls and/or change the current saved project.
// The Worker's per-message queue cannot keep a Journal replay together with its UI refresh.
const MODEL_HOST_COMMANDS = new Set([
  'project.new', 'project.open', 'project.delete', 'project.rename',
  'file.open', 'file.restore', 'file.openExample', 'example.open', 'geometry.importFile',
  'file.export',
]);

/**
 * Serialize complete browser model operations, including refresh and project bookkeeping.
 * UI controls and cancellation stay live. Scripts and the Assistant dispatch their individual
 * model Commands through this queue; queuing their outer run would deadlock those nested calls.
 */
export function serializeModelDispatch(registry: Pick<Registry, 'describe'>, run: Registry['dispatch']): Registry['dispatch'] {
  let tail: Promise<unknown> = Promise.resolve();
  return async (command) => {
    if (registry.describe(command.cmd).provider !== 'engine' && !MODEL_HOST_COMMANDS.has(command.cmd)) return run(command);
    const next = tail.then(() => run(command));
    tail = next.catch(() => undefined);
    return next;
  };
}
