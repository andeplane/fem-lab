// Shared by the browser and MCP validation workers. All compiler files are supplied as text;
// this module never uses ts.sys, a filesystem, an engine transport or script execution.
import ts from 'typescript';

export interface ScriptDiagnostic {
  code: string;
  cause: string;
  where: { line: number; column: number } | null;
  hint: string;
}
export interface ScriptValidation {
  ok: boolean;
  diagnostics: ScriptDiagnostic[];
}
export type ScriptDeclarations = Readonly<Record<string, string>>;
export const MAX_SCRIPT_CHARACTERS = 64_000;

const PREFIX = `import type { Fem } from './fem';
declare const fem: Fem;
declare const console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void; debug(...values: unknown[]): void };
declare function setTimeout(callback: () => void, delay?: number): number;
declare function clearTimeout(id: number): void;
async function __fem_script__() {
`;
const PREFIX_LINES = PREFIX.split('\n').length - 1;

/** Parse/type-check one authored script without evaluating it. Hosts enforce worker deadlines. */
export function validateScript(code: string, declarations: ScriptDeclarations): ScriptValidation {
  if (code.length > MAX_SCRIPT_CHARACTERS) return {
    ok: false,
    diagnostics: [{ code: 'script.limit', cause: `script exceeds ${MAX_SCRIPT_CHARACTERS} characters`, where: null, hint: 'Split the script into smaller validated runs.' }],
  };
  const files: ScriptDeclarations = { ...declarations, '/script.ts': `${PREFIX}${code}\n}\n` };
  const readFile = (name: string) => files[name];
  const newline = () => '\n';
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) => {
      const source = readFile(name);
      return source === undefined ? undefined : ts.createSourceFile(name, source, languageVersion);
    },
    getDefaultLibFileName: () => '/lib.es2022.d.ts',
    writeFile: newline, // noEmit: the compiler never requests an output write.
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: newline,
    fileExists: (name) => files[name] !== undefined,
    readFile,
    resolveModuleNames: (names) => names.map((name) => name === './fem' || name === './engine'
      ? { resolvedFileName: `/${name.slice(2)}.d.ts`, extension: ts.Extension.Dts }
      : undefined),
  };
  const program = ts.createProgram(['/script.ts'], {
    strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, skipLibCheck: false,
  }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic): ScriptDiagnostic => {
    const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start!);
    const authored = diagnostic.file?.fileName === '/script.ts' && position !== undefined;
    return {
      code: `TS${diagnostic.code}`,
      cause: ts.flattenDiagnosticMessageText(diagnostic.messageText, host.getNewLine()),
      where: authored ? { line: Math.max(1, position.line + 1 - PREFIX_LINES), column: position.character + 1 } : null,
      hint: authored ? 'Use the generated fem API types and correct this source location before running.' : 'Rebuild the validator declarations from the installed TypeScript SDK and generated registry.',
    };
  });
  return { ok: diagnostics.length === 0, diagnostics };
}
