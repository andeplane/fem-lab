/** The generator's pure functions, imported by codegen.test.ts; tools/codegen.mjs is plain ESM. */
declare module '*/tools/codegen.mjs' {
  export function mergeSchema(doc: unknown): unknown;
  export function femDts(doc: unknown): string;
  export function generate(doc: unknown): Promise<Record<string, string>>;
}
