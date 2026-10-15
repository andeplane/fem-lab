export interface DeadlineClock { schedule(ms: number, expire: () => void): () => void }
const clock: DeadlineClock = { schedule(ms, expire) { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); } };

/** Expiry closes only the page context or stdio process this case owns. */
export async function withinCaseDeadline<T>(work: () => Promise<T>, close: () => Promise<void>, timeoutMs: number, timer: DeadlineClock = clock): Promise<T> {
  let cancel: () => void = () => undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    cancel = timer.schedule(timeoutMs, () => {
      void close().catch(() => undefined);
      reject(new Error(`evaluation case exceeded ${timeoutMs} ms and its host was closed`));
    });
  });
  try { return await Promise.race([work(), expired]); }
  finally { cancel(); }
}
