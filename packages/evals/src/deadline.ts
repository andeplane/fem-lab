export interface DeadlineClock { schedule(ms: number, expire: () => void): () => void }
const clock: DeadlineClock = { schedule(ms, expire) { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); } };

/** Expiry aborts the supplier request and closes only this case's owned host. Wait for
 * both to settle before returning, so the next case cannot overlap a paid generation. */
export async function withinCaseDeadline<T>(work: (signal: AbortSignal) => Promise<T>, close: () => Promise<void>, timeoutMs: number, timer: DeadlineClock = clock): Promise<T> {
  const controller = new AbortController();
  let cancel: () => void = () => undefined;
  let closing: Promise<void> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    cancel = timer.schedule(timeoutMs, () => {
      controller.abort();
      closing = close();
      void closing.catch(() => undefined);
      reject(new Error(`evaluation case exceeded ${timeoutMs} ms and its host was closed`));
    });
  });
  const task = Promise.resolve().then(() => work(controller.signal));
  try { return await Promise.race([task, expired]); }
  finally {
    cancel();
    if (closing) await Promise.allSettled([task, closing]);
  }
}
