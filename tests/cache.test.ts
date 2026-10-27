import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SatelliteCache,tileKey,type TileDisk} from '../src/tile-cache';
class Disk implements TileDisk {
 files=new Map<string,ArrayBuffer>();folders=new Set<string>();
 async exists(p:string){return this.files.has(p)||this.folders.has(p);}
 async mkdir(p:string){this.folders.add(p);}
 async list(p:string){return {files:[...this.files.keys()].filter(k=>k.startsWith(p+'/')),folders:[]};}
 async stat(p:string){const b=this.files.get(p);return b?{size:b.byteLength,mtime:1}:null;}
 async readBinary(p:string){const b=this.files.get(p);if(!b)throw Error('missing');return b;}
 async writeBinary(p:string,b:ArrayBuffer){this.files.set(p,b);}
 async remove(p:string){this.files.delete(p);}
}
const jpg=()=>new Uint8Array([255,216,1,2,3,4,255,217]).buffer;
test('tile wrap uses WGS84 longitude with XYZ north-up rows; invalid requests never escape cache',()=>{
 assert.equal(tileKey(4,-1,2),'eox2024-4-15-2.jpg');assert.equal(tileKey(4,16,2),'eox2024-4-0-2.jpg');
 for(const args of [[15,0,0],[4,0,-1],[4,0,16],[1.5,0,0]])assert.throws(()=>tileKey(...args as [number,number,number]));
});
test('persisted satellite tiles reload after restart offline, same-key work deduplicates',async()=>{
 const disk=new Disk();let calls=0;
 const a=new SatelliteCache(disk,'plugin/cache',async()=>{calls++;return jpg();});
 await Promise.all([a.get(4,0,0),a.get(4,0,0)]);assert.equal(calls,1);
 const b=new SatelliteCache(disk,'plugin/cache',async()=>{throw Error('network called');});b.online=false;
 assert.deepEqual(await b.get(4,0,0),jpg());assert.equal(b.stats.hits,1);await assert.rejects(b.get(4,1,0),/未缓存/);
});
test('corrupt, HTML and failed writes cannot masquerade as successfully cached imagery',async()=>{
 const disk=new Disk();await disk.mkdir('cache');disk.files.set('cache/eox2024-4-0-0.jpg',new Uint8Array([1,2]).buffer);
 const cache=new SatelliteCache(disk,'cache',async()=>new TextEncoder().encode('<html>error</html>').buffer);
 await assert.rejects(cache.get(4,0,0),/无效影像/);assert.equal(cache.stats.downloads,0);
 const bad=new SatelliteCache(disk,'second',async()=>jpg());disk.writeBinary=async()=>{throw Error('disk full');};assert.deepEqual(await bad.get(4,1,0),jpg());assert.match(bad.lastError,/disk full/);assert.equal(bad.stats.entries,0);
});
test('cache evicts within budget and clearing only removes its own satellite files',async()=>{
 const disk=new Disk();disk.files.set('cache/user.md',new Uint8Array([1]).buffer);
 const cache=new SatelliteCache(disk,'cache',async()=>jpg());cache.limitBytes=16;
 for(let i=0;i<5;i++)await cache.get(4,i,0);
 assert.equal(cache.stats.entries,2);assert.equal(cache.stats.bytes,16);
 await cache.clear();assert.equal(cache.stats.entries,0);assert.ok(disk.files.has('cache/user.md'));
});
test('network concurrency remains at four and clear prevents active downloads repopulating disk',async()=>{
 const disk=new Disk();let active=0,peak=0;
 const cache=new SatelliteCache(disk,'cache',async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return jpg();});
 const requests=Array.from({length:16},(_,i)=>cache.get(4,i,0));await Promise.all(requests);assert.equal(peak,4);
 const next=cache.get(4,0,1);const clear=cache.clear();await Promise.all([next,clear]);assert.equal(cache.stats.entries,0);
});

test('transient cache initialization failure is recoverable on retry',async()=>{
 const disk=new Disk();const list=disk.list.bind(disk);let first=true;
 disk.list=async path=>{if(first){first=false;throw Error('暂时无法读取缓存');}return list(path);};
 const cache=new SatelliteCache(disk,'cache',async()=>jpg());
 await assert.rejects(cache.get(4,0,0),/暂时无法读取/);
 assert.deepEqual(await cache.get(4,0,0),jpg());assert.equal(cache.stats.entries,1);
});

test('clearing removes corrupt tiles even after an offline read dropped their index entry',async()=>{
 const disk=new Disk();disk.files.set('cache/eox2024-4-0-0.jpg',new Uint8Array([1,2]).buffer);disk.files.set('cache/user.md',jpg());
 const cache=new SatelliteCache(disk,'cache',async()=>jpg());cache.online=false;
 await assert.rejects(cache.get(4,0,0),/未缓存/);assert.equal(cache.stats.entries,0);
 await cache.clear();assert.ok(!disk.files.has('cache/eox2024-4-0-0.jpg'));assert.ok(disk.files.has('cache/user.md'));
});

test('stale satellite returns immediately, refreshes in background, and survives failed refresh',async()=>{
 const disk=new Disk();const old=jpg(),next=new Uint8Array([255,216,9,8,7,6,255,217]).buffer;
 disk.files.set('cache/eox2024-4-0-0.jpg',old);let release!:()=>void,calls=0;
 const gate=new Promise<void>(r=>release=r);const cache=new SatelliteCache(disk,'cache',async()=>{calls++;await gate;return next;});
 assert.deepEqual(await cache.get(4,0,0),old);release();await cache.settled();assert.equal(calls,1);assert.deepEqual(disk.files.get('cache/eox2024-4-0-0.jpg'),next);
 const failing=new SatelliteCache(disk,'cache',async()=>{throw Error('offline');});assert.deepEqual(await failing.get(4,0,0),next);await failing.settled();assert.deepEqual(disk.files.get('cache/eox2024-4-0-0.jpg'),next);
});
test('legacy cache migrates on demand while preserving old files, including offline use',async()=>{
 const disk=new Disk();disk.files.set('plugin/old/eox2024-4-0-0.jpg',jpg());const cache=new SatelliteCache(disk,'地球资源/卫星影像',async()=>{throw Error('unexpected');});cache.legacyFolder='plugin/old';cache.online=false;
 assert.deepEqual(await cache.get(4,0,0),jpg());assert.ok(disk.files.has('plugin/old/eox2024-4-0-0.jpg'));assert.ok(disk.files.has('地球资源/卫星影像/eox2024-4-0-0.jpg'));
});
