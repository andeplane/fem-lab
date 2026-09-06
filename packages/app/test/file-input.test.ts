import { afterEach, expect, it, vi } from 'vitest';
import { MAX_MODEL_FILE_BYTES } from '@femlab/registry';
import { fakeTransport } from '../../registry/test/fakes';
import { readHostCaps } from '../src/capabilities';
import { makeHostContext } from '../src/host';
import { Store } from '../src/store';

afterEach(() => vi.restoreAllMocks());

it('rejects an oversized picker file before reading its contents', async () => {
  const context = makeHostContext(new Store(), fakeTransport(), { current: null }, readHostCaps({}));
  const text = vi.fn(async () => 'unread');
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    Object.defineProperty(this, 'files', { value: [{ size: MAX_MODEL_FILE_BYTES + 1, text }] });
    this.dispatchEvent(new Event('change'));
  });
  await expect(context.files.pick()).rejects.toMatchObject({ code: 'schema', where: 'picker' });
  expect(text).not.toHaveBeenCalled();
});

it('reads a picker file within the byte limit', async () => {
  const context = makeHostContext(new Store(), fakeTransport(), { current: null }, readHostCaps({}));
  const text = vi.fn(async () => '{}');
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    Object.defineProperty(this, 'files', { value: [{ size: 2, text }] });
    this.dispatchEvent(new Event('change'));
  });
  await expect(context.files.pick()).resolves.toBe('{}');
  expect(text).toHaveBeenCalledOnce();
});
