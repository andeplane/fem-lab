import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileDocsSite,loadReference,normalizeBase,headingSlug,isDocsInput,APP_REFERENCE_INPUTS} from './docs.mjs';
import {validateGuideExamples} from './docs-examples.mjs';

const reference={entries:[
  {name:'geometry.addBox',kind:'command',provider:'engine',execution:'modelWrite',journaled:true,tool:true,description:'Create a box with named dimensions.',schema:{type:'object',properties:{cmd:{const:'geometry.addBox'},name:{type:'string',description:'The box name.'}},required:['cmd','name']}},
  {name:'query.capabilities',kind:'query',provider:'engine',execution:'modelRead',tool:true,description:'Read engine capabilities.',schema:{type:'object',properties:{query:{const:'query.capabilities'}}}},
  {name:'query.capabilities',kind:'query',provider:'browser',execution:'modelRead',tool:true,description:'Read engine and browser capabilities.',schema:{type:'object',properties:{}}},
],defs:{Quantity:{type:'string',description:'A value with units.'}},queryResult:{type:'object',properties:{capabilities:{type:'object'}}}};
const documents=[
  {slug:'index',markdown:'# FEM Lab documentation\n\nLearn to build, solve and check a model.\n\n[First model](./getting-started.md#build-a-beam) · [API](./api-reference.md)\n'},
  {slug:'getting-started',markdown:'# Your first model\n\n[Overview](./index.md)\n\n## Build a beam\n\nUse a known length and independent reference.\n\n| Input | Value |\n| --- | --- |\n| Length | 100 mm |\n\n```ts\nconst label = "<script>not executed</script>";\n```\n\n## Build a beam\n\nA second heading receives a unique anchor.\n'},
];
const navigation=[{title:'Start',pages:['index','getting-started']},{title:'Reference',pages:['api-reference']}];
const fixture=options=>compileDocsSite({base:'/fem-lab/',documents:structuredClone(documents),reference:structuredClone(reference),navigation:structuredClone(navigation),css:'body { color: white; }',clientCode:'export {};',...options});

