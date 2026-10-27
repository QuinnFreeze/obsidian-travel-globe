import {test} from 'node:test';import assert from 'node:assert/strict';import {chooseQuality,movingRenderScale} from '../src/quality';
const desktop={mobile:false,intel:false,cores:8,memory:8,maxTextureSize:8192,pixelRatio:2};
test('explicit 4K and 8K remain distinct and legacy high preserves desktop quality',()=>{
 assert.equal(chooseQuality('clear',desktop).width,4096);
 assert.equal(chooseQuality('ultra',desktop).width,8192);
 assert.equal(chooseQuality('high',desktop).width,8192);
 assert.equal(chooseQuality('high',{...desktop,maxTextureSize:4096}).width,4096);
 assert.equal(chooseQuality('auto',{...desktop,intel:true}).width,4096);
 assert.equal(chooseQuality('auto',desktop).width,8192);
 assert.equal(chooseQuality('low',desktop).pixelRatio,1);
});
test('GPU and memory limits are disclosed and all resource dimensions fit the budget',()=>{
 for(const quality of ['auto','low','standard','high','clear','ultra'] as const){
  for(const size of [1024,2048,4096,8192]){
   const p=chooseQuality(quality,{...desktop,maxTextureSize:size});
   assert.ok(p.width<=size);assert.ok(p.heightWidth<=size);assert.ok(p.cloudWidth<=size);
  }
 }
 assert.match(chooseQuality('ultra',{...desktop,maxTextureSize:2048}).reason,/纹理尺寸/);
 assert.match(chooseQuality('ultra',{...desktop,memory:2}).reason,/内存/);
 assert.equal(chooseQuality('high',{...desktop,memory:2}).tier,'standard');
 assert.throws(()=>chooseQuality('low',{...desktop,maxTextureSize:512}));
});
test('phones allow explicit 4K but bound unknown-memory devices and expose 8K downgrade',()=>{
 const phone={...desktop,mobile:true,memory:undefined,cores:6,maxTextureSize:16384,pixelRatio:3};
 assert.equal(chooseQuality('clear',phone).width,4096);
 assert.equal(chooseQuality('auto',phone).width,4096);
 assert.equal(chooseQuality('auto',phone).pixelRatio,1.5);
 assert.equal(chooseQuality('auto',phone).markerLimit,120);
 assert.equal(chooseQuality('auto',{...phone,cores:2}).width,1024);
 assert.equal(chooseQuality('auto',{...phone,memory:2}).tier,'low');
 assert.equal(chooseQuality('ultra',phone).width,4096);
 assert.match(chooseQuality('ultra',phone).reason,/手机/);
 assert.equal(chooseQuality('standard',{...phone,maxTextureSize:1024}).width,1024);
 assert.equal(chooseQuality('ultra',desktop).heightWidth,2048);
 assert.equal(chooseQuality('ultra',desktop).cloudWidth,8192);
 assert.equal(chooseQuality('clear',desktop).cloudWidth,4096);
 assert.equal(chooseQuality('ultra',phone).cloudWidth,2048);
});

test('moving rendering adapts only auto, never increases pixels, and retains explicit quality',()=>{
 assert.equal(movingRenderScale('auto',1.5,{mobile:false,intel:true}),.85);
 assert.equal(movingRenderScale('auto',1.5,{mobile:true,intel:false}),1);
 assert.equal(movingRenderScale('auto',.75,{mobile:false,intel:true}),.75);
 for(const request of ['low','standard','clear','ultra','high'] as const)
  assert.equal(movingRenderScale(request,2,{mobile:false,intel:true}),2);
});
