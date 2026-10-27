import {replaceBinary,recoverFile} from './resource-files';
import {isMissingResource} from './resource-read';
const READ_ERROR='缓存暂不可读，已保留原件，请稍后重试：';
export interface TileDisk {
  exists(path:string):Promise<boolean>; mkdir(path:string):Promise<void>;
  list(path:string):Promise<{files:string[];folders:string[]}>;
  stat(path:string):Promise<{size:number;mtime:number}|null>;
  readBinary(path:string):Promise<ArrayBuffer>;writeBinary(path:string,data:ArrayBuffer):Promise<void>;
  remove(path:string):Promise<void>;rename?(from:string,to:string):Promise<void>;
}
export interface CacheSource {prefix:string;extension:string;url:(z:number,x:number,y:number)=>string;valid:(data:ArrayBuffer)=>boolean}
export const SATELLITE_SOURCE='https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g';
export function tileKey(z:number,x:number,y:number){
  if(!Number.isInteger(z)||z<0||z>14||!Number.isInteger(x)||!Number.isInteger(y)||y<0||y>=2**z)throw Error('无效卫星瓦片坐标');
  return `eox2024-${z}-${((x%2**z)+2**z)%2**z}-${y}.jpg`;
}
/** Persistent cache lives inside the plugin, never amongst travel notes or photographs. */
export class SatelliteCache {
  lastError='';online=true;limitBytes=128*1024*1024;legacyFolder?:string;
  refreshAfter=30*24*60*60*1000;private refreshing=new Map<string,Promise<void>>();
  stats={hits:0,downloads:0,failures:0,bytes:0,entries:0};
  private clearing=false;private ready?:Promise<void>;private entries=new Map<string,{size:number;used:number;updated:number}>();
  private pending=new Map<string,Promise<ArrayBuffer>>();private active=0;private waiting:(()=>void)[]=[];
  private mutations:Promise<unknown>=Promise.resolve();private generation=0;
  constructor(private disk:TileDisk,readonly folder:string,private fetchTile:(url:string)=>Promise<ArrayBuffer>,private source?:CacheSource){}
  private key(z:number,x:number,y:number){const key=tileKey(z,x,y);return this.source?key.replace('eox2024',this.source.prefix).replace('.jpg','.'+this.source.extension):key;}
  private own(key:string){return this.source?new RegExp('^'+this.source.prefix+'-[0-9]+-[0-9]+-[0-9]+[.]'+this.source.extension+'$').test(key):/^eox2024-\d+-\d+-\d+\.jpg$/.test(key);}
  private async readStat(path:string){
    try{return await this.disk.stat(path);}catch(error){if(!isMissingResource(error))throw error;return null;}
  }
  private async initialize(){
    const parts=this.folder.split('/');for(let i=1;i<=parts.length;i++){const path=parts.slice(0,i).join('/');if(!await this.disk.exists(path))await this.disk.mkdir(path);}
    const {files}=await this.disk.list(this.folder);
    // Publish a complete scan only; a failed stat must not leave a partial/poisoned index.
    const entries=new Map<string,{size:number;used:number;updated:number}>();let cursor=0;
    await Promise.all(Array.from({length:Math.min(6,files.length)},async()=>{
      while(cursor<files.length){const path=files[cursor++]!;
        const key=path.slice(this.folder.length+1);if(!this.own(key))continue;
        const info=await this.readStat(path);if(info)entries.set(key,{size:info.size,used:info.mtime,updated:info.mtime});
      }
    }));
    this.entries=entries;this.measure();
  }
  private ensureReady(){
    if(!this.ready)this.ready=this.initialize().catch(error=>{this.ready=undefined;throw error;});
    return this.ready;
  }
  private measure(){this.stats.bytes=[...this.entries.values()].reduce((sum,e)=>sum+e.size,0);this.stats.entries=this.entries.size;}
  get(z:number,x:number,y:number):Promise<ArrayBuffer>{
    if(this.clearing)return Promise.reject(Error('卫星缓存正在清理'));
    const key=this.key(z,x,y),existing=this.pending.get(key);if(existing)return existing;
    const generation=this.generation;
    const work=this.load(key,z,x,y,generation).finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;
  }
  private async load(key:string,z:number,x:number,y:number,generation:number){
    const path=this.folder+'/'+key;let corrupt=false;
    try{
      await this.ensureReady();
      if(!this.entries.has(key)){
        if(this.disk.rename&&await this.disk.exists(path+'.previous'))await recoverFile(this.disk as TileDisk&{rename(from:string,to:string):Promise<void>},path);
        // Also discover files restored by sync after initialization, without recreating the cache instance.
        const info=await this.readStat(path);if(info){this.entries.set(key,{size:info.size,used:info.mtime,updated:info.mtime});this.measure();}
      }
      if(!this.entries.has(key)&&this.legacyFolder){
        try{const old=this.legacyFolder+'/'+key;if(await this.disk.exists(old)){
          const data=await this.disk.readBinary(old);if(this.isJpeg(data)){
            const stat=await this.readStat(old);await this.persist(key,data,generation);
            const entry=this.entries.get(key);if(entry)entry.updated=stat?.mtime??0;
          }
        }}catch(error){if(!isMissingResource(error))throw error;}
      }
      if(this.entries.has(key)){
        let data:ArrayBuffer|undefined;
        try{data=await this.disk.readBinary(path);}catch(error){if(!isMissingResource(error))throw error;}
        if(data&&this.isJpeg(data)){
          const entry=this.entries.get(key)!;entry.used=Date.now();this.stats.hits++;
          if(this.lastError.startsWith(READ_ERROR))this.lastError='';
          if(this.online&&Date.now()-entry.updated>=this.refreshAfter&&!this.refreshing.has(key)){
            const work=this.remote(key,z,x,y,generation).then(()=>{}).catch(()=>{}).finally(()=>this.refreshing.delete(key));this.refreshing.set(key,work);
          }return data;
        }
        // Only proven absence or bytes that actually failed validation can invalidate the index.
        corrupt=!!data;this.entries.delete(key);this.measure();
      }
    }catch(error){this.lastError=READ_ERROR+String(error);throw Error(this.lastError);}
    if(!this.online)throw Error(corrupt?'此区域缓存损坏，未缓存可用影像；联网后可重新加载。':'未缓存此区域；联网加载一次后可离线查看。');
    return this.remote(key,z,x,y,generation);
  }
  private async remote(key:string,z:number,x:number,y:number,generation:number){
    if(this.active>=4)await new Promise<void>(resolve=>this.waiting.push(resolve));else this.active++;
    try{
      if(!this.online)throw Error('影像下载已取消');
      const wrapped=((x%2**z)+2**z)%2**z;
      const data=await this.fetchTile(this.source?this.source.url(z,wrapped,y):`${SATELLITE_SOURCE}/${z}/${y}/${wrapped}.jpg`);
      if(!this.isJpeg(data)||data.byteLength>2*1024*1024)throw Error('卫星服务返回了无效影像');
      this.stats.downloads++;
      if(this.online&&generation===this.generation)try{await this.persist(key,data,generation);}catch(error){this.lastError='影像已加载，但缓存写入失败：'+(error instanceof Error?error.message:String(error));}
      return data;
    }catch(error){this.stats.failures++;this.lastError=error instanceof Error?error.message:String(error);throw error;}
    finally{const next=this.waiting.shift();if(next)next();else this.active--;}
  }
  private async persist(key:string,data:ArrayBuffer,generation:number){
    const write=this.mutations.then(async()=>{
      if(generation!==this.generation)return;const path=this.folder+'/'+key;
      if(this.disk.rename)await replaceBinary(this.disk as TileDisk&{rename(from:string,to:string):Promise<void>},path,data);
      else await this.disk.writeBinary(path,data);
      this.entries.set(key,{size:data.byteLength,used:Date.now(),updated:Date.now()});if(this.lastError.startsWith('影像已加载，但缓存写入失败')||this.lastError.startsWith(READ_ERROR))this.lastError='';this.measure();
      for(const [old,info]of [...this.entries].sort((a,b)=>a[1].used-b[1].used)){
        if(this.stats.bytes<=this.limitBytes)break;
        await this.disk.remove(this.folder+'/'+old);this.entries.delete(old);this.stats.bytes-=info.size;
      }this.measure();
    });this.mutations=write.catch(()=>{});await write;
  }
  stop(){this.online=false;this.generation++;}
  async settled(){await Promise.allSettled([...this.pending.values(),...this.refreshing.values()]);}
  private isJpeg(data:ArrayBuffer){if(this.source)return this.source.valid(data);const b=new Uint8Array(data);return b.length>4&&b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217;}
  async clear(){
    this.clearing=true;try{this.generation++;await this.settled();await this.ensureReady();await this.mutations;
    const {files}=await this.disk.list(this.folder);
    for(const path of files)if(this.own(path.slice(this.folder.length+1)))await this.disk.remove(path);
    this.entries.clear();this.lastError='';this.measure();}finally{this.clearing=false;}
  }
}
