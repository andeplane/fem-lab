// Produce the same immutable virtual compiler files for browser and MCP workers.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { build } = createRequire(new URL('../packages/mcp/package.json', import.meta.url))('esbuild');
import { compile } from 'json-schema-to-typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.dirname(createRequire(import.meta.url).resolve('typescript'));
const files = {};
function include(name) {
  if (Object.hasOwn(files, `/${name}`)) return;
  const source = readFileSync(path.join(lib, name), 'utf8');
  files[`/${name}`] = source;
  for (const match of source.matchAll(/<reference lib="([^"]+)"/g)) include(`lib.${match[1]}.d.ts`);
}
include('lib.es2022.d.ts');
for (const [target, source] of [['fem.d.ts', 'fem.d.ts'], ['engine.d.ts', 'engine.ts']]) {
  files[`/${target}`] = readFileSync(path.join(root, 'packages/registry/src/generated', source), 'utf8');
}
// Derive host arguments from the actual registries, not a second handwritten API list.
const bundled = await build({
  stdin: { contents: `
    import { Registry, HOST_COMMANDS, HOST_QUERIES } from './packages/registry/src/index.ts';
    import schema from './packages/registry/src/generated/engine.schema.json';
    import { createRegistry } from './packages/mcp/src/server.ts';
    const browser = new Registry({ schema, host: {} });
    const mcp = createRegistry({ engine: { dispatch: async () => null, query: async () => null, modelFile: () => ({}) } });
    const names = new Set([...HOST_COMMANDS, ...HOST_QUERIES].map(d => d.name).concat('export.file'));
    const rows = registry => { const list = registry.list(); return [...list.commands, ...list.queries].filter(d => names.has(d.name)).map(d => [d.name, d.schema]); };
    export const hosts = { browser: rows(browser), mcp: rows(mcp) };
  `, resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { hosts } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
for (const [host, rows] of Object.entries(hosts)) {
  const args = await compile({ type: 'object', properties: Object.fromEntries(rows), required: rows.map(([name]) => name), additionalProperties: false }, 'HostArgs', { bannerComment: '', unknownAny: false });
  const hostTypes = args + `
  type Namespace<K> = K extends \`\${infer N}.\${string}\` ? N : never;
  type Verb<K, N extends string> = K extends \`\${N}.\${infer V}\` ? V : never;
  type Method<T> = {} extends T ? (args?: T) => Promise<any> : (args: T) => Promise<any>;
  export type HostFem = { [N in Namespace<keyof HostArgs>]: { [K in keyof HostArgs as Verb<K, N>]: Method<HostArgs[K]> } };
  `;
  const output = { ...files, '/host.d.ts': hostTypes,
    '/fem.d.ts': files['/fem.d.ts'].replace('export interface Fem {', 'export interface EngineFem {') + "\nimport type { HostFem } from './host';\nexport type Fem = EngineFem & HostFem;\n" };
  const target = path.join(root, `packages/registry/src/generated/script-declarations-${host}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(output));
  renameSync(temporary, target);
}
console.log(`Prepared browser and MCP virtual declarations from their registered host schemas.`);
