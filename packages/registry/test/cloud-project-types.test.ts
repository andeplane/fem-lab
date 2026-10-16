import {expect,it} from 'vitest';
import {PROJECT_CHUNK_BYTES,PROJECT_MAX_CHUNKS,PROJECT_STORAGE_QUOTAS} from '../src/index';
it('publishes decimal storage entitlements and bounded binary chunks independently of AI credits',()=>{
  expect(PROJECT_STORAGE_QUOTAS).toEqual({free:100000000,plus:2000000000,pro:10000000000,studio:50000000000});
  expect(PROJECT_CHUNK_BYTES).toBe(8000000);expect(PROJECT_MAX_CHUNKS).toBe(8192);
});
