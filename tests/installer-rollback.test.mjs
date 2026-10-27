import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,readdir,lstat,chmod,access,symlink,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';

// Only synthetic vaults under this explicit sandbox are ever executed against.
// Run: node --test tests/installer-rollback.test.mjs (Node >=18, /bin/zsh).
// Production has NO test/hash bypass. A temporary byte-for-byte script copy
// changes ONLY fixed OS executable paths; its own checksum is regenerated.
const BASE=join(await realpath('/tmp'),'travel-globe-installer-fixtures');
await mkdir(BASE,{recursive:true});
const runRoot=await mkdtemp(join(BASE,'run-'));
const tools=join(runRoot,'fixed-tools');await mkdir(tools);
const installer=resolve(dirname(fileURLToPath(import.meta.url)),'../安装或修复.command');
let code=await readFile(installer,'utf8');
for(const op of ['cp','mv','chmod']) code=code.replaceAll(`/bin/${op}`,`/bin/sh '${join(tools,op)}'`);
const mktempPath=['/usr/bin/mktemp','/bin/mktemp'].find(existsSync);
assert.ok(mktempPath,'a native mktemp utility is required');
const hashCommand=existsSync('/usr/bin/shasum')?'/usr/bin/shasum -a 256 -c FILES.sha256':'/usr/bin/sha256sum -c FILES.sha256';
code=code.replaceAll('/usr/bin/mktemp',mktempPath)
 .replaceAll('/usr/bin/shasum',`/bin/sh '${join(tools,'shasum')}'`)
 .replaceAll('/usr/bin/osascript',`/bin/sh '${join(tools,'osascript')}'`);
assert.equal(spawnSync('/bin/zsh',['-n',installer]).status,0);
const sha=b=>createHash('sha256').update(b).digest('hex');
const roots=['main.js','manifest.json','styles.css','LICENSE','THIRD_PARTY_NOTICES.md','安装说明.md','安装或修复.command','Mac本地安装.command','Mac恢复iCloud安装.command'];
const shared='runtime-assets/中文 目录/地球.bin';
const added='runtime-assets/new.bin',retired='runtime-assets/retired.bin';
const newLeaves=[...roots,shared,added,'FILES.sha256'];
const oldLeaves=[...roots,shared,retired,'FILES.sha256'];
const protectedRel=['data.json','satellite-cache/瓦片.jpg','unknown 私人.txt','runtime-assets/私人 扩展.bin'];

