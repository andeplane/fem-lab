import type {Storage} from '@google-cloud/storage';
import {PROJECT_CHUNK_BYTES} from '@femlab/registry';
import type {ProjectObjects,ProjectObjectInfo} from './cloud-projects';

/** A separate private bucket; no signed URLs, public ACLs, bucket probes or export expiry. */
export function projectObjects(storage:Storage,bucketName:string):ProjectObjects {
  const bucket=storage.bucket(bucketName);
  async function stat(name:string):Promise<ProjectObjectInfo|null>{
    try {const [meta]=await bucket.file(name).getMetadata({timeout:10000});const bytes=Number(meta.size),sha256=meta.metadata?.sha256,generation=meta.generation;
      if(!Number.isSafeInteger(bytes)||bytes<1||bytes>PROJECT_CHUNK_BYTES||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||!generation)throw new Error('Invalid project object metadata.');
      return {bytes,sha256,generation:String(generation)};
    }catch(error){if((error as {code?:number}).code===404)return null;throw error}
  }
  return {
    stat,
    async put(name,bytes,sha256){
      try{await bucket.file(name).save(bytes,{resumable:false,timeout:30000,validation:'crc32c',preconditionOpts:{ifGenerationMatch:0},contentType:'application/octet-stream',metadata:{cacheControl:'private,no-store',metadata:{sha256}}});}
      catch(error){if((error as {code?:number}).code!==412)throw error;}
      const info=await stat(name);if(!info||info.bytes!==bytes.length||info.sha256!==sha256)throw new Error('Project object upload is not confirmed.');return info;
    },
    async read(name,generation){const info=await stat(name);if(!info||info.generation!==generation)throw new Error('Project object generation is unavailable.');const [bytes]=await bucket.file(name,{generation}).download({validation:'crc32c'});return bytes;},
    async remove(name,generation){const current=generation??(await stat(name))?.generation;if(!current)return;await bucket.file(name).delete({ignoreNotFound:true,ifGenerationMatch:current});},
  };
}
