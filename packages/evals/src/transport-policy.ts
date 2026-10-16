/** Host-only experiment: close each HTTP1 connection without changing native TLS or fetch. */
export function evaluationTransport(value: string | undefined, node: string, previous?: Record<string, string | number | boolean>) {
  const mode = value ?? 'native-default';
  if (mode !== 'native-default' && mode !== 'http1-connection-close') throw new Error('invalid evaluation HTTP transport');
  if (mode === 'http1-connection-close' && !/^v22\./.test(node)) throw new Error('evaluation HTTP1 connection-close requires Node22');
  if (previous && previous['httpTransport'] !== mode) throw new Error('checkpoint HTTP transport differs; start a new evaluation');
  return { mode, ...(mode === 'http1-connection-close' ? { defaultHeaders: { Connection: 'close' } } : {}) };
}
