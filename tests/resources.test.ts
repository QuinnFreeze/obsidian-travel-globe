import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EarthResources,EARTH_RESOURCES,RESOURCE_TTL,type ResourceDisk} from '../src/earth-resources';
const jpeg=(value=1)=>new Uint8Array([255,216,value,255,217]).buffer;
class Disk implements ResourceDisk {
  files=new Map<string,ArrayBuffer>();folders=new Set<string>();failRename=false;
  async exists(p:string){return this.files.has(p)||this.folders.has(p);}
  async mkdir(p:string){this.folders.add(p);}
  async read(p:string){return new TextDecoder().decode(await this.readBinary(p));}
  async write(p:string,s:string){await this.writeBinary(p,new TextEncoder().encode(s).buffer);}
  async readBinary(p:string){const b=this.files.get(p);if(!b)throw Error('missing');return b;}
  async writeBinary(p:string,b:ArrayBuffer){this.files.set(p,b);}
  async rename(a:string,b:string){if(this.failRename)throw Error('disk full');this.files.set(b,await this.readBinary(a));this.files.delete(a);}
  async remove(p:string){this.files.delete(p);}
}
const spec=EARTH_RESOURCES[0],path='地球资源/全球底图/'+spec.name;
function setup(){const disk=new Disk();disk.files.set('bundle/runtime-assets/'+spec.name,jpeg());return disk;}
test('first offline open seeds the vault; restart loads locally without the installation texture',async()=>{
  const disk=setup();const cache=new EarthResources(disk,'bundle',async()=>{throw Error('network');},async b=>b);cache.online=false;
  assert.equal(await cache.resolve('runtime-assets/'+spec.name),path);assert.deepEqual(disk.files.get(path),jpeg());
  disk.files.delete('bundle/runtime-assets/'+spec.name);
  const next=new EarthResources(disk,'bundle',async()=>{throw Error('network');},async b=>b);next.online=false;
  assert.equal(await next.resolve('runtime-assets/'+spec.name),path);
});
test('stale local image returns before remote finishes; conditional 304 avoids conversion and respects TTL',async()=>{
  const disk=setup();let now=100,calls=0,convert=0,release!:()=>void,seen={};
  const gate=new Promise<void>(r=>release=r);
  const cache=new EarthResources(disk,'bundle',async(_url,headers)=>{seen=headers;calls++;await gate;return {status:calls===1?200:304,headers:{ETag:'v1'},data:jpeg(2)};},async b=>{convert++;return b;},()=>now);
  assert.equal(await cache.resolve('runtime-assets/'+spec.name),path);assert.deepEqual(disk.files.get(path),jpeg());release();await cache.settled();
  assert.deepEqual(disk.files.get(path),jpeg(2));await cache.resolve('runtime-assets/'+spec.name);await cache.settled();assert.equal(calls,1);
  now+=RESOURCE_TTL+1;await cache.refresh(spec);assert.equal(calls,2);assert.equal(convert,1);assert.deepEqual(seen,{'If-None-Match':'v1'});
});
test('network failures, invalid content and conversion failure preserve the old file',async()=>{
  for(const failure of ['network','html','decode']){
    const disk=setup();const cache=new EarthResources(disk,'bundle',async()=>{if(failure==='network')throw Error('offline');return {status:200,headers:{},data:failure==='html'?new TextEncoder().encode('<html>').buffer:jpeg(2)};},async()=>{throw Error('decode');});
    await cache.resolve('runtime-assets/'+spec.name);await cache.settled();assert.deepEqual(disk.files.get(path),jpeg());assert.match(cache.lastError,/保留本地/);assert.ok(!disk.files.has(path+'.json'));
  }
});
test('failed atomic replacement preserves the last good image and cleans temp files',async()=>{
  const disk=setup();disk.files.set(path,jpeg());disk.failRename=true;
  const cache=new EarthResources(disk,'bundle',async()=>({status:200,headers:{},data:jpeg(2)}),async b=>b);
  await cache.resolve('runtime-assets/'+spec.name);await cache.settled();assert.deepEqual(disk.files.get(path),jpeg());assert.ok(!disk.files.has(path+'.tmp'));assert.match(cache.lastError,/disk full/);
});
test('concurrent opens deduplicate downloads; unload prevents writing an in-flight result',async()=>{
  const disk=setup();let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const cache=new EarthResources(disk,'bundle',async()=>{calls++;await gate;return {status:200,headers:{},data:jpeg(2)};},async b=>b);
  await Promise.all(Array.from({length:8},()=>cache.resolve('runtime-assets/'+spec.name)));cache.stop();release();await cache.settled();assert.equal(calls,1);assert.deepEqual(disk.files.get(path),jpeg());
});
test('failed local writes fall back to packaged resources without breaking rendering',async()=>{
  const disk=setup();disk.writeBinary=async()=>{throw Error('disk full');};const cache=new EarthResources(disk,'bundle',async()=>{throw Error('unexpected');},async b=>b);
  assert.equal(await cache.resolve('runtime-assets/'+spec.name),'bundle/runtime-assets/'+spec.name);assert.match(cache.lastError,/使用安装包/);
});

