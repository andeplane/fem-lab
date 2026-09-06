import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SCRIPT_CHARACTERS, validateScript, type ScriptDeclarations } from '../src/script-validation';

const require = createRequire(import.meta.url);
const lib = path.dirname(require.resolve('typescript'));
const declarations: ScriptDeclarations = Object.fromEntries([
  ...readdirSync(lib).filter((name) => /^lib\..*\.d\.ts$/.test(name)).map((name) => [`/${name}`, readFileSync(path.join(lib, name), 'utf8')]),
  ['/fem.d.ts', readFileSync(new URL('../src/generated/fem.d.ts', import.meta.url), 'utf8')],
  ['/engine.d.ts', readFileSync(new URL('../src/generated/engine.ts', import.meta.url), 'utf8')],
]);

describe('read-only script validation', () => {
  it.each([
    '',
    'await fem.model.new({ name: "typed" });\nconst m = await fem.query.model();\nconsole.log(m.name);\nreturn m;',
    'const length: string = "1 m"; await fem.geometry.addBox({ name: "beam", size: [length, "1 m", "1 m"] });',
    'throw new Error("never execute validation input");',
    'while (true) {}',
    'await new Promise(resolve => setTimeout(resolve, 10));',
    'await new Promise<void>((resolve) => { const id = setTimeout(resolve, 1); clearTimeout(id); });',
  ])('accepts well-typed source without executing it: %s', (code) => {
    expect(validateScript(code, declarations)).toEqual({ ok: true, diagnostics: [] });
  });

  it.each([
    ['await fem.geometry.inventBox({});', 'does not exist'],
    ['await fem.model.new({ name: 7 });', 'not assignable'],
    ['const m = await fem.query.model();\nconsole.log(m.invented);', 'does not exist'],
    ['const x: = 3;', 'Type expected'],
    ['await fetch("https://example.com");', 'Cannot find name'],
    ['await import("node:fs");', 'Cannot find module'],
  ])('reports source diagnostics for %s', (code, cause) => {
    const result = validateScript(code, declarations);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.cause.includes(cause))).toBe(true);
    expect(result.diagnostics.every((item) => item.where !== null && item.where.line >= 1 && item.where.column >= 1)).toBe(true);
    expect(result.diagnostics.every((item) => item.code.startsWith('TS') && item.hint.includes('before running'))).toBe(true);
  });

  it('validates registered host arguments and limits host commands to the serving host', () => {
    const browser = JSON.parse(readFileSync(new URL('../src/generated/script-declarations-browser.json', import.meta.url), 'utf8')) as ScriptDeclarations;
    const mcp = JSON.parse(readFileSync(new URL('../src/generated/script-declarations-mcp.json', import.meta.url), 'utf8')) as ScriptDeclarations;
    expect(validateScript('await fem.view.fit();', browser)).toEqual({ ok: true, diagnostics: [] });
    expect(validateScript('await fem.view.setMode({ mode: 7 });', browser).ok).toBe(false);
    expect(validateScript('await fem.view.fit();', mcp).ok).toBe(false);
    expect(validateScript('await fem.export.file({ format: "journal", path: "model.json" });', mcp)).toEqual({ ok: true, diagnostics: [] });
    expect(validateScript('await fem.export.file({ format: "invented", path: "model.json" });', mcp).ok).toBe(false);
  });

  it('maps an argument error to its authored line and column', () => {
    const result = validateScript('// first line\nawait fem.model.new({ name: 7 });', declarations);
    expect(result.diagnostics[0]?.where).toEqual({ line: 2, column: 23 });
  });

  it('reports missing compiler declarations instead of silently accepting an untyped API', () => {
    const result = validateScript('', {});
    expect(result.ok).toBe(false);
    expect(result.diagnostics.every((item) => item.where === null && item.hint.includes('Rebuild'))).toBe(true);
  });

  it('rejects oversized input before constructing a compiler program', () => {
    expect(validateScript(' '.repeat(MAX_SCRIPT_CHARACTERS + 1), {})).toEqual({
      ok: false,
      diagnostics: [{ code: 'script.limit', cause: 'script exceeds 64000 characters', where: null, hint: 'Split the script into smaller validated runs.' }],
    });
  });
});
