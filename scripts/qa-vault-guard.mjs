import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {relative} from 'node:path';
export function isIsolatedQaVault(vault,expected=process.env.TRAVEL_GLOBE_QA_VAULT){
 if(!expected)return ['/tmp/travel-globe-qa-vault','/private/tmp/travel-globe-qa-vault'].includes(vault);
 try{
  const root=realpathSync(tmpdir()),target=realpathSync(expected),actual=realpathSync(vault);
  const path=relative(root,target).replace(/\\/g,'/');
  return /^travel-globe-atlas-qa-[A-Za-z0-9]+\/vault$/.test(path)&&actual===target;
 }catch{return false;}
}
