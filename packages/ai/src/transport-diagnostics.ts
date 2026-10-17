/** A bounded allowlist: no error messages, stacks, headers, URLs, payloads or credentials. */
export interface TransportCause {
  kind: string;
  code?: string;
  /** Absent on legacy/truncated causes; null means a hostile property trap prevented inspection. */
  codePresent?: boolean | null;
  /** A finite type tag only. Rejected code values are never copied. */
  codeType?: 'absent' | 'unreadable' | 'null' | 'undefined' | 'string' | 'number' | 'boolean' | 'bigint' | 'symbol' | 'function' | 'object';
  codeRecognized?: boolean;
  status?: number;
  requestId?: string;
  cause?: TransportCause;
  errors?: TransportCause[];
}
export interface ProviderDiagnostic {
  phase: 'request' | 'stream' | 'input-count';
  abortOrigin: 'none' | 'request-signal' | 'sdk-timeout';
  elapsedMs: number;
  error: TransportCause;
}
export interface ProviderObserver {
  now(): number;
  record(diagnostic: ProviderDiagnostic): void;
}
const KINDS = new Set(['Error', 'TypeError', 'AggregateError', 'AbortError', 'TimeoutError', 'APIError', 'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError', 'BadRequestError', 'AuthenticationError', 'PermissionDeniedError', 'NotFoundError', 'ConflictError', 'UnprocessableEntityError', 'RateLimitError', 'InternalServerError']);
// Exact public identifiers only: a private value shaped like E*/ERR_* must not become evidence.
// Undici identifiers are pinned to undici-types 6.21.0 errors.d.ts; Node TLS/system
// identifiers below are diagnostic only. Recognition never grants retry eligibility.
const CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETRESET', 'ENETUNREACH', 'EHOSTUNREACH',
  'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTCONN', 'EPROTO',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'UND_ERR_HEADERS_OVERFLOW', 'UND_ERR_RESPONSE_STATUS_CODE', 'UND_ERR_INVALID_ARG',
  'UND_ERR_INVALID_RETURN_VALUE', 'UND_ERR_INFO', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_BPL_MISSING_UPSTREAM',
  'UND_ERR_RES_EXCEEDED_MAX_SIZE', 'UND_ERR_REQ_RETRY', 'UND_ERR_PRX_TLS',
  'EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EHOSTDOWN', 'ENETDOWN',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
  // Node preserves the slash in OpenSSL's public 'ssl/tls alert bad record mac' reason.
  'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
function field(value: object, key: string): unknown {
  try { return Reflect.get(value, key); } catch { return undefined; }
}
function cause(value: unknown, seen: Set<object>, depth: number): TransportCause {
  if (value === null || typeof value !== 'object' || depth === 4 || seen.has(value)) return { kind: 'UnknownError' };
  seen.add(value);
  const constructor = field(value, 'constructor');
  const constructorName = typeof constructor === 'function' ? field(constructor, 'name') : undefined;
  const name = field(value, 'name');
  const kind = typeof constructorName === 'string' && KINDS.has(constructorName) ? constructorName : typeof name === 'string' && KINDS.has(name) ? name : 'UnknownError';
  const result: TransportCause = { kind, codePresent: false, codeType: 'absent', codeRecognized: false };
  let code: unknown;
  try {
    result.codePresent = Reflect.has(value, 'code');
    if (result.codePresent) {
      try { code = Reflect.get(value, 'code'); result.codeType = code === null ? 'null' : typeof code; }
      catch { result.codeType = 'unreadable'; }
    }
  } catch { result.codePresent = null; result.codeType = 'unreadable'; }
  if (typeof code === 'string' && CODES.has(code)) { result.code = code; result.codeRecognized = true; }
  const status = field(value, 'status'), requestId = field(value, 'requestID');
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
  if (typeof requestId === 'string' && /^req_[A-Za-z0-9_-]{1,128}$/.test(requestId)) result.requestId = requestId;
  const nested = field(value, 'cause'), aggregate = field(value, 'errors');
  if (nested !== undefined) result.cause = cause(nested, seen, depth + 1);
  if (Array.isArray(aggregate)) result.errors = aggregate.slice(0, 4).map(error => cause(error, seen, depth + 1));
  return result;
}
export function providerDiagnostic(error: unknown, phase: ProviderDiagnostic['phase'], signal: AbortSignal | undefined, elapsedMs: number): ProviderDiagnostic {
  const safe = cause(error, new Set(), 0);
  return { phase, abortOrigin: signal?.aborted ? 'request-signal' : safe.kind === 'APIConnectionTimeoutError' ? 'sdk-timeout' : 'none', elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0, error: safe };
}
/** Host clocks are optional diagnostic inputs, never a prerequisite for a provider call. */
export function startProviderObservation(observer: ProviderObserver | undefined): number | undefined {
  try { return observer?.now(); } catch { return undefined; }
}
/** Observability must never mask the original provider failure or change retry/charging policy. */
export function observeProviderFailure(observer: ProviderObserver | undefined, error: unknown, phase: ProviderDiagnostic['phase'], signal: AbortSignal | undefined, started: number | undefined): void {
  if (observer) {
    let elapsed = 0;
    try { if (started !== undefined) elapsed = observer.now() - started; } catch { /* Keep the failure even if the clock fails. */ }
    try { observer.record(providerDiagnostic(error, phase, signal, elapsed)); } catch { /* The original failure still reaches the caller. */ }
  }
}
