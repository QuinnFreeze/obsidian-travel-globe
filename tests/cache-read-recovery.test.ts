import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EarthResources,EARTH_RESOURCES,type ResourceDisk} from '../src/earth-resources';
import {SatelliteCache,type TileDisk} from '../src/tile-cache';
import {createTerrainCache} from '../src/terrain-data';
import {isMissingResource} from '../src/resource-read';

const jpeg=(n=1)=>new Uint8Array([255,216,n,2,3,4,255,217]).buffer;
function terrain(n=1){const a=new Uint8Array(33);a.set([137,80,78,71,13,10,26,10]);const v=new DataView(a.buffer);v.setUint32(16,256);v.setUint32(20,256);a[32]=n;return a.buffer;}
const hash=(b:ArrayBuffer)=>createHash('sha256').update(new Uint8Array(b)).digest('hex');
const missing=()=>Object.assign(Error('file disappeared'),{code:'ENOENT'});
class Disk implements ResourceDisk,TileDisk {
  files=new Map<string,ArrayBuffer>();folders=new Set<string>();
  trace:{op:string;path:string;to?:string}[]=[];
  faults=new Map<string,unknown[]>();
  fail(op:string,path:string,count=1,error:unknown=Object.assign(Error('EIO transient '+op),{code:'EIO'})){
    this.faults.set(op+':'+path,Array.from({length:count},()=>error));
  }
  private touch(op:string,path:string,to?:string){
    this.trace.push({op,path,to});const faults=this.faults.get(op+':'+path);if(faults?.length)throw faults.shift();
  }
  async exists(p:string){this.touch('exists',p);return this.files.has(p)||this.folders.has(p);}
  async mkdir(p:string){this.touch('mkdir',p);this.folders.add(p);}
  async list(p:string){this.touch('list',p);return {files:[...this.files.keys()].filter(k=>k.startsWith(p+'/')),folders:[]};}
  async stat(p:string){this.touch('stat',p);const b=this.files.get(p);return b?{size:b.byteLength,mtime:Date.now()}:null;}
  async readBinary(p:string){this.touch('readBinary',p);const b=this.files.get(p);if(!b)throw missing();return b;}
  async read(p:string){return new TextDecoder().decode(await this.readBinary(p));}
  async writeBinary(p:string,b:ArrayBuffer){this.touch('writeBinary',p);this.files.set(p,b);}
  async write(p:string,s:string){await this.writeBinary(p,new TextEncoder().encode(s).buffer);}
  async rename(a:string,b:string){this.touch('rename',a,b);assert.ok(!this.files.has(b),'rename over existing');const data=this.files.get(a);if(!data)throw missing();this.files.set(b,data);this.files.delete(a);}
  async remove(p:string){this.touch('remove',p);this.files.delete(p);}
  mutations(){return this.trace.filter(t=>['writeBinary','rename','remove','mkdir'].includes(t.op));}
  reads(p:string){return this.trace.filter(t=>t.op==='readBinary'&&t.path===p).length;}
}
const spec=EARTH_RESOURCES[0],earthPath='地球资源/全球底图/'+spec.name,bundlePath='bundle/runtime-assets/'+spec.name;
function earthSetup(){
  const disk=new Disk();disk.folders.add('地球资源');disk.folders.add('地球资源/全球底图');disk.files.set(earthPath,jpeg(7));disk.files.set(bundlePath,jpeg(9));
  disk.files.set(earthPath+'.json',new TextEncoder().encode(JSON.stringify({checked:100000,source:spec.url})).buffer);
  let network=0;const cache=new EarthResources(disk,'bundle',async()=>{network++;throw Error('unexpected network');},async b=>b,()=>100000);
  return {disk,cache,network:()=>network};
}

