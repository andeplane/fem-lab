import { expect, it, vi, afterEach } from 'vitest';
import { PythonHost } from '../src/python-host';
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: any[] = [];
  terminate = vi.fn();
  postMessage(value: unknown, transfers?: unknown[]) { this.sent.push({value, transfers}); }
  emit(data: unknown) { return this.onmessage?.({data} as MessageEvent); }
}
afterEach(() => vi.useRealTimers());
it('bounds initialization/execution, transfers scientific f64 and discards late RPC completion', async () => {
  const worker = new FakeWorker();
  let release!: (value: unknown) => void;
  const slow = new Promise(resolve => {release=resolve;});
  const query = vi.fn(async (payload: Record<string, unknown>) => payload.query === 'query.field' ? {values:[1.00000000001,-0],unit:'m'} : slow);
  const host = new PythonHost(() => worker as unknown as Worker, vi.fn(), query);
  const run = host.run('print(1)');
  await worker.emit({kind:'ready'});
  await worker.emit({kind:'rpc',id:1,op:'query',payload:{query:'query.field'}});
  const reply = worker.sent.at(-1);
  expect(reply.value.value.values).toBeInstanceOf(Float64Array);
  expect(reply.value.value.values[0]).toBe(1.00000000001);
  expect(Object.is(reply.value.value.values[1],-0)).toBe(true);
  expect(reply.transfers).toEqual([reply.value.value.values.buffer]);
  await worker.emit({kind:'rpc',id:2,op:'dispatch',payload:{cmd:'billing.checkout'}});
  expect(worker.sent.at(-1).value.error).toContain('engine Commands');
  await worker.emit({kind:'rpc',id:4,op:'dispatch',payload:{cmd:'chat.send',text:'start spending'}});
  expect(worker.sent.at(-1).value.error).toContain('engine Commands');
  const pending=worker.emit({kind:'rpc',id:3,op:'query',payload:{query:'query.model'}});
  host.stop(); const count=worker.sent.length; release({name:'old'}); await pending;
  expect(worker.sent).toHaveLength(count);
  expect(await run).toMatchObject({error:'stopped'});
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it('retains output/errors, stops infinite cells and rejects bad input/messages', async () => {
  vi.useFakeTimers(); const worker=new FakeWorker();
  const host=new PythonHost(()=>worker as unknown as Worker,vi.fn(),vi.fn());
  expect(await host.run('x',0)).toHaveProperty('error');
  const run=host.run('x',10);
  expect(()=>host.run('other')).toThrow('already running');
  await worker.emit({kind:'ready'}); await worker.emit({kind:'log',value:'hello'}); await worker.emit({kind:'plot',value:'png'});
  vi.advanceTimersByTime(11); expect(await run).toMatchObject({console:['hello'],plots:['png'],error:expect.stringContaining('10 ms')});
  const startup=host.run('x'); vi.advanceTimersByTime(120001); expect(await startup).toHaveProperty('error');
  const bad=host.run('x'); await worker.emit({kind:'rpc',id:1,op:'erase',payload:{}}); expect(await bad).toMatchObject({error:'invalid Python registry call'});
  const done=host.run('x'); await worker.emit({kind:'done'}); expect(await done).not.toHaveProperty('error');
  const failed=host.run('x'); await worker.emit({kind:'failed',value:'bad python'}); expect(await failed).toMatchObject({error:'bad python'});
});