// Fixed fake tools delegate to the real utilities. A matching one-shot rule can
// fail before OR after actual I/O, including partial writes; never system /bin.
const ioShim=`#!/bin/sh
op=TOOL
prev=''; dst=''; src=''
for arg do src="$prev"; prev="$arg"; dst="$arg"; done
phase=other
case "$dst" in
  */staged/*) phase=stage ;;
  */originals/*) phase=backup ;;
  "$TG_TARGET"/*) phase=replace; [ "$op" = cp ] && phase=rollback ;;
esac
[ "$op" = chmod ] && phase=chmod
printf '%s:%s:%s\\n' "$op" "$phase" "$dst" >> "$TG_TRACE"
match=0
if [ "$TG_RULE" = "$op:$phase" ]; then
  case "$dst" in */"$TG_REL") match=1 ;; esac
fi
if [ "$match" = 1 ] && /bin/mkdir "$TG_ONCE" 2>/dev/null; then
  printf 'FIRED:%s:%s\\n' "$op" "$phase" >> "$TG_TRACE"
  if [ "$TG_POST" = 1 ]; then /bin/$op "$@" || exit $?; fi
  if [ -n "$TG_SIGNAL" ]; then /bin/kill -"$TG_SIGNAL" "$PPID"; exit 1; fi
  if [ "$TG_PAUSE" = 1 ]; then /bin/kill -STOP "$PPID"; exit 0; fi
  exit 5
fi
if [ "$TG_ROLLBACK_FAIL" = 1 ] && [ "$phase" = rollback ]; then
  printf 'ROLLBACK_IO_FAILURE\\n' >> "$TG_TRACE"
  exit 5
fi
exec /bin/$op "$@"
`;
for(const op of ['cp','mv','chmod']){const p=join(tools,op);await writeFile(p,ioShim.replace('TOOL',op));await chmod(p,0o755);}
const hashShim=`#!/bin/sh
[ "$1 $2 $3 $4" = '-a 256 -c FILES.sha256' ] || exit 92
printf 'HASH:%s\\n' "$PWD" >> "$TG_TRACE"
if [ "$PWD" = "$TG_TARGET" ]; then
  [ "$TG_HASH_FAIL" = 1 ] && exit 5
  [ "$TG_HASH_CORRUPT" = 1 ] && printf 'corrupted bytes' > main.js
fi
exec ${hashCommand}
`;
await writeFile(join(tools,'shasum'),hashShim);await chmod(join(tools,'shasum'),0o755);
await writeFile(join(tools,'osascript'),'#!/bin/sh\necho "Unexpected GUI/app operation" >&2\nexit 93\n');await chmod(join(tools,'osascript'),0o755);
async function put(p,v){await mkdir(dirname(p),{recursive:true});await writeFile(p,v);}
async function exists(p){try{await access(p);return true;}catch{return false;}}
async function bundle(dir,kind){
 const leaves=kind==='new'?newLeaves:oldLeaves;
 for(const rel of leaves.filter(x=>x!=='FILES.sha256')){
  await put(join(dir,rel),rel==='安装或修复.command'?code:`${kind} release bytes: ${rel}\n`);
 }
 await chmod(join(dir,'安装或修复.command'),0o644);
 const manifest=[];for(const rel of leaves.filter(x=>x!=='FILES.sha256'))manifest.push(`${sha(await readFile(join(dir,rel)))}  ${rel}`);
 await put(join(dir,'FILES.sha256'),manifest.join('\n')+'\n');
}
let counter=0;
async function fixture(old=true){
 const dir=join(runRoot,`${String(++counter).padStart(3,'0')} 中文's 路径`);
 const source=join(dir,'解压包 with spaces'),vault=join(dir,"合成's 仓库"),parent=join(vault,'.obsidian/plugins'),target=join(parent,'travel-globe');
 await mkdir(parent,{recursive:true});await bundle(source,'new');
 if(old)await bundle(target,'old');
 for(const rel of protectedRel)await put(join(target,rel),`unknown settings/cache bytes ${rel}`);
 for(const rel of ['旅行记录/笔记.md','旅行照片/原图.jpg'])await put(join(vault,rel),`never rewrite ${rel}`);
 const trace=join(dir,'trace.log');await writeFile(trace,'');
 return {dir,source,vault,parent,target,trace,lock:join(parent,'.travel-globe-install.lock')};
}
async function snapshot(root){
 const out={};if(!await exists(root))return out;
 async function walk(dir){for(const n of (await readdir(dir)).sort()){
  const p=join(dir,n),s=await lstat(p);if(s.isDirectory())await walk(p);
  else out[p.slice(root.length+1)]={hash:sha(await readFile(p)),mode:s.mode&0o777};
 }}await walk(root);return out;
}
async function protectedState(f){
 const out={};for(const p of [...protectedRel.map(x=>join(f.target,x)),join(f.vault,'旅行记录/笔记.md'),join(f.vault,'旅行照片/原图.jpg')]){
  const s=await lstat(p,{bigint:true});out[p]={hash:sha(await readFile(p)),ino:String(s.ino),mtime:String(s.mtimeNs),mode:String(s.mode)};
 }return out;
}
function launch(f,opts={}){
 const env={...process.env,TG_TARGET:f.target,TG_TRACE:f.trace,TG_RULE:'',TG_REL:'',TG_ONCE:join(f.dir,'fired'),TG_POST:'',TG_SIGNAL:'',TG_PAUSE:'',TG_ROLLBACK_FAIL:'',TG_HASH_FAIL:'',TG_HASH_CORRUPT:'',...opts.env};
 const script=join(opts.self?f.target:f.source,'安装或修复.command');
 const args=['-f',script,...(opts.self?[]:[f.vault])];
 const child=spawn('/bin/zsh',args,{env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const done=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill('SIGCONT');child.kill('SIGKILL');reject(new Error('installer exceeded 45s bound'));},45000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',async(status,signal)=>{clearTimeout(timer);const r={status,signal,stdout,stderr};await writeFile(join(f.dir,`result-${opts.tag||'install'}.json`),JSON.stringify(r,null,2));resolve(r);});
 });return {child,done};
}
async function run(f,opts){return launch(f,opts).done;}
async function transactions(f){return (await readdir(f.parent)).filter(n=>n.startsWith('.travel-globe-transaction.')).map(n=>join(f.parent,n));}
async function assertRolledBack(f,before,protectedBefore,result){
 assert.notEqual(result.status,0,JSON.stringify(result));assert.equal(result.signal,null);
 assert.deepEqual(await snapshot(f.target),before,JSON.stringify(result));
 assert.deepEqual(await protectedState(f),protectedBefore,'unknown files were rewritten');
 assert.equal(await exists(f.lock),false,'clean rollback must release lock');
}
async function waitUntil(fn){const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('bounded fixture wait exceeded');}
console.log(`Synthetic installer evidence: ${runRoot}`);

