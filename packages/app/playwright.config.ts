import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env['CI'];
const PREVIEW = 'http://localhost:4173/fem-lab/';
const HEADERLESS = 'http://localhost:4180/fem-lab/';

/**
 * Chromium only (ADR 0014), three projects:
 *  - `cpu`   the built app behind `vite preview`, which sends COOP/COEP itself
 *  - `sw`    the same files behind a header-less server, so the coi-serviceworker has to earn
 *            cross-origin isolation the way GitHub Pages makes it earn it (ADR 0013)
 *  - `gpu`   SwiftShader's Vulkan adapter, allowed to fail in CI
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'npm run preview -- --port 4173 --strictPort', url: PREVIEW, reuseExistingServer: !CI, timeout: 120_000 },
    { command: 'node ../../tools/static-serve.mjs dist 4180', url: HEADERLESS, reuseExistingServer: !CI, timeout: 120_000 },
  ],
  projects: [
    { name: 'cpu', grep: /@cpu/, use: { ...devices['Desktop Chrome'], baseURL: PREVIEW } },
    { name: 'sw', grep: /@sw/, use: { ...devices['Desktop Chrome'], baseURL: HEADERLESS } },
    { name: 'thumbnails', grep: /@thumbnails/, use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1, baseURL: PREVIEW } },
    {
      name: 'gpu',
      grep: /@gpu/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: PREVIEW,
        launchOptions: {
          args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
});
