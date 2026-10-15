import type { ChatRequest, Provider, Usage } from '@femlab/ai';
import { costOf } from '../../app/src/ai/provider';

export interface EvaluationLimits {
  model: string;
  maxUsd: number;
  maxRequests: number;
  maxInputTokens: number;
}

/** One shared account for both lanes. Unknown usage retains its worst-case reservation. */
export class EvaluationBudget {
  private chargedMicros = 0;
  private requests = 0;
  private inFlightRequests = 0;
  private reason: string | null = null;
  constructor(readonly limits: EvaluationLimits, checkpoint?: ReturnType<EvaluationBudget['snapshot']>) {
    if (!Number.isFinite(limits.maxUsd) || limits.maxUsd <= 0 || !Number.isSafeInteger(limits.maxRequests) || limits.maxRequests <= 0 || !Number.isSafeInteger(limits.maxInputTokens) || limits.maxInputTokens <= 0) throw new Error('invalid evaluation budget');
    if (checkpoint) {
      if (checkpoint.model !== limits.model || checkpoint.maxUsd !== limits.maxUsd || checkpoint.maxRequests !== limits.maxRequests || checkpoint.maxInputTokens !== limits.maxInputTokens || checkpoint.stoppedReason !== null || checkpoint.inFlightRequests !== 0 || !Number.isSafeInteger(checkpoint.requests) || checkpoint.requests < 0 || checkpoint.requests > limits.maxRequests || !Number.isFinite(checkpoint.chargedOrReservedUsd) || checkpoint.chargedOrReservedUsd < 0 || checkpoint.chargedOrReservedUsd > limits.maxUsd) throw new Error('evaluation budget checkpoint is incompatible or unresolved');
      this.requests = checkpoint.requests;
      this.chargedMicros = Math.ceil(checkpoint.chargedOrReservedUsd * 1e6);
    }
  }
  interrupt(reason: string): void { this.reason ??= reason; }
  assertReady(): void {
    if (this.reason !== null) throw new Error(this.reason);
    if (this.requests >= this.limits.maxRequests) { this.reason = 'evaluation request limit reached'; throw new Error(this.reason); }
  }
  snapshot(): EvaluationLimits & { requests: number; chargedOrReservedUsd: number; stoppedReason: string | null; inFlightRequests: number } { return { ...this.limits, requests: this.requests, inFlightRequests: this.inFlightRequests, chargedOrReservedUsd: this.chargedMicros / 1e6, stoppedReason: this.reason }; }
  reserve(model: string, inputTokens: number, outputTokens: number): { finish(usage: Usage | null): void } {
    this.assertReady();
    if (model !== this.limits.model) throw new Error('evaluation model differs from the budgeted model');
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > this.limits.maxInputTokens || !Number.isSafeInteger(outputTokens) || outputTokens <= 0) throw new Error('evaluation request exceeds its token limits');
    // Cache writes are the highest Standard input rate of the selected model. Reserve
    // them for the entire authoritative count; any cache hit only lowers the final bill.
    const maximum = costOf(model, { input: inputTokens, cacheRead: 0, cacheWrite: inputTokens, output: outputTokens });
    if (maximum === null) throw new Error('evaluation model has no verified maximum tariff');
    const held = Math.ceil(maximum * 1e6);
    if (this.chargedMicros + held > Math.floor(this.limits.maxUsd * 1e6)) { this.reason = 'evaluation cost limit reached before generation'; throw new Error(this.reason); }
    this.requests++;
    this.inFlightRequests++;
    this.chargedMicros += held;
    let settled = false;
    return { finish: (usage) => {
      if (settled) throw new Error('evaluation reservation already settled');
      settled = true;
      this.inFlightRequests--;
      if (usage === null) { this.reason = 'provider usage unavailable; reserved cost retained and generation stopped'; return; }
      const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite ?? 0];
      const actual = costOf(model, usage);
      if (!counts.every(n => Number.isSafeInteger(n) && n >= 0) || (usage.cacheWrite ?? 0) > usage.input || usage.input + usage.cacheRead > inputTokens || usage.output > outputTokens || actual === null || Math.ceil(actual * 1e6) > held) {
        this.reason = 'provider usage exceeded the counted request reservation'; return;
      }
      this.chargedMicros += Math.ceil(actual * 1e6) - held;
    } };
  }
}

/** Counting and resource admission happen before the real provider can generate. */
export function boundedProvider(provider: Provider, budget: EvaluationBudget, countInput: (request: ChatRequest) => Promise<number>, resources: () => Promise<void>, changed: () => Promise<void> = async () => undefined): Provider {
  return {
    id: provider.id, models: provider.models,
    async *chat(request) {
      let reservation: ReturnType<EvaluationBudget['reserve']> | undefined;
      let usage: Usage | null = null;
      try {
        budget.assertReady();
        await resources();
        const tokens = await countInput(request);
        reservation = budget.reserve(request.model, tokens, request.maxTokens);
        await changed();
        for await (const event of provider.chat(request)) {
          if (event.type === 'usage') usage = event.usage;
          yield event;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        budget.interrupt(message);
        yield { type: 'error', message };
      } finally {
        if (reservation) { reservation.finish(usage); await changed(); }
      }
    },
  };
}

export function requireFreeDisk(availableBytes: number, minimumBytes: number): void {
  if (!Number.isFinite(availableBytes) || availableBytes < minimumBytes) throw new Error(`evaluation requires at least ${minimumBytes / 2 ** 30} GiB free disk`);
}
