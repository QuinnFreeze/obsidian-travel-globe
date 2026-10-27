import {test} from 'node:test';import assert from 'node:assert/strict';import sharp from 'sharp';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
test('离线纹理尺寸、哈希与全球经纬方向匹配',async()=>{
 const manifest=JSON.parse(await readFile('assets/realistic/provenance.json','utf8'));
 for(const output of manifest.outputs){const bytes=await readFile(output.file),meta=await sharp(bytes).metadata();assert.equal(meta.width,output.width);assert.equal(meta.height,output.height);assert.equal(createHash('sha256').update(bytes).digest('hex'),output.sha256);}
 const pixel=async(kind:string,lat:number,lng:number)=>{const width=kind==='surface'?8192:4096;return [...await sharp('assets/realistic/'+(kind==='surface'?'surface-8k.jpg':'height-high.png')).extract({left:Math.floor((lng+180)/360*width),top:Math.floor((90-lat)/180*(width/2)),width:1,height:1}).raw().toBuffer()];};
 const amazon=await pixel('surface',-3,-60),sahara=await pixel('surface',24,10),ice=await pixel('surface',71,-42),ocean=await pixel('surface',0,-140);
 assert.ok(amazon[1]>amazon[0]&&amazon[1]>amazon[2]);assert.ok(sahara[0]>sahara[1]&&sahara[1]>sahara[2]);assert.ok(ice.every(c=>c>220));assert.ok(ocean.every(c=>c<30));
 assert.ok((await pixel('height',28,86))[0]>100);assert.equal((await pixel('height',0,-140))[0],0);
});

test('高清云层来自 8K 原图，4K 纹理保留超出旧 2K 放大的细节',async()=>{
 const source=await sharp('assets/upstream/nasa-clouds-8192.tif').metadata();assert.equal(source.width,8192);assert.equal(source.height,4096);
 const hd=await sharp('assets/realistic/clouds-hd-high.png').metadata(),ultra=await sharp('assets/realistic/clouds-hd-8k.png').metadata();assert.equal(hd.width,4096);assert.equal(ultra.width,8192);
 const detail=await sharp('assets/realistic/clouds-hd-high.png').toColourspace('b-w').raw().toBuffer();
 const enlarged=await sharp('assets/upstream/nasa-clouds-2048.jpg').resize(4096,2048,{kernel:'lanczos3'}).greyscale().toColourspace('b-w').raw().toBuffer();
 assert.equal(detail.length,enlarged.length);let squared=0;for(let i=0;i<detail.length;i++)squared+=(detail[i]-enlarged[i])**2;
 assert.ok(Math.sqrt(squared/detail.length)>1,'高清纹理不能只是旧图放大');
});
