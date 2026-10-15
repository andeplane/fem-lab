import {defineConfig,devices} from '@playwright/test';
// Explicit operator invocation only: two disposable staging fixtures, zero signup credits,
// paused AI admission, no supplier generation, and durable cleanup. Never retry used links.
export default defineConfig({testDir:'./e2e',testMatch:'hosted-live.spec.ts',fullyParallel:false,workers:1,retries:0,timeout:300000,reporter:'list',use:{...devices['Desktop Chrome'],baseURL:process.env['FEMLAB_LIVE_ORIGIN'],screenshot:'only-on-failure',trace:'off',video:'off'}});
