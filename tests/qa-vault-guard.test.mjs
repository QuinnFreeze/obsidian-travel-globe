import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isIsolatedQaVault} from '../scripts/qa-vault-guard.mjs';

test('QA守卫只接受明确创建的临时测试vault，不接受任意个人或其它临时路径',async()=>{
 const qa=await mkdtemp(join(tmpdir(),'travel-globe-atlas-qa-'));
 const unrelated=await mkdtemp(join(tmpdir(),'travel-globe-unrelated-'));
 try{
  const vault=join(qa,'vault'),other=join(unrelated,'vault');await mkdir(vault);await mkdir(other);
  assert.equal(isIsolatedQaVault(vault,vault),true);
  assert.equal(isIsolatedQaVault(other,other),false);
  assert.equal(isIsolatedQaVault(other,vault),false);
  assert.equal(isIsolatedQaVault(process.cwd(),process.cwd()),false);
  assert.equal(isIsolatedQaVault('/not/existing',vault),false);
 }finally{await rm(qa,{recursive:true,force:true});await rm(unrelated,{recursive:true,force:true});}
});

test('旧固定QA目录的兼容不会放行个人vault',()=>{
 assert.equal(isIsolatedQaVault('/tmp/travel-globe-qa-vault',''),true);
 assert.equal(isIsolatedQaVault('/private/tmp/travel-globe-qa-vault',''),true);
 assert.equal(isIsolatedQaVault(process.cwd(),''),false);
});
