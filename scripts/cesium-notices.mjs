import {readFile,writeFile,readdir,rename} from 'node:fs/promises';
export async function collectCesiumNotices(targetDir = 'runtime-assets/cesium/'){
 const root='node_modules/',target=targetDir.endsWith('/')?targetDir:targetDir+'/',seen=new Set(),pieces=[];
 const write=async(name,data)=>{await writeFile(target+name+'.tmp',data);await rename(target+name+'.tmp',target+name);};
 async function visit(name){
  if(seen.has(name))return;seen.add(name);let manifest;
  try{manifest=JSON.parse(await readFile(root+name+'/package.json','utf8'));}catch{return;}
  pieces.push('\n\n## '+name+' '+manifest.version+'\n');
  for(const e of await readdir(root+name,{withFileTypes:true}))if(e.isFile()&&/^(license|copying|notice)/i.test(e.name))pieces.push(e.name+'\n'+await readFile(root+name+'/'+e.name,'utf8'));
  for(const dep of Object.keys(manifest.dependencies||{}))await visit(dep);
 }
 await visit('cesium');
 await write('DEPENDENCY_LICENSES.txt',pieces.join('\n'));
 for(const name of ['LICENSE.md','ThirdParty.json'])await write(name,await readFile(root+'cesium/'+name));
 await write('TERRAIN_CREDITS.md',await readFile('assets/terrain/ATTRIBUTION.md'));
}
