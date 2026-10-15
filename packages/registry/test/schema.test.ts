import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import schema from '../src/generated/engine.schema.json';

describe('engine Command schema documentation', () => {
  it('describes every property of every Command variant, including the discriminator and stubs', () => {
    expect(schema.commands.oneOf.length).toBeGreaterThan(0);
    for (const variant of schema.commands.oneOf) {
      const command = variant.properties.cmd.const;
      expect(Object.keys(variant.properties).length, command).toBeGreaterThan(0);
      for (const [name, property] of Object.entries(variant.properties)) {
        const description = (property as { description?: unknown }).description;
        expect(typeof description, `${command}.${name}`).toBe('string');
        expect((description as string).trim().length, `${command}.${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps documented Commands discriminated and their required fields validated', () => {
    const command = z.fromJSONSchema(schema.commands as unknown as Parameters<typeof z.fromJSONSchema>[0]);
    expect(command.safeParse({ cmd: 'model.new', name: 'documented' }).success).toBe(true);
    // Adding a description to an unconstrained JSON field must leave arbitrary JSON valid.
    for (const manifest of [null, 123, ['metadata', true], { description: 'user metadata' }]) {
      expect(command.safeParse({
        cmd: 'plugin.load', name: 'documented', kind: 'materialLaw', language: 'ts',
        source: { inline: 'source' }, manifest,
      }).success).toBe(true);
    }
    for (const invalid of [
      { cmd: 'model.unknown', name: 'documented' },
      { cmd: 'model.new' },
      { cmd: 'model.new', name: 123 },
      { name: 'documented' },
    ]) expect(command.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
  });
});
