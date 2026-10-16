import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire,Module} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'packages/app/package.json'));
const {Marked}=require('marked');
const {build}=require('esbuild');
let compilerPromise,declarationsPromise;
const checks=new Map();

export function resetGuideExampleCache(){declarationsPromise=undefined;compilerPromise=undefined;checks.clear();}

async function compiler(){
  return compilerPromise??=(async()=>{
    const result=await build({entryPoints:[path.join(root,'packages/registry/src/script-validation.ts')],bundle:true,platform:'node',format:'cjs',external:['typescript'],write:false});
    // Load trusted, locally bundled validator source in memory. Authored examples are only
    // passed to its virtual TypeScript compiler; they are never evaluated or sent to an engine.
    const filename=path.join(root,'tools/.docs-script-validator.cjs');
    const module=new Module(filename);module.filename=filename;module.paths=Module._nodeModulePaths(root);
    module._compile(result.outputFiles[0].text,filename);
    return module.exports.validateScript;
  })();
}
async function declarations(){
  return declarationsPromise??=(async()=>{
    // Standalone docs checks must use fresh schemas, just like app prebuild/typecheck.
    await promisify(execFile)(process.execPath,[path.join(root,'tools/build-script-declarations.mjs')],{cwd:root});
    return JSON.parse(await readFile(path.join(root,'packages/registry/src/generated/script-declarations-browser.json'),'utf8'));
  })();
}

/** Validate every authored TypeScript fence with the real browser Script validator. */
export async function validateGuideExamples(documents){
  const key=JSON.stringify(documents.map(({slug,markdown})=>[slug,markdown]));
  if(!checks.has(key))checks.set(key,(async()=>{
    const [validateScript,files]=await Promise.all([compiler(),declarations()]);
    const markdown=new Marked();let count=0;const failures=[];
    for(const document of documents){let index=0;
      markdown.walkTokens(markdown.lexer(document.markdown),token=>{
        if(token.type!=='code'||!['ts','typescript'].includes(token.lang?.split(/\s/)[0]))return;
        index++;count++;const result=validateScript(token.text,files);
        if(!result.ok)for(const diagnostic of result.diagnostics)failures.push(`${document.slug}.md TypeScript example ${index}${diagnostic.where?`:${diagnostic.where.line}:${diagnostic.where.column}`:''}: ${diagnostic.code} ${diagnostic.cause}`);
      });
    }
    if(failures.length)throw new Error(`Documentation examples failed static validation:\n${failures.join('\n')}`);
    return count;
  })());
  return checks.get(key);
}