// Each source-copy and backup-copy stage fails before mutation begins.
await test('installer transaction fault matrix', {concurrency:2}, async t=>{
const pending=[];
const selected=process.env.TG_INSTALLER_TEST_FILTER?new RegExp(process.env.TG_INSTALLER_TEST_FILTER):null;
const test=(name,fn)=>{if(!selected||selected.test(name))pending.push(t.test(name,fn));};
for(const phase of ['stage','backup'])for(const rel of (phase==='stage'?newLeaves:oldLeaves)){
 test(`${phase} cp I/O failure: ${rel}`,async()=>{
  const f=await fixture(),before=await snapshot(f.target),keep=await protectedState(f);
  const r=await run(f,{env:{TG_RULE:`cp:${phase}`,TG_REL:rel}});
  await assertRolledBack(f,before,keep,r);assert.match(await readFile(f.trace,'utf8'),/FIRED:cp:/);
  assert.doesNotMatch(await readFile(f.trace,'utf8'),/mv:replace:/,'backup failure touched target');
 });
}
// Actual mv succeeds then reports I/O failure, proving intent-before-operation.
for(const old of [true,false])for(const rel of newLeaves){
 test(`${old?'upgrade':'first install'} mv post-I/O failure: ${rel}`,async()=>{
  const f=await fixture(old),before=await snapshot(f.target),keep=await protectedState(f);
  const r=await run(f,{env:{TG_RULE:'mv:replace',TG_REL:rel,TG_POST:'1'}});
  await assertRolledBack(f,before,keep,r);assert.match(await readFile(f.trace,'utf8'),/FIRED:mv:replace/);
 });
}
for(const [name,env] of [
 ['chmod fails after changing mode',{TG_RULE:'chmod:chmod',TG_REL:'安装或修复.command',TG_POST:'1'}],
 ['final hash tool I/O failure',{TG_HASH_FAIL:'1'}],
 ['final hash detects genuinely corrupted installed bytes',{TG_HASH_CORRUPT:'1'}]
])test(name,async()=>{
 const f=await fixture(),before=await snapshot(f.target),keep=await protectedState(f);
 const r=await run(f,{env});await assertRolledBack(f,before,keep,r);
 assert.match(await readFile(join((await transactions(f))[0],'journal.log'),'utf8'),/ROLLED_BACK/);
});
test('success then source==target self-repair preserves unknown file identity',async()=>{
 const f=await fixture(),keep=await protectedState(f),r=await run(f);
 assert.equal(r.status,0,JSON.stringify(r));
 for(const rel of newLeaves)assert.equal(sha(await readFile(join(f.target,rel))),sha(await readFile(join(f.source,rel))),rel);
 assert.equal(await exists(join(f.target,retired)),false,'obsolete inventoried asset retired');
 assert.match(await readFile(f.trace,'utf8'),/chmod:chmod:/,'real chmod must be invoked');
 assert.ok((await lstat(join(f.target,'安装或修复.command'))).mode & 0o111,'installed command must be executable on native temporary filesystem');
 assert.deepEqual(await protectedState(f),keep);
 // The unknown runtime asset intentionally makes target larger than the source
 // bundle. Self-repair must still work, without rewriting that unknown asset.
 const again=await run(f,{self:true,tag:'self'});assert.equal(again.status,0,JSON.stringify(again));
 assert.deepEqual(await protectedState(f),keep);assert.equal(await exists(f.lock),false);
});
test('first install success',async()=>{
 const f=await fixture(false),keep=await protectedState(f),r=await run(f);assert.equal(r.status,0,JSON.stringify(r));
 for(const rel of newLeaves)assert.equal(sha(await readFile(join(f.target,rel))),sha(await readFile(join(f.source,rel))));
 assert.deepEqual(await protectedState(f),keep);
});
for(const kind of ['bad hash','incomplete inventory','escaping manifest','unlisted source asset'])test(`reject ${kind} without touching target`,async()=>{
 const f=await fixture(),before=await snapshot(f.target),keep=await protectedState(f);
 if(kind==='bad hash')await put(join(f.source,'main.js'),'bad bytes');
 if(kind==='incomplete inventory'){const s=await readFile(join(f.source,'FILES.sha256'),'utf8');await writeFile(join(f.source,'FILES.sha256'),s.split('\n').filter(l=>!l.endsWith('  main.js')).join('\n'));}
 if(kind==='escaping manifest')await writeFile(join(f.source,'FILES.sha256'),`${'0'.repeat(64)}  runtime-assets/../../data.json\n`,{flag:'a'});
 if(kind==='unlisted source asset')await put(join(f.source,'runtime-assets/extra.bin'),'not hashed');
 const r=await run(f);await assertRolledBack(f,before,keep,r);assert.equal((await transactions(f)).length,0);
});
test('rollback I/O failure leaves originals, presence inventory, journal and lock visible',async()=>{
 const f=await fixture(),before=await snapshot(f.target),keep=await protectedState(f);
 const r=await run(f,{env:{TG_RULE:'mv:replace',TG_REL:'styles.css',TG_POST:'1',TG_ROLLBACK_FAIL:'1'}});
 assert.equal(r.status,70,JSON.stringify(r));assert.match(r.stderr,/回滚未完成/);assert.equal(await exists(f.lock),true);
 const tx=(await transactions(f))[0];assert.ok(tx);assert.match(r.stderr,/恢复记录/);
 assert.match(await readFile(join(tx,'journal.log'),'utf8'),/ROLLBACK_FAILED/);
 const inventory=await readFile(join(tx,'inventory.tsv'),'utf8');assert.match(inventory,/yes\tmain.js/);assert.match(inventory,/no\truntime-assets\/new.bin/);
 for(const rel of oldLeaves)assert.equal(sha(await readFile(join(tx,'originals',rel))),before[rel].hash,rel);
 assert.deepEqual(await protectedState(f),keep);
 const retry=await run(f,{tag:'retry'});assert.notEqual(retry.status,0);assert.match(retry.stderr,/安装锁/);
});
for(const sig of ['INT','TERM'])test(`${sig} after replacement runs bounded automatic rollback`,async()=>{
 const f=await fixture(),before=await snapshot(f.target),keep=await protectedState(f);
 const r=await run(f,{env:{TG_RULE:'mv:replace',TG_REL:shared,TG_POST:'1',TG_SIGNAL:sig}});
 assert.equal(r.status,sig==='INT'?130:143,JSON.stringify(r));await assertRolledBack(f,before,keep,r);
});
test('same-target concurrent installer refuses lock without stealing it',async()=>{
 const f=await fixture(),keep=await protectedState(f);
 const first=launch(f,{tag:'first',env:{TG_RULE:'mv:replace',TG_REL:'styles.css',TG_POST:'1',TG_PAUSE:'1'}});
 try{
  await waitUntil(()=>exists(join(f.dir,'fired')));
  const second=await run(f,{tag:'second'});assert.notEqual(second.status,0);assert.match(second.stderr,/安装锁/);assert.equal(await exists(f.lock),true);
 }finally{first.child.kill('SIGCONT');}
 const r=await first.done;assert.equal(r.status,0,JSON.stringify(r));assert.equal(await exists(f.lock),false);assert.deepEqual(await protectedState(f),keep);
});
test('destination symlink rejected without writing outside target',async()=>{
 const f=await fixture(),outside=join(f.dir,'untouched outside'),p=join(f.target,'runtime-assets/new.bin');
 await writeFile(outside,'outside original');await symlink(outside,p);
 const r=await run(f);assert.notEqual(r.status,0);assert.match(r.stderr,/不安全/);assert.equal(await readFile(outside,'utf8'),'outside original');
 assert.doesNotMatch(await readFile(f.trace,'utf8'),/mv:replace:/);
});
await Promise.all(pending);
});
