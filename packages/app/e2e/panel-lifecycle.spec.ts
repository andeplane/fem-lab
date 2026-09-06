import { expect, test } from './fixtures';
import { TABS } from '../src/tabs';
import type { DirHandle, FileHandle } from '../src/ai/project';

test('@cpu every panel, disclosure and tab survives two open/close cycles', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    // Only the OS folder picker is faked; the real ProjectFolder reads and renders the rules.
    const file: FileHandle = {
      kind: 'file', name: 'AGENTS.md',
      getFile: async () => ({ size: 26, lastModified: 1, text: async () => 'Check dimensions and units.' }),
      createWritable: async () => { throw new Error('read-only test folder'); },
    };
    const directory: DirHandle = {
      kind: 'directory', name: 'lifecycle',
      async *entries() { yield ['AGENTS.md', file]; },
      getFileHandle: async () => file,
      getDirectoryHandle: async () => { throw new Error('no subdirectories'); },
    };
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => directory });
  });
  await page.goto('./');
  await page.waitForFunction(() => typeof window.fem !== 'undefined');
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
  await page.evaluate(() => window.fem.dispatch({ cmd: 'file.openExample', name: 'cantilever' }));

  const topbar = page.locator('.topbar');
  const panels = [
    { button: topbar.getByRole('button', { name: '✳ Assistant', exact: true }), body: page.locator('.assistant'), close: page.getByTitle('Close the assistant', { exact: true }) },
    { button: topbar.getByRole('button', { name: 'Examples', exact: true }), body: page.getByRole('dialog', { name: 'Examples and benchmarks' }) },
    { button: topbar.getByRole('button', { name: 'Export', exact: true }), body: page.getByRole('dialog', { name: 'Export', exact: true }) },
    { button: topbar.getByTitle('Search commands (⌘K)'), body: page.getByRole('dialog', { name: 'Command palette' }) },
    { button: topbar.getByRole('button', { name: 'Tutorials', exact: true }), body: page.locator('.tutorial-panel') },
  ];
  // Report has no renderer yet (#14); the list above covers every implemented top-level panel.
  for (const panel of panels) {
    for (let cycle = 0; cycle < 2; cycle++) {
      await panel.button.click();
      await expect(panel.body).toBeVisible();
      if (panel.close) await panel.close.click();
      else await page.keyboard.press('Escape');
      await expect(panel.body).toBeHidden();
    }
  }

  // Selecting another tab unmounts the previous body; tabs have no separate close control.
  const tabs = page.getByRole('tablist', { name: 'results panel' });
  await expect(tabs.getByRole('tab')).toHaveCount(TABS.length);
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const tab of TABS) {
      await tabs.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      await expect(tabs.getByRole('tab', { selected: true })).toHaveAttribute('title', `panel.toggle ${tab}`);
      await expect(page.locator('.bottom-body')).toBeVisible();
    }
  }
  await tabs.getByRole('tab', { name: /^journal/ }).click();
  const modes = page.getByRole('group', { name: 'display mode' });
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const mode of ['geometry', 'mesh', 'results']) {
      await modes.getByRole('button', { name: mode, exact: true }).click();
      await expect(modes.getByRole('button', { name: mode, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
  }

  // Properties has no close action: replacing its form removes the previous controls.
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const command of ['geometry.addBox', 'material.add']) {
      await page.evaluate((command) => window.fem.dispatch({ cmd: 'form.open', command }), command);
      await expect(page.locator('.props .panel-sub')).toHaveText(command);
      await expect(page.locator('.props form')).toBeVisible();
    }
  }

  await panels[0]!.button.click();
  const assistant = page.locator('.assistant');
  await assistant.getByTitle('Open a folder on disk', { exact: true }).click();
  await expect(assistant.getByTitle('The project rules in force')).toBeVisible();
  for (const disclosure of [
    { button: assistant.getByTitle('Settings', { exact: true }), body: assistant.locator('.settings') },
    { button: assistant.getByTitle('Reference a Model object, a file or a Result'), body: assistant.locator('.popover') },
    { button: assistant.getByTitle('The project rules in force'), body: assistant.locator('.rules') },
  ]) {
    for (let cycle = 0; cycle < 2; cycle++) {
      await disclosure.button.click();
      await expect(disclosure.body).toBeVisible();
      await disclosure.button.click();
      await expect(disclosure.body).toBeHidden();
    }
  }
  await assistant.getByTitle('Close the assistant', { exact: true }).click();
});
