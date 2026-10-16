// Read only static declaration metadata. Importing the browser host would start storage I/O.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'packages/app/package.json')),ts=require('typescript');
const unwrap=node=>ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isParenthesizedExpression(node)?unwrap(node.expression):node;
const key=node=>node.name?.getText().replace(/^['"]|['"]$/g,'');
const property=(node,name)=>node.properties.find(p=>key(p)===name);
function metadata(node,source){
  node=unwrap(node);if(!ts.isObjectLiteralExpression(node))throw new Error(`Docs require static host definition metadata: ${source.fileName}`);
  return '{'+node.properties.filter(p=>key(p)!=='run').map(p=>p.getText(source)).join(',')+'}';
}
function declaration(source,name){let result;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)===name)result=node.initializer;ts.forEachChild(node,visit);}visit(source);if(!result)throw new Error(`Documentation cannot find ${name} in ${source.fileName}`);return result;}
function definitions(source,functionName){
  const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===functionName);
  if(!declaration?.body)throw new Error(`Documentation cannot find ${functionName}`);
  const returned=declaration.body.statements.find(ts.isReturnStatement)?.expression,array=returned&&unwrap(returned);
  if(!array||!ts.isArrayLiteralExpression(array)||array.elements.some(node=>!ts.isObjectLiteralExpression(unwrap(node))))throw new Error(`Documentation needs explicit ${functionName} definitions; update its source reader for this registration shape.`);
  return array.elements.map(node=>metadata(node,source));
}
function checkMainRegistrations(source){
  let found=0;
  function visit(node){
    if(ts.isNewExpression(node)&&node.expression.getText(source)==='Registry'){
      const options=node.arguments?.[0];if(!options||!ts.isObjectLiteralExpression(options))return;
      for(const name of ['hostCommands','hostQueries']){
        const value=property(options,name)?.initializer;if(!value)continue;found++;
        if(!ts.isArrayLiteralExpression(value))throw new Error(`Docs need an explicit ${name} inventory in main.tsx.`);
        for(const item of value.elements){
          if(ts.isSpreadElement(item)){
            const expression=item.expression;
            if(ts.isIdentifier(expression)&&['HOST_COMMANDS','HOST_QUERIES'].includes(expression.text))continue;
            if(ts.isCallExpression(expression)&&['appHostCommands','appHostQueries'].includes(expression.expression.getText(source)))continue;
          }else if(ts.isObjectLiteralExpression(item)&&item.properties.some(p=>ts.isSpreadAssignment(p)&&p.expression.getText(source)==='WORKSPACE_STATUS')&&item.properties.every(p=>ts.isSpreadAssignment(p)||key(p)==='run'))continue;
          throw new Error(`New ${name} registration in main.tsx must be included in the generated documentation inventory: ${item.getText(source).slice(0,100)}`);
        }
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(source);if(found!==2)throw new Error('Documentation could not verify the active browser registry registration.');
}
export async function appReferenceSource(){
  const parse=async name=>ts.createSourceFile(name,await readFile(path.join(root,name),'utf8'),ts.ScriptTarget.Latest,true,name.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const [host,startup,main,ui]=await Promise.all(['packages/app/src/host.ts','packages/app/src/startup.ts','packages/app/src/main.tsx','packages/app/src/ui/schema.ts'].map(parse));
  checkMainRegistrations(main);
  const commands=definitions(host,'appHostCommands'),queries=definitions(host,'appHostQueries'),startupDefinitions=[];
  function visit(node){if(ts.isObjectLiteralExpression(node)&&property(node,'name')&&property(node,'schema'))startupDefinitions.push(metadata(node,startup));ts.forEachChild(node,visit);}
  visit(startup);
  if(!startupDefinitions.length)throw new Error('Documentation could not read startup registry metadata.');
  return `
    const MATERIAL_PHYSICS=${declaration(ui,'MATERIAL_PHYSICS').getText(ui)};
    const FORM_OPEN=${metadata(declaration(host,'FORM_OPEN'),host)};
    const appCommands=[${commands.join(',')}],appQueries=[${queries.join(',')}],startupDefinitions=[${startupDefinitions.join(',')}];
    const metadataRows=(entries,kind,provider,sourceFile)=>entries.map(d=>({name:d.name,description:d.description,schema:z.toJSONSchema(d.schema),execution:d.execution,journaled:false,tool:d.tool,kind:kind??(d.name.startsWith('query.')?'query':'command'),provider,sourceFile}));
    const appEntries=[...metadataRows(appCommands,'command','browser-app','packages/app/src/host.ts'),...metadataRows(appQueries,'query','browser-app','packages/app/src/host.ts'),...metadataRows(startupDefinitions,null,'startup','packages/app/src/startup.ts')];
  `;
}
