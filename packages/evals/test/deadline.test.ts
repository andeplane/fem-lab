import { expect, it, vi } from 'vitest';
import { withinCaseDeadline, type DeadlineClock } from '../src/deadline';

it('closes a stuck owned host on expiry and cancels its timer on successful completion', async () => {
  let fire: () => void = () => undefined;
  const cancel = vi.fn(), close = vi.fn(async () => undefined);
  const clock: DeadlineClock = { schedule: vi.fn((_ms, expire) => { fire = expire; return cancel; }) };
  const stuck = withinCaseDeadline(() => new Promise<never>(() => undefined), close, 600000, clock);
  fire();
  await expect(stuck).rejects.toThrow('host was closed');
  expect(close).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  close.mockClear(); cancel.mockClear();
  await expect(withinCaseDeadline(async () => 'actual observation', close, 600000, clock)).resolves.toBe('actual observation');
  expect(close).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
});
