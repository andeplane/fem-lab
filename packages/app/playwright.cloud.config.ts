import {defineConfig,devices} from '@playwright/test';
const port=Number(process.env['PW_PORT']??17775);
export default defineConfig({testDir:'./e2e',testMatch:'cloud-project-sync.spec.ts',workers:1,fullyParallel:false,retries:0,timeout:120000,use:{...devices['Desktop Chrome'],baseURL:`http://localhost:${port}/fem-lab/`,trace:'retain-on-failure'},webServer:{command:`npm run dev -- --config e2e/cloud-sync.vite.ts --port ${port} --strictPort`,url:`http://localhost:${port}/fem-lab/`,reuseExistingServer:false,timeout:120000}});
