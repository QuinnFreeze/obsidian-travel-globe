import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TravelStore,type NoteFile} from '../src/store';
import {decodeRecord,renderNote,groupRecords,statistics,filterRecords,placeId,validDate,safeFolder,type TravelInput} from '../src/model';
import {searchCities,configureCityLoader} from '../src/cities';
import rows from '../assets/cities.json';
configureCityLoader(async()=>rows);
const input:TravelInput={place_id:'geonames:1796236',city:'上海',country_code:'CN',country_name:'中国',latitude:31.22222,longitude:121.45806,date:'2026-05-01',photos:[],body:'示例回忆（虚构），不是用户旅行历史。'};
// Generated YAML uses JSON-compatible scalars. Real Obsidian parseYaml is tested in the host integration suite.
function parse(text:string){return Object.fromEntries(text.split('\n').map(line=>{const at=line.indexOf(':');const value=line.slice(at+1).trim();return [line.slice(0,at),value==='travel'?value:JSON.parse(value)];}));}
class MemoryVault {
  files=new Map<string,{text:string;mtime:number}>();folders=new Set<string>();clock=0;writes=0;
  getMarkdownFiles():NoteFile[]{return [...this.files].filter(([path])=>path.endsWith('.md')).map(([path,v])=>({path,extension:'md',stat:{mtime:v.mtime,size:v.text.length}}));}
  async read(f:NoteFile){return this.files.get(f.path)!.text;}
  getAbstractFileByPath(p:string){return this.files.get(p)||this.folders.has(p);}
  async createFolder(p:string){this.folders.add(p);}
  async create(path:string,text:string){if(this.files.has(path))throw Error('exists');this.set(path,text);this.writes++;}
  set(path:string,text:string){this.files.set(path,{text,mtime:++this.clock});}
}
test('real calendar dates and coordinate validation',()=>{
  assert.ok(validDate('2024-02-29'));assert.ok(!validDate('2025-02-29'));assert.ok(!validDate('2026-13-01'));
  assert.throws(()=>renderNote({...input,latitude:91}));assert.throws(()=>renderNote({...input,date:'2026-02-30'}));
  assert.throws(()=>renderNote({...input,country_code:'ZZZ'}));
});
test('relative folder safety',()=>{for(const path of ['../secret','a/../b','/absolute','.obsidian/test','a//b'])assert.throws(()=>safeFolder(path));assert.equal(safeFolder('旅行/记录'),'旅行/记录');});
test('duplicate visits aggregate to one city; same name in other countries stays separate',()=>{
  const a=decodeRecord('a.md',renderNote(input),parse)!;const b={...a,path:'b.md',date:'2025-10-01'};
  const c={...a,path:'c.md',place_id:'different-city',country_code:'US',country_name:'美国'};
  assert.deepEqual(statistics([a,b,c]),{cities:2,countries:2,records:3});
  assert.equal(groupRecords([b,a])[0]!.records[0]!.date,'2026-05-01');
  assert.equal(filterRecords([a,b,c],{year:'2025',country:'CN'}).length,1);
});
test('manual repeat reuses existing ID nearby; distant same name remains distinct',()=>{
  const a=decodeRecord('a.md',renderNote(input),parse)!;
  assert.equal(placeId('上海','CN',31.23,121.47,[a]),a.place_id);
  assert.notEqual(placeId('上海','CN',40,116,[a]),a.place_id);
});
test('offline search exposes multiple Paris locations with stable unique IDs',async()=>{
  const result=await searchCities('Paris');assert.ok(result.total>1);
  assert.ok(result.results.some(c=>c.country_code==='FR'));assert.ok(result.results.some(c=>c.country_code==='US'));
  assert.equal(new Set(result.results.map(c=>c.id)).size,result.results.length);
  assert.ok((await searchCities('上海')).results.some(c=>c.country_code==='CN'));
});
test('create, repeat, modification, rename, delete and out-of-folder move synchronize without note rewrites',async()=>{
  const vault=new MemoryVault();const store=new TravelStore(vault,parse,()=> '旅行记录');
  const first=await store.create(input);const second=await store.create({...input,date:'2025-10-01'});
  await store.scan();assert.equal(groupRecords(store.records).length,1);assert.equal(store.records.length,2);
  const original=vault.files.get(first)!.text;
  vault.set(first,original.replace('latitude: 31.22222','latitude: 30.1234').replace('示例回忆','更新的回忆'));
  store.invalidate(first);await store.scan();assert.equal(store.records.find(r=>r.path===first)!.latitude,30.1234);
  assert.match(store.records.find(r=>r.path===first)!.summary,/更新的回忆/);
  const edited=vault.files.get(first)!.text;vault.set('旅行记录/改名.md',edited);vault.files.delete(first);
  await store.scan();assert.ok(store.records.some(r=>r.path==='旅行记录/改名.md'));assert.ok(!store.records.some(r=>r.path===first));
  vault.files.delete(second);await store.scan();assert.equal(store.records.length,1);
  vault.set('其他/改名.md',edited);vault.files.delete('旅行记录/改名.md');await store.scan();assert.equal(store.records.length,0);
  assert.equal(vault.files.get('其他/改名.md')!.text,edited);assert.equal(vault.writes,2);
});
test('concurrent same-day saves allocate distinct files, preserving existing body and properties',async()=>{
  const vault=new MemoryVault();const store=new TravelStore(vault,parse,()=> '旅行记录');
  const paths=await Promise.all([store.create(input),store.create(input)]);assert.notEqual(paths[0],paths[1]);
  const file=paths[0]!;const original=vault.files.get(file)!.text;
  vault.set(file,original.replace('type: travel','type: travel\ncustom: "保留额外属性"')+'\n自由正文\n');
  const before=vault.files.get(file)!.text;await store.scan();await store.scan();assert.equal(vault.files.get(file)!.text,before);
});
test('malformed travel note reports an issue; unrelated Markdown is ignored',async()=>{
  const vault=new MemoryVault();vault.set('旅行记录/错误.md','---\ntype: travel\nlatitude: bad\n---\n');
  vault.set('旅行记录/普通.md','# 普通笔记');
  const store=new TravelStore(vault,parse,()=> '旅行记录');await store.scan();assert.equal(store.issues.length,1);assert.equal(store.records.length,0);
});
test('an older slow scan cannot overwrite a newer scan',async()=>{
  const vault=new MemoryVault();vault.set('旅行记录/a.md',renderNote(input));
  let release!:()=>void;let block=true;const read=vault.read.bind(vault);
  vault.read=async f=>{const text=await read(f);if(block){block=false;await new Promise<void>(resolve=>release=resolve);}return text;};
  const store=new TravelStore(vault,parse,()=> '旅行记录');const old=store.scan();
  await new Promise(resolve=>setTimeout(resolve,0));vault.set('旅行记录/a.md',renderNote({...input,city:'更新城市'}));
  await store.scan();release();assert.equal(await old,false);assert.equal(store.records[0]!.city,'更新城市');
});
test('invalidate cancels an in-flight scan even before the scheduled replacement starts',async()=>{
 const vault=new MemoryVault();vault.set('旅行记录/a.md',renderNote(input));let release!:()=>void;
 const read=vault.read.bind(vault);vault.read=async f=>{const text=await read(f);await new Promise<void>(r=>release=r);return text;};
 const store=new TravelStore(vault,parse,()=> '旅行记录');const old=store.scan();await new Promise(r=>setTimeout(r,0));
 store.invalidate('旅行记录/a.md');release();assert.equal(await old,false);assert.equal(store.records.length,0);
});
test('1000-note scans keep six-reader concurrency, reuse cache and invalidate only changed paths or subfolders',async()=>{
 const vault=new MemoryVault();for(let i=0;i<1000;i++)vault.set('旅行记录/子目录/'+i+'.md',renderNote({...input,place_id:'city:'+i%100}));
 let reads=0,active=0,peak=0;const read=vault.read.bind(vault);vault.read=async f=>{reads++;active++;peak=Math.max(peak,active);await Promise.resolve();const text=await read(f);active--;return text;};
 const store=new TravelStore(vault,parse,()=> '旅行记录');await store.scan();assert.equal(reads,1000);assert.equal(peak,6);assert.equal(groupRecords(store.records).length,100);
 await store.scan();assert.equal(reads,1000);store.invalidate('旅行记录/子目录/1.md');await store.scan();assert.equal(reads,1001);
 store.invalidate('旅行记录/子目录');await store.scan();assert.equal(reads,2001);assert.equal(vault.writes,0);
});

