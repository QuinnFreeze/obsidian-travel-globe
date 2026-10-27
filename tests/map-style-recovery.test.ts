import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import type {Settings} from '../src/model';
import type {MapStyle} from '../src/map-style';

const requireModule=createRequire(path.join(process.cwd(),'package.json'));
const esbuild=requireModule('esbuild');
const sourceRoot=process.env.TRAVEL_GLOBE_SOURCE_ROOT||process.cwd();
function deferred(){
 let resolve!:()=>void;
 const promise=new Promise<void>(r=>resolve=r);
 return {promise,resolve};
}

// Execute the production Plugin, settings queue, model validation and device settings.
// Only Obsidian persistence/rendering boundaries are synthetic; no Vault is opened.
function harness(){
 const writes:MapStyle[]=[],renders:MapStyle[]=[],notices:string[]=[];
 let saveGate=Promise.resolve(),saveStarted=()=>{};
 const obsidian={Plugin:class{constructor(public app:unknown){}},PluginSettingTab:class{},Notice:class{
  constructor(message:string){notices.push(message);}
 }};
 const cache=new Map<string,any>();
 const load=(name:string):any=>{
  if(cache.has(name))return cache.get(name);
  if(name==='obsidian')return obsidian;
  if(name==='./view')return {VIEW_TYPE:'travel-globe-view'};
  if(name==='./lazy')return {lazyResource:(factory:unknown)=>factory};
  if(!['./main','./model','./trip-dates','./device-settings'].includes(name))return {};
  const file=path.join(sourceRoot,'src',name.slice(2)+'.ts');
  const code=esbuild.transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code;
  const module={exports:{}};cache.set(name,module.exports);
  vm.runInNewContext(code,{module,exports:module.exports,require:load,console,navigator:{onLine:false}},{filename:file});
  cache.set(name,module.exports);return module.exports;
 };
 let plugin:any;
 const view={applyQuality:async()=>{renders.push(plugin.settings.mapStyle);}};
 const app={saveLocalStorage:(_key:string,settings:Partial<Settings>)=>{writes.push(settings.mapStyle!);},
  workspace:{getLeavesOfType:()=>[{view}]}};
 const Main=load('./main').default;plugin=new Main(app);
 plugin.satelliteCache={};plugin.terrainCache={};plugin.earthResources={};
 plugin.store={invalidate(){},scan:async()=>true};
 plugin.saveData=async()=>{saveStarted();await saveGate;};
 return {plugin,writes,renders,notices,blockPersistence(){
  const gate=deferred(),started=deferred();saveGate=gate.promise;saveStarted=started.resolve;
  return {started:started.promise,release:gate.resolve};
 }};
}

test('production settings queue persists a renderer fallback once',{timeout:2000},async()=>{
 const h=harness();await h.plugin.updateSettings({mapStyle:'atlas'});
 await h.plugin.restoreMapStyle('natural');
 assert.equal(h.plugin.settings.mapStyle,'natural');
 assert.deepEqual(h.writes,['atlas','natural']);assert.deepEqual(h.renders,['atlas','natural']);
 assert.deepEqual(h.notices,[]);
});

test('newer map request already waiting in the production queue defeats an old fallback',{timeout:2000},async()=>{
 const h=harness();await h.plugin.updateSettings({mapStyle:'atlas'});
 const gate=h.blockPersistence();const shared=h.plugin.updateSettings({recordsFolder:'Synthetic records'});
 await gate.started;
 // Retrying the same style is still a newer request; comparing values alone is insufficient.
 const newer=h.plugin.updateSettings({mapStyle:'atlas'}),fallback=h.plugin.restoreMapStyle('natural');
 gate.release();await Promise.all([shared,newer,fallback]);
 assert.equal(h.plugin.settings.mapStyle,'atlas');
 assert.deepEqual(h.writes,['atlas','atlas']);assert.deepEqual(h.renders,['atlas','atlas']);
 assert.deepEqual(h.notices,[]);
});

test('duplicate renderer fallback events do not loop or rerender repeatedly',{timeout:2000},async()=>{
 const h=harness();await h.plugin.updateSettings({mapStyle:'atlas'});
 await Promise.all(Array.from({length:8},()=>h.plugin.restoreMapStyle('natural')));
 await h.plugin.restoreMapStyle('natural');
 assert.equal(h.plugin.settings.mapStyle,'natural');
 assert.deepEqual(h.writes,['atlas','natural']);assert.deepEqual(h.renders,['atlas','natural']);
 assert.deepEqual(h.notices,[]);
});

test('a user choice queued after restoration remains the final preference',{timeout:2000},async()=>{
 const h=harness();await h.plugin.updateSettings({mapStyle:'atlas'});
 const gate=h.blockPersistence();const shared=h.plugin.updateSettings({recordsFolder:'Synthetic records'});
 await gate.started;
 const fallback=h.plugin.restoreMapStyle('natural'),newer=h.plugin.updateSettings({mapStyle:'atlas'});
 gate.release();await Promise.all([shared,fallback,newer]);
 assert.equal(h.plugin.settings.mapStyle,'atlas');
 assert.deepEqual(h.writes,['atlas','natural','atlas']);assert.deepEqual(h.renders,['atlas','natural','atlas']);
 assert.deepEqual(h.notices,[]);
});
