import {replaceBinary,recoverFile} from './resource-files';
import {isMissingResource} from './resource-read';
const LOCAL_ERROR='本地资源暂不可用，使用安装包底图：';
export const RESOURCE_FOLDER='地球资源';
export const RESOURCE_SCHEMA='earth-v2';
export const RESOURCE_TTL=7*24*60*60*1000;
export interface ResourceDisk {
  exists(path:string):Promise<boolean>;mkdir(path:string):Promise<void>;
  stat?(path:string):Promise<{size:number;mtime:number}|null>;
  read(path:string):Promise<string>;write(path:string,text:string):Promise<void>;
  readBinary(path:string):Promise<ArrayBuffer>;writeBinary(path:string,data:ArrayBuffer):Promise<void>;
  rename(from:string,to:string):Promise<void>;remove(path:string):Promise<void>;
}
export interface ResourceSpec {name:string;url:string;width:number;sourceWidth:number;kind:'surface'|'height'|'clouds';format?:'tiff'}
const nasa='https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/';
export const EARTH_RESOURCES:ResourceSpec[]=[
  ...([['low',1024],['standard',2048],['high',4096],['8k',8192]] as const).map(([tier,width])=>({name:`surface-${tier}.jpg`,width,sourceWidth:width===8192?21600:5400,kind:'surface' as const,url:nasa+`bmng-topography/july/world.topo.200407.3x${width===8192?'21600x10800':'5400x2700'}.jpg`})),
  ...([['low',1024],['standard',2048],['high',4096]] as const).map(([tier,width])=>({name:`height-${tier}.png`,width,sourceWidth:5400,kind:'height' as const,url:nasa+'topography/gebco_08_rev_elev_5400x2700.jpg'})),
  ...([['low',1024],['standard',2048]] as const).map(([tier,width])=>({name:`clouds-hd-${tier}.png`,width,sourceWidth:2048,kind:'clouds' as const,url:'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg'})),
  ...([['high',4096],['8k',8192]] as const).map(([tier,width])=>({name:`clouds-hd-${tier}.png`,width,sourceWidth:8192,kind:'clouds' as const,format:'tiff' as const,url:'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif'}))
];
interface Stamp {checked:number;etag?:string;modified?:string;source:string}
interface Response {status:number;headers:Record<string,string>;data:ArrayBuffer}
/** Local files render first. Updates replace only a decoded, validated derivative. */
export class EarthResources {
  online=true;lastError='';private ready?:Promise<void>;private pending=new Map<string,Promise<void>>();
  private foreground=new Map<string,Promise<string>>();private stopped=false;private queue:Promise<void>=Promise.resolve();private attempted=new Map<string,number>();
  private validated=new Map<string,string>();private revisions=new Map<string,number>();
  readonly folder=RESOURCE_FOLDER+'/全球底图';
  constructor(private disk:ResourceDisk,private bundle:string,
    private fetch:(url:string,headers:Record<string,string>)=>Promise<Response>,
    private convert:(data:ArrayBuffer,spec:ResourceSpec)=>Promise<ArrayBuffer>,private now=()=>Date.now()){}
  private initialize(){
    return this.ready??= (async()=>{for(const path of [RESOURCE_FOLDER,this.folder])if(!await this.disk.exists(path))await this.disk.mkdir(path);})().catch(e=>{this.ready=undefined;throw e;});
  }
  resolve(path:string):Promise<string>{
    const name=path.split('/').pop()!,spec=EARTH_RESOURCES.find(s=>s.name===name);
    if(!spec)return Promise.resolve(this.bundle+'/'+path);
    const existing=this.foreground.get(name);if(existing)return existing;
    const work=this.local(spec).finally(()=>this.foreground.delete(name));this.foreground.set(name,work);return work;
  }
  private async local(spec:ResourceSpec){
    const target=this.folder+'/'+spec.name;
    try{
      await this.initialize();await recoverFile(this.disk,target);
      let valid=false;
      if(await this.disk.exists(target))try{
        const stamp=await this.fingerprint(target);
        valid=!!stamp&&this.validated.get(target)===stamp;
        if(!valid){valid=validImage(await this.disk.readBinary(target),spec.name);if(valid&&stamp)this.validated.set(target,stamp);}
      }catch(error){
        // A failed read/stat is not evidence of corrupt bytes. Keep the original and retry on the next resolve.
        if(!isMissingResource(error))throw error;
        this.validated.delete(target);
      }
      if(!valid){const seed=await this.disk.readBinary(this.bundle+'/runtime-assets/'+spec.name);if(!validImage(seed,spec.name))throw Error('安装包素材损坏');await this.atomic(target,seed);}
      if(this.lastError.startsWith(LOCAL_ERROR))this.lastError='';
      void this.refresh(spec).catch(()=>{});return target;
    }catch(error){this.lastError=LOCAL_ERROR+String(error);return this.bundle+'/runtime-assets/'+spec.name;}
  }
  private async fingerprint(path:string){
    const stat=await this.disk.stat?.(path);return stat&&Number.isFinite(stat.mtime)&&Number.isFinite(stat.size)?stat.mtime+':'+stat.size:undefined;
  }
  /** Stable across opens; changes after a local edit, replacement, or resource schema change. */
  async version(path:string){return RESOURCE_SCHEMA+':'+(await this.fingerprint(path)??'local')+':'+(this.revisions.get(path)??0);}
  refresh(spec:ResourceSpec,force=false):Promise<void>{
    const existing=this.pending.get(spec.name);if(existing)return existing;
    if(!this.online||this.stopped)return Promise.resolve();
    const work=this.queue.then(()=>this.update(spec,force)).catch(error=>{this.lastError='更新失败，保留本地底图：'+String(error);}).finally(()=>this.pending.delete(spec.name));
    this.queue=work;this.pending.set(spec.name,work);return work;
  }
  private async update(spec:ResourceSpec,force:boolean){
    if(this.stopped||!this.online)return;
    await this.initialize();const path=this.folder+'/'+spec.name;let stamp:Stamp|undefined;
    try{stamp=JSON.parse(await this.disk.read(path+'.json'));}catch{}
    if(!force&&stamp?.source===spec.url&&Number.isFinite(stamp.checked)&&this.now()-stamp.checked<RESOURCE_TTL)return;
    if(!force&&this.now()-(this.attempted.get(spec.name)??-Infinity)<60*60*1000)return;
    this.attempted.set(spec.name,this.now());
    const headers:Record<string,string>={};
    if(stamp?.source===spec.url&&await this.disk.exists(path)){if(stamp.etag)headers['If-None-Match']=stamp.etag;if(stamp.modified)headers['If-Modified-Since']=stamp.modified;}
    const response=await this.fetch(spec.url,headers);if(this.stopped||!this.online)return;
    if(response.status!==200&&response.status!==304)throw Error('NASA HTTP '+response.status);
    if(response.status===304&&(!stamp||!await this.disk.exists(path)))throw Error('缺少可复用的本地文件');
    if(response.status===200){
      if(!validImage(response.data,spec.format==='tiff'?'.tif':'.jpg')||response.data.byteLength>40*1024*1024)throw Error('上游返回无效影像');
      const converted=await this.convert(response.data,spec);if(this.stopped||!this.online)return;
      if(!validImage(converted,spec.name))throw Error('图像转换失败');await this.atomic(path,converted);
    }
    const lower=Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k.toLowerCase(),v]));
    const next:Stamp={checked:this.now(),etag:lower.etag??stamp?.etag,modified:lower['last-modified']??stamp?.modified,source:spec.url};
    const data=new TextEncoder().encode(JSON.stringify(next,null,2)+'\n');await this.atomic(path+'.json',data.buffer);this.lastError='';
  }
  private async atomic(path:string,data:ArrayBuffer){
    await replaceBinary(this.disk,path,data);
    this.validated.delete(path);this.revisions.set(path,(this.revisions.get(path)??0)+1);
    if(!path.endsWith('.json')){const stamp=await this.fingerprint(path);if(stamp)this.validated.set(path,stamp);}
  }
  async settled(){await Promise.allSettled([...this.pending.values()]);}
  stop(){this.stopped=true;}
}
export function validImage(data:ArrayBuffer,name:string){
  const b=new Uint8Array(data);
  if(name.endsWith('.tif'))return b.length>8&&((b[0]===73&&b[1]===73&&b[2]===42&&b[3]===0)||(b[0]===77&&b[1]===77&&b[2]===0&&b[3]===42));
  return name.endsWith('.jpg')?b.length>4&&b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217:
    b.length>8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);
}
/** Decoder scales before canvas allocation; no 21K canvas or GPU texture is created. */
export async function convertEarthImage(data:ArrayBuffer,spec:ResourceSpec){
  const dimensions=jpegDimensions(data);
  if(!dimensions||dimensions.width!==spec.sourceWidth||dimensions.height*2!==dimensions.width)throw Error('上游影像尺寸或投影不符');
  const bitmap=await createImageBitmap(new Blob([data]),{resizeWidth:spec.width,resizeHeight:spec.width/2,resizeQuality:'high'});
  try{
    const canvas=document.createElement('canvas');canvas.width=spec.width;canvas.height=spec.width/2;
    const ctx=canvas.getContext('2d');if(!ctx)throw Error('图像解码不可用');ctx.drawImage(bitmap,0,0);
    if(spec.kind!=='surface'){
      const image=ctx.getImageData(0,0,canvas.width,canvas.height),pixels=image.data;
      for(let i=0;i<pixels.length;i+=4){const value=Math.round(.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2]);pixels[i]=pixels[i+1]=pixels[i+2]=value;}ctx.putImageData(image,0,0);
    }
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('图像编码失败')),spec.kind==='surface'?'image/jpeg':'image/png',.96));
    canvas.width=canvas.height=1;return blob.arrayBuffer();
  }finally{bitmap.close();}
}

function jpegDimensions(data:ArrayBuffer):{width:number;height:number}|undefined {
  const b=new Uint8Array(data);let offset=2;
  while(offset+8<b.length){
    if(b[offset++]!==255)return;const marker=b[offset++];if(marker===0xd9||marker===0xda)return;
    if(marker===0xff){offset--;continue;}if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
    const size=(b[offset]<<8)|b[offset+1];if(size<2||offset+size>b.length)return;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return {height:(b[offset+3]<<8)|b[offset+4],width:(b[offset+5]<<8)|b[offset+6]};
    offset+=size;
  }
}
