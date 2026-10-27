import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {host,openView,closeView,viewport,emulateMobile,qa} from './qa-cesium-host.mjs';
const expected=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8')).version;
const h=await host('recovery-'+expected),{page,cdp}=h,checks=[];
const city='QA091虚构跨年旅行',body='仅用于隔离宿主验收，不是用户经历。';
const initial=await page.evaluate(()=>app.vault.getFiles().map(f=>f.path));
const hashes=new Map(await Promise.all(initial.map(async p=>[p,createHash('sha256').update(await readFile(h.identity.vault+'/'+p)).digest('hex')])));
let created=[];
try{
 assert.equal(h.identity.version,expected);await viewport(cdp,1440,1000);
 await page.evaluate(()=>app.plugins.plugins['travel-globe'].updateSettings({mapStyle:'natural',quality:'standard',listOnly:false}));await openView(page);
 await page.getByRole('button',{name:'＋ 添加足迹',exact:true}).click();
 for(const [key,value]of Object.entries({city,country_name:'中国',country_code:'CN',latitude:'31.25',longitude:'121.49',date:'2026-12-31',end_date:'2027-01-01',body}))await page.locator('.tg-form [name='+key+']').fill(value);
 await page.locator('.tg-form [name=time_of_day]').selectOption('evening');
 await page.locator('.tg-form input[type=file]').setInputFiles(fileURLToPath(new URL('../examples/附件/示例风景.png',import.meta.url)));
 await page.evaluate(()=>{const v=app.vault;v.__qaBinary=v.createBinary;window.__qaImports=0;v.createBinary=function(...args){window.__qaImports++;return v.__qaBinary.apply(this,args);};const s=app.plugins.plugins['travel-globe'].store;s.__qaCreate=s.create;s.create=async()=>{await new Promise((_,reject)=>window.__qaReject=reject);throw Error('unreachable');};});
 await page.getByRole('button',{name:'保存足迹',exact:true}).click();
 await page.waitForFunction(()=>typeof window.__qaReject==='function');
 created=await page.evaluate(()=>app.plugins.plugins['travel-globe'].tripModal.draft.photos.split('\n').filter(Boolean));assert.equal(created.length,1);
 await page.keyboard.press('Escape');await page.locator('.tg-form').waitFor({state:'detached'});
 await page.evaluate(()=>window.__qaReject(Error('QA injected note write failure')));
 await page.getByRole('button',{name:'恢复草稿',exact:true}).click();
 assert.equal(await page.locator('.tg-form [name=body]').inputValue(),body);
 assert.equal(await page.locator('.tg-form [name=end_date]').inputValue(),'2027-01-01');
 assert.equal(await page.locator('.tg-form [name=time_of_day]').inputValue(),'evening');
 assert.match(await page.locator('.tg-form .tg-error').innerText(),/QA injected note write failure/);
 await page.locator('.tg-trip-modal').screenshot({path:qa+'/recovery-failed-save-restored.png'});
 checks.push({name:'保存途中宿主关闭、独立错误提示与同一草稿恢复',status:'pass'});
 await page.evaluate(()=>{const s=app.plugins.plugins['travel-globe'].store;s.create=s.__qaCreate;delete s.__qaCreate;delete window.__qaReject;});
 await page.getByRole('button',{name:'保存足迹',exact:true}).click();await page.locator('.tg-form').waitFor({state:'detached'});
 await page.waitForFunction(city=>app.plugins.plugins['travel-globe'].store.records.some(r=>r.city===city),city);
 const records=await page.evaluate(city=>app.plugins.plugins['travel-globe'].store.records.filter(r=>r.city===city),city);assert.equal(records.length,1);assert.equal(records[0].photos.length,1);assert.equal(records[0].photos[0],created[0]);assert.equal(await page.evaluate(()=>window.__qaImports),1);created.push(records[0].path);
 checks.push({name:'失败后重试只生成一份笔记与一份照片',status:'pass'});
 for(const year of ['2026','2027']){await page.locator('[aria-label="按年份筛选"]').selectOption(year);await page.getByRole('button',{name:city+' · 1 次旅行',exact:true}).click();assert.match(await page.locator('.tg-details').innerText(),/2026-12-31 – 2027-01-01 · 晚上/);}
 await page.locator('[aria-label="按年份筛选"]').selectOption('');await page.locator('.tg-app').screenshot({path:qa+'/recovery-cross-year-evening.png'});
 checks.push({name:'多日与中文时段显示、跨年两年份筛选均可见',status:'pass'});
 await closeView(page);await emulateMobile(page,true);const sizes=[];
 for(const [width,height]of [[320,568],[390,844],[667,375],[375,480]]){
  await viewport(cdp,width,height,true,2);await openView(page);
  const geometry=await page.evaluate(()=>{const appEl=document.querySelector('.tg-app'),zoom=document.querySelector('.tg-zoom-controls').getBoundingClientRect(),layers=document.querySelector('.tg-layers').getBoundingClientRect();return {width:appEl.clientWidth,scrollWidth:appEl.scrollWidth,height:appEl.clientHeight,scrollHeight:appEl.scrollHeight,zoom:zoom.toJSON(),layers:layers.toJSON()};});
  assert.ok(geometry.scrollWidth<=geometry.width+1,JSON.stringify({viewport:[width,height],geometry}));assert.ok(geometry.scrollHeight<=geometry.height+1,JSON.stringify({viewport:[width,height],geometry}));
  const {zoom,layers}=geometry;assert.ok(zoom.right<=layers.left+1||zoom.bottom<=layers.top+1||layers.bottom<=zoom.top+1,JSON.stringify(geometry));
  for(const selector of ['.tg-zoom-controls button','.tg-layers>button','.tg-layers>select','.tg-quality-menu summary']){
   for(const control of await page.locator(selector).all()){
    if(!await control.isVisible())continue;await control.scrollIntoViewIfNeeded();
    const target=await control.evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{width:r.width,height:r.height,hit:e===hit||e.contains(hit)};});
    assert.ok(target.width>=43.5&&target.height>=43.5,JSON.stringify({selector,target}));assert.ok(target.hit,JSON.stringify({selector,target}));
   }
  }
  sizes.push({viewport:[width,height],geometry});if(width===390){await page.waitForFunction(()=>{const g=app.workspace.getLeavesOfType('travel-globe-view')[0]?.view?.globe;return g?.el.dataset.terrainReady==='true'&&g.instance.scene.globe.tilesLoaded;},{},{timeout:60000});await page.locator('.tg-app').screenshot({path:qa+'/recovery-mobile-controls-390x844.png'});}await closeView(page);
 }
 checks.push({name:'四种小屏缩放与图层不重叠、44px目标可命中',status:'pass',detail:sizes});
 assert.deepEqual(h.errors,[]);await h.save('0.9.1-恢复交互',{checks});console.log(JSON.stringify(checks,null,2));
}catch(error){await page.screenshot({path:qa+'/recovery-failure.png'}).catch(()=>{});await h.save('0.9.1-恢复交互-失败',{checks,error:String(error)});throw error;
}finally{
 await page.evaluate(async({created,initial,city})=>{const t=app.plugins.plugins['travel-globe'],s=t.store;if(app.vault.__qaBinary){app.vault.createBinary=app.vault.__qaBinary;delete app.vault.__qaBinary;}delete window.__qaImports;if(s.__qaCreate){s.create=s.__qaCreate;delete s.__qaCreate;}delete window.__qaReject;const records=s.records.filter(r=>r.city===city);const paths=new Set([...created,...records.flatMap(r=>[r.path,...r.photos])]);for(const p of paths){if(initial.includes(p))throw Error('refuse deleting initial fixture');const f=app.vault.getAbstractFileByPath(p);if(f)await app.vault.delete(f);}s.invalidate();await t.refresh();},{created,initial,city}).catch(error=>{process.exitCode=1;console.error('QA cleanup failure',error)});
 try{for(const [p,hash]of hashes)assert.equal(createHash('sha256').update(await readFile(h.identity.vault+'/'+p)).digest('hex'),hash,p);}finally{await h.close();}
}
