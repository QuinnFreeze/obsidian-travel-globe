import {Plugin,PluginSettingTab,Setting,Notice,parseYaml,TFolder,TFile,type TAbstractFile,type App,normalizePath,requestUrl} from 'obsidian';
import {TravelStore} from './store';
import {DEFAULTS,safeFolder,type Settings} from './model';
import {TravelGlobeView,VIEW_TYPE} from './view';
import {AddTripModal} from './form';
import {SatelliteCache} from './tile-cache';
import {createTerrainCache} from './terrain-data';
import {configureCityLoader} from './cities';
import {lazyResource} from './lazy';
import {EarthResources,RESOURCE_FOLDER,convertEarthImage,type ResourceSpec} from './earth-resources';
import {DEVICE_KEYS,devicePreferences,resolveSettings,sharedSettingsPatch} from './device-settings';
import {PhotoPreviews} from './photo-previews';
import {RendererWorkers} from './renderer-workers';
import {applyTheme} from './theme';
import {validateAtlasData,ATLAS_DATA_PATH,type AtlasData,type MapStyle} from './map-style';
import {createRenderer} from 'embedded:renderer';
import {CLOUD_WORKER_SOURCE} from 'embedded:cloud-worker';
import {executeRendererLoader,type RendererModule} from './renderer-loader';
export default class TravelGlobePlugin extends Plugin {
  loadRenderer=lazyResource(async()=>executeRendererLoader({
    isStopped:()=>this.stopped,
    getWorkerConstructor:()=>Worker,
    setRendererWorkers:workers=>{this.rendererWorkers=workers;},
    createRenderer:WorkerClass=>createRenderer(WorkerClass) as unknown as RendererModule
  }) as unknown as typeof import('./globe'));
  loadAtlasData=lazyResource(async():Promise<AtlasData>=>{
    const bundle=this.manifest.dir||'.obsidian/plugins/travel-globe';
    const path=normalizePath(bundle+'/'+ATLAS_DATA_PATH);
    const text=await this.app.vault.adapter.read(path);
    if(text.length>12*1024*1024)throw Error('基础地图数据超出 12MiB 预算。');
    return validateAtlasData(JSON.parse(text));
  });
  private cloudConversions=new Set<()=>void>();
  earthResources!:EarthResources;satelliteCache!:SatelliteCache;terrainCache!:SatelliteCache;private settingsQueue:Promise<unknown>=Promise.resolve();
  settings:Settings={...DEFAULTS};store!:TravelStore;lastError='';
  private sharedData:Record<string,unknown>={};private mapRequestRevision=0;
  photoPreviews!:PhotoPreviews;
  private rendererWorkers?:RendererWorkers;
  private themedElements=new Set<HTMLElement>();
  private scanWork?:Promise<void>;private scanAgain=false;
  private listeners=new Set<()=>void>();private timer?:number;private stopped=false;
  async onload(){
    const saved=await this.loadData() as Partial<Settings>|null;
    this.sharedData=saved&&typeof saved==='object'&&!Array.isArray(saved)?{...saved}:{};
    this.photoPreviews=new PhotoPreviews(file=>this.app.vault.adapter.readBinary(file.path));
    configureCityLoader(async()=>JSON.parse(await this.app.vault.adapter.read((this.manifest.dir||'.obsidian/plugins/travel-globe')+'/runtime-assets/cities.json')));
    try{this.settings=resolveSettings(saved,this.readDevicePreferences());}
    catch{this.settings={...DEFAULTS};new Notice('Travel Globe 设置路径无效，已恢复默认文件夹。');}
    const bundle=this.manifest.dir||'.obsidian/plugins/travel-globe';
    this.earthResources=new EarthResources(this.app.vault.adapter,bundle,async(url,headers)=>{const r=await timedRequest(url,headers);return {status:r.status,headers:r.headers,data:r.arrayBuffer};},(data,spec)=>this.convertResource(data,spec));
    this.earthResources.online=this.settings.earthOnline&&navigator.onLine;
    this.satelliteCache=new SatelliteCache(this.app.vault.adapter,RESOURCE_FOLDER+'/卫星影像',async url=>{const result=await timedRequest(url);if(result.status!==200)throw Error('卫星服务暂不可用：'+result.status);return result.arrayBuffer;});
    this.satelliteCache.online=this.settings.satelliteOnline&&navigator.onLine;
    this.terrainCache=createTerrainCache(this.app.vault.adapter,RESOURCE_FOLDER+'/地形高程',async url=>{const r=await timedRequest(url);if(r.status!==200)throw Error('高程服务 HTTP '+r.status);return r.arrayBuffer;});this.terrainCache.online=this.settings.earthOnline&&navigator.onLine;
    this.satelliteCache.legacyFolder=bundle+'/satellite-cache';
    const connectivity=()=>{this.earthResources.online=this.settings.earthOnline&&navigator.onLine;this.satelliteCache.online=this.settings.satelliteOnline&&navigator.onLine;
    this.terrainCache.online=this.settings.earthOnline&&navigator.onLine;for(const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))(leaf.view as TravelGlobeView).refreshSatellite();};
    this.registerDomEvent(window,'online',connectivity);this.registerDomEvent(window,'offline',connectivity);
    this.store=new TravelStore({
      getMarkdownFiles:()=>this.app.vault.getMarkdownFiles(),
      getFilesInFolder:folder=>{
        const root=this.app.vault.getAbstractFileByPath(folder);if(!(root instanceof TFolder))return [];
        const files:TFile[]=[],folders=[root];
        while(folders.length)for(const file of folders.pop()!.children){if(file instanceof TFolder)folders.push(file);else if(file instanceof TFile&&file.extension==='md')files.push(file);}
        return files;
      },
      read:file=>this.app.vault.read(file as TFile),
      getAbstractFileByPath:path=>this.app.vault.getAbstractFileByPath(path),
      createFolder:path=>this.app.vault.createFolder(path),create:(path,text)=>this.app.vault.create(path,text)
    },parseYaml,()=>this.settings.recordsFolder);
    this.registerView(VIEW_TYPE,leaf=>new TravelGlobeView(leaf,this));
    this.registerEvent(this.app.workspace.on('css-change',()=>this.refreshTheme()));
    this.addRibbonIcon('globe','打开旅行地球',()=>{void this.activateView();});
    this.addCommand({id:'open-travel-globe',name:'打开旅行地球',callback:()=>{void this.activateView();}});
    this.addCommand({id:'add-travel-footprint',name:'添加足迹',callback:()=>this.addTrip()});
    this.addCommand({id:'refresh-travel-globe',name:'重新读取旅行笔记',callback:()=>{this.store.invalidate();void this.refresh();}});
    this.addSettingTab(new TravelGlobeSettings(this.app,this));
    const relevant=(path:string)=>path===this.settings.recordsFolder||path.startsWith(this.settings.recordsFolder+'/');
    const changed=(file:TAbstractFile)=>{if(relevant(file.path)){this.store.invalidate(file.path);this.scheduleRefresh();}};
    this.registerEvent(this.app.vault.on('create',changed));
    this.registerEvent(this.app.vault.on('modify',changed));
    this.registerEvent(this.app.vault.on('delete',changed));
    this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{if(relevant(file.path)||relevant(oldPath)){this.store.invalidate(file.path);this.store.invalidate(oldPath);this.scheduleRefresh();}}));
    this.app.workspace.onLayoutReady(()=>{if(!this.stopped)void this.refresh();});
  }
  private async convertResource(data:ArrayBuffer,spec:ResourceSpec){
    if(spec.format!=='tiff')return convertEarthImage(data,spec);
    if(this.stopped)throw Error('插件已关闭');
    const url=URL.createObjectURL(new Blob([CLOUD_WORKER_SOURCE],{type:'application/javascript'}));
    let worker:Worker|undefined,cancel:()=>void=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
    try{return await new Promise<ArrayBuffer>((resolve,reject)=>{
      worker=new Worker(url);cancel=()=>reject(Error('云层转换已取消'));this.cloudConversions.add(cancel);
      timer=setTimeout(()=>reject(Error('云层转换超时')),60000);
      worker.onmessage=(event:MessageEvent<{result?:ArrayBuffer;error?:string}>)=>{
        if(event.data.result instanceof ArrayBuffer)resolve(event.data.result);else reject(Error(event.data.error||'云层转换失败'));
      };
      worker.onerror=()=>reject(Error('高清云层解码不可用'));worker.postMessage({buffer:data,width:spec.width},[data]);
    });}finally{if(timer!==undefined)clearTimeout(timer);this.cloudConversions.delete(cancel);worker?.terminate();URL.revokeObjectURL(url);}
  }
  async resourceUrl(path:string){const local=await this.earthResources.resolve(path);const url=this.app.vault.adapter.getResourcePath(normalizePath(local));const version=await this.earthResources.version(local);return url+(url.includes('?')?'&':'?')+'v='+encodeURIComponent(this.manifest.version+'-'+version);}
  private deviceStorageKey(){return 'travel-globe:device:'+this.app.vault.adapter.getResourcePath('');}
  private readDevicePreferences():unknown{
    try{return typeof this.app.loadLocalStorage==='function'?this.app.loadLocalStorage('travel-globe-device-v1'):JSON.parse(window.localStorage.getItem(this.deviceStorageKey())||'null');}
    catch{return null;}
  }
  private writeDevicePreferences(value:unknown){
    if(typeof this.app.saveLocalStorage==='function')this.app.saveLocalStorage('travel-globe-device-v1',value);
    else window.localStorage.setItem(this.deviceStorageKey(),JSON.stringify(value));
  }
  subscribe(callback:()=>void){this.listeners.add(callback);return()=>this.listeners.delete(callback);}
  applyTheme(element:HTMLElement){this.themedElements.add(element);return applyTheme(element,this.settings.theme);}
  forgetTheme(element:HTMLElement){this.themedElements.delete(element);}
  private refreshTheme(){
    if(this.stopped)return;
    for(const element of this.themedElements){if(element.isConnected)this.applyTheme(element);else this.themedElements.delete(element);}
    for(const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))(leaf.view as TravelGlobeView).updateTheme();
  }
  private scheduleRefresh(){window.clearTimeout(this.timer);this.timer=window.setTimeout(()=>{void this.refresh();},180);}
  async refresh(){
    if(this.stopped)return;this.scanAgain=true;
    if(this.scanWork)return this.scanWork;
    const work=this.drainRefresh();this.scanWork=work;
    try{await work;}finally{this.scanWork=undefined;}
  }
  private async drainRefresh(){
    while(this.scanAgain&&!this.stopped){
      this.scanAgain=false;
      try{if(await this.store.scan()){this.lastError='';this.listeners.forEach(cb=>cb());}else this.scanAgain=true;}
      catch(e){this.lastError='读取失败：'+(e instanceof Error?e.message:String(e));this.listeners.forEach(cb=>cb());console.error('Travel Globe',e);}
    }
  }
  async activateView():Promise<TravelGlobeView>{
    let leaf=this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if(!leaf){try{leaf=this.app.workspace.getLeaf('tab');}catch{leaf=this.app.workspace.getLeaf(false);}await leaf.setViewState({type:VIEW_TYPE,active:true});}
    await this.app.workspace.revealLeaf(leaf);this.app.workspace.setActiveLeaf(leaf,{focus:true});return leaf.view as TravelGlobeView;
  }
  private tripModal?:AddTripModal;
  releaseTripModal(modal:AddTripModal){if(this.tripModal===modal)this.tripModal=undefined;}
  addTrip(){const modal=this.tripModal??(this.tripModal=new AddTripModal(this));modal.open();return modal;}
  updateSettings(patch:Partial<Settings>){
    const work=this.settingsQueue.then(()=>this.applySettings(patch));this.settingsQueue=work.catch(()=>{});return work;
  }
  restoreMapStyle(mapStyle:MapStyle){
    const revision=this.mapRequestRevision;
    // A newer choice may already be queued when an older renderer reports failure.
    // Check ownership when this restoration executes, not only when it is requested.
    const work=this.settingsQueue.then(()=>{
      if(this.stopped||revision!==this.mapRequestRevision||this.settings.mapStyle===mapStyle)return;
      return this.applySettings({mapStyle});
    });this.settingsQueue=work.catch(()=>{});return work;
  }
  private async applySettings(patch:Partial<Settings>){
    if(this.stopped)throw Error('插件已关闭，请重新打开后调整设置。');
    const previousMapStyle=this.settings.mapStyle;const mapRevision=patch.mapStyle!==undefined?++this.mapRequestRevision:this.mapRequestRevision;
    const next={...this.settings,...patch};
    next.recordsFolder=safeFolder(next.recordsFolder);next.attachmentsFolder=safeFolder(next.attachmentsFolder);
    const sharedPatch=sharedSettingsPatch(patch),localChanged=DEVICE_KEYS.some(key=>patch[key]!==undefined);
    if(Object.keys(sharedPatch).length){const shared={...this.sharedData,...sharedPatch,settingsVersion:4};await this.saveData(shared);this.sharedData=shared;}
    if(this.stopped)return;
    if(localChanged)this.writeDevicePreferences(devicePreferences(next));
    this.settings=next;this.satelliteCache.online=next.satelliteOnline&&navigator.onLine;this.earthResources.online=next.earthOnline&&navigator.onLine;this.terrainCache.online=next.earthOnline&&navigator.onLine;
    if(patch.theme!==undefined)this.refreshTheme();
    if(patch.recordsFolder!==undefined||patch.attachmentsFolder!==undefined){this.store.invalidate();await this.refresh();}
    // Persisting preferences must not wait for GPU frames in hidden tabs. Rendering has its own revision guards.
    if(patch.listOnly!==undefined)void Promise.all(this.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf=>(leaf.view as TravelGlobeView).initializeGlobe())).catch(error=>{if(!this.stopped)new Notice('地球重新加载失败：'+String(error));});
    else if(patch.quality!==undefined||patch.mapStyle!==undefined)void Promise.all(this.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf=>(leaf.view as TravelGlobeView).applyQuality())).catch(error=>{if(!this.stopped){new Notice('画质或底图切换失败，保留已显示画面：'+String(error));if(patch.mapStyle!==undefined&&this.mapRequestRevision===mapRevision&&this.settings.mapStyle===next.mapStyle)void this.restoreMapStyle(previousMapStyle).catch(e=>new Notice(String(e)));}});
    if(patch.satelliteOnline!==undefined||patch.earthOnline!==undefined)for(const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))(leaf.view as TravelGlobeView).refreshSatellite();
    else if(patch.showBorders!==undefined||patch.showClouds!==undefined||patch.atlasBorders!==undefined||patch.atlasLabels!==undefined||patch.showCountryNames!==undefined)for(const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))(leaf.view as TravelGlobeView).updateAppearance();
  }
  onunload(){this.stopped=true;this.photoPreviews?.dispose();this.earthResources?.stop();this.satelliteCache?.stop();this.terrainCache?.stop();for(const cancel of this.cloudConversions)cancel();window.clearTimeout(this.timer);this.store?.dispose();this.listeners.clear();this.app.workspace.detachLeavesOfType(VIEW_TYPE);this.themedElements.clear();this.rendererWorkers?.dispose();}
}
class TravelGlobeSettings extends PluginSettingTab {
  constructor(app:App,private plugin:TravelGlobePlugin){super(app,plugin);}
  hide(){this.plugin.forgetTheme(this.containerEl);}
  display(){
    const el=this.containerEl;el.empty();el.addClass('tg-settings');this.plugin.applyTheme(el);el.createEl('h2',{text:'Travel Globe · 旅行地球'});
    el.createEl('p',{text:'核心功能完全离线。城市坐标来源 GeoNames（CC BY）；地表、高程与云层来源 NASA；国界来源 Natural Earth（公共领域）。'});
    const theme=new Setting(el).setName('外观主题').setDesc('默认跟随 Obsidian，也可固定浅色或深色；界面与地球背景一起切换，仅保存在此设备。');
    theme.settingEl.addClass('tg-theme-setting');theme.controlEl.setAttribute('role','group');theme.controlEl.setAttribute('aria-label','外观主题');
    const themeButtons=new Map<Settings['theme'],HTMLButtonElement>();
    const updateButtons=()=>{for(const [value,button]of themeButtons)button.setAttribute('aria-pressed',String(value===this.plugin.settings.theme));};
    for(const [value,label]of [['auto','跟随 Obsidian'],['light','浅色'],['dark','深色']] as const){
      theme.addButton(button=>{themeButtons.set(value,button.buttonEl);button.setButtonText(label).onClick(async()=>{
        try{await this.plugin.updateSettings({theme:value});updateButtons();}catch(error){new Notice(String(error));}
      });});
    }
    updateButtons();
    for(const [key,title,desc] of [
      ['recordsFolder','旅行笔记文件夹','仅扫描此目录及子目录，创建记录时按需新建。'],
      ['attachmentsFolder','照片附件文件夹','导入的照片保存到此仓库内目录。']
    ] as const) {
      new Setting(el).setName(title).setDesc(desc).addText(text=>{
        text.setValue(this.plugin.settings[key]);text.inputEl.addEventListener('change',()=>{
          void this.plugin.updateSettings({[key]:normalizePath(text.getValue())}).catch(e=>{new Notice(e.message);text.setValue(this.plugin.settings[key]);});
        });
      });
    }
    new Setting(el).setName('此设备画质').setDesc('也可在地球页面直接调整。画质、底图风格、云层、国界和列表模式仅保存在此设备，不随旅行笔记同步。自动按设备选择；清晰 4K、超清 8K，能力不足时显示实际档位与原因。')
      .addDropdown(drop=>drop.addOptions({auto:'自动',low:'流畅 · 1K',standard:'标准 · 2K',clear:'清晰 · 4K',ultra:'超清 · 8K',...(this.plugin.settings.quality==='high'?{high:'旧版高清 · 兼容'}:{})}).setValue(this.plugin.settings.quality)
        .onChange(value=>{void this.plugin.updateSettings({quality:value as Settings['quality']}).catch(e=>new Notice(String(e)));}));
    new Setting(el).setName('底图风格').setDesc('选择地球底图样式。偏好仅保存在此设备。暗蓝地图使用包内离线基础地图（城市图层未启用）。')
      .addDropdown(drop=>drop.addOptions({natural:'自然地球',atlas:'暗蓝地图'}).setValue(this.plugin.settings.mapStyle)
        .onChange(value=>{void this.plugin.updateSettings({mapStyle:value as Settings['mapStyle']}).then(()=>this.display()).catch(e=>new Notice(String(e)));}));
    new Setting(el).setName('联网更新地球底图').setDesc('先读取仓库「地球资源/全球底图」，后台每 7 天条件检查 NASA 同一历史合成产品；更新失败继续使用旧图。精细高程按视野下载到「地球资源/地形高程」（最多 64 MiB），30 天后后台检查；关闭后仅读取本地高程。底图下载和转换按画质进行，下一次打开使用更新后的文件；不代表实时天气。').addToggle(t=>t.setValue(this.plugin.settings.earthOnline).onChange(earthOnline=>{void this.plugin.updateSettings({earthOnline}).catch(e=>new Notice(String(e)));}));
    if(this.plugin.settings.mapStyle==='atlas'){
      new Setting(el).setName('国界线').setDesc('显示国家或地区分界线（暗蓝地图）。实线为常规界，虚线为未定或争议界；公共数据非官方国界，城市界未启用。').addToggle(t=>t.setValue(this.plugin.settings.atlasBorders).onChange(atlasBorders=>{void this.plugin.updateSettings({atlasBorders}).catch(e=>new Notice(String(e)));}));
      new Setting(el).setName('国家或地区名称').setDesc('显示主要国家或地区的中英文名称标注（暗蓝地图）。包内离线基础地图，城市图层未启用。').addToggle(t=>t.setValue(this.plugin.settings.atlasLabels).onChange(atlasLabels=>{void this.plugin.updateSettings({atlasLabels}).catch(e=>new Notice(String(e)));}));
    }else{
      new Setting(el).setName('国界细线').setDesc('叠加地理示意线，不改变旅行记录的国家或地区。').addToggle(t=>t.setValue(this.plugin.settings.showBorders).onChange(showBorders=>{void this.plugin.updateSettings({showBorders}).catch(e=>new Notice(String(e)));}));
      new Setting(el).setName('国家或地区名称').setDesc('显示国家或地区名称标注（自然地球）。').addToggle(t=>t.setValue(this.plugin.settings.showCountryNames).onChange(showCountryNames=>{void this.plugin.updateSettings({showCountryNames}).catch(e=>new Notice(String(e)));}));
    }
    new Setting(el).setName('云层').setDesc(this.plugin.settings.mapStyle==='atlas'?'显示自然云带；云层仅在自然地球底图生效，当前暗蓝地图下不显示。偏好仅保存在此设备。':'显示自然云带；独立控制云图开销。仅在自然地球底图生效。偏好仅保存在此设备。历史合成影像，不是实时天气。').addToggle(t=>t.setValue(this.plugin.settings.showClouds).onChange(showClouds=>{void this.plugin.updateSettings({showClouds}).catch(e=>new Notice(String(e)));}));
    new Setting(el).setName('使用旅行列表').setDesc('无需 WebGL；保留添加足迹、筛选与回忆查看。')
      .addToggle(toggle=>toggle.setValue(this.plugin.settings.listOnly).onChange(value=>{void this.plugin.updateSettings({listOnly:value}).catch(e=>new Notice(String(e)));}));
    new Setting(el).setName('联网卫星影像').setDesc('放大地球时自动从 EOX 读取 2024 年 Sentinel-2 合成影像，服务会收到所浏览区域的瓦片坐标。约 10 米分辨率；CC BY-NC-SA 4.0，仅非商业使用。关闭后只读取本地缓存；已缓存影像每 30 天后台重新下载检查，断网保留旧图。').addToggle(t=>t.setValue(this.plugin.settings.satelliteOnline).onChange(satelliteOnline=>{void this.plugin.updateSettings({satelliteOnline}).catch(e=>new Notice(String(e)));}));
    new Setting(el).setName('卫星缓存').setDesc('最多 128 MiB，按最近使用顺序淘汰；位于仓库「地球资源/卫星影像」。旧插件缓存按需复制，保留原件。缓存只覆盖已浏览的区域与层级，不是完整离线地图。清理不会删除旅行笔记或照片。').addButton(b=>b.setButtonText('清理卫星缓存').onClick(()=>{b.setDisabled(true);void this.plugin.satelliteCache.clear().then(()=>{new Notice('卫星缓存已清理。');}).catch(e=>new Notice(String(e))).finally(()=>b.setDisabled(false));}));
    new Setting(el).setName('重新读取').setDesc('同步外部编辑或排查导入的笔记。').addButton(b=>b.setButtonText('重新读取笔记').onClick(()=>{
      this.plugin.store.invalidate();void this.plugin.refresh().then(()=>new Notice('旅行笔记已重新读取。'));
    }));
  }
}

async function timedRequest(url:string,headers:Record<string,string>={}){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([requestUrl({url,headers,throw:false}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('资源请求超时')),url.endsWith('.tif')?90000:30000);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
}
