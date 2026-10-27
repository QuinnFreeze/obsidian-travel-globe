import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {host,openView,ready} from './qa-cesium-host.mjs';
const expectedVersion=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8')).version;
const h=await host('atlas-'+expectedVersion+'-edge'),{page}=h,checks=[];
try{
 assert.equal(h.identity.version,expectedVersion);await openView(page);
 await page.evaluate(async()=>{const t=app.plugins.plugins['travel-globe'];await t.updateSettings({quality:'clear',mapStyle:'natural',showClouds:true,listOnly:false});});
 await page.waitForFunction(()=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0]?.view?.globe;return g?.currentMapStyle==='natural'&&g.cloudShell?.show;},{},{timeout:60000});
 await page.evaluate(()=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe;g.__qaResource=g.resourceUrl;g.resourceUrl=path=>{if(path.includes('atlas-surface'))throw Error('QA injected atlas read failure');return g.__qaResource(path);};});
 await page.locator('[aria-label="底图风格"]').selectOption('atlas');
 await page.waitForFunction(()=>{const t=app.plugins.plugins['travel-globe'],g=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe;return t.settings.mapStyle==='natural'&&g.currentMapStyle==='natural'&&g.requestedMapStyle==='natural'&&g.cloudShell?.show;},{},{timeout:30000});
 const restored=await page.evaluate(async()=>{const t=app.plugins.plugins['travel-globe'],g=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe;let calls=0;const cacheGet=g.cache.get;g.cache.get=()=>{calls++;return Promise.reject(Error('QA cache spy'));};try{await g.satelliteProvider.requestImage(0,0,0)?.catch(()=>{});}finally{g.cache.get=cacheGet;g.resourceUrl=g.__qaResource;delete g.__qaResource;}return{style:t.settings.mapStyle,requested:g.requestedMapStyle,active:g.currentMapStyle,clouds:g.cloudShell.show,cacheCalls:calls,dropdown:document.querySelector('[aria-label="底图风格"]').value};});
 assert.deepEqual(restored,{style:'natural',requested:'natural',active:'natural',clouds:true,cacheCalls:1,dropdown:'natural'});checks.push({name:'损坏专题资源回滚模式、控件与自然云层/卫星请求',status:'pass',detail:restored});
 await page.evaluate(()=>app.plugins.plugins['travel-globe'].updateSettings({mapStyle:'atlas',atlasBorders:false,atlasLabels:true,showClouds:false}));
 await page.waitForFunction(()=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe;return g.currentMapStyle==='atlas'&&g.atlasLayers?.lastLabels>0;},{},{timeout:30000});
 const old=await page.evaluate(()=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe;g.atlasLayers.lastLabels=performance.now();g.instance.camera.rotateRight(.01);g.instance.scene.requestRender();return g.atlasLayers.lastLabels;});
 await page.waitForFunction(before=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe;return g.atlasLayers.lastLabels>before&&!g.atlasLayers.dirty;},old,{timeout:5000});
 checks.push({name:'只开国家名时短于100ms的相机调整仍完成节流尾帧',status:'pass'});
 const owner=await page.evaluate(()=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe;return{document:g.ownerDoc===g.el.ownerDocument,window:g.ownerWin===g.el.ownerDocument.defaultView,visible:g.isRenderable(),pointerHandler:typeof g.pointerUp};});
 assert.equal(owner.document,true);assert.equal(owner.window,true);assert.equal(owner.visible,true);checks.push({name:'事件与可见性使用实际所属文档/窗口',status:'pass',detail:owner,limitation:'未模拟实际Obsidian跨进程popout或最小化主窗口'});
 assert.deepEqual(h.errors,[]);await h.save('边缘路径验收',{checks,limitations:['跨进程popout、实体手机未验收']});console.log(JSON.stringify({checks,errors:h.errors,warnings:h.warnings},null,2));
}finally{
 await page.evaluate(()=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0]?.view?.globe;if(g?.__qaResource){g.resourceUrl=g.__qaResource;delete g.__qaResource;}}).catch(()=>{});
 await h.close();
}
