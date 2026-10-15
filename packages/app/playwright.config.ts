import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env['CI'];
// Ports come from PW_PORT so every worktree can run its own servers: with many checkouts on one
// machine, a shared 4173 plus reuseExistingServer means a green run may have tested another
// branch's build. The header-less server takes the port seven above.
const PORT = Number(process.env['PW_PORT'] ?? 4173);
const PREVIEW = `http://localhost:${PORT}/fem-lab/`;
const HEADERLESS = `http://localhost:${PORT + 7}/fem-lab/`;

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
    { command: `npm run preview -- --port ${PORT} --strictPort`, url: PREVIEW, reuseExistingServer: !CI, timeout: 120_000 },
    { command: `node ../../tools/static-serve.mjs dist ${PORT + 7}`, url: HEADERLESS, reuseExistingServer: !CI, timeout: 120_000 },
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
          // Select Dawn's WebGPU adapter explicitly; ANGLE/Vulkan flags alone select
          // the renderer and can leave WebGPU on the hardware adapter.
          args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
});
