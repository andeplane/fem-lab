/** Public causes are fixed strings; underlying SDK/database errors never reach a client. */
export class ServiceFailure extends Error {
  constructor(readonly status: number, readonly code: string, cause: string, readonly where: string, readonly suggestion: string | null = null) { super(cause); }
}
