import type { Command, ModelSummary, Selection } from '@femlab/registry';

/** Project exact saved Load definitions to drawable targets, never display summaries. */
export function loadTargets(command: Command, model: ModelSummary | null): Partial<Pick<Selection, 'bodies' | 'faces' | 'sets'>> {
  if ('on' in command && typeof command.on === 'string') return { sets: [command.on] };
  if ('bodies' in command) return { bodies: command.bodies };
  if (command.cmd === 'load.gravity') return { bodies: model?.bodies.map(body => body.name) ?? [] };
  const connection = command.cmd === 'contact.thermal' ? model?.connections.find(item => item.name === command.of) : undefined;
  return connection ? { sets: [connection.master, connection.slave] } : {};
}