test('10000 records keep cached rescans free of note reads and preserve all visits',async()=>{
 const vault=new MemoryVault();for(let i=0;i<10000;i++)vault.set('旅行记录/'+i+'.md',renderNote({...input,place_id:'city:'+i%250}));
 let reads=0;const read=vault.read.bind(vault);vault.read=async f=>{reads++;return read(f);};
 const store=new TravelStore(vault,parse,()=> '旅行记录');await store.scan();assert.equal(reads,10000);
 assert.equal(store.records.length,10000);assert.equal(groupRecords(store.records).length,250);
 await store.scan();assert.equal(reads,10000);store.invalidate('旅行记录/10.md');await store.scan();assert.equal(reads,10001);
});

test('scoped scans use only the records folder, including nested notes and an absent folder',async()=>{
 const vault=new MemoryVault();vault.set('旅行记录/子目录/a.md',renderNote(input));vault.set('其他/b.md','# unrelated');
 const all=vault.getMarkdownFiles.bind(vault);let folderExists=true;
 Object.assign(vault,{getFilesInFolder:(folder:string)=>folderExists?all().filter(f=>f.path.startsWith(folder+'/')):[]});
 vault.getMarkdownFiles=()=>{throw Error('Must not enumerate the entire vault');};
 const store=new TravelStore(vault,parse,()=> '旅行记录');await store.scan();assert.equal(store.records.length,1);
 folderExists=false;store.invalidate();await store.scan();assert.equal(store.records.length,0);
});
