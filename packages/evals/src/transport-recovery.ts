import { providerDiagnostic, type ChatEvent, type ChatRequest, type Provider, type ProviderDiagnostic, type ProviderObserver, type TransportCause, type Usage } from '@femlab/ai';
import { EvaluationBudget } from './budget';

export interface AttemptReceipt {
  request: number;
  attempt: number;
  outcome: 'completed' | 'retry' | 'stopped';
  diagnostics: ProviderDiagnostic[];
  discardedEvents: number;
  unknownUsageRetained: boolean;
  reason?: string;
}
export interface RecoveryOptions {
  /** Exactly one retry is benchmark policy, never an implicit SDK retry. */
  maxTransportRetries: 1;
  now(): number;
  record(receipt: AttemptReceipt): void;
}
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
function networkCause(error: TransportCause): boolean {
  const nodes: TransportCause[] = [error];
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i]!;
    const unrecognizedCode = current.codePresent === null || current.codeType === 'unreadable' || (current.codeRecognized === false && current.codeType !== undefined && current.codeType !== 'absent' && current.codeType !== 'undefined');
    if (unrecognizedCode || (current.code !== undefined && TLS_CODES.has(current.code)) || current.status !== undefined || ['APIUserAbortError', 'AbortError', 'TimeoutError', 'APIConnectionTimeoutError'].includes(current.kind)) return false;
    if (current.cause) nodes.push(current.cause);
    if (current.errors) nodes.push(...current.errors);
  }
  return nodes.some(node => node.code !== undefined && NETWORK_CODES.has(node.code));
}
export function retryableTransport(diagnostics: readonly ProviderDiagnostic[]): boolean {
  return diagnostics.length > 0 && diagnostics.every(d => d.abortOrigin === 'none' && networkCause(d.error));
}

/** Count and generation share one retry; events stay buffered until completion and billing settle. */
export function recoverableProvider(factory: (observer: ProviderObserver) => Provider, identity: Pick<Provider, 'id' | 'models'>, budget: EvaluationBudget, countInput: (request: ChatRequest) => Promise<number>, resources: () => Promise<void>, changed: () => Promise<void>, options: RecoveryOptions): Provider {
  if (options.maxTransportRetries !== 1) throw new Error('evaluation permits exactly one explicit transport retry');
  return { ...identity, async *chat(request) {
    for (let attempt = 0; attempt <= options.maxTransportRetries; attempt++) {
      const diagnostics: ProviderDiagnostic[] = [];
      const observer: ProviderObserver = { now: options.now, record: d => { diagnostics.push(d); } };
      const events: ChatEvent[] = [];
      let reservation: ReturnType<EvaluationBudget['reserve']> | undefined;
      let usage: Usage | null = null;
      let usageCount = 0, doneCount = 0, errorCount = 0, failure: string | undefined, protocolFailure = false;
      const abort = () => { if (request.signal?.aborted) throw new Error('evaluation request aborted'); };
      try {
        abort(); budget.assertReady(); await resources(); abort();
        const started = options.now();
        let tokens: number;
        try { tokens = await countInput(request); }
        catch (error) {
          diagnostics.push(providerDiagnostic(error, 'input-count', request.signal, options.now() - started));
          if (attempt < options.maxTransportRetries && retryableTransport(diagnostics)) {
            // Authoritative counting precedes reservation. Its retry consumes this same loop's allowance.
            options.record({ request: budget.snapshot().requests, attempt, outcome: 'retry', diagnostics, discardedEvents: 0, unknownUsageRetained: false, reason: error instanceof Error ? error.message : String(error) });
            await changed();
            continue;
          }
          throw error;
        }
        abort();
        reservation = budget.reserve(request.model, tokens, request.maxTokens);
        await changed(); abort();
        try {
          for await (const event of factory(observer).chat(request)) {
            if ((doneCount > 0 || failure !== undefined) && event.type !== 'error') protocolFailure = true;
            if (event.type === 'error') { errorCount++; failure ??= event.message; }
            if (event.type === 'usage') { usageCount++; usage = event.usage; if (failure !== undefined) protocolFailure = true; }
            if (event.type === 'done') doneCount++;
            events.push(event);
          }
        } catch (error) {
          diagnostics.push(providerDiagnostic(error, 'stream', request.signal, options.now() - started));
          failure ??= error instanceof Error ? error.message : String(error);
        }
        abort();
        protocolFailure ||= usageCount > 1 || doneCount > 1 || errorCount > 1;
        if (failure === undefined && (doneCount !== 1 || usageCount !== 1)) { failure = 'provider attempt lacks one completion and usage receipt'; protocolFailure = true; }
        if (protocolFailure) failure = 'provider attempt violated completion/usage protocol';
        const retry = failure !== undefined && !protocolFailure && attempt < options.maxTransportRetries && retryableTransport(diagnostics);
        reservation.finish(protocolFailure ? null : usage, retry ? 'retain-for-transport-retry' : undefined);
        reservation = undefined;
        // Invalid usage must never release events or admit a retry.
        if (budget.snapshot().stoppedReason !== null) failure ??= budget.snapshot().stoppedReason!;
        const mayRetry = retry && budget.snapshot().stoppedReason === null;
        options.record({ request: budget.snapshot().requests, attempt, outcome: mayRetry ? 'retry' : failure !== undefined ? 'stopped' : 'completed', diagnostics, discardedEvents: failure !== undefined ? events.length : 0, unknownUsageRetained: usage === null || protocolFailure, ...(failure !== undefined ? { reason: failure } : {}) });
        await changed();
        if (mayRetry) continue;
        if (failure !== undefined) { budget.interrupt(failure); await changed(); yield { type: 'error', message: failure }; return; }
        abort();
        for (const event of events) yield event;
        return;
      } catch (error) {
        const heldRetained = reservation !== undefined;
        if (reservation) { reservation.finish(null); reservation = undefined; }
        const reason = error instanceof Error ? error.message : String(error);
        budget.interrupt(reason);
        options.record({ request: budget.snapshot().requests, attempt, outcome: 'stopped', diagnostics, discardedEvents: events.length, unknownUsageRetained: heldRetained, reason });
        await changed();
        yield { type: 'error', message: reason }; return;
      }
    }
  } };
}
