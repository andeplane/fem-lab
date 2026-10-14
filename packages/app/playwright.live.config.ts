import {defineConfig,devices} from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:'hosted-live.spec.ts',workers:1,retries:0,timeout:180000,reporter:'list',use:{...devices['Desktop Chrome'],baseURL:process.env['FEMLAB_LIVE_ORIGIN'],screenshot:'only-on-failure',trace:'off'}});
