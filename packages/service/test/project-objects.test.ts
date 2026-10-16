import type {Storage} from '@google-cloud/storage';
import {describe,expect,it,vi} from 'vitest';
import {projectObjects} from '../src/project-objects';
const sha='a'.repeat(64);
function fixture(){
  const metadata={size:'3',generation:'123',metadata:{sha256:sha}},file={save:vi.fn(async()=>{}),getMetadata:vi.fn(async()=>[metadata]),download:vi.fn(async()=>[Buffer.from('abc')]),delete:vi.fn(async()=>{})},bucket={file:vi.fn((_name:string,_options?:unknown)=>file)},storage={bucket:vi.fn(()=>bucket)};
  return {metadata,file,bucket,storage,objects:projectObjects(storage as unknown as Storage,'private-project-bucket')};
}
describe('private generation-pinned project object adapter',()=>{
  it('writes create-only verified binary objects without signed URLs or bucket metadata permissions',async()=>{
    const f=fixture();expect(await f.objects.put('owned/chunk',Buffer.from('abc'),sha)).toEqual({bytes:3,sha256:sha,generation:'123'});
    expect(f.storage.bucket).toHaveBeenCalledWith('private-project-bucket');expect(f.file.save).toHaveBeenCalledWith(Buffer.from('abc'),expect.objectContaining({resumable:false,timeout:30000,validation:'crc32c',preconditionOpts:{ifGenerationMatch:0},contentType:'application/octet-stream',metadata:{cacheControl:'private,no-store',metadata:{sha256:sha}}}));
  });
  it('accepts exact immutable retries and refuses mismatched metadata or private SDK failures',async()=>{
    const f=fixture();f.file.save.mockRejectedValueOnce({code:412});expect((await f.objects.put('owned/chunk',Buffer.from('abc'),sha)).generation).toBe('123');
    await expect(f.objects.put('owned/chunk',Buffer.from('abcd'),sha)).rejects.toThrow('not confirmed');f.file.save.mockRejectedValueOnce(new Error('provider unavailable'));await expect(f.objects.put('owned/chunk',Buffer.from('abc'),sha)).rejects.toThrow('provider unavailable');
  });
  it('pins downloads and deletion generations and treats missing objects as missing',async()=>{
    const f=fixture();expect(await f.objects.read('owned/chunk','123')).toEqual(Buffer.from('abc'));expect(f.bucket.file).toHaveBeenCalledWith('owned/chunk',{generation:'123'});expect(f.file.download).toHaveBeenCalledWith({validation:'crc32c'});
    await expect(f.objects.read('owned/chunk','124')).rejects.toThrow('unavailable');await f.objects.remove('owned/chunk','123');expect(f.file.delete).toHaveBeenCalledWith({ignoreNotFound:true,ifGenerationMatch:'123'});
    await f.objects.remove('owned/chunk',undefined);expect(f.file.delete).toHaveBeenCalledWith({ignoreNotFound:true,ifGenerationMatch:'123'});
    f.file.getMetadata.mockRejectedValueOnce({code:404});expect(await f.objects.stat('missing')).toBeNull();f.file.getMetadata.mockRejectedValueOnce({code:404});f.file.delete.mockClear();await f.objects.remove('missing',undefined);expect(f.file.delete).not.toHaveBeenCalled();
  });
  it('rejects unbounded or malformed object metadata before downloading and preserves generation conflicts',async()=>{
    const f=fixture();f.metadata.size='8000001';await expect(f.objects.read('owned/chunk','123')).rejects.toThrow('Invalid');expect(f.file.download).not.toHaveBeenCalled();
    f.metadata.size='3';f.metadata.metadata.sha256='bad';await expect(f.objects.stat('owned/chunk')).rejects.toThrow('Invalid');f.metadata.metadata.sha256=sha;f.file.delete.mockRejectedValueOnce({code:412});await expect(f.objects.remove('owned/chunk','123')).rejects.toMatchObject({code:412});
  });
});
