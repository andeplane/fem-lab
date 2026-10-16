#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,mkdir,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {appReferenceSource} from './docs-app-reference.mjs';
import {validateGuideExamples,resetGuideExampleCache} from './docs-examples.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(ROOT,'packages/app/package.json'));
const {Marked,Renderer}=require('marked');
const {build}=require('esbuild');
export const NAVIGATION=[
  {title:'Start here',pages:['index','getting-started','concepts','workspace','examples-tutorials']},
  {title:'Build a model',pages:['geometry','meshing','materials-sections','sets-constraints-loads','units']},
  {title:'Solve and understand',pages:['steps-solvers','physics','results-verification']},
  {title:'Save and automate',pages:['projects-storage','import-export','scripting-journal','cli-mcp']},
  {title:'AI and your account',pages:['assistant','accounts-billing']},
  {title:'Reference and help',pages:['api-reference','browser-troubleshooting','architecture-extensions']},
];
const html=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const plain=value=>String(value).replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,'').replace(/[`*_]/g,'').trim();
export const headingSlug=value=>plain(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s+/g,'-');
export function normalizeBase(base){if(typeof base!=='string'||!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base))throw new Error('Docs base must be an absolute directory path ending in /.');return base;}
const route=(base,slug)=>`${base}docs/${slug==='index'?'':`${slug}/`}`;
const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,12);
let referencePromise;
export const APP_REFERENCE_INPUTS=['packages/app/src/host.ts','packages/app/src/startup.ts','packages/app/src/main.tsx','packages/app/src/ui/schema.ts','packages/app/src/tutorial/tour-state.ts'];
export function isDocsInput(filename){
  const relative=path.relative(ROOT,filename).split(path.sep).join('/');
  if(/^packages\/registry\/src\/generated\/script-declarations-(browser|mcp)\.json(?:\..*\.tmp)?$/.test(relative))return false;
  return APP_REFERENCE_INPUTS.includes(relative)||relative.startsWith('docs/guide/')||relative==='packages/app/docs/theme.css'||relative.startsWith('packages/app/src/docs/')||relative.startsWith('packages/registry/src/');
}

/** Load both original registries, including engine definitions wrapped by a browser Query. */
export async function loadReference(){
  if(!referencePromise)referencePromise=(async()=>{
    const appSource=await appReferenceSource();
    const result=await build({stdin:{contents:`
      import {Registry,HOST_COMMANDS,HOST_QUERIES} from './packages/registry/src/index.ts';
      import {z} from 'zod';
      import schema from './packages/registry/src/generated/engine.schema.json';
      const engine=new Registry({schema,host:{},hostCommands:[],hostQueries:[]});
      const browser=new Registry({schema:{commands:{oneOf:[]},queries:{oneOf:[]}},host:{},hostCommands:HOST_COMMANDS,hostQueries:HOST_QUERIES});
      if(engine.list().commands.length!==schema.commands.oneOf.length||engine.list().queries.length!==schema.queries.oneOf.length||browser.list().commands.length!==HOST_COMMANDS.length||browser.list().queries.length!==HOST_QUERIES.length)throw new Error('Duplicate authoritative API names cannot be silently collapsed in documentation.');
      const rows=(registry,provider)=>{const list=registry.list();return ['commands','queries'].flatMap(kind=>list[kind].map(({name,description,schema,execution,journaled,tool})=>({name,description,schema,execution,journaled,tool,kind:kind==='commands'?'command':'query',provider})));};
      ${appSource}
      export default {entries:[...rows(engine,'engine'),...rows(browser,'browser'),...appEntries],defs:engine.defs,queryResult:schema.queryResult,schemaVersion:schema.schemaVersion};
    `,resolveDir:ROOT,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
    return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default;
  })();
  return referencePromise;
}

function schemaType(schema){
  if(!schema||typeof schema!=='object')return 'any';
  if(schema.$ref)return schema.$ref.split('/').at(-1);
  if(Object.hasOwn(schema,'const'))return JSON.stringify(schema.const);
  if(schema.enum)return schema.enum.map(v=>JSON.stringify(v)).join(' | ');
  if(schema.anyOf||schema.oneOf)return (schema.anyOf??schema.oneOf).map(schemaType).join(' | ');
  if(schema.type==='array')return schema.prefixItems?`[${schema.prefixItems.map(schemaType).join(', ')}]`:`${schemaType(schema.items)}[]`;
  if(Array.isArray(schema.type))return schema.type.join(' | ');
  return schema.type??'object';
}
function parameterRows(schema){return Object.entries(schema.properties??{}).map(([name,spec])=>`<tr><th scope="row"><code>${html(name)}</code>${(schema.required??[]).includes(name)?'<span class="required">required</span>':'<span class="optional">optional</span>'}</th><td><code>${html(schemaType(spec))}</code></td><td>${html(spec.description??'See the exact schema below.')}${spec.minimum!==undefined?` Minimum: ${html(spec.minimum)}.`:''}${spec.maximum!==undefined?` Maximum: ${html(spec.maximum)}.`:''}</td></tr>`).join('');}
const schemaBlock=(schema,label='Exact JSON schema')=>`<details class="api-schema"><summary>${html(label)}</summary><div class="docs-code"><div class="docs-code-toolbar"><span>JSON</span><button class="docs-copy" type="button">Copy code</button></div><pre><code>${html(JSON.stringify(schema,null,2))}</code></pre></div></details>`;
function referencePage(reference){
  const groups=new Map();
  for(const entry of reference.entries){const namespace=entry.name.split('.')[0];if(!groups.has(namespace))groups.set(namespace,[]);groups.get(namespace).push(entry);}
  const headings=[{depth:1,id:'api-reference',text:'API reference'}],ids=new Set(['api-reference']);
  const kinds=kind=>reference.entries.filter(e=>e.kind===kind).length;
  let body=`<h1 id="api-reference">API reference</h1><p class="docs-lead">The complete registered engine and browser API. Every entry below comes from the same schemas that validate Commands and Queries.</p><div class="api-stats"><span><strong>${kinds('command')}</strong> command definitions</span><span><strong>${kinds('query')}</strong> query definitions</span><span><strong>${Object.keys(reference.defs).length}</strong> shared types</span></div><p>Use <code>await fem.namespace.method(args)</code> in a Script. Commands change the Model or its host; Queries read it. Browser definitions can wrap an engine Query, so both original forms appear. Availability, required fields and exact schemas are shown without hiding planned capabilities or actions that need a person.</p><div class="api-index">${[...groups.keys()].sort().map(name=>`<a href="#namespace-${html(name)}">${html(name)}</a>`).join('')}</div>`;
  for(const namespace of [...groups.keys()].sort()){
    const id=`namespace-${namespace}`;headings.push({depth:2,id,text:namespace});ids.add(id);body+=`<section><h2 id="${html(id)}">${html(namespace)}</h2>`;
    for(const entry of groups.get(namespace).sort((a,b)=>a.name.localeCompare(b.name)||a.provider.localeCompare(b.provider))){
      const entryId=`${entry.kind}-${entry.provider}-${headingSlug(entry.name)}`;ids.add(entryId);
      const status=entry.schema['x-status']==='stub'?'Planned capability':!entry.tool?'Person-controlled action':'Registered capability';
      body+=`<section class="api-entry" data-api-entry="${html(`${entry.kind}:${entry.provider}:${entry.name}`)}"><h3 id="${entryId}"><a class="heading-anchor" href="#${entryId}" aria-label="Link to ${html(entry.name)}">#</a><code>${html(entry.name)}</code></h3><div class="api-meta"><span>${entry.provider==='engine'?'Engine':entry.provider==='startup'?'Startup host only':'Browser host'}</span><span>${entry.kind==='command'?'Command':'Query'}</span><span>${html(status)}</span>${entry.kind==='command'?`<span>${entry.journaled?'Recorded in Journal':'Not journaled'}</span>`:''}<span>Execution: ${html(entry.execution)}</span></div><p>${html(entry.description).replaceAll('\n','<br>')}</p>${entry.schema['x-returns']?`<p>Returns: <code>${html(entry.schema['x-returns'])}</code> (see Query response schema below).</p>`:''}<div class="docs-table"><table class="params"><caption>Parameters for ${html(entry.name)}</caption><thead><tr><th>Parameter</th><th>Type</th><th>Description</th></tr></thead><tbody>${parameterRows(entry.schema)||'<tr><td colspan="3">No parameters.</td></tr>'}</tbody></table></div>${schemaBlock(entry.schema)}<p class="api-source"><a href="https://github.com/andeplane/fem-lab/blob/main/${entry.sourceFile??(entry.provider==='engine'?'packages/registry/src/generated/engine.schema.json':'packages/registry/src/host-commands.ts')}">View authoritative definition ↗</a></p></section>`;
    }
    body+='</section>';
  }
  ids.add('shared-types');headings.push({depth:2,id:'shared-types',text:'Shared schema types'});body+='<section><h2 id="shared-types">Shared schema types</h2><p>Schema references such as <code>#/$defs/Quantity</code> use these definitions. Units, unions, admissible values and nested argument shapes are included exactly.</p>';
  for(const [name,schema] of Object.entries(reference.defs).sort(([a],[b])=>a.localeCompare(b))){const id=`type-${headingSlug(name)}`;ids.add(id);body+=`<section class="api-type"><h3 id="${html(id)}"><code>${html(name)}</code></h3>${schemaBlock(schema)}</section>`;}
  if(reference.queryResult){ids.add('query-responses');headings.push({depth:2,id:'query-responses',text:'Query response schema'});body+=`<section><h2 id="query-responses">Query response schema</h2><p>The complete engine response union and its local shared definitions. Browser Query descriptions document their additional host-owned responses.</p>${schemaBlock(reference.queryResult,'Complete QueryResult JSON schema')}</section>`;}
  return {slug:'api-reference',title:'API reference',description:'Complete engine and browser Commands, Queries, parameters and schema types.',body,headings,ids,links:[],markdown:null,search:[...reference.entries.map(entry=>({title:entry.name,url:`#${entry.kind}-${entry.provider}-${headingSlug(entry.name)}`,section:`API reference · ${entry.provider} ${entry.kind}`,content:`${entry.description} ${Object.keys(entry.schema.properties??{}).join(' ')}`})),...Object.entries(reference.defs).map(([name,schema])=>({title:name,url:`#type-${headingSlug(name)}`,section:'API reference · Shared type',content:`${schema.description??''} ${Object.keys(schema.properties??{}).join(' ')}`}))]};
}

