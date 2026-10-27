import {test} from 'node:test';import assert from 'node:assert/strict';
import {PhotoPreviews} from '../src/photo-previews';
const file=(path:string,mtime=1)=>({path,stat:{mtime,size:8}});
test('previews deduplicate, limit concurrent source reads, evict LRU and refresh modified originals',async()=>{
 let active=0,peak=0,reads=0;const revoked:string[]=[];
 const cache=new PhotoPreviews(async()=>{reads++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,8));active--;return new ArrayBuffer(8);},async(_b,f)=>'preview:'+f.path+':'+f.stat.mtime,url=>revoked.push(url),2);
 const a=cache.get(file('a'));assert.equal(cache.get(file('a')),a);await a;assert.equal(await cache.get(file('a')),'preview:a:1');assert.equal(reads,1);
 await Promise.all(['b','c','d'].map(p=>cache.get(file(p))));assert.equal(peak,2);assert.ok(revoked.includes('preview:a:1'));
 await cache.get(file('d',2));assert.ok(revoked.includes('preview:d:1'));cache.dispose();assert.ok(revoked.includes('preview:d:2'));
 await assert.rejects(cache.get(file('a')),/关闭/);
});
test('late thumbnail completion after unload is revoked and failed generation can retry',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r),revoked:string[]=[];
 const cache=new PhotoPreviews(async()=>new ArrayBuffer(8),async()=>{await gate;return 'late';},url=>revoked.push(url));
 const pending=cache.get(file('a'));await new Promise(r=>setTimeout(r,0));cache.dispose();release();await assert.rejects(pending,/关闭/);assert.deepEqual(revoked,['late']);
 let attempts=0;const retry=new PhotoPreviews(async()=>{if(++attempts===1)throw Error('not synced');return new ArrayBuffer(8);},async()=> 'ok',()=>{});
 await assert.rejects(retry.get(file('a')),/not synced/);assert.equal(await retry.get(file('a')),'ok');retry.dispose();
});