test('only explicit ENOENT / NotFoundError mean absent, not EIO or arbitrary messages',()=>{
  assert.ok(isMissingResource(missing()));assert.ok(isMissingResource({name:'NotFoundError'}));
  for(const error of [null,undefined,'ENOENT',Error('missing'),Error('EIO'),{code:'EIO'},{code:'EACCES'},{code:'ETIMEDOUT'},{code:'ENOTDIR'},{}])assert.equal(isMissingResource(error),false);
});
for(const op of ['stat','readBinary','exists'])for(const online of [false,true])test(`earth ${op} failure (${online?'online':'offline'}): read-only fallback, original hash and next-call recovery`,async()=>{
  const {disk,cache,network}=earthSetup();cache.online=online;
  const before=hash(disk.files.get(earthPath)!);disk.files.set(earthPath+'.previous',jpeg(3));const previous=hash(disk.files.get(earthPath+'.previous')!);
  disk.fail(op,earthPath,2);
  for(let i=0;i<2;i++){
    assert.equal(await cache.resolve('runtime-assets/'+spec.name),bundlePath);await cache.settled();
    assert.match(cache.lastError,/暂不可用.*EIO/);assert.equal(hash(disk.files.get(earthPath)!),before);
    assert.equal(hash(disk.files.get(earthPath+'.previous')!),previous);assert.deepEqual(disk.mutations(),[]);
    assert.equal(disk.reads(bundlePath),0);assert.equal(network(),0);
  }
  assert.equal(await cache.resolve('runtime-assets/'+spec.name),earthPath);await cache.settled();
  assert.equal(cache.lastError,'');assert.equal(hash(disk.files.get(earthPath)!),before);assert.deepEqual(disk.mutations(),[]);assert.equal(network(),0);
  assert.equal(disk.reads(earthPath),op==='readBinary'?3:1);
});
test('earth proven corrupt bytes still self-heal from seed, unlike temporary I/O',async()=>{
  const {disk,cache,network}=earthSetup();cache.online=false;disk.files.set(earthPath,new Uint8Array([1,2,3]).buffer);
  assert.equal(await cache.resolve('runtime-assets/'+spec.name),earthPath);assert.deepEqual(disk.files.get(earthPath),jpeg(9));
  assert.equal(disk.reads(bundlePath),1);assert.ok(disk.mutations().some(t=>t.op==='rename'));assert.equal(network(),0);assert.ok(!disk.files.has(earthPath+'.previous'));
});
test('earth confirmed missing read race can seed, and true first-use absence can seed',async()=>{
  for(const race of [false,true]){
    const {disk,cache}=earthSetup();cache.online=false;
    if(race)disk.fail('readBinary',earthPath,1,missing());else disk.files.delete(earthPath);
    assert.equal(await cache.resolve('runtime-assets/'+spec.name),earthPath);assert.deepEqual(disk.files.get(earthPath),jpeg(9));
  }
});
test('earth atomic install failure after moving old bytes rolls back with original hash',async()=>{
  const {disk,cache}=earthSetup();cache.online=false;disk.files.set(earthPath,new Uint8Array([1,2,3]).buffer);const before=hash(disk.files.get(earthPath)!);
  disk.fail('rename',earthPath+'.tmp');assert.equal(await cache.resolve('runtime-assets/'+spec.name),bundlePath);
  assert.equal(hash(disk.files.get(earthPath)!),before);assert.match(cache.lastError,/EIO/);assert.ok(!disk.files.has(earthPath+'.tmp'));assert.ok(!disk.files.has(earthPath+'.previous'));
});

