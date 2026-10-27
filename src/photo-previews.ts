export interface PhotoFile {path:string;stat:{mtime:number;size:number}}
interface Preview {url:string;path:string}

/** Device-memory-only derived images. Original attachments are never written or replaced. */
export class PhotoPreviews {
  private cache=new Map<string,Preview>();private pending=new Map<string,Promise<string>>();
  private active=0;private waiters:(()=>void)[]=[];private stopped=false;
  constructor(private load:(file:PhotoFile)=>Promise<ArrayBuffer>,private make:(data:ArrayBuffer,file:PhotoFile)=>Promise<string>=thumbnail,
    private revoke:(url:string)=>void=url=>URL.revokeObjectURL(url),private limit=24){}
  get(file:PhotoFile):Promise<string>{
    if(this.stopped)return Promise.reject(Error('照片预览已关闭'));
    const key=file.path+':'+file.stat.mtime+':'+file.stat.size,cached=this.cache.get(key);
    if(cached){this.cache.delete(key);this.cache.set(key,cached);return Promise.resolve(cached.url);}
    const pending=this.pending.get(key);if(pending)return pending;
    const work=this.generate(file,key).finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;
  }
  private async generate(file:PhotoFile,key:string){
    if(this.active>=2)await new Promise<void>(resolve=>this.waiters.push(resolve));else this.active++;
    if(this.stopped)throw Error('照片预览已关闭');
    try{
      if(file.stat.size>25*1024*1024)throw Error('照片超过预览大小限制，请打开原图');
      const data=await this.load(file);if(this.stopped)throw Error('照片预览已关闭');
      const url=await this.make(data,file);
      if(this.stopped){this.revoke(url);throw Error('照片预览已关闭');}
      for(const [old,preview]of this.cache)if(preview.path===file.path){this.revoke(preview.url);this.cache.delete(old);}
      this.cache.set(key,{url,path:file.path});
      while(this.cache.size>this.limit){const oldest=this.cache.entries().next().value!;this.revoke(oldest[1].url);this.cache.delete(oldest[0]);}
      return url;
    }finally{const next=this.waiters.shift();if(next)next();else this.active--;}
  }
  dispose(){this.stopped=true;for(const value of this.cache.values())this.revoke(value.url);this.cache.clear();for(const release of this.waiters.splice(0))release();}
}

async function thumbnail(data:ArrayBuffer,file:PhotoFile){
  const extension=file.path.split('.').pop()?.toLowerCase();
  const mime=extension==='jpg'||extension==='jpeg'?'image/jpeg':'image/'+extension;
  const source=URL.createObjectURL(new Blob([data],{type:mime})),image=new Image();image.decoding='async';
  try{
    await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(Error('照片尚未同步、格式不支持或文件损坏'));image.src=source;});
    if(!image.naturalWidth||!image.naturalHeight)throw Error('照片尺寸无效');
    const scale=Math.min(1,512/image.naturalWidth,512/image.naturalHeight),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    try{
      const context=canvas.getContext('2d');if(!context)throw Error('照片预览暂不可用');
      context.drawImage(image,0,0,canvas.width,canvas.height);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('照片预览生成失败')),'image/jpeg',.84));
      return URL.createObjectURL(blob);
    }finally{canvas.width=canvas.height=1;}
  }finally{image.src='';URL.revokeObjectURL(source);}
}