function renderMarkdown(document,base,known){
  const headings=[],ids=new Set(),links=[],occurrences=new Map(),search=[];
  let active;
  const renderer=new Renderer();
  renderer.html=token=>html(token.text);
  renderer.heading=function(token){
    const title=plain(token.text),root=headingSlug(title)||'section',count=occurrences.get(root)??0,id=count?`${root}-${count}`:root;occurrences.set(root,count+1);
    ids.add(id);headings.push({depth:token.depth,id,text:title});active={title,url:`#${id}`,section:document.title,content:''};search.push(active);
    return `<h${token.depth} id="${html(id)}">${token.depth>1?`<a class="heading-anchor" href="#${html(id)}" aria-label="Link to ${html(title)}">#</a>`:''}${this.parser.parseInline(token.tokens)}</h${token.depth}>`;
  };
  renderer.paragraph=function(token){if(active)active.content+=` ${plain(token.text)}`;return `<p>${this.parser.parseInline(token.tokens)}</p>`;};
  renderer.code=token=>`<div class="docs-code"><div class="docs-code-toolbar"><span>${html(token.lang?.split(/\s/)[0]??'Code')}</span><button class="docs-copy" type="button">Copy code</button></div><pre><code${token.lang?` class="language-${html(token.lang.split(/\s/)[0])}"`:''}>${html(token.text)}</code></pre></div>`;
  const defaultTable=renderer.table;renderer.table=function(token){return `<div class="docs-table">${defaultTable.call(this,token)}</div>`;};
  const resolveLink=href=>{
    if(/^(?:https?:|mailto:)/.test(href))return href;
    if(/^[a-z]+:/i.test(href)||href.startsWith('//'))throw new Error(`${document.slug}: unsafe link ${href}`);
    if(href.startsWith('#')){links.push({slug:document.slug,hash:decodeURIComponent(href.slice(1))});return href;}
    const [pathname,hash='']=href.split('#');
    if(pathname.endsWith('.md')){
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(document.slug+'.md'),pathname)).replace(/\.md$/,'');
      if(!known.has(target))throw new Error(`${document.slug}: missing documentation page ${href}`);
      links.push({slug:target,hash:decodeURIComponent(hash)});return route(base,target)+(hash?'#'+hash:'');
    }
    if(pathname.startsWith(base)){links.push({url:href});return href;}
    if(pathname.startsWith('/')){if(base!=='/')throw new Error(`${document.slug}: root-relative link bypasses configured base: ${href}`);links.push({url:href});return href;}
    throw new Error(`${document.slug}: use a relative .md link or an absolute supported URL: ${href}`);
  };
  renderer.link=function(token){const href=resolveLink(token.href);return `<a href="${html(href)}"${/^https?:/.test(href)?' rel="noreferrer"':''}${token.title?` title="${html(token.title)}"`:''}>${this.parser.parseInline(token.tokens)}</a>`;};
  renderer.image=token=>{throw new Error(`${document.slug}: image ${token.href} needs an explicitly copied and validated local asset; use a text diagram meanwhile.`);};
  const markdown=new Marked({renderer,gfm:true});const body=markdown.parse(document.markdown);
  if(headings[0]?.depth!==1||headings.filter(h=>h.depth===1).length!==1)throw new Error(`${document.slug}: exactly one first-level page title is required.`);
  const description=search.map(entry=>entry.content.trim()).find(Boolean)?.slice(0,170)??document.title;
  return {...document,title:headings[0].text,description,body,headings,ids,links,search};
}

