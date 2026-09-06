import { test as base, expect, type Page } from '@playwright/test';

/** Every browser test fails on uncaught page errors, including errors in newly opened pages. */
export const test = base.extend<{ noPageErrors: void }>({
  noPageErrors: [async ({ context }, use) => {
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.stack ?? error.message);
    const watch = (page: Page) => page.on('pageerror', onError);
    context.on('page', watch);
    context.pages().forEach(watch);
    try {
      await use();
    } finally {
      context.off('page', watch);
      context.pages().forEach((page) => page.off('pageerror', onError));
      expect(errors, 'uncaught browser page errors').toEqual([]);
    }
  }, { auto: true }],
});

export { expect, type Page } from '@playwright/test';
