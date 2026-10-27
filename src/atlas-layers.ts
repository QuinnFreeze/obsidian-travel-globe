import {
 Cartesian3,Color,Ellipsoid,EllipsoidalOccluder,GeometryInstance,GroundPolylineGeometry,GroundPolylinePrimitive,
 HorizontalOrigin,LabelCollection,LabelStyle,Material,PolylineCollection,PolylineMaterialAppearance,
 SceneTransforms,VerticalOrigin,ClassificationType,type Scene,type Label
} from 'cesium';
import {MAP_COLORS,atlasLod,selectLabelBoxes,type AtlasData,type AtlasLod,type AtlasLabel,type LabelBox,type BorderClassification} from './map-style';

export class AtlasLayers {
 private disposed=false;private showBorders=false;private showLabels=false;private low=false;private lod?:AtlasLod;
 private ground:GroundPolylinePrimitive[]=[];private floating?:PolylineCollection;private materials:Material[]=[];
 private labels?:LabelCollection;private labelItems:{label:Label;source:AtlasLabel;position:Cartesian3}[]=[];
 private lastLabels=0;private dirty=true;private lastCamera='';private groundSupported:boolean;
 private pendingSince=0;private borderPending=false;private borderPaintFrames=0;private labelTimer?:number;
 constructor(private scene:Scene,private el:HTMLElement,private data:AtlasData,private mobile:boolean,
  private wake:()=>void,private sample:(lat:number,lng:number)=>number){
  this.groundSupported=GroundPolylinePrimitive.isSupported(scene);
  el.dataset.atlasSource=data.source.name+' '+data.source.version;
  el.dataset.atlasPlacement=this.groundSupported?'ground':'approximate';
 }
 update(borders:boolean,labels:boolean,low:boolean){
  if(this.disposed)return;
  const changed=this.showBorders!==borders||this.showLabels!==labels||this.low!==low;
  this.showBorders=borders;this.showLabels=labels;this.low=low;
  for(const primitive of this.ground)primitive.show=borders;
  if(this.floating)this.floating.show=borders;
  if(this.labels)this.labels.show=labels;
  if(!labels)this.el.dataset.atlasVisibleLabels='0';
  if(changed){this.dirty=true;this.wake();}
 }
 refresh(){if(this.disposed)return;this.lod=undefined;this.dirty=true;this.wake();}
 frame(altitude:number){
  if(this.disposed)return;
  const camera=this.scene.camera;
  const key=[camera.positionWC.x,camera.positionWC.y,camera.positionWC.z,camera.directionWC.x,camera.directionWC.y,camera.directionWC.z,this.el.clientWidth,this.el.clientHeight].join(':');
  if(key!==this.lastCamera){this.lastCamera=key;this.dirty=true;if(this.showBorders)this.borderPaintFrames=Math.max(this.borderPaintFrames,4);}
  if(this.showBorders){
   const lod=atlasLod(altitude,this.mobile,this.low);
   if(this.lod!==lod){this.clearBorders();this.createBorders(lod);this.lod=lod;this.el.dataset.atlasLod=lod;}
   const pending=this.ground.some(primitive=>!primitive.ready);
   if(pending){this.borderPending=true;if(performance.now()-this.pendingSince<15000)this.scene.requestRender();}
   else if(this.borderPending){this.borderPending=false;this.borderPaintFrames=4;}
   if(this.borderPaintFrames>0){this.borderPaintFrames--;this.scene.requestRender();}
   this.el.dataset.atlasBorderReady=String(!pending&&!this.borderPaintFrames);
  }
  if(!this.showLabels)return;
  if(!this.labels)this.createLabels();
  const now=performance.now();if(!this.dirty)return;
  const win=this.el.ownerDocument.defaultView||window;
  if(now-this.lastLabels<100){if(this.labelTimer===undefined)this.labelTimer=win.setTimeout(()=>{this.labelTimer=undefined;if(!this.disposed)this.wake();},Math.ceil(100-(now-this.lastLabels)));return;}
  if(this.labelTimer!==undefined){win.clearTimeout(this.labelTimer);this.labelTimer=undefined;}
  this.lastLabels=now;this.dirty=false;
  const occluder=new EllipsoidalOccluder(Ellipsoid.WGS84,camera.positionWC),boxes:LabelBox[]=[];
  const center=altitude>.65?SceneTransforms.worldToWindowCoordinates(this.scene,Cartesian3.ZERO):undefined;
  const frustum=camera.frustum as {fovy?:number;fov?:number};
  const distance=Cartesian3.magnitude(camera.positionWC);
  const radius=center&&frustum.fovy?this.el.clientHeight/2*Math.tan(Math.asin(Math.min(1,Ellipsoid.WGS84.maximumRadius/distance)))/Math.tan(frustum.fovy/2):undefined;
  for(const item of this.labelItems){
   const [lng,lat]=item.source.position;
   item.position=Cartesian3.fromDegrees(lng,lat,this.sample(lat,lng)+1200);item.label.position=item.position;
   const p=SceneTransforms.worldToWindowCoordinates(this.scene,item.position);
   if(!p||!occluder.isPointVisible(item.position))continue;
   const text=item.source.nameZh||item.source.name;
   const width=[...text].reduce((n,char)=>n+(/[㐀-鿿]/.test(char)?1:.6),0)*(this.mobile?14:13)+10;
   const box={id:item.source.id,x:p.x-width/2,y:p.y-11,width,height:22,rank:item.source.rank};
   if(center&&radius&&[[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]].some(([x,y])=>Math.hypot(x-center.x,y-center.y)>radius-6))continue;
   boxes.push(box);
  }
  const visible=new Set(selectLabelBoxes(boxes,this.el.clientWidth,this.el.clientHeight,this.mobile?28:55));
  let changed=false;
  for(const item of this.labelItems){const show=visible.has(item.source.id);if(item.label.show!==show){item.label.show=show;changed=true;}}
  this.el.dataset.atlasVisibleLabels=String(visible.size);
  if(changed)this.scene.requestRender();
 }
 private borderMaterial(kind:BorderClassification){
  const color=Color.fromCssColorString(MAP_COLORS.border)!.withAlpha(.95);
  const material=kind==='normal'?Material.fromType('PolylineOutline',{color,outlineColor:Color.fromCssColorString(MAP_COLORS.outline)!.withAlpha(.65),outlineWidth:.6}):Material.fromType('PolylineDash',{color,gapColor:Color.TRANSPARENT,dashLength:kind==='disputed'?16:10,dashPattern:255});
  this.materials.push(material);return material;
 }
 private createBorders(lod:AtlasLod){
  const lines=this.data.borders[lod];this.pendingSince=performance.now();this.borderPending=true;this.borderPaintFrames=0;this.el.dataset.atlasBorderReady='false';
  if(this.groundSupported){
   try{
    for(const kind of ['normal','disputed','indeterminate'] as const){
     const group=lines.filter(line=>line.classification===kind);if(!group.length)continue;
     const instances=group.map(line=>new GeometryInstance({id:line.id,geometry:new GroundPolylineGeometry({positions:line.coordinates.map(([lng,lat])=>Cartesian3.fromDegrees(lng,lat)),width:kind==='normal'?2.2:1.8})}));
     const primitive=new GroundPolylinePrimitive({geometryInstances:instances,appearance:new PolylineMaterialAppearance({material:this.borderMaterial(kind)}),classificationType:ClassificationType.TERRAIN,allowPicking:false,asynchronous:true});
     this.ground.push(this.scene.groundPrimitives.add(primitive));
    }
   }catch(error){
    this.clearBorders();this.groundSupported=false;this.el.dataset.atlasPlacement='approximate';
    console.warn('Travel Globe ground borders:',error);this.createFloating(lod);
   }
  }else this.createFloating(lod);
  this.el.dataset.atlasBorderLines=String(lines.length);this.wake();
 }
 private createFloating(lod:AtlasLod){
  this.floating=this.scene.primitives.add(new PolylineCollection());
  const materials=new Map<BorderClassification,Material>();
  for(const line of this.data.borders[lod]){
   let material=materials.get(line.classification);if(!material){material=this.borderMaterial(line.classification);materials.set(line.classification,material);}
   this.floating!.add({positions:line.coordinates.map(([lng,lat])=>Cartesian3.fromDegrees(lng,lat,this.sample(lat,lng)+80)),width:line.classification==='normal'?2.2:1.8,material});
  }
 }
 private createLabels(){
  this.labels=this.scene.primitives.add(new LabelCollection({scene:this.scene,show:this.showLabels}));
  const fontFamily=this.el.ownerDocument.defaultView?.getComputedStyle(this.el).fontFamily||'sans-serif';
  for(const source of this.data.labels){
   const [lng,lat]=source.position,position=Cartesian3.fromDegrees(lng,lat,this.sample(lat,lng)+1200);
   const label=this.labels!.add({position,text:source.nameZh||source.name,font:'500 '+(this.mobile?14:13)+'px '+fontFamily,
    fillColor:Color.fromCssColorString(MAP_COLORS.label),outlineColor:Color.fromCssColorString(MAP_COLORS.outline),outlineWidth:2,
    style:LabelStyle.FILL_AND_OUTLINE,horizontalOrigin:HorizontalOrigin.CENTER,verticalOrigin:VerticalOrigin.CENTER,
    disableDepthTestDistance:Number.POSITIVE_INFINITY,show:false});
   this.labelItems.push({label,source,position});
  }
  this.dirty=true;this.wake();
 }
 private clearBorders(){
  for(const primitive of this.ground)if(!primitive.isDestroyed())this.scene.groundPrimitives.remove(primitive);
  this.ground=[];
  if(this.floating&&!this.floating.isDestroyed())this.scene.primitives.remove(this.floating);this.floating=undefined;
  for(const material of this.materials)if(!material.isDestroyed())material.destroy();this.materials=[];
 }
 dispose(){
  if(this.disposed)return;this.disposed=true;if(this.labelTimer!==undefined)(this.el.ownerDocument.defaultView||window).clearTimeout(this.labelTimer);this.labelTimer=undefined;this.clearBorders();
  if(this.labels&&!this.labels.isDestroyed())this.scene.primitives.remove(this.labels);this.labels=undefined;this.labelItems=[];
 }
}
