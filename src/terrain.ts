import {CustomHeightmapTerrainProvider,HeightmapTerrainData,GeographicTilingScheme,Math as CMath,Credit} from 'cesium';
import {SatelliteCache,type TileDisk} from './tile-cache';
import {mercatorY} from './zoom';
import {GlobalHeightField,terrariumHeight} from './terrain-data';
interface DemTile {data:Float32Array;used:number;z:number;x:number;y:number}
export class TerrainSurface {
 readonly provider:CustomHeightmapTerrainProvider;
 private decoded=new Map<string,DemTile>();private pending=new Map<string,Promise<DemTile>>();
 private closed=false;private active=0;
 stats={tiles:0,detailed:0,fallback:0,max:0};
 constructor(readonly coarse:GlobalHeightField,private cache:SatelliteCache,private mobile:boolean,private wake:()=>void){
  const scheme=new GeographicTilingScheme();
  this.provider=new CustomHeightmapTerrainProvider({width:65,height:65,tilingScheme:scheme,credit:new Credit('<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> · <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen / USGS / data sources</a>',true),callback:()=>new Float32Array(65*65)});
  this.provider.getTileDataAvailable=(_x,_y,level)=>level<=13;
  this.provider.requestTileGeometry=(x,y,level)=>{
   if(this.closed||this.active>=(this.mobile?4:8))return undefined;
   this.active++;
   const rect=scheme.tileXYToRectangle(x,y,level);
   return this.heights(level,CMath.toDegrees(rect.north),CMath.toDegrees(rect.south),CMath.toDegrees(rect.west),CMath.toDegrees(rect.east))
    .then(buffer=>new HeightmapTerrainData({buffer,width:65,height:65,childTileMask:level<13?15:0}))
    .finally(()=>{this.active--;this.wake();});
  };
 }
 private async decode(z:number,x:number,y:number){
  const n=2**z;x=((x%n)+n)%n;y=Math.max(0,Math.min(n-1,y));const key=z+'/'+x+'/'+y;
  const old=this.decoded.get(key);if(old){old.used=performance.now();return old;}
  const pending=this.pending.get(key);if(pending)return pending;
  const work=(async()=>{
   const data=await this.cache.get(z,x,y);if(this.closed)throw Error('地形视图已关闭');
   const bitmap=await createImageBitmap(new Blob([data],{type:'image/png'}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
   try{
    if(bitmap.width!==256||bitmap.height!==256)throw Error('高程瓦片尺寸不符');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw Error('高程解码不可用');
    ctx.drawImage(bitmap,0,0);const rgb=ctx.getImageData(0,0,256,256).data,heights=new Float32Array(256*256);
    for(let i=0;i<heights.length;i++){const h=terrariumHeight(rgb[i*4],rgb[i*4+1],rgb[i*4+2]);if(!Number.isFinite(h)||h< -12000||h>10000)throw Error('高程数值超出范围');heights[i]=Math.max(0,h);}
    canvas.width=canvas.height=1;
    const tile={data:heights,used:performance.now(),z,x,y};if(!this.closed)this.decoded.set(key,tile);return tile;
   }finally{bitmap.close();}
  })().finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;
 }
 private async heights(level:number,north:number,south:number,west:number,east:number){
  const result=new Float32Array(65*65),z=Math.max(0,Math.min(14,level-1)),n=2**z,tiles=new Map<string,DemTile>();let detailed=false;
  if(level>=4&&north<85&&south> -85)try{
   const x0=Math.floor((west+180)/360*n-1e-9),x1=Math.floor((east+180)/360*n+1e-9),y0=Math.floor(mercatorY(north)*n-1/512),y1=Math.floor(mercatorY(south)*n+1/512);
   const jobs:Promise<void>[]=[];
   for(let yy=y0;yy<=y1;yy++)for(let xx=x0;xx<=x1;xx++)jobs.push(this.decode(z,xx,yy).then(t=>{tiles.set(t.x+'/'+t.y,t);}));
   await Promise.all(jobs);detailed=true;
  }catch{/* Keep coarse terrain on missing, failed or offline detailed tiles. */}
  const value=(px:number,py:number)=>{
   const xx=Math.floor(px/256),yy=Math.max(0,Math.min(n-1,Math.floor(py/256))),tile=tiles.get(((xx%n+n)%n)+'/'+yy);
   return tile?.data[Math.max(0,Math.min(255,Math.floor(py)-yy*256))*256+((Math.floor(px)%256+256)%256)];
  };
  for(let row=0;row<=64;row++)for(let col=0;col<=64;col++){
   const lat=north+(south-north)*row/64,lng=west+(east-west)*col/64;let h=this.coarse.sample(lat,lng);
   if(detailed){
    const px=(lng+180)/360*n*256-.5,py=mercatorY(lat)*n*256-.5,ix=Math.floor(px),iy=Math.floor(py),fx=px-ix,fy=py-iy;
    const a=value(ix,iy),b=value(ix+1,iy),c=value(ix,iy+1),d=value(ix+1,iy+1);
    if(a!==undefined&&b!==undefined&&c!==undefined&&d!==undefined)h=(a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy;
   }
   result[row*65+col]=h;this.stats.max=Math.max(this.stats.max,h);
  }
  this.stats.tiles++;if(detailed)this.stats.detailed++;else this.stats.fallback++;
  const cap=this.mobile?24:64;
  for(const [key] of [...this.decoded].sort((a,b)=>a[1].used-b[1].used).slice(0,Math.max(0,this.decoded.size-cap)))this.decoded.delete(key);
  return result;
 }
 sample(lat:number,lng:number){
  for(const tile of [...this.decoded.values()].sort((a,b)=>b.z-a.z)){
   const n=2**tile.z,px=(lng+180)/360*n,py=mercatorY(lat)*n;
   if(Math.floor(px)===tile.x&&Math.floor(py)===tile.y)return tile.data[Math.min(255,Math.max(0,Math.floor((py-tile.y)*256)))*256+Math.min(255,Math.max(0,Math.floor((px-tile.x)*256)))];
  }return this.coarse.sample(lat,lng);
 }
 dispose(){this.closed=true;this.decoded.clear();}
}