function shell(page,pages,navigation,base,assets){
  const order=navigation.flatMap(group=>group.pages),position=order.indexOf(page.slug),previous=pages.get(order[position-1]),next=pages.get(order[position+1]);
  const section=navigation.find(group=>group.pages.includes(page.slug))?.title??'Documentation';
  const sidebar=navigation.map(group=>`<section class="docs-nav-group"><h2>${html(group.title)}</h2><ul>${group.pages.map(slug=>{const item=pages.get(slug);return `<li><a href="${route(base,slug)}"${slug===page.slug?' class="is-active" aria-current="page"':''}>${html(item.title)}</a></li>`;}).join('')}</ul></section>`).join('');
  const toc=page.headings.filter(h=>h.depth===2||(page.slug!=='api-reference'&&h.depth===3));
  return `<!doctype html><html lang="en" class="no-js" data-fem-docs="true" data-search-index="${base+assets.search}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${html(page.description)}"><meta name="color-scheme" content="dark"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'"><title>${html(page.title)} · FEM Lab documentation</title><link rel="stylesheet" href="${base+assets.css}"><script type="module" src="${base+assets.client}"></script></head><body><a class="docs-skip" href="#main-content">Skip to content</a><header class="docs-header"><a class="docs-brand" href="${route(base,'index')}" aria-label="FEM Lab documentation home"><span class="docs-brand-mark" aria-hidden="true"></span><strong>FEM Lab</strong><span>Documentation</span></a><div class="docs-header-links"><button class="docs-search-open" type="button"><span>Search documentation</span><kbd>⌘ K</kbd></button><a href="${base}">Open FEM Lab <span aria-hidden="true">↗</span></a><button class="docs-menu-toggle" type="button" aria-expanded="false" aria-controls="docs-sidebar">Browse topics</button></div></header><div class="docs-layout"><nav id="docs-sidebar" class="docs-sidebar" aria-label="Documentation">${sidebar}<a class="docs-return" href="${base}">Open FEM Lab ↗</a></nav><main id="main-content" class="docs-main" tabindex="-1"><nav class="docs-breadcrumb" aria-label="Breadcrumb"><a href="${route(base,'index')}">Docs</a><span aria-hidden="true">/</span><span>${html(section)}</span></nav><article class="docs-article">${page.body}</article><nav class="docs-pagination" aria-label="Previous and next pages">${previous?`<a class="previous" href="${route(base,previous.slug)}"><span>← Previous</span><strong>${html(previous.title)}</strong></a>`:'<span></span>'}${next?`<a class="next" href="${route(base,next.slug)}"><span>Next →</span><strong>${html(next.title)}</strong></a>`:''}</nav><footer class="docs-footer"><p>FEM Lab · Understand the model. Check the result.</p><a href="https://github.com/andeplane/fem-lab/${page.slug==='api-reference'?'tree/main/packages/registry/src':'edit/main/docs/guide/'+page.slug+'.md'}">${page.slug==='api-reference'?'View reference source':'Improve this page'} ↗</a><a href="${base}">Open FEM Lab ↗</a><a href="${base}terms.html">Terms</a><a href="${base}privacy.html">Privacy</a></footer></main><aside class="docs-toc" aria-label="On this page"><p>On this page</p><ol>${toc.map(h=>`<li class="depth-${h.depth}"><a href="#${html(h.id)}">${html(h.text)}</a></li>`).join('')}</ol><a class="docs-toc-top" href="#${html(page.headings[0].id)}">Back to top ↑</a></aside></div><dialog id="docs-search" aria-labelledby="docs-search-title"><div class="docs-search-heading"><h2 id="docs-search-title">Search documentation</h2><button type="button" data-docs-search-close aria-label="Close search">Esc</button></div><label class="docs-search-label" for="docs-search-input">Search topics or commands</label><input id="docs-search-input" type="search" placeholder="Search topics or commands…" autocomplete="off" spellcheck="false"><p id="docs-search-status" role="status" aria-live="polite"></p><ol id="docs-search-results" aria-label="Search results"></ol><p class="docs-search-hint">Arrow keys to navigate · Enter to open · Esc to close</p></dialog></body></html>`;
}

