import {BufferGeometry,Float32BufferAttribute,Group,Mesh,MeshBasicMaterial,Texture,SRGBColorSpace,type PerspectiveCamera} from 'three';
import type {SatelliteCache} from './tile-cache';
import {tileLatitude,tileLongitude,visibleTiles,type ImageryTile} from './zoom';
interface Tile extends ImageryTile {mesh:Mesh<BufferGeometry,MeshBasicMaterial>;born:number;used:number}
/** Mercator imagery is draped on the same spherical surface as the offline globe. */
export class GlobeImagery {
  readonly group=new Group();private tiles=new Map<string,Tile>();private wanted=new Map<string,ImageryTile>();
  private pending=new Set<string>();private failed=new Set<string>();private closed=false;private active=0;
  private frame=0;private opacity=0;private status:HTMLElement;private attribution:HTMLElement;
  constructor(private el:HTMLElement,private cache:SatelliteCache,private radius:number,private mobile:boolean,private wake:()=>void){
    this.group.name='travel-globe-imagery';this.group.raycast=()=>{};
    this.status=document.createElement('div');this.status.className='tg-imagery-status';this.status.setAttribute('aria-live','polite');
    this.attribution=document.createElement('div');this.attribution.className='tg-imagery-attribution';
    this.attribution.innerHTML='<span class="tg-imagery-source"><a href="https://s2maps.eu">Sentinel-2 cloudless 2024</a> · </span><a href="https://eox.at">EOX</a> · Copernicus 2024 · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>';
    this.el.append(this.status,this.attribution);this.group.visible=false;this.updateStatus();
  }
  update(camera:PerspectiveCamera,center:{lat:number;lng:number;altitude:number},samples:{lat:number;lng:number}[]){
    if(this.closed)return;
    const {altitude}=center;this.opacity=Math.max(0,Math.min(1,(.95-altitude)/.5));this.group.visible=this.opacity>0;
    const selected=visibleTiles(samples,center,altitude,this.el.clientHeight,camera.fov,this.mobile?40:64);
    this.wanted=new Map(selected.map(t=>[t.key,t]));this.el.parentElement?.classList.toggle('tg-has-imagery',selected.length>0);
    for(const tile of this.tiles.values())if(this.wanted.has(tile.key))tile.used=performance.now();
    this.el.dataset.imageryLevel=String(selected[0]?.z??0);this.el.dataset.altitude=altitude.toFixed(6);
    this.paint();this.pump();this.trim();this.updateStatus();
  }
  private pump(){
    if(this.closed)return;
    for(const tile of this.wanted.values()){
      if(this.active>=4)break;
      if(this.tiles.has(tile.key)||this.pending.has(tile.key)||this.failed.has(tile.key))continue;
      this.active++;this.pending.add(tile.key);
      void this.load(tile).finally(()=>{this.active--;this.pending.delete(tile.key);if(!this.closed){this.pump();this.updateStatus();}});
    }
  }
  private async load(tile:ImageryTile){
    let bitmap:ImageBitmap|undefined,texture:Texture|undefined;
    try{
      const data=await this.cache.get(tile.z,tile.x,tile.y);
      if(this.closed||!this.wanted.has(tile.key))return;
      bitmap=await createImageBitmap(new Blob([data],{type:'image/jpeg'}),{imageOrientation:'flipY'});
      if(this.closed||!this.wanted.has(tile.key)){bitmap.close();return;}
      texture=new Texture(bitmap);texture.flipY=false;texture.colorSpace=SRGBColorSpace;texture.anisotropy=this.mobile?2:8;texture.needsUpdate=true;
      const material=new MeshBasicMaterial({map:texture,transparent:true,opacity:0,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-tile.z-1});
      const mesh=new Mesh(this.geometry(tile),material);mesh.renderOrder=tile.z+1;mesh.raycast=()=>{};
      const now=performance.now();this.tiles.set(tile.key,{...tile,mesh,born:now,used:now});this.group.add(mesh);this.trim();this.paint();this.wake();
    }catch{bitmap?.close();texture?.dispose();if(!this.closed)this.failed.add(tile.key);}
  }
  private geometry(tile:ImageryTile){
    const {x,y,z}=tile,n=2**z,segments=Math.max(1,Math.ceil(360/n/1.5)),positions:number[]=[],uv:number[]=[],indices:number[]=[];
    for(let row=0;row<=segments;row++)for(let col=0;col<=segments;col++){
      const lat=tileLatitude(y+row/segments,z)*Math.PI/180,lng=tileLongitude(x+col/segments,z)*Math.PI/180,r=this.radius*(1+1e-7);
      positions.push(r*Math.cos(lat)*Math.sin(lng),r*Math.sin(lat),r*Math.cos(lat)*Math.cos(lng));uv.push(col/segments,1-row/segments);
    }
    for(let row=0;row<segments;row++)for(let col=0;col<segments;col++){const a=row*(segments+1)+col,b=a+segments+1;indices.push(a,b,a+1,b,b+1,a+1);}
    const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
  }
  private paint=()=>{
    if(this.closed)return;cancelAnimationFrame(this.frame);this.frame=0;let fading=false;
    for(const tile of this.tiles.values()){
      const fade=Math.min(1,(performance.now()-tile.born)/240);tile.mesh.material.opacity=this.opacity*fade;if(fade<1)fading=true;
    }
    this.el.dataset.imageryTiles=String(this.tiles.size);
    if(fading&&this.group.visible){this.wake();this.frame=requestAnimationFrame(this.paint);}
  };
  private trim(){
    const cap=this.mobile?80:128;
    for(const tile of [...this.tiles.values()].sort((a,b)=>a.used-b.used)){
      if(this.tiles.size<=cap)break;if(this.wanted.has(tile.key))continue;this.remove(tile);
    }
    if(this.failed.size>256)this.failed=new Set([...this.failed].filter(key=>this.wanted.has(key)));
  }
  private remove(tile:Tile){this.group.remove(tile.mesh);tile.mesh.geometry.dispose();const texture=tile.mesh.material.map;(texture?.image as ImageBitmap|undefined)?.close();texture?.dispose();tile.mesh.material.dispose();this.tiles.delete(tile.key);}
  private updateStatus(){
    const count=[...this.wanted.keys()].filter(key=>this.tiles.has(key)).length,missing=[...this.wanted.keys()].filter(key=>this.failed.has(key)).length;
    this.status.hidden=!this.wanted.size;this.attribution.hidden=!this.group.visible||!this.tiles.size;
    const level=Number(this.el.dataset.imageryLevel),altitude=Number(this.el.dataset.altitude);
    this.status.textContent=!this.wanted.size?'':`${level===14&&altitude<.001?'影像放大 · 原始约 10 米':'逐级加载地表影像'} · ${this.cache.online?'联网并缓存':'仅离线缓存'}${missing?' · 未加载区域保留底图':count<this.wanted.size?' · 正在细化':''}${this.cache.lastError.startsWith('影像已加载，但缓存写入失败')?' · 缓存写入失败':''}`;
  }
  reload(){this.failed.clear();this.pump();this.updateStatus();}
  dispose(){if(this.closed)return;this.closed=true;cancelAnimationFrame(this.frame);for(const tile of this.tiles.values())this.remove(tile);this.wanted.clear();this.failed.clear();this.status.remove();this.attribution.remove();this.group.removeFromParent();}
}
