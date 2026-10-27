import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdir,open,unlink,writeFile} from 'node:fs/promises';
import {isIsolatedQaVault} from './qa-vault-guard.mjs';
export const repo=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
export const qa=process.env.TRAVEL_GLOBE_QA_DIR||join(tmpdir(),'travel-globe-qa-output');
export const {chromium}=createRequire(repo+'/package.json')('playwright');
export async function host(label){
 await mkdir(qa,{recursive:true});const lock=qa+'/host.lock';const fd=await open(lock,'wx').catch(()=>{throw Error('Another QA script owns the host; refuse concurrent measurements');});await fd.writeFile(String(process.pid));
 let browser;
 try{browser=await chromium.connectOverCDP('http://127.0.0.1:9224');const context=browser.contexts()[0];const page=context.pages().find(p=>p.url().includes('index.html'));if(!page)throw Error('Obsidian host page missing');
 await layoutReady(page);const identity=await page.evaluate(()=>({url:location.href,title:document.title,vault:app.vault.adapter.basePath,version:app.plugins.plugins['travel-globe']?.manifest.version}));
 if(!isIsolatedQaVault(identity.vault))throw Error('Not exact isolated QA Vault: '+identity.vault);
 const original=await page.evaluate(()=>({...app.plugins.plugins['travel-globe'].settings}));const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await page.bringToFront();const errors=[];const warnings=[];
 page.on('pageerror',e=>errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});
 // Obsidian's requestUrl bypasses browser request interception. Both plugin gates and cache gates must be false.
 await page.evaluate(async()=>{const t=app.plugins.plugins['travel-globe'];await t.updateSettings({satelliteOnline:false,earthOnline:false});t.satelliteCache.online=t.terrainCache.online=t.earthResources.online=false;});await context.setOffline(false);await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/,route=>route.abort('internetdisconnected'));
 return{browser,context,page,cdp,identity,original,errors,warnings,async save(name,data){await writeFile(qa+'/'+name+'.json',JSON.stringify({date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),label,fallback:'Browser plugin not available',identity,errors,warnings,...data},null,2));},async close(){try{await context.unrouteAll({behavior:'wait'});await context.setOffline(false);await cdp.send('Emulation.clearDeviceMetricsOverride');await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await layoutReady(page);if(await page.evaluate(()=>app.isMobile))await emulateMobile(page,false);const currentVault=await page.evaluate(()=>app.vault.adapter.basePath);if(!isIsolatedQaVault(currentVault))throw Error('Vault changed');await page.evaluate(async({original,expected})=>{if(app.vault.adapter.basePath!==expected)throw Error('Vault changed');await app.plugins.plugins['travel-globe'].updateSettings({...original,earthOnline:false,satelliteOnline:false});},{original,expected:currentVault});}finally{await browser.close();await fd.close();await unlink(lock);}}};
 }catch(e){await browser?.close();await fd.close();await unlink(lock);throw e;}
}
export async function layoutReady(page){await page.waitForFunction(()=>typeof app!=='undefined'&&app.workspace?.layoutReady&&!!app.plugins?.plugins?.['travel-globe']?.terrainCache&&!!app.plugins.plugins['travel-globe'].store,{},{timeout:30000});}
export async function emulateMobile(page,enabled){
 await layoutReady(page);if(await page.evaluate(enabled=>app.isMobile===enabled,enabled))return;
 const token=await page.evaluate(()=>window.__qaDocumentToken=crypto.randomUUID());await page.evaluate(enabled=>app.emulateMobile(enabled),enabled);
 await page.waitForFunction(({token,enabled})=>window.__qaDocumentToken!==token&&typeof app!=='undefined'&&app.isMobile===enabled&&app.workspace?.layoutReady&&!!app.plugins?.plugins?.['travel-globe']?.terrainCache,{token,enabled},{timeout:30000});await layoutReady(page);
 await page.evaluate(()=>{const t=app.plugins.plugins['travel-globe'];t.satelliteCache.online=t.terrainCache.online=t.earthResources.online=false;});
}
export async function ready(page){await page.waitForFunction(()=>{if(typeof app==='undefined'||!app.workspace?.layoutReady)return false;const leaf=app.workspace.getLeavesOfType('travel-globe-view')[0],e=document.querySelector('.tg-canvas');return app.workspace.activeLeaf===leaf&&e?.clientWidth>0&&e?.clientHeight>0&&e.dataset.rendering!=='paused'&&e.dataset.surfaceReady==='true'&&!!leaf?.view.globe?.instance?.scene;},{},{timeout:60000});}
export async function openView(page){await layoutReady(page);await page.evaluate(async()=>{await app.plugins.plugins['travel-globe'].activateView();});await ready(page);}
export async function closeView(page){await layoutReady(page);await page.evaluate(async()=>{
 let anchor=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file);if(!anchor){anchor=app.workspace.getLeaf('tab');const path=app.plugins.plugins['travel-globe'].store.records[0]?.path,file=path?app.vault.getAbstractFileByPath(path):app.vault.getMarkdownFiles()[0];if(!file)throw Error('QA requires a read-only note anchor');await anchor.openFile(file);}
 await app.workspace.revealLeaf(anchor);app.workspace.setActiveLeaf(anchor,{focus:true});app.workspace.detachLeavesOfType('travel-globe-view');
});}
export async function viewport(cdp,width,height,mobile=false,dpr=1){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile});}
export async function surface(page){return page.evaluate(()=>{const v=app.workspace.getLeavesOfType('travel-globe-view')[0]?.view,g=v?.globe,w=g?.instance,c=w?.canvas;const gl=c?.getContext('webgl2'),ext=gl?.getExtension('WEBGL_debug_renderer_info');return{surfaceImages:g?.surfaceImages?.size,surfaceDecoders:g?.surfaceDecoders?.size,gpu:gl?(ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)):null,engine:document.querySelector('.tg-canvas')?.dataset.engine,dataset:{...document.querySelector('.tg-canvas')?.dataset},profile:g?.profile,css:c?{width:c.clientWidth,height:c.clientHeight}:null,pixels:c?{width:c.width,height:c.height,ratioX:c.width/c.clientWidth,ratioY:c.height/c.clientHeight}:null,imageryLayers:w?.scene.imageryLayers.length,tilesLoaded:w?.scene.globe.tilesLoaded,canvases:document.querySelectorAll('.tg-canvas canvas').length,places:v?.places?.length,records:v?.plugin.store.records.length};});}
