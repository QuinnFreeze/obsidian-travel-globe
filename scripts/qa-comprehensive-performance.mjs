import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {host,openView,closeView,viewport,surface,ready} from './qa-cesium-host.mjs';
const expectedVersion=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8')).version;
const h=await host('comprehensive-performance'),{page,cdp}=h,results=[];
try{
 assert.equal(h.identity.version,expectedVersion);await viewport(cdp,1440,1000);
 for(const style of ['natural','atlas']){
  await page.evaluate(async style=>{app.workspace.leftSplit?.collapse();app.workspace.rightSplit?.collapse();await app.plugins.plugins['travel-globe'].updateSettings({quality:'clear',mapStyle:style,listOnly:false,showClouds:false,showBorders:false,showCountryNames:false,atlasBorders:true,atlasLabels:true});},style);
  await openView(page);const samples=[];
  for(let i=0;i<3;i++){
   await closeView(page);const started=Date.now();await openView(page);
   await page.waitForFunction(style=>{const e=document.querySelector('.tg-canvas');return e?.dataset.activeMapStyle===style&&e?.dataset.activeTexture==='4096';},style,{timeout:60000});
   samples.push({elapsedMs:Date.now()-started,surface:await surface(page)});
  }
  await page.evaluate(()=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe;g.reset();});
  await page.waitForFunction(()=>app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe.instance.scene.tweens.length===0);
  const settled=await page.evaluate(async()=>{const s=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe.instance.scene;const start=performance.now();let last=start;const remove=s.postRender.addEventListener(()=>last=performance.now());try{while(performance.now()-start<20000){if(s.globe.tilesLoaded&&s.tweens.length===0&&performance.now()-last>=1200)return{settleMs:performance.now()-start,tilesLoaded:true};await new Promise(r=>setTimeout(r,100));}throw Error('资源和相机未进入1200ms无绘制稳定窗口');}finally{remove();}});
  const idle=await page.evaluate(async()=>{const s=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe.instance.scene;let frames=0;const remove=s.postRender.addEventListener(()=>frames++);await new Promise(r=>setTimeout(r,3000));remove();return{durationMs:3000,frames};});
  assert.ok(idle.frames<=3,'静止按需渲染不应持续空转:'+JSON.stringify(idle));
  const measured=page.evaluate(async()=>{const s=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe.instance.scene,intervals=[];let previous;const remove=s.postRender.addEventListener(()=>{const now=performance.now();if(previous!==undefined)intervals.push(now-previous);previous=now;});await new Promise(r=>setTimeout(r,2400));remove();const sorted=[...intervals].sort((a,b)=>a-b);return{renderedFrames:intervals.length,medianMs:sorted[Math.floor(sorted.length*.5)]??null,p95Ms:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]??null};});
  const box=await page.locator('.tg-canvas').boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();
  for(let i=0;i<30;i++){await page.mouse.move(box.x+box.width*(.5+.12*Math.sin(i/8)),box.y+box.height*(.5+.06*Math.cos(i/8)));await page.waitForTimeout(45);}
  await page.mouse.up();const active=await measured;const sorted=samples.map(row=>row.elapsedMs).sort((a,b)=>a-b);
  results.push({style,quality:'clear',viewport:[1440,1000],sampleCount:samples.length,hotReopenMedianMs:sorted[1],hotReopenP95Ms:sorted[2],samples,settled,idle,active,surface:await surface(page)});
 }
 assert.deepEqual(h.errors,[]);
 await h.save('宿主-双模式性能',{results,limitations:['每模式只有3个热重开样本；P95在该样本数下为最大值，不是可靠尾部统计','不是进程冷启动；不外推60/30fps目标或长期耗电','固定桌面Electron/Intel环境，不代表实体手机']});
 console.log(JSON.stringify({results:results.map(({samples,...row})=>row),errors:h.errors,warnings:h.warnings},null,2));
}finally{await h.close();}
