import {defineConfig,mergeConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import appConfig from '../vite.config.ts';
import {realpathSync} from 'node:fs';
export default defineConfig(env=>mergeConfig(typeof appConfig==='function'?appConfig(env):appConfig,{
  plugins:[{name:'local-cloud-auth-fixture',enforce:'pre',resolveId(source:string,importer?:string){if(source==='./account/browser'&&importer?.endsWith('/src/main.tsx'))return fileURLToPath(new URL('./cloud-fixture/account.ts',import.meta.url));}}],
  server:{fs:{allow:[fileURLToPath(new URL('../../../',import.meta.url)),...['@fontsource','katex'].map(name=>realpathSync(fileURLToPath(new URL('../../../node_modules/'+name,import.meta.url))))]}},
  define:{__AI_API_ORIGIN__:JSON.stringify('/__cloud_fixture'),__HOSTED_AI__:'true',__DEV_API_KEYS__:'null'},
}));
