interface Disk {
  exists(path:string):Promise<boolean>;writeBinary(path:string,data:ArrayBuffer):Promise<void>;
  rename(from:string,to:string):Promise<void>;remove(path:string):Promise<void>;
}
/** Obsidian adapters refuse rename-over-existing. Retain a recoverable previous file. */
export async function recoverFile(disk:Disk,path:string){
  if(!await disk.exists(path)&&await disk.exists(path+'.previous'))await disk.rename(path+'.previous',path);
}
export async function replaceBinary(disk:Disk,path:string,data:ArrayBuffer){
  const temp=path+'.tmp',previous=path+'.previous';await recoverFile(disk,path);
  try{
    await disk.writeBinary(temp,data);
    if(await disk.exists(path)){
      if(await disk.exists(previous))await disk.remove(previous);
      await disk.rename(path,previous);
    }
    await disk.rename(temp,path);
  }catch(error){
    await recoverFile(disk,path).catch(()=>{});
    if(await disk.exists(temp))await disk.remove(temp).catch(()=>{});
    throw error;
  }
  if(await disk.exists(previous))await disk.remove(previous).catch(()=>{});
}
