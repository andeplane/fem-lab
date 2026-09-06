import type { Fem } from './generated/fem';

export type Dispatch = (cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown>;
export type QueryFn = (q: { query: string } & Record<string, unknown>) => Promise<unknown>;

/**
 * `fem.geometry.addBox(args)` → `dispatch({ cmd: 'geometry.addBox', ...args })`,
 * `fem.query.model()` → `query({ query: 'query.model' })`. The same proxy is `window.fem` on the
 * page and the global inside the script Worker; only the `dispatch` it closes over differs.
 * Typed by the generated `fem.d.ts`, so the type is as wide as the schema and no wider.
 */
export function makeFemProxy(dispatch: Dispatch, query: QueryFn): Fem {
  // Self-contained so isolated interpreters can install this same API from its source.
  // Symbols and `then` fall through so awaiting or inspecting the proxy never calls FEM.
  const bare = (key: string | symbol): key is string => typeof key === 'string' && key !== 'then';
  const method = (ns: string, verb: string) => (args: Record<string, unknown> = {}) =>
    ns === 'query' ? query({ query: `query.${verb}`, ...args }) : dispatch({ cmd: `${ns}.${verb}`, ...args });
  const namespace = (ns: string) => new Proxy({}, { get: (_, verb) => (bare(verb) ? method(ns, verb) : undefined) });
  return new Proxy({} as Fem, { get: (_, ns) => (bare(ns) ? namespace(ns) : undefined) });
}
