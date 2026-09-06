import { expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({ on: vi.fn(), postMessage: vi.fn() }));
vi.mock('node:worker_threads', () => ({ parentPort: port }));

it('the worker entry validates source using its generated declarations and returns diagnostics', async () => {
  await import('../src/script-validation-worker');
  expect(port.on).toHaveBeenCalledWith('message', expect.any(Function));
  const receive = port.on.mock.calls[0]![1] as (code: string) => void;
  receive('await fem.model.new({ name: "valid" });');
  expect(port.postMessage).toHaveBeenLastCalledWith({ ok: true, diagnostics: [] });
  receive('await fem.geometry.notReal({});');
  expect(port.postMessage).toHaveBeenLastCalledWith({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'TS2339', where: { line: 1, column: 20 } })]) });
});