test('static docs preserve prose, semantic tables, code and full wrapped API definitions under both bases',()=>{
  for(const base of ['/','/fem-lab/']){
    const site=fixture({base}),page=site.files.get('docs/getting-started/index.html'),api=site.files.get('docs/api-reference/index.html');
    assert.equal(site.pages.size,3);assert.equal(site.referenceCount,3);
    assert.match(page,/<h1 id="your-first-model">Your first model/);
    assert.match(page,/<table>/);assert.match(page,/&lt;script&gt;not executed&lt;\/script&gt;/);
    assert.match(page,/id="build-a-beam-1"/);assert.ok(page.includes(`href="${base}docs/"`));
    assert.ok(site.files.get('docs/index.html').includes(`href="${base}docs/getting-started/#build-a-beam"`));
    assert.equal([...api.matchAll(/data-api-entry=/g)].length,3);
    assert.match(api,/query-engine-querycapabilities/);assert.match(api,/query-browser-querycapabilities/);
    assert.match(api,/id="query-responses"/);assert.match(api,/The box name/);
    assert.ok(site.searchEntries.some(entry=>entry.title==='Quantity'));
    for(const html of [...site.files.values()].filter(value=>value.startsWith('<!doctype'))){
      assert.doesNotMatch(html,/modulepreload|session\.worker|firebase|wasm_bg|src="[^"\n]*\/index-/);
      assert.match(html,/script-src 'self'/);assert.doesNotMatch(html,/<script(?![^>]*src=)/);
    }
    for(const file of site.files.keys())assert.ok(!file.startsWith('/')&&!file.includes('..'));
  }
});
test('generated navigation exposes active page, semantic landmarks, edit source and previous/next routes',()=>{
  const page=fixture().files.get('docs/getting-started/index.html');
  assert.match(page,/aria-current="page">Your first model/);assert.match(page,/aria-label="On this page"/);
  assert.match(page,/aria-label="Previous and next pages"/);assert.match(page,/edit\/main\/docs\/guide\/getting-started.md/);
  assert.match(page,/class="docs-skip" href="#main-content"/);assert.match(page,/id="docs-search"/);
});
test('link and content graph checks reject broken pages, headings and content islands',()=>{
  assert.throws(()=>fixture({documents:[...documents,{slug:'lost',markdown:'# Lost\nInvisible page.'}],navigation:[...navigation,{title:'Lost',pages:['lost']}]}),/unreachable.*lost/);
  assert.throws(()=>fixture({documents:[{...documents[0],markdown:documents[0].markdown+'\n[Missing](./not-here.md)\n'},documents[1]]}),/missing documentation page/);
  assert.throws(()=>fixture({documents:[{...documents[0],markdown:documents[0].markdown.replace('#build-a-beam','#not-a-heading')},documents[1]]}),/missing heading/);
  assert.throws(()=>fixture({documents:[{...documents[0],markdown:documents[0].markdown+'\n[Missing](/fem-lab/docs/getting-started/#nope)\n'},documents[1]]}),/missing docs heading/);
  assert.throws(()=>fixture({navigation:[...navigation,{title:'Duplicate',pages:['index']}]}),/duplicate/);
  assert.throws(()=>fixture({navigation:[{title:'Incomplete',pages:['index','api-reference']}]}),/exactly once/);
});
test('unsafe URLs, malformed page titles and base-bypassing links fail before publication',()=>{
  for(const href of ['javascript:alert(1)','data:text/html,test','//external.example/test']){
    assert.throws(()=>fixture({documents:[{...documents[0],markdown:documents[0].markdown+`\n[Unsafe](${href})\n`},documents[1]]}),/unsafe link/);
  }
  assert.throws(()=>fixture({documents:[documents[0],{...documents[1],markdown:documents[1].markdown+'\n# Second title\n'}]}),/exactly one/);
  assert.throws(()=>fixture({documents:[{...documents[0],markdown:documents[0].markdown+'\n[Bypass](/docs/getting-started/)\n'},documents[1]]}),/bypasses configured base/);
  for(const base of ['fem-lab','/fem-lab','//','/../'])assert.throws(()=>normalizeBase(base),/absolute directory/);
  assert.equal(headingSlug('Build a `beam`!'),'build-a-beam');
});
test('API inventory is exhaustive for current engine, shared browser, app and startup registrations',async()=>{
  const inventory=await loadReference(),schema=JSON.parse(await readFile(new URL('../packages/registry/src/generated/engine.schema.json',import.meta.url),'utf8'));
  assert.equal(inventory.entries.filter(entry=>entry.provider==='engine'&&entry.kind==='command').length,schema.commands.oneOf.length);
  assert.equal(inventory.entries.filter(entry=>entry.provider==='engine'&&entry.kind==='query').length,schema.queries.oneOf.length);
  for(const name of ['form.open','form.edit','form.pick','palette.resolve','view.setMode','chat.setDraft','file.openExample','file.compare','example.filter','query.journalComparison','query.workspaceStatus','workspace.retryStartup','workspace.cancelStartup','tour.show','tour.dismiss','tour.startCantilever'])assert.ok(inventory.entries.some(entry=>entry.name===name),name);
  const tour=inventory.entries.find(entry=>entry.name==='tour.show');
  assert.equal(tour.sourceFile,'packages/app/src/tutorial/tour-state.ts');
  assert.equal(tour.schema.properties.step.maximum,7);
  assert.equal(tour.journaled,false);
  const site=fixture({reference:inventory}),api=site.files.get('docs/api-reference/index.html');
  assert.equal([...api.matchAll(/data-api-entry=/g)].length,inventory.entries.length);
  assert.ok(!site.files.get('docs/index.html').includes('data-api-entry='));
});
test('authored TypeScript examples use actual browser API types without executing code',async()=>{
  assert.equal(await validateGuideExamples([{slug:'safe',markdown:'```ts\nthrow new Error("must never execute");\n```\n\n```typescript\nawait fem.query.model();\n```'}]),2);
  await assert.rejects(validateGuideExamples([{slug:'broken',markdown:'```ts\nawait fem.query.thisMethodDoesNotExist();\n```'}]),/broken.md TypeScript example 1:1:.*TS2339/);
  await assert.rejects(validateGuideExamples([{slug:'nested',markdown:'> ```ts\n> const invalid: number = "wrong";\n> ```'}]),/nested.md TypeScript example.*TS2322/);
});

test('dev invalidates every app metadata source and guide additions without watching generated validator outputs',()=>{
 const root=new URL('../',import.meta.url).pathname;
 for(const filename of [...APP_REFERENCE_INPUTS,'docs/guide/new-topic.md','packages/registry/src/generated/engine.schema.json','packages/app/src/docs/client.ts'])assert.equal(isDocsInput(root+filename),true,filename);
 for(const filename of ['packages/registry/src/generated/script-declarations-browser.json','packages/registry/src/generated/script-declarations-mcp.json.123.tmp','packages/app/dist/index.html'])assert.equal(isDocsInput(root+filename),false,filename);
});
