import {test} from 'node:test';import assert from 'node:assert/strict';
import {GlobalHeightField,terrariumHeight,validTerrainPng,createTerrainCache} from '../src/terrain-data';
import type {TileDisk} from '../src/tile-cache';
class Disk implements TileDisk {
 files=new Map<string,ArrayBuffer>();folders=new Set<string>();
 async exists(p:string){return this.files.has(p)||this.folders.has(p);}async mkdir(p:string){this.folders.add(p);}
 async list(p:string){return {files:[...this.files.keys()].filter(k=>k.startsWith(p+'/')),folders:[]};}
 async stat(p:string){const a=this.files.get(p);return a?{size:a.byteLength,mtime:Date.now()}:null;}
 async readBinary(p:string){const a=this.files.get(p);if(!a)throw Error('missing');return a;}
 async writeBinary(p:string,a:ArrayBuffer){this.files.set(p,a);}async remove(p:string){this.files.delete(p);}
}
function png(){const a=new Uint8Array(40);a.set([137,80,78,71,13,10,26,10]);new DataView(a.buffer).setUint32(16,256);new DataView(a.buffer).setUint32(20,256);return a.buffer;}
test('Terrarium decodes signed metres and fractions without color/gamma interpretation',()=>{
 assert.equal(terrariumHeight(128,0,0),0);assert.equal(terrariumHeight(137,219,68),2523.265625);assert.equal(terrariumHeight(127,255,128),-.5);
 assert.ok(validTerrainPng(png()));assert.equal(validTerrainPng(new ArrayBuffer(8)),false);
 const a=png();new DataView(a).setUint32(16,512);assert.equal(validTerrainPng(a),false);
});
test('coarse height field is north-up, bilinear, finite at poles and wraps date line',()=>{
 const a=new Uint8ClampedArray(4*2*4);for(let row=0;row<2;row++)for(let col=0;col<4;col++)a[(row*4+col)*4]=row===0?255:0;
 const field=new GlobalHeightField(a,4,2);assert.equal(field.sample(90,0),6400);assert.equal(field.sample(-90,0),0);assert.equal(field.sample(0,0),3200);assert.equal(field.sample(20,180),field.sample(20,-180));
});
test('terrain tiles use separate PNG keys, cache offline and only clear their managed files',async()=>{
 const disk=new Disk();let urls:string[]=[];
 const cache=createTerrainCache(disk,'earth/terrain',async url=>{urls.push(url);return png();});
 await Promise.all([cache.get(4,-1,3),cache.get(4,15,3)]);assert.equal(urls.length,1);assert.match(urls[0],/terrarium\/4\/15\/3.png$/);
 assert.ok(disk.files.has('earth/terrain/terrain-v1-4-15-3.png'));
 const offline=createTerrainCache(disk,'earth/terrain',async()=>{throw Error('network');});offline.online=false;assert.deepEqual(await offline.get(4,15,3),png());
 disk.files.set('earth/terrain/user.md',png());disk.files.set('earth/terrain/eox2024-4-0-0.jpg',png());await offline.clear();
 assert.ok(disk.files.has('earth/terrain/user.md'));assert.ok(disk.files.has('earth/terrain/eox2024-4-0-0.jpg'));assert.ok(!disk.files.has('earth/terrain/terrain-v1-4-15-3.png'));
});
test('terrain unload prevents in-flight data from repopulating the vault',async()=>{
 const disk=new Disk();let finish!:(a:ArrayBuffer)=>void;
 const cache=createTerrainCache(disk,'terrain',()=>new Promise<ArrayBuffer>(r=>{finish=r;}));
 const loading=cache.get(3,1,2);while(!finish)await new Promise(r=>setTimeout(r,0));cache.stop();finish(png());await loading;assert.equal(disk.files.size,0);
});

test('coarse height decoding caps CPU pixels independently of the surface texture and releases canvas',async()=>{
 const {readHeightField}=await import('../src/terrain-data');
 const originalImage=globalThis.Image,originalDocument=globalThis.document;let drawn:number[]=[];
 const canvas={width:0,height:0,getContext:()=>({drawImage:(_image:unknown,_x:number,_y:number,w:number,h:number)=>{drawn=[w,h];},getImageData:(_x:number,_y:number,w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)})})};
 class MockImage {width=8192;height=4096;onload?:()=>void;onerror?:()=>void;set src(value:string){if(value)queueMicrotask(()=>this.onload?.());}}
 try{
  Object.assign(globalThis,{Image:MockImage,document:{createElement:()=>canvas}});
  const field=await readHeightField('height-test',1024);
  assert.equal(field.width,1024);assert.equal(field.height,512);assert.deepEqual(drawn,[1024,512]);assert.equal(field.data.byteLength,2*1024*1024);
  assert.equal(canvas.width,1);assert.equal(canvas.height,1);
 }finally{Object.assign(globalThis,{Image:originalImage,document:originalDocument});}
});