function tileSetup(kind:'satellite'|'terrain'){
  const disk=new Disk();disk.folders.add('cache');const data=kind==='terrain'?terrain(7):jpeg(7),next=kind==='terrain'?terrain(9):jpeg(9);
  const path='cache/'+(kind==='terrain'?'terrain-v1-4-0-0.png':'eox2024-4-0-0.jpg');disk.files.set(path,data);
  let network=0;const fetch=async()=>{network++;return next;};
  const cache=kind==='terrain'?createTerrainCache(disk,'cache',fetch):new SatelliteCache(disk,'cache',fetch);
  return {disk,cache,path,data,next,network:()=>network};
}
for(const kind of ['satellite','terrain'] as const){
  for(const op of ['stat','readBinary'])for(const online of [false,true])test(`${kind} ${op} EIO (${online?'online':'offline'}): bounded failure, no network/writes, next call recovers`,async()=>{
    const {disk,cache,path,data,network}=tileSetup(kind);cache.online=online;const before=hash(data);disk.fail(op,path,2);
    for(let i=0;i<2;i++){
      await assert.rejects(cache.get(4,0,0),/暂不可读.*EIO/);assert.match(cache.lastError,/EIO/);
      assert.equal(hash(disk.files.get(path)!),before);assert.deepEqual(disk.mutations(),[]);assert.equal(network(),0);
      if(op==='readBinary'){assert.equal(cache.stats.entries,1);assert.equal(cache.stats.bytes,data.byteLength);assert.equal(disk.reads(path),i+1);}
    }
    assert.deepEqual(await cache.get(4,0,0),data);assert.equal(cache.lastError,'');assert.equal(cache.stats.entries,1);assert.equal(cache.stats.hits,1);
    assert.equal(hash(disk.files.get(path)!),before);assert.deepEqual(disk.mutations(),[]);assert.equal(network(),0);
    assert.equal(disk.reads(path),op==='readBinary'?3:1);
  });
  test(`${kind} corrupt-byte control invalidates offline entry and self-heals when online`,async()=>{
    const {disk,cache,path,next,network}=tileSetup(kind);cache.online=false;disk.files.set(path,new Uint8Array([1,2,3]).buffer);const before=hash(disk.files.get(path)!);
    await assert.rejects(cache.get(4,0,0),/缓存损坏.*未缓存/);assert.equal(cache.stats.entries,0);assert.deepEqual(disk.mutations(),[]);assert.equal(hash(disk.files.get(path)!),before);assert.equal(network(),0);
    cache.online=true;assert.deepEqual(await cache.get(4,0,0),next);assert.equal(network(),1);assert.deepEqual(disk.files.get(path),next);assert.equal(cache.stats.entries,1);
    assert.ok(!disk.files.has(path+'.tmp'));assert.ok(!disk.files.has(path+'.previous'));
  });
  test(`${kind} confirmed ENOENT removes only index and detects subsequently restored file offline`,async()=>{
    const {disk,cache,path,data,network}=tileSetup(kind);cache.online=false;
    assert.deepEqual(await cache.get(4,0,0),data);disk.files.delete(path);
    await assert.rejects(cache.get(4,0,0),/未缓存/);assert.equal(cache.stats.entries,0);
    disk.files.set(path,data);assert.deepEqual(await cache.get(4,0,0),data);assert.equal(cache.stats.entries,1);assert.equal(network(),0);assert.deepEqual(disk.mutations(),[]);
  });
  test(`${kind} concurrent read failure deduplicates once, preserves index, and next concurrent call succeeds`,async()=>{
    const {disk,cache,path,data,network}=tileSetup(kind);cache.online=false;disk.fail('readBinary',path);
    const failed=await Promise.allSettled(Array.from({length:8},()=>cache.get(4,0,0)));
    assert.ok(failed.every(r=>r.status==='rejected'));assert.equal(disk.reads(path),1);assert.equal(cache.stats.entries,1);
    const recovered=await Promise.all(Array.from({length:8},()=>cache.get(4,0,0)));for(const b of recovered)assert.deepEqual(b,data);
    assert.equal(disk.reads(path),2);assert.equal(network(),0);assert.deepEqual(disk.mutations(),[]);
  });
}
test('unknown adapter read exceptions are not assumed missing',async()=>{
  const {disk,cache,path,data,network}=tileSetup('satellite');disk.fail('readBinary',path,1,Error('opaque adapter failure'));
  await assert.rejects(cache.get(4,0,0),/opaque adapter failure/);assert.equal(cache.stats.entries,1);assert.equal(network(),0);assert.deepEqual(disk.mutations(),[]);
  assert.deepEqual(await cache.get(4,0,0),data);assert.equal(cache.lastError,'');
});
test('legacy offline read EIO preserves old bytes and does not download; next call migrates',async()=>{
  const {disk,cache,path,data,network}=tileSetup('satellite');disk.files.delete(path);cache.legacyFolder='legacy';cache.online=false;
  const old='legacy/eox2024-4-0-0.jpg';disk.files.set(old,data);disk.fail('readBinary',old);
  await assert.rejects(cache.get(4,0,0),/EIO/);assert.deepEqual(disk.mutations(),[]);assert.equal(network(),0);assert.equal(hash(disk.files.get(old)!),hash(data));
  assert.deepEqual(await cache.get(4,0,0),data);assert.equal(hash(disk.files.get(old)!),hash(data));assert.deepEqual(disk.files.get(path),data);assert.equal(network(),0);
});
test('tile background atomic failure restores old image and retains usable index',async()=>{
  const {disk,cache,path,data,next,network}=tileSetup('satellite');cache.refreshAfter=0;disk.fail('rename',path+'.tmp');
  assert.deepEqual(await cache.get(4,0,0),data);await cache.settled();assert.equal(network(),1);assert.match(cache.lastError,/缓存写入失败.*EIO/);
  assert.equal(hash(disk.files.get(path)!),hash(data));assert.equal(cache.stats.entries,1);assert.ok(!disk.files.has(path+'.tmp'));assert.ok(!disk.files.has(path+'.previous'));
  cache.online=false;assert.deepEqual(await cache.get(4,0,0),data);assert.notEqual(hash(disk.files.get(path)!),hash(next));
});
test('stop still prevents an in-flight remote result from repopulating disk',async()=>{
  const disk=new Disk();disk.folders.add('cache');let release!:(b:ArrayBuffer)=>void,started!:()=>void;
  const gate=new Promise<ArrayBuffer>(r=>release=r),called=new Promise<void>(r=>started=r);
  const cache=new SatelliteCache(disk,'cache',async()=>{started();return gate;});
  const work=cache.get(4,0,0);await called;cache.stop();release(jpeg(9));assert.deepEqual(await work,jpeg(9));await cache.settled();
  assert.equal(cache.stats.entries,0);assert.deepEqual(disk.mutations(),[]);
});
test('explicit stat ENOENT is absence, not an I/O failure, even during initial scan',async()=>{
  const {disk,cache,path,next,network}=tileSetup('satellite');disk.fail('stat',path,2,missing());
  assert.deepEqual(await cache.get(4,0,0),next);assert.equal(network(),1);assert.equal(cache.lastError,'');assert.equal(cache.stats.entries,1);
});
test('stat EIO probing a file restored after initialization retries without network or writes',async()=>{
  const {disk,cache,path,data,network}=tileSetup('satellite');cache.online=false;disk.files.delete(path);
  await assert.rejects(cache.get(4,0,0),/未缓存/);disk.files.set(path,data);disk.fail('stat',path);
  await assert.rejects(cache.get(4,0,0),/暂不可读.*EIO/);assert.deepEqual(disk.mutations(),[]);assert.equal(network(),0);
  assert.deepEqual(await cache.get(4,0,0),data);assert.equal(cache.lastError,'');assert.equal(cache.stats.entries,1);
});
test('a later confirmed corruption can heal remotely and clears the previous temporary error',async()=>{
  const {disk,cache,path,next,network}=tileSetup('satellite');disk.fail('readBinary',path);
  await assert.rejects(cache.get(4,0,0),/EIO/);disk.files.set(path,new Uint8Array([1,2]).buffer);
  assert.deepEqual(await cache.get(4,0,0),next);assert.equal(cache.lastError,'');assert.equal(network(),1);
});
test('a transient stat failure after prior earth validation does not seed or lose the validated file',async()=>{
  const {disk,cache,network}=earthSetup();cache.online=false;await cache.resolve('runtime-assets/'+spec.name);const before=hash(disk.files.get(earthPath)!);
  disk.fail('stat',earthPath);assert.equal(await cache.resolve('runtime-assets/'+spec.name),bundlePath);assert.match(cache.lastError,/EIO/);
  assert.equal(await cache.resolve('runtime-assets/'+spec.name),earthPath);assert.equal(hash(disk.files.get(earthPath)!),before);assert.equal(disk.reads(bundlePath),0);assert.deepEqual(disk.mutations(),[]);assert.equal(network(),0);
});