test('replacement failure after moving the old image rolls back, and interrupted replacements recover offline',async()=>{
 const disk=setup();disk.files.set(path,jpeg());const rename=disk.rename.bind(disk);disk.rename=async(a,b)=>{if(a.endsWith('.tmp'))throw Error('interrupted');await rename(a,b);};
 const cache=new EarthResources(disk,'bundle',async()=>({status:200,headers:{},data:jpeg(2)}),async b=>b);await cache.resolve('runtime-assets/'+spec.name);await cache.settled();assert.deepEqual(disk.files.get(path),jpeg());assert.ok(!disk.files.has(path+'.previous'));
 disk.files.delete(path);disk.files.set(path+'.previous',jpeg(3));const next=new EarthResources(disk,'bundle',async()=>{throw Error('unexpected');},async b=>b);next.online=false;assert.equal(await next.resolve('runtime-assets/'+spec.name),path);assert.deepEqual(disk.files.get(path),jpeg(3));
});

test('高清 TIFF 云层使用新缓存名，离线首次打开不会误用旧 2K 文件',async()=>{
 const cloud=EARTH_RESOURCES.find(s=>s.name==='clouds-hd-high.png')!;assert.equal(cloud.width,4096);assert.equal(cloud.sourceWidth,8192);assert.equal(cloud.format,'tiff');
 const disk=new Disk(),png=new Uint8Array([137,80,78,71,13,10,26,10,1]).buffer;disk.files.set('bundle/runtime-assets/'+cloud.name,png);disk.files.set('地球资源/全球底图/clouds-high.png',jpeg());
 const cache=new EarthResources(disk,'bundle',async()=>{throw Error('network');},async b=>b);cache.online=false;
 assert.equal(await cache.resolve('runtime-assets/'+cloud.name),'地球资源/全球底图/'+cloud.name);assert.deepEqual(disk.files.get('地球资源/全球底图/'+cloud.name),png);assert.ok(disk.files.has('地球资源/全球底图/clouds-high.png'));
});

test('repeated opens reuse validation while stat changes invalidate it and repair corrupt files',async()=>{
 const disk=setup();let revision=1,reads=0;
 const withStat=disk as Disk&{stat:(p:string)=>Promise<{size:number;mtime:number}|null>};
 withStat.stat=async p=>{const file=disk.files.get(p);return file?{size:file.byteLength,mtime:revision}:null;};
 const read=disk.readBinary.bind(disk);disk.readBinary=async p=>{if(p===path)reads++;return read(p);};
 const cache=new EarthResources(withStat,'bundle',async()=>{throw Error('unused');},async b=>b);cache.online=false;
 await cache.resolve('runtime-assets/'+spec.name);const version=await cache.version(path);
 await cache.resolve('runtime-assets/'+spec.name);await cache.resolve('runtime-assets/'+spec.name);
 assert.equal(reads,0);assert.equal(await cache.version(path),version);
 revision++;disk.files.set(path,new Uint8Array([1,2,3,4,5]).buffer);
 assert.notEqual(await cache.version(path),version);
 await cache.resolve('runtime-assets/'+spec.name);assert.ok(reads>0);assert.deepEqual(disk.files.get(path),jpeg());
 const repairedReads=reads;await cache.resolve('runtime-assets/'+spec.name);assert.equal(reads,repairedReads);
});
test('adapters without stat keep checking contents and recover after a failed first seed',async()=>{
 const disk=setup(),write=disk.writeBinary.bind(disk);let fail=true;
 disk.writeBinary=async(p,b)=>{if(fail)throw Error('temporary sync error');return write(p,b);};
 const cache=new EarthResources(disk,'bundle',async()=>{throw Error('unused');},async b=>b);cache.online=false;
 assert.match(await cache.resolve('runtime-assets/'+spec.name),/^bundle/);
 fail=false;assert.equal(await cache.resolve('runtime-assets/'+spec.name),path);
 disk.files.set(path,new ArrayBuffer(1));await cache.resolve('runtime-assets/'+spec.name);
 assert.deepEqual(disk.files.get(path),jpeg());
});
