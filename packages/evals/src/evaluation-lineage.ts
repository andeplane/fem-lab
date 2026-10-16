import { createHash } from 'node:crypto';
import type { EvaluationLimits } from './budget';

/** A prior attempt is immutable evidence. Its stopped ledger is charged, never reopened. */
export function accountForPriorAttempts(original: EvaluationLimits, artifacts: readonly { bytes: Uint8Array; sha256: string }[]) {
  let micros = 0, requests = 0;
  const seen = new Set<string>();
  const receipts: { sha256: string; chargedMicros: number; requests: number }[] = [];
  for (const artifact of artifacts) {
    const actual = createHash('sha256').update(artifact.bytes).digest('hex');
    if (actual !== artifact.sha256 || seen.has(actual)) throw new Error('prior evaluation artifact hash differs or repeats');
    seen.add(actual);
    const parsed = JSON.parse(new TextDecoder().decode(artifact.bytes)) as { format?: unknown; manifest?: { model?: unknown }; controls?: { budget?: { model?: unknown; maxUsd?: unknown; maxRequests?: unknown; chargedOrReservedUsd?: unknown; requests?: unknown; inFlightRequests?: unknown } } };
    const ledger = parsed.controls?.budget;
    if (parsed.format !== 'femlab-assistant-eval/1' || parsed.manifest?.model !== original.model || !ledger || ledger.model !== original.model || ledger.inFlightRequests !== 0 || typeof ledger.chargedOrReservedUsd !== 'number' || !Number.isFinite(ledger.chargedOrReservedUsd) || ledger.chargedOrReservedUsd < 0 || typeof ledger.maxUsd !== 'number' || ledger.chargedOrReservedUsd > ledger.maxUsd || ledger.maxUsd > original.maxUsd || typeof ledger.requests !== 'number' || !Number.isSafeInteger(ledger.requests) || ledger.requests < 0 || typeof ledger.maxRequests !== 'number' || ledger.requests > ledger.maxRequests || ledger.maxRequests > original.maxRequests) throw new Error('prior evaluation ledger is incompatible or still in flight');
    // Every unknown reservation remains part of this debit. Round consumption up,
    // and the available original cap down, to integer microdollars.
    const chargedMicros = Math.ceil(ledger.chargedOrReservedUsd * 1e6);
    micros += chargedMicros; requests += ledger.requests;
    receipts.push({ sha256: actual, chargedMicros, requests: ledger.requests });
  }
  const remainingMicros = Math.floor(original.maxUsd * 1e6) - micros;
  if (!Number.isSafeInteger(micros) || remainingMicros <= 0 || requests >= original.maxRequests) throw new Error('prior attempts exhaust the original evaluation allowance');
  return { original, receipts, chargedMicros: micros, requests, limits: { ...original, maxUsd: remainingMicros / 1e6, maxRequests: original.maxRequests - requests } };
}
