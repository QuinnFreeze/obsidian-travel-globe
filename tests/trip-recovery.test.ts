import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const requireModule=createRequire(path.join(process.cwd(),'package.json'));
let esbuild:any;try{esbuild=requireModule('esbuild');}catch{esbuild=requireModule('/usr/local/lib/node_modules/wrangler/node_modules/esbuild');}
const sourceRoot=process.env.TRAVEL_GLOBE_SOURCE_ROOT||process.cwd();
// Deliberately small host/DOM doubles. These are module-level fault tests, NOT real Obsidian UI.
class El {
 children:El[]=[];value='';name='';textContent='';disabled=false;isConnected=true;type='';
 handlers=new Map<string,Function[]>();classList={add(){},toggle(){}};
 constructor(public tag='div'){}
 append(...items:any[]){this.children.push(...items.map(x=>typeof x==='string'?Object.assign(new El('text'),{textContent:x}):x));}
 empty(){for(const e of this.children)e.detach();this.children=[];}
 detach(){this.isConnected=false;for(const e of this.children)e.detach();}
 addClass(){}setAttribute(){}replaceChildren(...items:any[]){this.empty();this.append(...items);}
 addEventListener(event:string,fn:Function){this.handlers.set(event,[...(this.handlers.get(event)||[]),fn]);}
 querySelectorAll(selector:string):El[]{return this.children.flatMap(e=>[...(selector.split(',').includes(e.tag)?[e]:[]),...e.querySelectorAll(selector)]);}
 click(){if(!this.disabled)for(const fn of this.handlers.get('click')||[])fn();}
}
const text=(e:any):string=>typeof e==='string'?e:e.textContent+' '+e.children.map(text).join(' ');
function harness(baseline=false,delayedClose=false){
 const notices:any[]=[],files=new Map<string,any>(),binaries=new Map<string,Buffer>(),notes:any[]=[],attempts:any[]=[];
 const pendingCloses:(()=>void)[]=[];
 let imports=0,failImport=0,viewFailure=false,pickCallback:any,pickCancel:any,gate:Promise<void>=Promise.resolve();
 class TFile{constructor(public path:string){}}
 const element=(tag:string,_cls='',str='')=>Object.assign(new El(tag),{textContent:str});
 const button=(str:string,fn:()=>void)=>{const e=element('button','',str);e.addEventListener('click',fn);return e;};
 const obsidian={Plugin:class{app:any;constructor(app:any){this.app=app;}},PluginSettingTab:class{},Modal:class{
  app:any;contentEl=new El();modalEl=new El();constructor(app:any){this.app=app;}
  open(){(this as any).onOpen?.();}close(){const finish=()=>(this as any).onClose?.();if(delayedClose)pendingCloses.push(finish);else finish();}
 },Notice:class{constructor(message:any){notices.push(message);}},TFile,Platform:{isMobile:false},normalizePath:(s:string)=>s};
 const cache=new Map<string,any>();
 const load=(name:string):any=>{
  if(cache.has(name))return cache.get(name);
  if(!['./main','./form','./model','./trip-dates','./store'].includes(name)){
   if(name==='obsidian')return obsidian;if(name==='./view')return {element,button,VIEW_TYPE:'travel-globe-view'};
   if(name==='./lazy')return {lazyResource:(f:Function)=>f};return {};
  }
  const file=path.join(sourceRoot,'src',name.slice(2)+'.ts');let source=fs.readFileSync(file,'utf8');
  if(baseline&&['./main','./form','./model'].includes(name))source=fs.readFileSync(path.join(process.env.TRAVEL_GLOBE_BASELINE_ROOT!,name.slice(2)+'.ts'),'utf8');
  const code=esbuild.transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code;
  const module={exports:{}};cache.set(name,module.exports);
  vm.runInNewContext(code,{module,exports:module.exports,require:load,console,window:{clearTimeout,setTimeout},document:{createDocumentFragment:()=>new El('fragment')},HTMLInputElement:El,TextEncoder,TextDecoder,Buffer,queueMicrotask},{filename:file});
  cache.set(name,module.exports);return module.exports;
 };
 const app={workspace:{getLeavesOfType:()=>[]},metadataCache:{getFirstLinkpathDest:()=>null},vault:{
  getAbstractFileByPath:(p:string)=>files.get(p),createBinary:async(p:string,b:ArrayBuffer)=>{
   imports++;if(imports===failImport)throw Error('EIO photo');const f=new TFile(p);files.set(p,f);binaries.set(p,Buffer.from(b));return f;
  },delete:()=>{throw Error('attachments must NEVER be deleted');}
 }};
 const Main=load('./main').default,plugin=new Main(app);plugin.applyTheme=()=>{};plugin.forgetTheme=()=>{};
 plugin.settings={attachmentsFolder:'synthetic-attachments'};
 plugin.store={records:[],ensureFolder:async()=>{},create:async(input:any)=>{attempts.push(input);await gate;notes.push(input);return 'synthetic-note.md';}};
 plugin.refresh=async()=>{if(viewFailure)throw Error('view failure after successful note');};
 plugin.activateView=async()=>({beginPick:(cb:any,cancel:any)=>{pickCallback=cb;pickCancel=cancel;return true;}});
 const upload=(name='synthetic.jpg')=>({name,size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer});
 const start=()=>{const modal=plugin.addTrip();Object.assign(modal.draft,{city:'Synthetic',country_name:'Synthetic country',country_code:'CN',latitude:'30',longitude:'120',date:'2026-12-31',end_date:'2027-01-01',time_of_day:'evening',body:'SYNTHETIC UNSAVED MEMORY'});modal.files=[upload()];return modal;};
 const save=(m:any)=>m.save(new El('button'),m.errorEl||new El());
 return {plugin,start,save,notices,attempts,notes,binaries,files,upload,get imports(){return imports;},get pendingCloses(){return pendingCloses.length;},finishClose(){for(const finish of pendingCloses.splice(0))finish();},gate(p:Promise<void>){gate=p;},failPhoto(n:number){failImport=n;},failView(){viewFailure=true;},pick(lat:number,lng:number){pickCallback(lat,lng);},cancelPick(){pickCancel();},TFile};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('host close during write: independent failure notice recovers exact draft, imports once and saves once',async()=>{
 const h=harness(),m=h.start();let reject!:(e:Error)=>void;h.gate(new Promise<void>((_,r)=>reject=r));
 const work=h.save(m);await tick();assert.equal(h.attempts.length,1);assert.equal(h.imports,1);
 m.close();assert.equal(h.plugin.addTrip(),m);assert.equal(m.inputs.get('body').value,'SYNTHETIC UNSAVED MEMORY');
 assert.equal(m.inputs.get('end_date').value,'2027-01-01');assert.equal(m.inputs.get('time_of_day').value,'evening');
 assert(m.contentEl.querySelectorAll('input,textarea,select,button').every((e:El)=>e.disabled));
 await h.save(m);assert.equal(h.attempts.length,1);m.close();reject(Error('EIO note write'));await work;
 const notice=h.notices.find(n=>text(n).includes('足迹保存失败'));assert(notice);assert.match(text(notice),/EIO note write/);
 notice.querySelectorAll('button')[0].click();assert.equal(h.plugin.addTrip(),m);assert.match(m.errorEl.textContent,/EIO note write/);
 assert.equal(m.files.length,0);assert.equal(h.binaries.size,1);h.gate(Promise.resolve());await h.save(m);
 assert.equal(h.notes.length,1);assert.equal(h.imports,1);assert.equal(h.notes[0].photos.length,1);assert.deepEqual([...h.binaries.values()][0],Buffer.from([1,2,3]));
 await h.save(m);m.open();assert.equal(h.notes.length,1);assert.notEqual(h.plugin.addTrip(),m);
 assert.equal(h.plugin.addTrip().draft.body,'');assert.equal(h.plugin.addTrip().draft.photos,'');
});
test('failure while open updates newly reopened controls and does not delete original photo',async()=>{
 const h=harness(),m=h.start();const original='original/photo.jpg';h.files.set(original,new h.TFile(original));h.binaries.set(original,Buffer.from([9,8,7]));m.draft.photos=original;
 let reject!:(e:Error)=>void;h.gate(new Promise<void>((_,r)=>reject=r));const work=h.save(m);await tick();m.close();h.plugin.addTrip();reject(Error('EIO'));await work;
 assert.match(m.errorEl.textContent,/EIO/);assert(m.contentEl.querySelectorAll('input,textarea,select,button').every((e:El)=>!e.disabled));
 h.gate(Promise.resolve());await h.save(m);assert.equal(h.notes[0].photos[0],original);assert.deepEqual(h.binaries.get(original),Buffer.from([9,8,7]));
});
test('partial photo import retries only remaining file, keeping first imported bytes',async()=>{
 const h=harness(),m=h.start();m.files.push(h.upload('second.jpg'));h.failPhoto(2);await h.save(m);
 assert.equal(h.imports,2);assert.equal(h.binaries.size,1);assert.equal(m.files.length,1);assert.equal(h.notes.length,0);
 h.failPhoto(0);await h.save(m);assert.equal(h.imports,3);assert.equal(h.binaries.size,2);assert.equal(h.notes.length,1);assert.equal(h.notes[0].photos.length,2);
});
test('successful note with view failure is final and stale recovery cannot create duplicate',async()=>{
 const h=harness(),m=h.start();h.failView();await h.save(m);await h.save(m);assert.equal(h.notes.length,1);
 assert(h.notices.some(n=>text(n).includes('笔记已保存，但视图暂未更新')));assert.notEqual(h.plugin.addTrip(),m);
});
test('pick/cancel restores same draft; concurrent Add cannot reopen or submit during picking',async()=>{
 const h=harness(),m=h.start();const pick=m.contentEl.querySelectorAll('button').find((b:El)=>b.textContent==='在地球上选点');pick.click();await tick();assert.equal(m.opened,false);
 assert.equal(h.plugin.addTrip(),m);assert.equal(m.opened,false);await h.save(m);assert.equal(h.attempts.length,0);
 h.pick(31.23456,121.34567);assert.equal(m.opened,true);assert.equal(m.draft.latitude,'31.23456');assert.equal(m.draft.body,'SYNTHETIC UNSAVED MEMORY');
 m.contentEl.querySelectorAll('button').find((b:El)=>b.textContent==='在地球上选点').click();await tick();h.cancelPick();assert.equal(m.opened,true);assert.equal(m.files.length,1);
});
test('explicit discard needs two clicks, frees draft, never removes imported/original attachments',async()=>{
 const h=harness(),m=h.start();h.gate(Promise.reject(Error('EIO')));await h.save(m);const bytes=[...h.binaries.values()][0];
 const discard=m.contentEl.querySelectorAll('button').find((b:El)=>b.textContent==='丢弃草稿');discard.click();assert.equal(h.plugin.addTrip(),m);discard.click();
 assert.notEqual(h.plugin.addTrip(),m);assert.equal(h.binaries.size,1);assert.equal([...h.binaries.values()][0],bytes);await h.save(m);assert.equal(h.notes.length,0);
});
test('phone close animation queues one quick reopen after host onClose finishes',async()=>{
 const h=harness(false,true),m=h.start(),photo=m.files[0];
 m.close();m.close();assert.equal(h.pendingCloses,1);assert.equal(m.closing,true);
 assert.equal(h.plugin.addTrip(),m);assert.equal(h.plugin.addTrip(),m);assert.equal(m.reopenAfterClose,true);
 h.finishClose();assert.equal(m.opened,false);assert.equal(m.closing,false);
 await tick();assert.equal(m.opened,true);assert.equal(m.reopenAfterClose,false);assert.equal(h.pendingCloses,0);
 assert.equal(m.inputs.get('body').value,'SYNTHETIC UNSAVED MEMORY');
 assert.equal(m.inputs.get('end_date').value,'2027-01-01');assert.equal(m.inputs.get('time_of_day').value,'evening');
 assert.equal(m.files[0],photo);assert.equal(h.plugin.addTrip(),m);assert.equal(h.imports,0);
});
test('pick cancellation during phone close animation restores once after onClose',async()=>{
 const h=harness(false,true),m=h.start(),photo=m.files[0];
 m.contentEl.querySelectorAll('button').find((b:El)=>b.textContent==='在地球上选点').click();await tick();
 assert.equal(m.picking,true);assert.equal(m.closing,true);assert.equal(h.pendingCloses,1);
 assert.equal(h.plugin.addTrip(),m);assert.equal(m.reopenAfterClose,false);await h.save(m);assert.equal(h.attempts.length,0);
 h.cancelPick();assert.equal(m.picking,false);assert.equal(m.reopenAfterClose,true);
 h.finishClose();assert.equal(m.opened,false);await tick();assert.equal(m.opened,true);
 assert.equal(m.inputs.get('body').value,'SYNTHETIC UNSAVED MEMORY');assert.equal(m.files[0],photo);assert.equal(h.imports,0);
});
test('phone close can finish before pick cancellation without reopening during picking',async()=>{
 const h=harness(false,true),m=h.start();
 m.contentEl.querySelectorAll('button').find((b:El)=>b.textContent==='在地球上选点').click();await tick();
 h.finishClose();await tick();assert.equal(m.opened,false);assert.equal(m.picking,true);
 assert.equal(h.plugin.addTrip(),m);assert.equal(m.opened,false);assert.equal(m.reopenAfterClose,false);
 h.cancelPick();assert.equal(m.opened,true);assert.equal(m.inputs.get('body').value,'SYNTHETIC UNSAVED MEMORY');
 assert.equal(m.inputs.get('end_date').value,'2027-01-01');assert.equal(m.files.length,1);assert.equal(h.imports,0);
});
test('fault control: baseline loses recovery ownership and reports no Notice after host close',{skip:!process.env.TRAVEL_GLOBE_BASELINE_ROOT},async()=>{
 const h=harness(true),m=h.start();let reject!:(e:Error)=>void;h.gate(new Promise<void>((_,r)=>reject=r));const work=h.save(m);await tick();m.close();reject(Error('EIO baseline'));await work;
 assert.equal(h.notices.length,0);const next=h.plugin.addTrip();assert.notEqual(next,m);assert.equal(next.draft.body,'');assert.equal(next.draft.photos,'');assert.equal(h.binaries.size,1);
});
