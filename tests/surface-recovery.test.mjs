// Run: TYPESCRIPT_PATH=/path/to/typescript/lib/typescript.js node --test tests/surface-recovery.test.mjs
// Only Cesium/DOM are mocked: the constructor, resource loading, visibility,
// revision checks, painting hand-off, failure policy and dispose are production code.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const ts=require(process.env.TYPESCRIPT_PATH||'typescript');
const source=new URL('../src/',import.meta.url);
function compile(name,dependencies={}){
 const text=readFileSync(new URL(name+'.ts',source),'utf8');
 const result=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
 assert.equal(result.diagnostics?.length||0,0);
 const module={exports:{}};
 vm.runInNewContext(result.outputText,{exports:module.exports,module,require:id=>dependencies[id]||{},console,URL});
 return module.exports;
}
const quality=compile('quality'),mapStyle=compile('map-style');
class Signal {items=new Set();addEventListener(fn){this.items.add(fn);return()=>this.items.delete(fn)}raise(...args){for(const fn of [...this.items])fn(...args)}}
class El {
 dataset={};children=[];listeners=new Map();classList={toggle(){}};
 setAttribute(){}append(...items){this.children.push(...items)}replaceChildren(...items){this.children=items}
 addEventListener(k,fn){this.listeners.set(k,fn)}removeEventListener(k){this.listeners.delete(k)}
 dispatchEvent(){}closest(){return null}getBoundingClientRect(){return {width:375,height:300}}
}
const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve()};
function env({hidden=false,urlHook,mobile=true,quality:qualityName='low'}={}){
 const images=[],frames=[],failures=[],widgets=[];
 const win={performance,clearTimeout(){},setTimeout:()=>1,requestAnimationFrame:fn=>(frames.push(fn),frames.length),addEventListener(){},removeEventListener(){},CustomEvent:class{},ResizeObserver:class{observe(){}disconnect(){}},IntersectionObserver:class{observe(){}disconnect(){}}};
 class Img extends El {
  _src='';onload=null;onerror=null;constructor(){super();images.push(this)}
  set src(v){this._src=v}get src(){return this._src}
  succeed(width=1024){this.naturalWidth=width;this.naturalHeight=width/2;this.width=width;this.onload?.()}
  error(){this.onerror?.(Error('injected image failure'))}
 }
 const doc={hidden,defaultView:win,createElement:tag=>tag==='img'?new Img():new El(),addEventListener(){},removeEventListener(){}};
 class Widget {
  constructor(){widgets.push(this);this.canvas=new El();this.canvas.getContext=()=>({MAX_TEXTURE_SIZE:3379,getParameter:()=>8192,isContextLost:()=>false,getExtension:()=>null});this.useDefaultRenderLoop=true;
   this.camera={cancelFlight(){},changed:new Signal()};const layers=[];
   this.scene={camera:this.camera,globe:{tileLoadProgressEvent:new Signal(),tilesLoaded:true},fog:{},primitives:{add:o=>o,remove:()=>true},screenSpaceCameraController:{},postRender:new Signal(),renderError:new Signal(),requestRender(){},
    imageryLayers:{addImageryProvider:p=>{const layer={imageryProvider:p,_imageryCache:{x:{state:4,texture:{}}},isDestroyed:()=>!!layer.destroyed};layers.push(layer);return layer},indexOf:l=>layers.indexOf(l),remove:l=>{l.destroyed=true;layers.splice(layers.indexOf(l),1);return true}}};
  }
  resize(){}isDestroyed(){return !!this.destroyed}destroy(){this.destroyed=true}
 }
 class Material {uniforms={};destroy(){this.destroyed=true}isDestroyed(){return !!this.destroyed}}
 const cesium={CesiumWidget:Widget,buildModuleUrl:{setBaseUrl(){}},CreditDisplay:{},Credit:class{},Color:{fromCssColorString:()=>({})},Material,
  PointPrimitiveCollection:class{},ScreenSpaceEventHandler:class{setInputAction(){}destroy(){}},ScreenSpaceEventType:{},CameraEventType:{},KeyboardEventModifier:{},
  Rectangle:{MAX_VALUE:{}},SingleTileImageryProvider:class{constructor(options){Object.assign(this,options)}},Matrix4:{IDENTITY:{}}};
 const imports={'cesium':cesium,'./quality':quality,'./map-style':mapStyle,'./terrain-data':{EARTH_METRES:6371000}};
 for(const name of ['low','standard','high','8k'])for(const style of ['realistic','atlas'])imports['../assets/'+style+'/surface-'+name+'.jpg']={default:'surface-'+style+'-'+name};
 const {GlobeCanvas:Globe}=compile('globe',imports);
 for(const method of ['setTheme','setView','setPlaces','setAppearance','afterRender','addSatellite'])Globe.prototype[method]=function(){};
 Globe.prototype.defaultAltitude=()=>2;
 const el=new El();el.ownerDocument=doc;
 const settings={quality:qualityName,mapStyle:'natural',showBorders:false,showClouds:false};
 let globe;globe=new Globe(el,settings,{mobile,intel:false,cores:8,memory:8,pixelRatio:1},()=>{},()=>{},reason=>{failures.push(reason);globe.dispose()}, {},path=>urlHook?urlHook(path):Promise.resolve(path));
 return {globe,el,settings,images,frames,doc,failures,widgets};
}
async function paint(e,width=1024){await flush();assert.ok(e.images.at(-1));e.images.at(-1).succeed(width);await flush();e.widgets[0].scene.postRender.raise();e.widgets[0].scene.postRender.raise();await flush()}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};

