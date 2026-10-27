import {
 CesiumWidget,SkyBox,buildModuleUrl,SingleTileImageryProvider,UrlTemplateImageryProvider,ImageryLayer,WebMercatorTilingScheme,
 EllipsoidTerrainProvider,Ellipsoid,Cartesian3,Cartesian2,Cartographic,Math as CMath,Color,Rectangle,BoundingSphere,HeadingPitchRange,
 DirectionalLight,ScreenSpaceEventHandler,ScreenSpaceEventType,CameraEventType,KeyboardEventModifier,
 Material,Primitive,GeometryInstance,EllipsoidGeometry,MaterialAppearance,PointPrimitiveCollection,PolylineCollection,
 SceneTransforms,EllipsoidalOccluder,HorizontalOrigin,VerticalOrigin,Credit,CreditDisplay
} from 'cesium';
import earthLow from '../assets/realistic/surface-low.jpg';
import earthStandard from '../assets/realistic/surface-standard.jpg';
import earthHigh from '../assets/realistic/surface-high.jpg';
import earthUltra from '../assets/realistic/surface-8k.jpg';
import heightLow from '../assets/realistic/height-low.png';
import heightStandard from '../assets/realistic/height-standard.png';
import cloudLow from '../assets/realistic/clouds-hd-low.png';
import cloudStandard from '../assets/realistic/clouds-hd-standard.png';
import cloudHigh from '../assets/realistic/clouds-hd-high.png';
import cloudUltra from '../assets/realistic/clouds-hd-8k.png';
import borders from '../assets/realistic/borders.json';
import atlasLow from '../assets/atlas/atlas-surface-low.jpg';
import atlasStandard from '../assets/atlas/atlas-surface-standard.jpg';
import atlasHigh from '../assets/atlas/atlas-surface-high.jpg';
import atlasUltra from '../assets/atlas/atlas-surface-8k.jpg';
import {AtlasLayers} from './atlas-layers';
import {mapAppearance,mapStyleName,validateAtlasData,type MapStyle,type AtlasData} from './map-style';
import {chooseQuality,movingRenderScale,type DeviceCapabilities} from './quality';
import type {Place,Settings} from './model';
import type {SatelliteCache} from './tile-cache';
import {TerrainSurface} from './terrain';
import {readHeightField,EARTH_METRES} from './terrain-data';
import type {ResolvedTheme} from './theme';
import {clampAltitude,zoomAltitude} from './zoom';
const surfaces={low:earthLow,standard:earthStandard,high:earthHigh};
const atlasSurfaces={low:atlasLow,standard:atlasStandard,high:atlasHigh};
interface SurfaceResource {path:string;width:number;style:MapStyle;credit:string}
import {createStarfield} from './starfield';
export class GlobeCanvas {
 private ownerDoc?:Document;private ownerWin?:Window;
 private bindOwnerEvents(){
  const doc=this.doc,win=this.win;if(this.ownerDoc===doc&&this.ownerWin===win)return;
  this.ownerWin?.removeEventListener('pointerup',this.pointerUp);this.ownerWin?.removeEventListener('pointercancel',this.pointerUp);this.ownerDoc?.removeEventListener('visibilitychange',this.visibility);
  this.ownerDoc=doc;this.ownerWin=win;win.addEventListener('pointerup',this.pointerUp);win.addEventListener('pointercancel',this.pointerUp);doc.addEventListener('visibilitychange',this.visibility);
 }
 private get doc(){return this.el.ownerDocument;}
 private get win(){return (this.doc.defaultView||window) as Window&typeof globalThis;}
 instance?:CesiumWidget;profile:ReturnType<typeof chooseQuality>;readonly ready:Promise<void>;
 terrain?:TerrainSurface;
 private closed=false;private suspended=false;private visible=true;private tilted=false;private terrainEnabled=true;
 private places:Place[]=[];private markers:{el:HTMLButtonElement;place:Place;position:Cartesian3}[]=[];
 private markerRoot:HTMLElement;private credits:HTMLElement;private status:HTMLElement;
 private points?:PointPrimitiveCollection;private borderLines?:PolylineCollection;private cloudShell?:Primitive;private cloudMaterial?:Material;
 private satellite?:ImageryLayer;private satelliteProvider?:UrlTemplateImageryProvider;private handler?:ScreenSpaceEventHandler;
 private resize?:ResizeObserver;private intersection?:IntersectionObserver;private removers:(()=>void)[]=[];
 private objectUrls=new Set<string>();private retryTimer?:number;private cloudPromise?:Promise<void>;
 private showClouds=false;private requestedClouds=false;private lastPlaceUpdate=0;private idleTimer?:number;private motionTimer?:number;
 private cloudUpgradeReady=false;private targetCloudWidth=0;
 private baseLayer?:ImageryLayer;private qualityRevision=0;private cloudRevision=0;private appliedCloudWidth=0;private appliedHeightWidth=0;
 private skyTheme='';
 private requestedMapStyle:MapStyle='natural';private currentMapStyle:MapStyle='natural';
 private atlasLayers?:AtlasLayers;private atlasWork?:Promise<void>;private atlasFailed=false;private atlasRevision=0;
 private showMapBorders=false;private showCountryNames=false;private terrainShade?:Material;
 private surfaceSpecs=new Map<SingleTileImageryProvider,SurfaceResource>();
 private device!:DeviceCapabilities;private started=0;private firstFrame=false;private renderedFrames=0;
 private surfaceImages=new Map<SingleTileImageryProvider,HTMLImageElement>();private surfaceDecoders=new Set<()=>void>();
 private pendingQuality?:Settings;private activeQuality?:Settings;private surfaceWaiters=new Set<()=>void>();private surfaceRequest?:number;
 private contextLost=(event:Event)=>{event.preventDefault();if(!this.closed){this.el.dataset.contextLost='true';this.fail('显卡上下文已中断，已切换旅行列表；可点击重试三维地球。');}};
 private pinchMoved=false;private touches=new Map<number,{x:number;y:number}>();private pinch?:{distance:number;altitude:number;lat:number;lng:number};
 private pointerDown=(event:PointerEvent)=>{
  if(this.closed||this.suspended)return;this.bindOwnerEvents();this.motion();this.wake();this.instance?.camera.cancelFlight();
  if(!this.touches.size)this.pinchMoved=false;this.touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(this.touches.size===2){const [a,b]=[...this.touches.values()],center=this.center();this.pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),altitude:this.viewAltitude(),...center};if(this.instance){const c=this.instance.scene.screenSpaceCameraController;c.enableRotate=c.enableTilt=c.enableZoom=false;}}
 };
 private pointerMove=(event:PointerEvent)=>{
  if(!this.touches.has(event.pointerId))return;this.motion();this.touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(this.pinch&&this.touches.size>=2){const [a,b]=[...this.touches.values()],distance=Math.hypot(a.x-b.x,a.y-b.y);if(distance>2){this.pinchMoved=true;event.preventDefault();this.setView(this.pinch.lat,this.pinch.lng,clampAltitude(this.pinch.altitude*this.pinch.distance/distance),false);}}
 };
 private pointerUp=(event:PointerEvent)=>{this.touches.delete(event.pointerId);if(this.touches.size<2){this.pinch=undefined;if(this.instance){const c=this.instance.scene.screenSpaceCameraController;c.enableRotate=c.enableTilt=c.enableZoom=true;}}};
 private visibility=()=>{if(this.doc.hidden){this.touches.clear();this.pinch=undefined;if(this.instance){const c=this.instance.scene.screenSpaceCameraController;c.enableRotate=c.enableTilt=c.enableZoom=true;}}this.updateVisibility();};
 private wake=()=>{
  if(this.closed)return;this.instance?.scene.requestRender();this.win.clearTimeout(this.idleTimer);
  if(!this.isRenderable()){this.el.dataset.rendering='paused';return;}
  this.el.dataset.rendering='active';this.idleTimer=this.win.setTimeout(()=>{if(!this.closed)this.el.dataset.rendering=this.isRenderable()?'idle':'paused';},900);
 };
 private finishMotion=()=>{
  this.win.clearTimeout(this.motionTimer);
  if(!this.instance||this.closed)return;
  this.instance.resolutionScale=this.profile.pixelRatio;this.el.dataset.renderScale=String(this.profile.pixelRatio);
  this.el.dataset.interactionQuality='full';this.wake();
 };
 private motion=()=>{
  const widget=this.instance;if(!widget||this.closed||!this.firstFrame||!this.isRenderable()||this.profile.requested!=='auto')return;
  const scale=movingRenderScale(this.profile.requested,this.profile.pixelRatio,this.device);
  if(scale===this.profile.pixelRatio)return;
  widget.resolutionScale=scale;this.el.dataset.renderScale=String(scale);this.el.dataset.interactionQuality='adaptive';
  this.win.clearTimeout(this.motionTimer);this.motionTimer=this.win.setTimeout(this.finishMotion,700);this.wake();
 };
 constructor(private el:HTMLElement,settings:Settings,device:Omit<DeviceCapabilities,'maxTextureSize'>,private select:(place:Place)=>void,
  private pick:(lat:number,lng:number)=>void,private fail:(reason:string)=>void,private cache:SatelliteCache,
  private resourceUrl:(path:string)=>Promise<string>|string=path=>path,private terrainCache?:SatelliteCache,private loadAtlasData?:()=>Promise<AtlasData>){
  this.started=this.win.performance.now();
  for(const key of Object.keys(el.dataset))delete el.dataset[key];
  this.profile=chooseQuality(settings.quality,{...device,maxTextureSize:8192});
  this.markerRoot=this.doc.createElement('div');this.markerRoot.className='tg-cesium-markers';
  this.credits=this.doc.createElement('div');this.credits.className='tg-cesium-credits';
  this.status=this.doc.createElement('div');this.status.className='tg-terrain-status';this.status.setAttribute('aria-live','polite');
  this.el.append(this.markerRoot,this.credits,this.status);
  this.requestedMapStyle=settings.mapStyle||'natural';this.el.dataset.requestedMapStyle=this.requestedMapStyle;
  const appearance=mapAppearance(settings);this.showClouds=appearance.clouds;this.showMapBorders=appearance.borders;this.showCountryNames=appearance.labels;
  this.ready=this.initialize(settings,device).catch(error=>{if(!this.closed){console.warn('Travel Globe Cesium:',error);this.fail('三维地球加载失败，已切换旅行列表。请确认安装包资源完整。');}});
 }
 private async initialize(settings:Settings,device:Omit<DeviceCapabilities,'maxTextureSize'>){
  const probe=await this.resourceUrl('runtime-assets/cesium/Assets/approximateTerrainHeights.json');if(this.closed)return;
  (buildModuleUrl as typeof buildModuleUrl&{setBaseUrl:(url:string)=>void}).setBaseUrl(probe.split('?')[0].replace(/Assets\/.*$/,''));
  CreditDisplay.cesiumCredit=new Credit('<a href="https://cesium.com/cesiumjs/">CesiumJS</a>',true);
  const widget=this.instance=new CesiumWidget(this.el,{baseLayer:false,creditContainer:this.credits,skyBox:false,
   requestRenderMode:true,maximumRenderTimeChange:Infinity,shouldAnimate:false,useBrowserRecommendedResolution:true,
   contextOptions:{webgl:{alpha:false,antialias:!device.mobile,powerPreference:'low-power'}},showRenderLoopErrors:false});
  // Widget appends its canvas after the marker container; CSS controls the layers.
  const gl=widget.canvas.getContext('webgl2');this.device={...device,maxTextureSize:gl?.getParameter(gl.MAX_TEXTURE_SIZE)||4096};this.profile=chooseQuality(settings.quality,this.device);
  this.el.addEventListener('wheel',this.motion,{passive:true});this.el.addEventListener('pointerdown',this.pointerDown,true);this.el.addEventListener('pointermove',this.pointerMove,{capture:true,passive:false});
  this.bindOwnerEvents();
  widget.canvas.addEventListener('webglcontextlost',this.contextLost);
  widget.resolutionScale=this.profile.pixelRatio;widget.targetFrameRate=device.mobile?30:60;
  const scene=widget.scene;this.setTheme(this.el.closest<HTMLElement>('[data-tg-theme]')?.dataset.tgTheme==='light'?'light':'dark');
  scene.globe.baseColor=Color.fromCssColorString('#102737');scene.globe.maximumScreenSpaceError=device.mobile?4:2;
  scene.globe.tileCacheSize=device.mobile?70:160;scene.globe.depthTestAgainstTerrain=true;scene.globe.enableLighting=false;
  scene.globe.showGroundAtmosphere=true;scene.fog.enabled=true;scene.fog.density=.0001;
  scene.verticalExaggeration=2;scene.verticalExaggerationRelativeHeight=0;
  if(scene.skyAtmosphere){scene.skyAtmosphere.atmosphereLightIntensity=8;scene.skyAtmosphere.brightnessShift=-.25;}
  // Derivatives of the actual displaced mesh supply slope shading even for heightmap terrain without stored normals.
  scene.globe.material=this.terrainShade=new Material({fabric:{type:'TravelTerrainShadeV2',uniforms:{strength:1},source:[
   'czm_material czm_getMaterial(czm_materialInput i) {',
   'czm_material m=czm_getDefaultMaterial(i);',
   'vec3 n=normalize(cross(dFdx(i.positionToEyeEC),dFdy(i.positionToEyeEC)));',
   'float shade=clamp(dot(n,normalize(vec3(-0.35,0.65,0.68))),0.0,1.0);',
   'm.diffuse=vec3(0.015,0.025,0.04);m.alpha=(1.0-shade)*0.32*strength;return m;}'
  ].join('\n')}});
  const controller=scene.screenSpaceCameraController;controller.minimumZoomDistance=100;controller.maximumZoomDistance=EARTH_METRES*6;
  controller.enableCollisionDetection=true;controller.inertiaSpin=.75;controller.inertiaZoom=.7;
  controller.zoomEventTypes=[CameraEventType.WHEEL];
  controller.tiltEventTypes=[CameraEventType.RIGHT_DRAG,{eventType:CameraEventType.LEFT_DRAG,modifier:KeyboardEventModifier.CTRL}];
  this.points=scene.primitives.add(new PointPrimitiveCollection());
  this.handler=new ScreenSpaceEventHandler(widget.canvas);
  this.handler.setInputAction((event:{position:Cartesian2})=>{
   if(this.closed||this.suspended)return;
   const picked=scene.pick(event.position) as {id?:Place}|undefined;
   if(picked?.id&&typeof picked.id==='object'&&'records' in picked.id){this.select(picked.id);return;}
   const point=this.pickSurface(event.position);if(point)this.pick(point.lat,point.lng);
  },ScreenSpaceEventType.LEFT_CLICK);
  this.removers.push(scene.postRender.addEventListener(()=>this.afterRender()));
  this.removers.push(scene.camera.changed.addEventListener(()=>{this.motion();this.wake();}));
  this.removers.push(scene.renderError.addEventListener((_scene:unknown,error:Error)=>{if(!this.closed){console.warn('Travel Globe WebGL:',error);this.fail('三维渲染暂不可用，已切换旅行列表。');}}));
  this.removers.push(scene.globe.tileLoadProgressEvent.addEventListener(()=>this.wake()));
  this.resize=new this.win.ResizeObserver(()=>{if(!this.closed){this.updateViewportFov();widget.resize();this.updateVisibility();this.wake();}});this.resize.observe(this.el);
  this.intersection=new this.win.IntersectionObserver(entries=>{this.visible=entries.some(e=>e.isIntersecting);this.updateVisibility();});this.intersection.observe(this.el);

  this.el.dataset.engine='cesium';this.el.dataset.engineReadyMs=(this.win.performance.now()-this.started).toFixed(1);
  this.setView(28,108,this.defaultAltitude(),false);this.setPlaces(this.places);
  await this.applyResources(this.pendingQuality??settings,true);if(this.closed)return;
  await this.addSatellite();if(this.closed)return;this.setPlaces(this.places);this.updateVisibility();this.wake();
 }
 /** Replace resources in the existing scene, preserving camera, selection and terrain/tilt state. */
 async applyQuality(settings:Settings){
  if(this.closed)return;
  this.requestMapStyle(settings.mapStyle||'natural');this.pendingQuality={...settings};
  // A hidden newer choice also supersedes URL/decode work from an older choice.
  if(!this.instance||!this.isRenderable()){this.qualityRevision++;this.cancelSurfaceWork();return;}
  this.pendingQuality=undefined;await this.applyResources(settings,false);
 }
 private requestMapStyle(style:MapStyle){
  if(this.requestedMapStyle!==style){this.cloudRevision++;this.cloudPromise=undefined;}
  this.requestedMapStyle=style;this.el.dataset.requestedMapStyle=style;
  if(style==='atlas'&&this.satellite)this.satellite.show=false;
  if(style==='atlas'&&this.cloudShell)this.cloudShell.show=false;
 }
 private surfaceResource(style:MapStyle,width:number):SurfaceResource {
  const tier=width===1024?'low':width===2048?'standard':'high';
  const path=style==='atlas'?(width===8192?atlasUltra:atlasSurfaces[tier]):(width===8192?earthUltra:surfaces[tier]);
  return {path,width,style,credit:style==='atlas'?'Made with Natural Earth · Public domain':'NASA Blue Marble'};
 }
 private applySurfacePolicy(){
  const scene=this.instance?.scene;if(!scene)return;
  const atlas=this.currentMapStyle==='atlas';
  if(this.terrainShade)this.terrainShade.uniforms.strength=atlas?0:1;
  scene.globe.showGroundAtmosphere=!atlas;scene.fog.enabled=!atlas;
  this.el.dataset.activeMapStyle=this.currentMapStyle;
  this.setAppearance(this.showMapBorders,this.requestedClouds,this.showCountryNames);
 }
 private surfaceError(error:unknown,revision:number,surface:SurfaceResource,settings:Settings,upgrade=false){
  // Every entry point (ready, visibility resume and explicit quality changes) uses this
  // policy. Obsolete/closed work must not touch diagnostics or a newer painted image.
  if(this.closed||revision!==this.qualityRevision)return;
  this.surfaceRequest=undefined;
  if(!this.isRenderable()){this.pendingQuality??={...settings};return;}
  this.el.dataset.qualityError=String(error);
  if(!this.baseLayer){
   this.profile.reason=this.el.dataset.qualityReason='底图读取失败，请重试三维地球';
   this.fail('三维地球底图读取失败，已切换旅行列表；可点击重试三维地球。');return;
  }
  if(surface.style!==this.currentMapStyle){
   this.requestMapStyle(this.currentMapStyle);
   const restored=mapAppearance({...settings,mapStyle:this.currentMapStyle});
   this.setAppearance(restored.borders,restored.clouds,restored.labels);this.applySurfacePolicy();
   this.el.dataset.mapStyleError=mapStyleName(surface.style)+'读取失败，保留'+mapStyleName(this.currentMapStyle);
  }
  this.profile.reason=this.el.dataset.qualityReason=(upgrade?'高清底图':'底图')+'读取失败，保留已显示底图';
  this.el.dispatchEvent(new this.win.CustomEvent('tg-quality-change',{bubbles:true}));
 }
 private async applyResources(settings:Settings,initial:boolean){
  this.requestMapStyle(settings.mapStyle||'natural');
  const widget=this.instance;if(!widget||this.closed)return;
  if(!this.isRenderable()){this.pendingQuality={...settings};return;}
  this.pendingQuality=undefined;this.activeQuality={...settings};this.win.clearTimeout(this.motionTimer);this.el.dataset.interactionQuality='full';
  const revision=++this.qualityRevision;this.cancelSurfaceWork();this.surfaceRequest=revision;
  const profile=this.profile=chooseQuality(settings.quality,this.device);
  widget.resolutionScale=profile.pixelRatio;widget.scene.globe.maximumScreenSpaceError=profile.mobile?4:profile.low?4:2;
  this.el.dataset.quality=profile.tier;this.el.dataset.requestedQuality=profile.requested;this.el.dataset.qualityReason=profile.reason;
  this.el.dataset.texture=String(profile.width);this.el.dataset.renderScale=String(profile.pixelRatio);
  this.el.dispatchEvent(new this.win.CustomEvent('tg-quality-change',{bubbles:true}));
  this.cloudUpgradeReady=false;
  if(this.targetCloudWidth!==profile.cloudWidth){
   this.targetCloudWidth=profile.cloudWidth;this.cloudRevision++;this.cloudPromise=undefined;
   // Keep the previous cloud texture until its replacement is decoded and installed.
  }
  delete this.el.dataset.qualityError;delete this.el.dataset.mapStyleError;delete this.el.dataset.highResolutionReady;delete this.el.dataset.highResolutionReadyMs;
  const appearance=mapAppearance(settings);
  this.setAppearance(appearance.borders,appearance.clouds,appearance.labels);this.setPlaces(this.places);this.wake();
  const surface=this.surfaceResource(this.requestedMapStyle,profile.width);
  // 4K is already modest enough to decode directly; only 8K needs a staged first image.
  const first=initial&&profile.width===8192?this.surfaceResource(surface.style,4096):surface;
  const prepared=first!==surface?this.prepareSurface(surface,revision):undefined;
  // Attach rejection handling immediately while the first image is being painted.
  void prepared?.catch(()=>{});
  try{if(!await this.replaceSurface(first,revision)){if(revision===this.qualityRevision)this.surfaceRequest=undefined;return;}}
  catch(error){this.surfaceError(error,revision,surface,settings);return;}
  if(this.closed||revision!==this.qualityRevision)return;
  this.el.dataset.surfaceReady='true';this.el.dataset.surfaceReadyMs=(this.win.performance.now()-this.started).toFixed(1);this.setAppearance(appearance.borders,appearance.clouds,appearance.labels);this.wake();
  const upgrade=first!==surface?this.replaceSurface(surface,revision,prepared):Promise.resolve(true);
  const upgrading=upgrade.then(painted=>{
   if(!painted||this.closed||revision!==this.qualityRevision)return;
   this.cloudUpgradeReady=true;this.setAppearance(appearance.borders,appearance.clouds,appearance.labels);
   this.el.dataset.highResolutionReady='true';this.el.dataset.highResolutionReadyMs=(this.win.performance.now()-this.started).toFixed(1);this.el.dispatchEvent(new this.win.CustomEvent('tg-quality-change',{bubbles:true}));this.wake();
  }).catch(error=>this.surfaceError(error,revision,surface,settings,true)).finally(()=>{if(revision===this.qualityRevision)this.surfaceRequest=undefined;});
  // Let the first image render before allocating CPU height-field buffers.
  this.win.requestAnimationFrame(()=>this.win.setTimeout(()=>{if(!this.closed&&revision===this.qualityRevision)void this.loadTerrain(profile.heightWidth,revision);},0));
  if(!initial)await upgrading;
 }
 private releaseSurface(provider:SingleTileImageryProvider){
  const image=this.surfaceImages.get(provider);if(!image)return;
  image.onload=image.onerror=null;image.src='';this.surfaceImages.delete(provider);this.surfaceSpecs.delete(provider);
 }
 private cancelSurfaceWork(){
  this.surfaceRequest=undefined;
  for(const cancel of [...this.surfaceWaiters])cancel();
  for(const cancel of [...this.surfaceDecoders])cancel();
  for(const provider of [...this.surfaceImages.keys()])if(provider!==this.baseLayer?.imageryProvider)this.releaseSurface(provider);
 }
 private async prepareSurface(spec:SurfaceResource,revision:number){
  const {path,width}=spec;
  const url=await this.resourceUrl(path);if(this.closed||revision!==this.qualityRevision)return;
  const image=this.el.ownerDocument.createElement('img');
  image.crossOrigin='anonymous';image.decoding='async';
  const loaded=await new Promise<boolean>((resolve,reject)=>{
   let finished=false;
   const finish=(success:boolean,error?:Error)=>{
    if(finished)return;finished=true;image.onload=image.onerror=null;this.surfaceDecoders.delete(cancel);
    if(!success)image.src='';if(error)reject(error);else resolve(success);
   };
   const cancel=()=>finish(false);this.surfaceDecoders.add(cancel);
   image.onload=()=>image.naturalWidth===width&&image.naturalHeight===width/2?finish(true):finish(false,Error('底图尺寸或2:1投影不符'));
   image.onerror=()=>finish(false,Error('底图图像读取失败'));image.src=url;
  });
  if(!loaded||this.closed||revision!==this.qualityRevision){image.src='';return;}
  // Keep the exact Obsidian URL on the Image: Cesium Resource query normalization breaks app:// XHR.
  const provider=new SingleTileImageryProvider({url,tileWidth:image.naturalWidth,tileHeight:image.naturalHeight,rectangle:Rectangle.MAX_VALUE,credit:new Credit(spec.credit,true)});
  provider.requestImage=()=>Promise.resolve(image);this.surfaceImages.set(provider,image);this.surfaceSpecs.set(provider,spec);return provider;
 }
 private surfaceTextureReady(layer:ImageryLayer){
  // Pinned Cesium 1.146: SingleTileImageryProvider uses one global level-0 texture, shared by terrain tiles.
  // Global tilesLoaded also waits for unrelated refinement; require this layer's GPU-ready imagery instead.
  const cache=(layer as ImageryLayer&{_imageryCache?:Record<string,{state:number;texture?:unknown}>})._imageryCache;
  if(!cache||typeof cache!=='object')return this.instance?.scene.globe.tilesLoaded??false;
  const imagery=Object.values(cache);
  if(imagery.some(item=>!item||typeof item.state!=='number'||!('texture' in item)))return this.instance?.scene.globe.tilesLoaded??false;
  return imagery.some(item=>item.state===4&&!!item.texture);
 }
 private async replaceSurface(spec:SurfaceResource,revision:number,prepared?:Promise<SingleTileImageryProvider|undefined>){
  const provider=await (prepared??this.prepareSurface(spec,revision));if(!provider)return false;
  if(this.closed||revision!==this.qualityRevision){this.releaseSurface(provider);return false;}
  if(!this.isRenderable()){this.pendingQuality??=this.activeQuality;this.releaseSurface(provider);return false;}
  const scene=this.instance!.scene,previous=this.baseLayer;
  // New imagery is above the existing base but below the close-up satellite layer.
  let layer:ImageryLayer;
  try{layer=scene.imageryLayers.addImageryProvider(provider,previous?scene.imageryLayers.indexOf(previous)+1:0);}
  catch(error){this.releaseSurface(provider);throw error;}
  this.el.dataset.providerTexture=String(spec.width);
  this.el.dataset.providerReadyMs=(this.win.performance.now()-this.started).toFixed(1);this.wake();
  return new Promise<boolean>(resolve=>{
   let frames=0,paintedFrames=0,finished=false;let remove:()=>void=()=>{};
   const finish=(painted:boolean)=>{
    if(finished)return;finished=true;remove();this.surfaceWaiters.delete(cancel);
    if(painted){
     this.baseLayer=layer;if(previous&&!previous.isDestroyed()){const oldProvider=previous.imageryProvider as SingleTileImageryProvider;scene.imageryLayers.remove(previous,true);this.releaseSurface(oldProvider);}
     this.el.dataset.activeTexture=String(spec.width);this.currentMapStyle=spec.style;this.applySurfacePolicy();delete this.el.dataset.mapStyleError;
     this.el.dataset.surfacePaintMs=(this.win.performance.now()-this.started).toFixed(1);
     if(!this.firstFrame){this.firstFrame=true;this.el.dataset.firstFrameMs=this.el.dataset.surfacePaintMs;}
     this.el.dispatchEvent(new this.win.CustomEvent('tg-quality-change',{bubbles:true}));this.wake();
    }else{if(!layer.isDestroyed())scene.imageryLayers.remove(layer,true);this.releaseSurface(provider);}
    resolve(painted);
   };
   const cancel=()=>finish(false);this.surfaceWaiters.add(cancel);
   remove=scene.postRender.addEventListener(()=>{
    if(this.closed||revision!==this.qualityRevision){finish(false);return;}
    ++frames;paintedFrames=this.surfaceTextureReady(layer)?paintedFrames+1:0;
    // Two postRender observations with an allocated READY texture confirm upload and subsequent drawing.
    if(paintedFrames>=2)finish(true);else if(frames===1||paintedFrames===1)scene.requestRender();
   });
  });
 }
 private async loadTerrain(width:number,revision:number){
  if(!this.terrainCache||this.appliedHeightWidth===width)return;
  try{
   const url=await this.resourceUrl(width===1024?heightLow:heightStandard);
   if(this.closed||revision!==this.qualityRevision)return;
   const field=await readHeightField(url,width);
   if(this.closed||revision!==this.qualityRevision)return;
   const old=this.terrain;this.terrain=new TerrainSurface(field,this.terrainCache,this.profile.mobile,this.wake);
   if(this.terrainEnabled)this.instance!.terrainProvider=this.terrain.provider;
   old?.dispose();this.appliedHeightWidth=width;
   this.el.dataset.heightReady='true';this.el.dataset.terrainReady='true';this.el.dataset.heightTexture=String(width);
   this.el.dataset.heightReadyMs=(this.win.performance.now()-this.started).toFixed(1);delete this.el.dataset.heightError;
   this.setPlaces(this.places);this.atlasLayers?.refresh();this.wake();
  }catch(error){if(!this.closed&&revision===this.qualityRevision){this.el.dataset.heightError=String(error);this.status.textContent='地形暂不可用 · 地球与回忆可继续浏览';}}
 }
 private async addSatellite(){
  const widget=this.instance;if(!widget)return;
  const provider=this.satelliteProvider=new UrlTemplateImageryProvider({url:'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg',tilingScheme:new WebMercatorTilingScheme(),
   minimumLevel:0,maximumLevel:14,credit:new Credit('<a href="https://s2maps.eu">Sentinel-2 cloudless 2024</a> · <a href="https://eox.at">EOX</a> · Copernicus · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>',true)});
  // Cesium selects/drapes tiles; all bytes still go through the existing vault cache and its four-request limit.
  provider.requestImage=(x,y,level)=>{
   if(this.requestedMapStyle!=='natural'||this.currentMapStyle!=='natural')return undefined;
   return this.cache.get(level,x,y).then(async data=>{
    if(this.closed)throw Error('视图已关闭');
    if(this.requestedMapStyle!=='natural'||this.currentMapStyle!=='natural')throw Error('地图样式已切换');
    const bitmap=await createImageBitmap(new Blob([data],{type:'image/jpeg'}),{imageOrientation:'flipY'});
    if(this.closed){bitmap.close();throw Error('视图已关闭');}
    return bitmap;
   });
  };
  provider.errorEvent.addEventListener(()=>{/* Missing offline tiles expose the NASA base layer. */});
  this.satellite=widget.scene.imageryLayers.addImageryProvider(provider);this.satellite.show=false;
 }
 private clearClouds(){
  if(this.cloudShell&&this.instance&&!this.instance.isDestroyed())this.instance.scene.primitives.remove(this.cloudShell);
  this.cloudShell=undefined;
  // Primitive.destroy releases geometry, but Cesium materials own and release their textures separately.
  if(this.cloudMaterial&&!this.cloudMaterial.isDestroyed())this.cloudMaterial.destroy();
  this.cloudMaterial=undefined;
 }
 private async loadClouds(){
  if(this.cloudPromise)return this.cloudPromise;
  const revision=this.cloudRevision,width=this.profile.cloudWidth;
  this.cloudPromise=(async()=>{
   const image=this.doc.createElement('img');const path=width===8192?cloudUltra:width===4096?cloudHigh:width===1024?cloudLow:cloudStandard;
   const url=await this.resourceUrl(path);if(this.closed||revision!==this.cloudRevision)return;
   await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(Error('云图读取失败'));image.src=url;});
   if(this.closed||!this.instance||revision!==this.cloudRevision){image.src='';return;}
   // Reuse this decoded image directly; a URL uniform would ask Cesium to read and decode it again.
   const material=new Material({fabric:{type:'TravelClouds',uniforms:{cloudImage:Material.DefaultImageId,opacity:.28},source:[
    'czm_material czm_getMaterial(czm_materialInput i) {',
    'czm_material m=czm_getDefaultMaterial(i);',
    'float density=texture(cloudImage,vec2(fract(i.st.x+0.5),i.st.y)).r;',
    'm.diffuse=vec3(0.96,0.98,1.0);m.alpha=density*opacity;return m;}'
   ].join('\n')},translucent:()=>true});
   // Fabric templates are deep-cloned and cannot contain DOM images; live uniforms accept them.
   material.uniforms.cloudImage=image;
   const radii=Cartesian3.add(Ellipsoid.WGS84.radii,new Cartesian3(40000,40000,40000),new Cartesian3());
   let shell:Primitive;
   try{shell=this.instance.scene.primitives.add(new Primitive({geometryInstances:new GeometryInstance({geometry:new EllipsoidGeometry({radii,stackPartitions:this.profile.low?64:128,slicePartitions:this.profile.low?128:256,vertexFormat:MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat})}),
    appearance:new MaterialAppearance({material,translucent:true,closed:true}),asynchronous:false,allowPicking:false}));}
   catch(error){material.destroy();throw error;}
   this.clearClouds();this.cloudMaterial=material;this.cloudShell=shell;this.appliedCloudWidth=width;
   shell.show=this.showClouds;this.el.dataset.cloudReady='true';this.el.dataset.cloudTexture=String(image.width);delete this.el.dataset.cloudError;this.wake();
  })().catch(error=>{if(!this.closed&&revision===this.cloudRevision){this.cloudPromise=undefined;this.el.dataset.cloudError=String(error);console.warn('Travel Globe clouds:',error);}});
  return this.cloudPromise;
 }
 private ensureAtlasLayers(){
  if(this.atlasLayers||this.atlasWork||this.atlasFailed||!this.loadAtlasData||!this.instance||this.closed)return;
  const revision=++this.atlasRevision;
  this.atlasWork=(async()=>{
   const data=validateAtlasData(await this.loadAtlasData!());
   if(this.closed||revision!==this.atlasRevision||!this.instance)return;
   this.atlasLayers=new AtlasLayers(this.instance.scene,this.el,data,this.profile.mobile,this.wake,(lat,lng)=>this.terrainEnabled?(this.terrain?.sample(lat,lng)||0)*2:0);
   delete this.el.dataset.atlasError;
   this.setAppearance(this.showMapBorders,this.requestedClouds,this.showCountryNames);
  })().catch(error=>{if(!this.closed&&revision===this.atlasRevision){this.atlasFailed=true;this.el.dataset.atlasError=String(error);this.setAppearance(this.showMapBorders,this.requestedClouds,this.showCountryNames);}}).finally(()=>{if(revision===this.atlasRevision)this.atlasWork=undefined;});
 }
 setAppearance(showBorders:boolean,showClouds:boolean,showCountryNames=false){
  this.requestedClouds=showClouds;this.showMapBorders=showBorders;this.showCountryNames=showCountryNames;
  this.showClouds=showClouds&&this.requestedMapStyle==='natural'&&this.currentMapStyle==='natural';
  const widget=this.instance;if(!widget||this.closed)return;
  if(this.showClouds&&this.cloudUpgradeReady&&this.firstFrame&&(!this.cloudShell||this.appliedCloudWidth!==this.profile.cloudWidth))void this.loadClouds();
  if(this.cloudShell)this.cloudShell.show=this.showClouds;
  if(showBorders||showCountryNames)this.ensureAtlasLayers();
  this.atlasLayers?.update(showBorders,showCountryNames,this.profile.low);
  const fallback=showBorders&&!this.atlasLayers&&(!this.loadAtlasData||this.atlasFailed);
  if(fallback&&!this.borderLines){
   const collection=this.borderLines=widget.scene.primitives.add(new PolylineCollection());
   for(const line of borders){const positions=line.map(([lng,lat])=>Cartesian3.fromDegrees(lng,lat,Math.max(80,(this.terrain?.sample(lat,lng)||0)*2+80)));
    collection.add({positions,width:1.5,material:Material.fromType('Color',{color:Color.fromCssColorString('#CE7084')!.withAlpha(.8)})});}
  }
  if(this.borderLines)this.borderLines.show=fallback;
  if(fallback){this.el.dataset.atlasSource='Natural Earth 110m / world-atlas（降级）';this.el.dataset.atlasPlacement='approximate';}
  this.el.dataset.borders=String(showBorders);this.el.dataset.clouds=String(this.showClouds);this.el.dataset.countryNames=String(showCountryNames);this.wake();
 }
 setPlaces(places:Place[]){
  this.places=places;const widget=this.instance;if(!widget||this.closed)return;
  this.points?.removeAll();this.markerRoot.replaceChildren();this.markers=[];
  for(const place of places.slice(0,this.profile.markerLimit)){
   const position=this.placePosition(place);
   this.points?.add({position,color:Color.WHITE,outlineColor:Color.fromCssColorString('#111111'),outlineWidth:2,pixelSize:this.profile.mobile?8:6,id:place});
   const el=this.doc.createElement('button');el.className='tg-marker';el.dataset.place=place.id;el.setAttribute('aria-label',place.city+' · '+place.records.length+' 次旅行');el.title=place.city+' · '+place.country_name;
   const dot=this.doc.createElement('span');dot.className='tg-marker-dot';el.append(dot);el.addEventListener('click',event=>{event.stopPropagation();if(!this.pinchMoved)this.select(place);});this.markerRoot.append(el);
   this.markers.push({el,place,position});
  }this.wake();
 }
 private placePosition(place:Place){const height=this.terrainEnabled?(this.terrain?.sample(place.latitude,place.longitude)||0)*2:0;return Cartesian3.fromDegrees(place.longitude,place.latitude,height+Math.max(10,Math.min(600,this.cameraAltitude()*EARTH_METRES*.002)));}
 private cameraAltitude(){return Math.max(.00002,(this.instance?.camera.positionCartographic.height??EARTH_METRES*2)/EARTH_METRES);}
 private afterRender(){
  const widget=this.instance;if(!widget||this.closed)return;const scene=widget.scene,altitude=this.cameraAltitude();
  this.el.dataset.renderedFrames=String(++this.renderedFrames);this.el.dataset.canvasWidth=String(widget.canvas.width);this.el.dataset.canvasHeight=String(widget.canvas.height);
  if(!this.firstFrame&&this.el.dataset.surfaceReady==='true'&&scene.globe.tilesLoaded){this.firstFrame=true;this.el.dataset.firstFrameMs=(this.win.performance.now()-this.started).toFixed(1);}
  this.el.parentElement?.classList.toggle('tg-has-imagery',this.currentMapStyle==='natural'&&this.requestedMapStyle==='natural'&&altitude<.7);this.el.dataset.altitude=altitude.toFixed(6);this.el.dataset.tilt=String(this.tilted);this.el.dataset.terrain=String(this.terrainEnabled);
  if(this.cloudMaterial)this.cloudMaterial.uniforms.opacity=.28*Math.max(0,Math.min(1,(altitude-.008)/.12));
  if(this.satellite){const show=this.currentMapStyle==='natural'&&this.requestedMapStyle==='natural'&&altitude<.7;const alpha=Math.max(0,Math.min(1,(.7-altitude)/.35));if(this.satellite.show!==show||Math.abs(this.satellite.alpha-alpha)>.001){this.satellite.show=show;this.satellite.alpha=alpha;scene.requestRender();}}
  this.atlasLayers?.frame(altitude);
  const now=this.win.performance.now(),refreshPositions=now-this.lastPlaceUpdate>400;if(refreshPositions)this.lastPlaceUpdate=now;
  const occluder=new EllipsoidalOccluder(Ellipsoid.WGS84,scene.camera.positionWC);
  for(const [index,marker] of this.markers.entries()){
   if(refreshPositions){marker.position=this.placePosition(marker.place);const point=this.points?.get(index);if(point)point.position=marker.position;}
   const p=SceneTransforms.worldToWindowCoordinates(scene,marker.position);
   const show=p&&occluder.isPointVisible(marker.position)&&p.x>=-25&&p.y>=-25&&p.x<=this.el.clientWidth+25&&p.y<=this.el.clientHeight+25;
   marker.el.hidden=!show;if(show)marker.el.style.transform='translate('+p!.x+'px,'+p!.y+'px) translate(-50%,-50%)';
  }
  const stats=this.terrain?.stats;
  this.status.textContent=this.terrainEnabled?(this.terrain?'立体地形 · 2× 起伏'+(stats?.detailed?(scene.globe.tilesLoaded?' · 精细高程':' · 正在细化'):' · 全球高程'):this.el.dataset.heightError?'地形暂不可用 · 地球与回忆可继续浏览':'地球已就绪 · 地形加载中'):'平坦地球';
  if(this.el.dataset.atlasError)this.status.textContent+=' · 国界/国家名暂不可用，可重试资源';
  else if(this.showMapBorders&&this.el.dataset.atlasPlacement==='approximate')this.status.textContent+=' · 国界近似贴合';
  this.el.dataset.terrainTiles=String(stats?.detailed||0);
 }
 private pickSurface(point:Cartesian2){
  const widget=this.instance;if(!widget)return;const ray=widget.camera.getPickRay(point);if(!ray)return;
  const position=widget.scene.globe.pick(ray,widget.scene)||widget.camera.pickEllipsoid(point);
  if(!position)return;const c=Cartographic.fromCartesian(position);return {lat:CMath.toDegrees(c.latitude),lng:CMath.toDegrees(c.longitude)};
 }
 setTheme(theme:ResolvedTheme){
  if(!this.instance||this.closed)return;
  const background=this.win.getComputedStyle(this.el).getPropertyValue('--tg-bg').trim()||(theme==='dark'?'#050505':'#f5f5f5');
  const key=theme+':'+background;if(this.skyTheme===key)return;
  const scene=this.instance.scene,previous=scene.skyBox;
  scene.backgroundColor=Color.fromCssColorString(background)||Color.fromCssColorString(theme==='dark'?'#050505':'#f5f5f5')!;
  scene.skyBox=new SkyBox({sources:createStarfield(this.device.mobile?512:1024,theme,background)});
  previous?.destroy();this.skyTheme=key;this.el.dataset.theme=theme;this.wake();
 }
 private updateViewportFov(r=this.el.getBoundingClientRect()){
  const frustum=this.instance?.camera.frustum as {fov?:number}|undefined;if(!frustum||typeof frustum.fov!=='number')return;
  const aspect=r.width/r.height,shortWide=Number.isFinite(aspect)&&aspect>1.3;
  // Fit wide panes within the existing 5.5R zoom limit, then restore Cesium's 60-degree default elsewhere.
  const fov=shortWide?Math.max(Math.PI/3,2*Math.atan(aspect/(.9*Math.sqrt(6.5**2-1)))):Math.PI/3;
  if(Math.abs(frustum.fov-fov)>1e-6){frustum.fov=fov;this.instance?.scene.requestRender();}
 }
 defaultAltitude(){
  const r=this.el.getBoundingClientRect();this.updateViewportFov(r);const diameter=.82*Math.min(r.width,r.height);
  const altitude=diameter>0?Math.min(5.5,Math.max(1.4,Math.sqrt(1+(r.height/(Math.tan(25*Math.PI/180)*diameter))**2)-1)):2.1;
  const aspect=r.width/r.height;if(!(Number.isFinite(aspect)&&aspect>1.3))return altitude;
  // Cesium's fov is horizontal in a wide viewport; fit the sphere inside 90% of its shorter dimension.
  const fov=(this.instance?.camera.frustum as {fov?:number}|undefined)?.fov??Math.PI/3;
  const fit=Math.sqrt(1+(aspect/(.9*Math.tan(fov/2)))**2)-1;
  return Math.min(5.5,Math.max(altitude,fit));
 }
 private center(){const p=this.pickSurface(new Cartesian2(this.el.clientWidth/2,this.el.clientHeight/2));const c=this.instance?.camera.positionCartographic;return p||{lat:c?CMath.toDegrees(c.latitude):28,lng:c?CMath.toDegrees(c.longitude):108};}
 private setView(lat:number,lng:number,altitude:number,animate:boolean){
  const widget=this.instance;if(!widget||this.closed)return;widget.camera.cancelFlight();
  const height=(this.terrainEnabled?(this.terrain?.sample(lat,lng)||0)*2:0),destination=Cartesian3.fromDegrees(lng,lat,altitude*EARTH_METRES+height);
  if(this.tilted){
   widget.camera.lookAt(Cartesian3.fromDegrees(lng,lat,height),new HeadingPitchRange(0,-CMath.PI/6,Math.max(1500,altitude*EARTH_METRES)));
   widget.camera.lookAtTransform(CesiumIdentity);
  }else if(animate)widget.camera.flyTo({destination,orientation:{heading:0,pitch:-CMath.PI_OVER_TWO,roll:0},duration:.8});
  else widget.camera.setView({destination,orientation:{heading:0,pitch:-CMath.PI_OVER_TWO,roll:0}});
  this.wake();
 }
 private viewAltitude(){
  const widget=this.instance;if(!widget)return 2;const center=this.center(),height=this.terrainEnabled?(this.terrain?.sample(center.lat,center.lng)||0)*2:0;
  return Math.max(.000025,(this.tilted?Cartesian3.distance(widget.camera.positionWC,Cartesian3.fromDegrees(center.lng,center.lat,height)):widget.camera.positionCartographic.height-height)/EARTH_METRES);
 }
 zoomBy(delta:number){const center=this.center();this.setView(center.lat,center.lng,zoomAltitude(this.viewAltitude(),delta),true);}
 reset(){this.tilted=false;this.setView(28,108,this.defaultAltitude(),true);}
 focus(place:Place){this.setView(place.latitude,place.longitude,Math.min(this.cameraAltitude(),.45),true);}
 focusDetail(lat:number,lng:number){this.setView(lat,lng,.0012,true);}
 get terrainActive(){return this.terrainEnabled;}
 get tiltActive(){return this.tilted;}
 toggleTilt(){this.tilted=!this.tilted;const center=this.center();this.setView(center.lat,center.lng,Math.min(this.cameraAltitude(),.12),false);return this.tilted;}
 toggleTerrain(){this.terrainEnabled=!this.terrainEnabled;if(this.instance)this.instance.terrainProvider=this.terrainEnabled&&this.terrain?this.terrain.provider:new EllipsoidTerrainProvider();this.setPlaces(this.places);this.atlasLayers?.refresh();this.wake();return this.terrainEnabled;}
 refreshImagery(){
  const widget=this.instance;if(!widget||this.closed)return;this.atlasFailed=false;delete this.el.dataset.atlasError;this.atlasLayers?.refresh();if(this.showMapBorders||this.showCountryNames)this.ensureAtlasLayers();if(this.pendingQuality||this.el.dataset.mapStyleError)void this.applyQuality(this.pendingQuality||this.activeQuality!).catch(()=>{});if(this.terrain){const coarse=this.terrain.coarse;this.terrain.dispose();this.terrain=new TerrainSurface(coarse,this.terrainCache!,this.profile.mobile,this.wake);if(this.terrainEnabled)widget.terrainProvider=this.terrain.provider;}
  if(this.satellite)widget.scene.imageryLayers.remove(this.satellite,true);
  this.satellite=undefined;void this.addSatellite().then(()=>this.wake());
 }
 suspend(value:boolean){this.suspended=value;this.instance?.camera.cancelFlight();this.updateVisibility();}
 private isRenderable(){const r=this.el.getBoundingClientRect();return !this.suspended&&this.visible&&!this.doc.hidden&&r.width>0&&r.height>0;}
 updateVisibility(){
  const widget=this.instance;if(!widget||this.closed)return;this.bindOwnerEvents();const active=this.isRenderable();
  widget.useDefaultRenderLoop=active;this.el.dataset.rendering=active?'active':'paused';
  if(!active&&this.el.dataset.interactionQuality==='adaptive')this.finishMotion();
  if(!active&&(this.surfaceRequest!==undefined||this.surfaceWaiters.size||this.surfaceDecoders.size)){
   this.pendingQuality??=this.activeQuality;this.qualityRevision++;this.cancelSurfaceWork();
  }
  if(active){const pending=this.pendingQuality;if(pending)void this.applyQuality(pending);this.wake();}
 }
 dispose(){
  if(this.closed)return;this.closed=true;this.qualityRevision++;this.cloudRevision++;this.atlasRevision++;this.atlasLayers?.dispose();this.atlasLayers=undefined;this.cancelSurfaceWork();this.instance?.canvas.removeEventListener('webglcontextlost',this.contextLost);this.instance?.camera.cancelFlight();this.win.clearTimeout(this.idleTimer);this.win.clearTimeout(this.motionTimer);this.win.clearTimeout(this.retryTimer);
  this.el.removeEventListener('wheel',this.motion);this.el.removeEventListener('pointerdown',this.pointerDown,true);this.el.removeEventListener('pointermove',this.pointerMove,true);this.ownerWin?.removeEventListener('pointerup',this.pointerUp);this.ownerWin?.removeEventListener('pointercancel',this.pointerUp);this.touches.clear();
  this.resize?.disconnect();this.intersection?.disconnect();this.ownerDoc?.removeEventListener('visibilitychange',this.visibility);this.ownerDoc=undefined;this.ownerWin=undefined;for(const remove of this.removers)remove();
  this.clearClouds();this.terrain?.dispose();this.handler?.destroy();for(const url of this.objectUrls)URL.revokeObjectURL(url);
  const widget=this.instance;let gl:WebGLRenderingContext|WebGL2RenderingContext|null=null;
  if(widget&&!widget.isDestroyed()){
   widget.useDefaultRenderLoop=false;gl=widget.canvas.getContext('webgl2')??widget.canvas.getContext('webgl');
   // CesiumWidget owns a second input handler that 1.146 does not release in destroy().
   const inputs=widget.screenSpaceEventHandler;if(inputs&&!inputs.isDestroyed())inputs.destroy();
   widget.destroy();
  }
  // Cesium deletes GPU resources but leaves context-slot reclamation to GC; release our retired canvas now.
  try{if(gl&&!gl.isContextLost())gl.getExtension('WEBGL_lose_context')?.loseContext();}catch{/* Unsupported teardown extensions must not interrupt cleanup. */}
  for(const provider of [...this.surfaceImages.keys()])this.releaseSurface(provider);this.instance=undefined;this.el.replaceChildren();
 }
}
import {Matrix4} from 'cesium';
const CesiumIdentity=Matrix4.IDENTITY;
