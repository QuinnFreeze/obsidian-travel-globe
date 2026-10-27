import {SatelliteCache,type TileDisk} from './tile-cache';
export const TERRAIN_SOURCE='https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const EARTH_METRES=6371000;
export function terrariumHeight(r:number,g:number,b:number){return r*256+g+b/256-32768;}
export function validTerrainPng(data:ArrayBuffer){
 const a=new Uint8Array(data),v=new DataView(data);
 return a.length>32&&[137,80,78,71,13,10,26,10].every((n,i)=>a[i]===n)&&v.getUint32(16)===256&&v.getUint32(20)===256;
}
export function createTerrainCache(disk:TileDisk,folder:string,fetch:(url:string)=>Promise<ArrayBuffer>){
 const cache=new SatelliteCache(disk,folder,fetch,{prefix:'terrain-v1',extension:'png',url:(z,x,y)=>TERRAIN_SOURCE+'/'+z+'/'+x+'/'+y+'.png',valid:validTerrainPng});
 cache.limitBytes=64*1024*1024;return cache;
}
/** NASA's north-up height field is the coarse offline fallback, not a precise DEM. */
export class GlobalHeightField {
 constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}
 sample(lat:number,lng:number){
  const x=((lng+180)/360*this.width-.5+this.width)%this.width,y=Math.max(0,Math.min(this.height-1,(90-lat)/180*this.height-.5)),x0=Math.floor(x),y0=Math.floor(y),fx=x-x0,fy=y-y0;
  const at=(a:number,b:number)=>this.data[(Math.min(this.height-1,b)*this.width+a%this.width)*4]/255*6400;
  return (at(x0,y0)*(1-fx)+at(x0+1,y0)*fx)*(1-fy)+(at(x0,y0+1)*(1-fx)+at(x0+1,y0+1)*fx)*fy;
 }
}
/** Decode only a bounded coarse field; close-up detail comes from independent terrain tiles. */
export async function readHeightField(url:string,maxWidth=2048){
 const image=await new Promise<HTMLImageElement>((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('高程图读取失败'));i.src=url;});
 if(!image.width||!image.height||image.width!==image.height*2)throw Error('高程图尺寸或投影不符');
 const width=Math.min(image.width,Math.max(1,Math.floor(maxWidth))),height=Math.max(1,Math.round(image.height*width/image.width));
 const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
 try{
  const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw Error('高程解码不可用');
  ctx.drawImage(image,0,0,width,height);return new GlobalHeightField(ctx.getImageData(0,0,width,height).data,width,height);
 }finally{canvas.width=canvas.height=1;image.src='';}
}
