import path from 'node:path';
import ts from 'typescript';

/** Follow actual emitted asset URLs, including nested module Workers absent from Vite's manifest. */
export function runtimeClosures(files, source) {
  const available = new Set(files);
  const graph = new Map(files.map(file => [file, new Set()]));
  for (const file of files.filter(file => file.endsWith('.js'))) {
    const parsed = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const visit = node => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const literal = node.text;
        const target = literal.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file), literal))
          : literal.includes('/assets/') ? `assets/${literal.split('/assets/').at(-1)}` : literal;
        if (available.has(target)) graph.get(file).add(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  const workers = files.filter(file => /^assets\/session\.worker-[^/]+\.js$/.test(file));
  if (workers.length !== 1) throw new Error(`Expected one emitted session Worker, found ${workers.length}`);
  const worker = workers[0];
  const reachable = start => {
    const found = new Set();
    const visit = file => {
      if (found.has(file)) return;
      found.add(file);
      for (const dependency of graph.get(file)) visit(dependency);
    };
    visit(start);
    return found;
  };
  const closure = reachable(worker);
  const binaries = [...closure].filter(file => file.endsWith('.wasm'));
  if (binaries.length !== 2) throw new Error(`Expected portable and threaded engine WASM, found ${binaries.length}`);
  const needs = new Map([...closure].map(file => [file, new Set([...reachable(file)].filter(file => binaries.includes(file)))]));
  return binaries.map(binary => {
    const selected = new Set();
    const visit = file => {
      if (selected.has(file)) return;
      const requires = needs.get(file);
      if (requires.size && !requires.has(binary)) return;
      selected.add(file);
      for (const dependency of graph.get(file)) visit(dependency);
    };
    visit(worker);
    return { binary, files: selected };
  });
}
