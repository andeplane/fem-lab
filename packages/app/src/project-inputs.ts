import type {AbaqusFile,AbaqusIo} from '@femlab/registry';
import {createProjectFileInventory,type ProjectAsset} from './project-artifact';
/** Captures only files actually read by one admitted import; directory selection is not consent to upload its other files. */
export function captureProjectInputs(io:AbaqusIo,nextId:()=>string):{io:AbaqusIo;add(name:string,mime:string,data:string|Uint8Array):void;snapshot():ProjectAsset[]} {
  const inventory=createProjectFileInventory(nextId);
  const add=(name:string,mime:string,data:string|Uint8Array):void=>{const bytes=typeof data==='string'?new TextEncoder().encode(data):data;if(inventory.snapshot().some(file=>file.name===name&&file.data.length===bytes.length&&file.data.every((value,index)=>value===bytes[index])))return;inventory.capture('input',name,mime,bytes);};
  const wrap=(file:AbaqusFile):AbaqusFile=>({...file,read:async()=>{const bytes=await file.read();add(file.name,'application/octet-stream',bytes);return bytes;}});
  return {add,snapshot:()=>inventory.snapshot(),io:{...io,pick:async()=>{const file=await io.pick();return file?wrap(file):null;},read:async path=>wrap(await io.read(path)),...(io.pickIncludes?{pickIncludes:async paths=>{const files=await io.pickIncludes!(paths);return files?.map(wrap)??null;}}:{})}};
}
