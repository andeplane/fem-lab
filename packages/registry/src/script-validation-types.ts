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

export function validationFailure(code: string, cause: string, hint: string): ScriptValidation {
  return { ok: false, diagnostics: [{ code, cause, where: null, hint }] };
}
