import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {rm} from 'node:fs/promises';
import {build} from 'esbuild';
import {beforeAll,afterAll,it,expect} from 'vitest';

const run=promisify(execFile),cliFile=fileURLToPath(new URL('../dist/operator-configuration-'+randomUUID()+'.mjs',import.meta.url));
beforeAll(async()=>{await build({entryPoints:[fileURLToPath(new URL('../tools/manage-operator.ts',import.meta.url))],outfile:cliFile,bundle:true,platform:'node',format:'esm',target:'node22',external:['pg','firebase-admin/*']});});
afterAll(async()=>{await rm(cliFile,{force:true});});
it('actual operator child rejects inherited emulator routing before Auth or database work',async()=>{
 const operationId=randomUUID(),actorRef='a'.repeat(64);
 const env={...process.env,FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:1',FIREBASE_PROJECT_ID:'femlab-app-staging',FEMLAB_OPERATOR_ACCESS_TOKEN:'private-never-used-token',FEMLAB_OPERATOR_ACTOR_REF:actorRef,PGHOST:'127.0.0.1',PGPORT:'1'};
 const failure=await run(process.execPath,[cliFile,'suspend',randomUUID(),operationId,'case-556'],{env,timeout:2000}).then(()=>null,error=>error);
 expect(failure).toMatchObject({code:1});
 expect(JSON.parse(failure.stdout)).toMatchObject({action:'suspend',operationId,actorRef,code:'operator-emulator-forbidden',where:'operator.configuration'});
 expect(failure.stdout).not.toContain('private-never-used-token');expect(failure.stdout).not.toContain('127.0.0.1:1');expect(failure.stderr).toBe('');
});
