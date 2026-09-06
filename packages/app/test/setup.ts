// Runs before every test file (vitest.config.ts `setupFiles`).
//
// Tests that mount the whole App render its viewer pane, which lazily imports three.js and tries
// to open a WebGL2 context. happy-dom has none, and three.js says so on the console after the
// test file has already finished; vitest then fails the run for a console line it could not
// deliver ("Closing rpc while onUserConsoleLog was pending"). A Viewer that refuses up front
// keeps the pane on its no-WebGL2 message and three.js out of the unit tests entirely. The
// real viewer is exercised by the Playwright suites, in a browser with a GPU.
import { vi } from 'vitest';

vi.mock('../src/viewer/viewer', () => ({
  Viewer: class {
    constructor() {
      throw new Error('no WebGL2 in unit tests');
    }
  },
}));

// The two other lazy chunks the App shell mounts: the Assistant drawer and the tutorial runner.
// Both start work when they arrive (a Journal watch, a provider probe) that outlives a unit test
// mounting the shell, so they are stood in for by empty components here. Their own tests import
// their modules directly, not through these index files, and are unaffected.
vi.mock('../src/ai', () => ({
  AssistantPanel: () => null,
  chatBridge: { send: () => undefined, insertMention: () => undefined, setDraft: () => undefined, clear: () => undefined },
}));
vi.mock('../src/tutorial', () => ({
  TutorialPanel: () => null,
  Tour: () => null,
}));