/** Compile already-read content. The same function powers production, dev and link tests. */
export function compileDocsSite({base='/fem-lab/',documents,reference,navigation=NAVIGATION,css,clientCode}){
  normalizeBase(base);const known=new Set([...documents.map(d=>d.slug),'api-reference']);
  if(known.size!==documents.length+1)throw new Error('Duplicate or reserved documentation slug.');
  const order=navigation.flatMap(g=>g.pages);if(new Set(order).size!==order.length)throw new Error('Documentation navigation contains duplicate pages.');
  if([...known].some(slug=>!order.includes(slug))||order.some(slug=>!known.has(slug)))throw new Error('Every documentation page must appear exactly once in navigation.');
  const pages=new Map(documents.map(d=>[d.slug,renderMarkdown(d,base,known)]));pages.set('api-reference',referencePage(reference));
  for(const page of pages.values())for(const link of page.links){if(link.slug&&link.hash&&!pages.get(link.slug).ids.has(link.hash))throw new Error(`${page.slug}: missing heading ${link.slug}#${link.hash}`);if(link.url&&link.url.startsWith(base+'docs/')){const target=link.url.slice((base+'docs/').length).split(/[?#]/)[0].replace(/\/$/,'')||'index';if(!known.has(target))throw new Error(`${page.slug}: missing docs route ${link.url}`);const hash=link.url.split('#')[1];if(hash&&!pages.get(target).ids.has(decodeURIComponent(hash)))throw new Error(`${page.slug}: missing docs heading ${link.url}`);}}
  // Navigation must not disguise a content island: a reader can reach every authored page from the overview.
  const reached=new Set(['index']),queue=['index'];while(queue.length){const current=queue.shift();for(const link of pages.get(current)?.links??[])if(link.slug&&!reached.has(link.slug)){reached.add(link.slug);queue.push(link.slug);}}
  const orphans=[...known].filter(slug=>!reached.has(slug));if(orphans.length)throw new Error(`Documentation pages are unreachable from the overview: ${orphans.join(', ')}`);
  const entries=[...pages.values()].flatMap(page=>page.search.map(entry=>({...entry,url:route(base,page.slug)+entry.url,content:entry.content.trim().slice(0,2000)})));
  const search=JSON.stringify({version:1,entries}),assets={css:`assets/docs-${digest(css)}.css`,client:`assets/docs-client-${digest(clientCode)}.js`,search:`assets/docs-search-${digest(search)}.json`};
  const files=new Map([[assets.css,css],[assets.client,clientCode],[assets.search,search]]);
  for(const page of pages.values())files.set(`docs/${page.slug==='index'?'':page.slug+'/'}index.html`,shell(page,pages,navigation,base,assets));
  const referenceHtml=files.get('docs/api-reference/index.html');
  const actual=new Set([...referenceHtml.matchAll(/data-api-entry="([^"]+)"/g)].map(m=>m[1]));
  for(const entry of reference.entries)if(!actual.has(`${entry.kind}:${entry.provider}:${entry.name}`))throw new Error(`Missing registered API definition: ${entry.name}`);
  if(actual.size!==reference.entries.length)throw new Error('API reference does not cover each authoritative definition exactly once.');
  return {base,files,pages,searchEntries:entries,referenceCount:reference.entries.length};
}

export async function buildDocsSite({base='/fem-lab/'}={}){
  const directory=path.join(ROOT,'docs/guide'),names=(await readdir(directory)).filter(name=>name.endsWith('.md')).sort();
  const documents=await Promise.all(names.map(async name=>({slug:name.slice(0,-3),title:name.slice(0,-3),markdown:await readFile(path.join(directory,name),'utf8')})));
  const [reference,css,client,exampleCount]=await Promise.all([loadReference(),readFile(path.join(ROOT,'packages/app/docs/theme.css'),'utf8'),build({entryPoints:[path.join(ROOT,'packages/app/src/docs/client.ts')],bundle:true,platform:'browser',format:'esm',target:'es2022',minify:true,write:false}),validateGuideExamples(documents)]);
  return {...compileDocsSite({base,documents,reference,css,clientCode:client.outputFiles[0].text}),exampleCount};
}

/** Emit real HTML assets; docs never import or preload the application entry. */
export function docsPlugin(base){
  let site,loading,generation=0;
  const get=()=>{if(!loading){const current=generation;loading=buildDocsSite({base}).then(value=>{if(current===generation)site=value;return value;});}return loading;};
  return {name:'femlab-static-documentation',
    async buildStart(){await get();},
    async generateBundle(){for(const [fileName,source] of (await get()).files)this.emitFile({type:'asset',fileName,source});},
    configureServer(server){
      server.watcher.add(['docs/guide','packages/app/docs','packages/app/src/docs','packages/registry/src',...APP_REFERENCE_INPUTS].map(filename=>path.join(ROOT,filename)));
      server.watcher.on('all',(event,filename)=>{if(['add','change','unlink'].includes(event)&&isDocsInput(filename)){generation++;loading=undefined;site=undefined;referencePromise=undefined;resetGuideExampleCache();server.ws.send({type:'full-reload'});}});
      server.middlewares.use(async(request,response,next)=>{
        const pathname=new URL(request.url??'/', 'http://localhost').pathname;
        if(pathname!==base+'docs'&&!pathname.startsWith(base+'docs/')&&!pathname.startsWith(base+'assets/docs-'))return next();
        try{
          const data=site??await get();let relative=decodeURIComponent(pathname.slice(base.length));
          if(relative==='docs'||relative.startsWith('docs/')&&!path.posix.extname(relative)&&!relative.endsWith('/')){response.statusCode=308;response.setHeader('Location',pathname+'/');response.end();return;}
          if(relative.endsWith('/'))relative+='index.html';const source=data.files.get(relative);
          if(source===undefined){response.statusCode=404;response.setHeader('content-type','text/html; charset=utf-8');response.end(`<h1>Documentation page not found</h1><p><a href="${route(base,'index')}">Browse FEM Lab documentation</a></p>`);return;}
          response.setHeader('content-type',relative.endsWith('.css')?'text/css; charset=utf-8':relative.endsWith('.js')?'text/javascript; charset=utf-8':relative.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8');response.setHeader('cache-control','no-cache');response.end(source);
        }catch(error){next(error);}
      });
    },
  };
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const bases=process.argv.includes('--check')?['/','/fem-lab/']:[process.env.FEMLAB_BASE_PATH??'/fem-lab/'];
  for(const base of bases){const site=await buildDocsSite({base});const outIndex=process.argv.indexOf('--out');if(outIndex>=0){const target=path.resolve(ROOT,process.argv[outIndex+1]);for(const [file,source] of site.files){await mkdir(path.dirname(path.join(target,file)),{recursive:true});await writeFile(path.join(target,file),source);}}
    console.log(`Docs ${base}: ${site.pages.size} static pages, ${site.referenceCount} authoritative API definitions, ${site.searchEntries.length} searchable sections, ${site.exampleCount} typed examples; links, anchors, navigation and coverage checked.`);
  }
}