test('foreground initial read failure falls back exactly once',async()=>{const e=env();await flush();e.images[0].error();await flush();await e.globe.ready;assert.equal(e.failures.length,1);assert.equal(e.globe.closed,true)});
test('initially hidden ready resolves, resumed read failure still falls back',async()=>{const e=env({hidden:true});await e.globe.ready;assert.equal(e.images.length,0);e.doc.hidden=false;e.globe.updateVisibility();await flush();e.images[0].error();await flush();assert.equal(e.failures.length,1)});
for(const mode of ['hidden','suspend','intersection'])test(mode+' cancels first decoder; resumed failure falls back',async()=>{
 const e=env();await flush();const old=e.images[0];
 const pause=v=>{if(mode==='hidden')e.doc.hidden=v;else if(mode==='suspend')e.globe.suspended=v;else e.globe.visible=!v;e.globe.updateVisibility()};
 pause(true);await flush();await e.globe.ready;assert.equal(old.src,'');assert.equal(e.globe.surfaceDecoders.size,0);assert.equal(e.widgets[0].useDefaultRenderLoop,false);
 pause(false);await flush();assert.equal(e.images.length,2);e.images[1].error();await flush();assert.equal(e.failures.length,1);
});
test('pause while first image waits for GPU paint also recovers with fallback',async()=>{const e=env();await flush();e.images[0].succeed();await flush();assert.equal(e.globe.surfaceWaiters.size,1);e.globe.suspend(true);await flush();await e.globe.ready;e.globe.suspend(false);await flush();e.images.at(-1).error();await flush();assert.equal(e.failures.length,1)});
test('successful resume paints normally without running queued animation frames',async()=>{const e=env();await flush();e.globe.suspend(true);await flush();e.globe.suspend(false);await paint(e);assert.equal(e.failures.length,0);assert.equal(e.el.dataset.activeTexture,'1024');assert.equal(e.widgets[0].useDefaultRenderLoop,true);e.globe.dispose()});
test('failed upgrade preserves existing displayed base',async()=>{const e=env();await paint(e);const old=e.globe.baseLayer;const work=e.globe.applyQuality({...e.settings,quality:'standard'});await flush();e.images.at(-1).error();await work;assert.equal(e.failures.length,0);assert.equal(e.globe.baseLayer,old);assert.match(e.el.dataset.qualityReason,/保留已显示底图/);e.globe.dispose()});
test('failed style change restores old style and reports the retained base',async()=>{const e=env();await paint(e);const old=e.globe.baseLayer;const work=e.globe.applyQuality({...e.settings,mapStyle:'atlas'});await flush();e.images.at(-1).error();await work;assert.equal(e.failures.length,0);assert.equal(e.globe.baseLayer,old);assert.equal(e.globe.requestedMapStyle,'natural');assert.ok(e.el.dataset.mapStyleError);e.globe.dispose()});
test('old URL rejection cannot erase newer success or diagnostics',async()=>{const late=deferred();let seen=0;const e=env({urlHook:path=>path.includes('surface-')&&++seen===1?late.promise:Promise.resolve(path)});await flush();const newer=e.globe.applyQuality(e.settings);await paint(e);await newer;late.reject(Error('obsolete URL failure'));await flush();assert.equal(e.failures.length,0);assert.equal(e.el.dataset.qualityError,undefined);assert.equal(e.el.dataset.activeTexture,'1024');e.globe.dispose()});
test('pause invalidates unresolved resource URL before resumed success',async()=>{const late=deferred();let seen=0;const e=env({urlHook:path=>path.includes('surface-')&&++seen===1?late.promise:Promise.resolve(path)});await flush();assert.equal(e.images.length,0);e.globe.suspend(true);assert.ok(e.globe.pendingQuality);e.globe.suspend(false);await paint(e);late.reject(Error('paused URL failure'));await flush();assert.equal(e.failures.length,0);assert.equal(e.el.dataset.qualityError,undefined);assert.equal(e.el.dataset.activeTexture,'1024');e.globe.dispose()});
test('dispose prevents late failures and callbacks',async()=>{const late=deferred();const e=env({urlHook:path=>path.includes('surface-')?late.promise:Promise.resolve(path)});await flush();e.globe.dispose();late.reject(Error('closed failure'));await flush();assert.equal(e.failures.length,0);assert.equal(e.el.dataset.qualityError,undefined)});
test('context loss still prevents default and invokes host fallback',async()=>{const e=env();await paint(e);let prevented=false;e.globe.contextLost({preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(e.failures.length,1);assert.equal(e.globe.closed,true)});
test('8K staged upgrade failure retains painted 4K',async()=>{const e=env({mobile:false,quality:'ultra'});await flush();assert.equal(e.images.length,2);e.images[1].succeed(4096);await flush();e.widgets[0].scene.postRender.raise();e.widgets[0].scene.postRender.raise();await flush();const old=e.globe.baseLayer;assert.ok(old);e.images[0].error();await flush();assert.equal(e.failures.length,0);assert.equal(e.globe.baseLayer,old);assert.equal(e.el.dataset.activeTexture,'4096');assert.match(e.el.dataset.qualityReason,/保留已显示底图/);e.globe.dispose()});
