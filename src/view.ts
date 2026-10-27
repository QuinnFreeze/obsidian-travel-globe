import {ItemView,WorkspaceLeaf,Platform,TFile,Notice,Component,MarkdownRenderer} from 'obsidian';
import type TravelGlobePlugin from './main';
import {formatTripDate,tripYears} from './trip-dates';
import {filterRecords,groupRecords,splitNote,type Place} from './model';
import {mapAppearance,type MapStyle,mapStyleName} from './map-style';
import {TravelPhotoModal,type TravelPhoto} from './gallery';
import type {GlobeCanvas} from './globe';
export const VIEW_TYPE='travel-globe-view';
export function element<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',text='',doc:Document=document):HTMLElementTagNameMap[K] {
  const el=doc.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;
}
export function button(text:string,handler:()=>void,cls='',doc:Document=document):HTMLButtonElement {
  const b=element('button',cls,text,doc);b.type='button';b.addEventListener('click',handler);return b;
}
export class TravelGlobeView extends ItemView {
  globe?:GlobeCanvas;
  private root!:HTMLElement;private stage!:HTMLElement;private canvas!:HTMLElement;private detail!:HTMLElement;
  private list!:HTMLElement;private stats!:HTMLElement;private status!:HTMLElement;private year!:HTMLSelectElement;
  private country!:HTMLSelectElement;private picker!:HTMLElement;private listToggle!:HTMLButtonElement;
  private yearValue='';private countryValue='';private selected='';private places:Place[]=[];
  private listVisible=false;private fallback=false;private closed=false;
  private qualityMenu!:HTMLDetailsElement;private qualityPanel!:HTMLElement;private qualitySelect!:HTMLSelectElement;private qualityReason!:HTMLElement;
  private detailCollapsed=false;private detailGeneration=0;private memoryComponents:Component[]=[];private photoObserver?:IntersectionObserver;
  private listDirty=true;private listCount=100;
  private pickCallback?: (lat:number,lng:number)=>void;
  private pickCancel?:()=>void;
  private resize?:ResizeObserver;private resizeTimer?:number;private resizeWindow?:Window;
  private terrainToggle!:HTMLButtonElement;private tiltToggle!:HTMLButtonElement;
  private unsubscribe?:()=>void;private borderToggle!:HTMLButtonElement;private cloudToggle!:HTMLButtonElement;private qualityLabel!:HTMLElement;
  private mapStyleSelect!:HTMLSelectElement;private labelToggle!:HTMLButtonElement;private legendEl!:HTMLElement;
  constructor(leaf:WorkspaceLeaf,public plugin:TravelGlobePlugin){super(leaf);}
  getViewType(){return VIEW_TYPE;}getDisplayText(){return '旅行地球';}getIcon(){return 'globe';}
  async onOpen(){
    this.closed=false;this.contentEl.empty();this.contentEl.addClass('tg-view-content');
    const doc=this.contentEl.ownerDocument||document;
    this.root=element('div','tg-app','',doc);this.plugin.applyTheme(this.root);this.root.classList.toggle('tg-mobile',Platform.isMobile);this.contentEl.append(this.root);
    const header=element('header','tg-header','',doc);this.root.append(header);
    const brand=element('div','tg-brand','',doc);brand.append(element('h2','','旅行地球',doc),element('span','','Travel Globe',doc));header.append(brand);
    this.stats=element('div','tg-stats','',doc);header.append(this.stats);
    const filters=element('div','tg-filters','',doc);header.append(filters);
    this.year=element('select','','',doc);this.year.setAttribute('aria-label','按年份筛选');
    this.country=element('select','','',doc);this.country.setAttribute('aria-label','按国家或地区筛选');
    this.year.addEventListener('change',()=>{this.yearValue=this.year.value;this.refresh();});
    this.country.addEventListener('change',()=>{this.countryValue=this.country.value;this.refresh();});
    filters.append(this.year,this.country,button('＋ 添加足迹',()=>this.plugin.addTrip(),'mod-cta tg-add',doc));
    const workspace=element('div','tg-workspace','',doc);this.root.append(workspace);
    this.stage=element('section','tg-stage','',doc);workspace.append(this.stage);
    this.canvas=element('div','tg-canvas','',doc);this.stage.append(this.canvas);
    const layers=element('div','tg-layers','',doc);this.stage.append(layers);
    this.mapStyleSelect=element('select','','',doc);
    this.mapStyleSelect.setAttribute('aria-label','底图风格');
    this.mapStyleSelect.title='切换底图风格：自然地球 / 暗蓝地图';
    for(const [style,label] of [['natural','自然地球'],['atlas','暗蓝地图']] as const){
      const opt=element('option','',label,doc);opt.value=style;this.mapStyleSelect.append(opt);
    }
    this.mapStyleSelect.value=this.plugin.settings.mapStyle;
    this.mapStyleSelect.addEventListener('change',()=>{
      const style=this.mapStyleSelect.value as MapStyle;
      void this.plugin.updateSettings({mapStyle:style}).catch(e=>{new Notice(String(e));this.updateAppearance();});
    });
    this.borderToggle=button('国界',()=>{
      const isAtlas=this.plugin.settings.mapStyle==='atlas';
      void this.plugin.updateSettings(isAtlas?{atlasBorders:!this.plugin.settings.atlasBorders}:{showBorders:!this.plugin.settings.showBorders}).catch(e=>new Notice(String(e)));
    },'',doc);
    this.labelToggle=button('名称',()=>{
      const isAtlas=this.plugin.settings.mapStyle==='atlas';
      void this.plugin.updateSettings(isAtlas?{atlasLabels:!this.plugin.settings.atlasLabels}:{showCountryNames:!this.plugin.settings.showCountryNames}).catch(e=>new Notice(String(e)));
    },'',doc);
    this.cloudToggle=button('云层',()=>{
      if(this.plugin.settings.mapStyle==='atlas')return;
      void this.plugin.updateSettings({showClouds:!this.plugin.settings.showClouds}).catch(e=>new Notice(String(e)));
    },'',doc);
    const terrain=this.terrainToggle=button('地形',()=>{const active=this.globe?.toggleTerrain();terrain.setAttribute('aria-pressed',String(active));},'',doc);terrain.setAttribute('aria-pressed','true');terrain.title='切换真实地形起伏';
    this.qualityMenu=element('details','tg-quality-menu','',doc);
    this.qualityLabel=element('summary','tg-quality','画质 · 加载中',doc);this.qualityMenu.append(this.qualityLabel);
    const qualityPanel=this.qualityPanel=element('div','tg-quality-panel','',doc);qualityPanel.hidden=true;qualityPanel.id='tg-quality-'+Math.random().toString(36).slice(2);this.qualityLabel.setAttribute('aria-controls',qualityPanel.id);const qualityField=element('label','tg-quality-field','本设备画质',doc);
    this.qualitySelect=element('select','','',doc);this.qualitySelect.setAttribute('aria-label','选择本设备画质');
    for(const [value,label] of [['auto','自动 · 按设备能力'],['low','流畅 · 1K'],['standard','标准 · 2K'],['clear','清晰 · 4K'],['ultra','超清 · 8K']]){const option=element('option','',label,doc);option.value=value!;this.qualitySelect.append(option);}
    this.qualitySelect.addEventListener('change',()=>{void this.plugin.updateSettings({quality:this.qualitySelect.value as typeof this.plugin.settings.quality}).catch(e=>{new Notice(String(e));this.updateAppearance();});});
    qualityField.append(this.qualitySelect);this.qualityReason=element('p','tg-quality-reason','',doc);qualityPanel.append(qualityField,this.qualityReason,element('p','tg-muted','旅行记录跨设备共享，画质按设备选择。',doc));this.root.append(qualityPanel);this.qualityMenu.addEventListener('toggle',()=>{qualityPanel.hidden=!this.qualityMenu.open;this.qualityLabel.setAttribute('aria-expanded',String(this.qualityMenu.open));if(this.qualityMenu.open)this.positionQualityPanel();});
    layers.append(this.mapStyleSelect,this.borderToggle,this.labelToggle,this.cloudToggle,terrain,this.qualityMenu);
    const qualityChanged=()=>{
      this.updateAppearance();
      const active=this.canvas.dataset.activeMapStyle as MapStyle|undefined;
      // The renderer handles failures from both explicit changes and visibility resume.
      // Persist its fallback only while the failed request still owns the displayed state.
      if(this.canvas.dataset.mapStyleError&&active&&this.canvas.dataset.requestedMapStyle===active&&this.plugin.settings.mapStyle!==active){
        void this.plugin.restoreMapStyle(active).catch(error=>new Notice('底图恢复设置保存失败：'+String(error)));
      }
    };this.canvas.addEventListener('tg-quality-change',qualityChanged);this.register(()=>this.canvas.removeEventListener('tg-quality-change',qualityChanged));
    this.registerDomEvent(this.root,'click',event=>{if(this.qualityMenu.open&&!this.qualityMenu.contains(event.target as Node)&&!this.qualityPanel.contains(event.target as Node))this.qualityMenu.open=false;});
    this.registerDomEvent(this.root,'keydown',event=>{if(event.key==='Escape'&&this.qualityMenu.open){event.preventDefault();event.stopPropagation();this.qualityMenu.open=false;this.qualityLabel.focus();}});
    this.qualityLabel.addEventListener('keydown',event=>{if(event.key==='Tab'&&!event.shiftKey&&this.qualityMenu.open){event.preventDefault();this.qualitySelect.focus();}});
    this.qualitySelect.addEventListener('keydown',event=>{if(event.key==='Tab'&&event.shiftKey){event.preventDefault();this.qualityLabel.focus();}});
    const zoom=element('div','tg-zoom-controls','',doc);
    for(const [text,label,delta]of [['＋','放大',-.6],['−','缩小',.6]] as const){const b=button(text,()=>this.globe?.zoomBy(delta),'',doc);b.setAttribute('aria-label',label);b.title=label;zoom.append(b);}this.stage.append(zoom);
    this.legendEl=element('div','tg-map-legend','实线：常规界 · 虚线：未定或争议 · 公共数据非官方国界 · 城市界未启用',doc);
    this.legendEl.setAttribute('role','note');this.legendEl.setAttribute('aria-label','地图边界说明');this.legendEl.hidden=true;this.stage.append(this.legendEl);
    this.picker=element('div','tg-pick-banner','',doc);this.picker.hidden=true;this.stage.append(this.picker);
    const footer=element('div','tg-stage-footer');this.stage.append(footer);
    footer.append(element('span','tg-hint',Platform.isMobile?'单指旋转 · 双指缩放 · 轻点城市':'拖动旋转 · 滚轮缩放 · 点击地点查看回忆'));
    const actions=element('div','tg-stage-actions');
    const retry=button('重试资源',()=>this.refreshSatellite(),'tg-imagery-retry');actions.append(retry);
    const tilt=this.tiltToggle=button('倾斜视角',()=>{const active=this.globe?.toggleTilt();tilt.setAttribute('aria-pressed',String(active));tilt.textContent=active?'俯视地球':'倾斜视角';});tilt.setAttribute('aria-pressed','false');actions.append(tilt);
    actions.append(button('重置视角',()=>{this.globe?.reset();tilt.setAttribute('aria-pressed','false');tilt.textContent='倾斜视角';}));
    this.listToggle=button('旅行列表',()=>{this.listVisible=!this.listVisible;this.updateListVisibility();});
    actions.append(this.listToggle);footer.append(actions);
    this.list=element('div','tg-list');this.list.hidden=true;this.stage.append(this.list);
    this.detail=element('aside','tg-details');this.detail.setAttribute('aria-label','旅行回忆');workspace.append(this.detail);
    this.status=element('div','tg-status');this.root.append(this.status);
    const layoutWindow=this.resizeWindow=doc.defaultView||window;
    this.resize=new ResizeObserver(entries=>{
      const rect=entries[0]?.contentRect;if(!rect)return;
      const {width,height}=rect;layoutWindow.clearTimeout(this.resizeTimer);
      // Mutating layout inside ResizeObserver can produce a resize delivery loop.
      // Coalesce to a separate task; do not depend on rAF in a hidden mobile view.
      this.resizeTimer=layoutWindow.setTimeout(()=>{
        this.resizeTimer=undefined;if(this.closed)return;
        this.root.classList.toggle('tg-compact',width<900);this.root.classList.toggle('tg-narrow',width<560);this.root.classList.toggle('tg-short',height<560);
        if(this.qualityMenu.open)this.positionQualityPanel();
      },0);
    });
    this.resize.observe(this.root);
    this.unsubscribe=this.plugin.subscribe(()=>this.refresh());
    const globeReady=this.initializeGlobe();this.refresh();await Promise.all([globeReady,this.plugin.refresh()]);
  }
  private positionQualityPanel(){
    const root=this.root.getBoundingClientRect(),anchor=this.qualityLabel.getBoundingClientRect();
    const top=Math.max(8,Math.min(anchor.bottom-root.top+8,root.height-100));
    this.qualityPanel.style.top=top+'px';this.qualityPanel.style.right=Math.max(8,root.right-anchor.right)+'px';
    this.qualityPanel.style.maxHeight=Math.max(80,root.height-top-12)+'px';
  }
  private globeGeneration=0;
  async initializeGlobe(){
    const generation=++this.globeGeneration;
    this.globe?.dispose();this.globe=undefined;this.fallback=false;delete this.canvas.dataset.activeTexture;delete this.canvas.dataset.qualityError;
    delete this.canvas.dataset.requestedMapStyle;delete this.canvas.dataset.activeMapStyle;delete this.canvas.dataset.mapStyleError;
    if(this.plugin.settings.listOnly){this.toFallback('当前使用旅行列表模式。');return;}
    this.canvas.replaceChildren(element('div','tg-fallback','正在加载离线地球…',this.contentEl.ownerDocument||document));this.updateAppearance();
    try{
      const {GlobeCanvas}=await this.plugin.loadRenderer();
      if(this.closed||generation!==this.globeGeneration)return;
      this.canvas.replaceChildren();
      this.globe=new GlobeCanvas(this.canvas,this.plugin.settings,{mobile:Platform.isMobile,intel:/Intel/i.test(navigator.userAgent),cores:navigator.hardwareConcurrency||2,memory:(navigator as Navigator&{deviceMemory?:number}).deviceMemory,pixelRatio:window.devicePixelRatio||1},p=>this.select(p),(lat,lng)=>{
        const cb=this.pickCallback;if(cb){this.cancelPick();cb(lat,lng);}
      },reason=>this.toFallback(reason),this.plugin.satelliteCache,path=>this.plugin.resourceUrl(path),this.plugin.terrainCache,()=>this.plugin.loadAtlasData());
      this.globe.setPlaces(this.places);if(Platform.isMobile){const credits=this.canvas.querySelector('.tg-cesium-credits');if(credits){const disclosure=element('details','tg-credit-disclosure','',this.contentEl.ownerDocument||document);disclosure.append(element('summary','','地图来源',this.contentEl.ownerDocument||document));credits.before(disclosure);disclosure.append(credits);}}await this.globe.ready;if(this.closed||generation!==this.globeGeneration)return;this.updateAppearance();
      this.updateListVisibility();
    }catch(e){if(this.closed||generation!==this.globeGeneration)return;console.warn('Travel Globe: renderer unavailable',e);this.toFallback('地球暂不可用，已切换旅行列表。请确认插件文件已完整下载。');}
  }
  async applyQuality(){
    if(!this.globe||this.plugin.settings.listOnly){await this.initializeGlobe();return;}
    try{await this.globe.applyQuality(this.plugin.settings);this.updateAppearance();}
    catch(error){this.updateAppearance();throw error;}
  }
  updateTheme(){
    if(this.closed||!this.root)return;
    this.globe?.setTheme(this.plugin.applyTheme(this.root));
  }
  updateAppearance(){
    this.updateTheme();
    const appearance=mapAppearance(this.plugin.settings);
    const isAtlas=this.plugin.settings.mapStyle==='atlas';
    this.globe?.setAppearance(appearance.borders,appearance.clouds,appearance.labels);
    const actMapStyle=this.canvas.dataset.activeMapStyle as MapStyle|undefined;
    const reqMapStyle=this.canvas.dataset.requestedMapStyle as MapStyle|undefined;
    const mapError=this.canvas.dataset.mapStyleError;
    if(this.mapStyleSelect){
      if(mapError&&actMapStyle&&actMapStyle!==this.plugin.settings.mapStyle){
        this.mapStyleSelect.value=actMapStyle;
        this.mapStyleSelect.title='底图切换失败，当前显示'+mapStyleName(actMapStyle);
      }else{
        this.mapStyleSelect.value=this.plugin.settings.mapStyle;
        this.mapStyleSelect.title='切换底图风格：自然地球 / 暗蓝地图';
      }
    }
    if(this.borderToggle){
      this.borderToggle.setAttribute('aria-pressed',String(appearance.borders));
      this.borderToggle.disabled=!this.globe;
      this.borderToggle.title=isAtlas?'切换暗蓝地图边界（实线常规/虚线未定或争议；非官方国界）':'切换自然地球国界细线';
    }
    if(this.labelToggle){
      this.labelToggle.setAttribute('aria-pressed',String(appearance.labels));
      this.labelToggle.disabled=!this.globe;
      this.labelToggle.title=isAtlas?'切换暗蓝地图国家或地区名称（中英文标注）':'切换国家或地区名称标注';
    }
    if(this.cloudToggle){
      this.cloudToggle.setAttribute('aria-pressed',String(appearance.clouds));
      this.cloudToggle.disabled=!this.globe||isAtlas;
      this.cloudToggle.title=isAtlas?'云层仅在自然地球显示，切换回自然地球后恢复':'切换云层';
    }
    if(this.legendEl){
      this.legendEl.hidden=!(isAtlas&&appearance.borders);
    }
    for(const [b,active] of [[this.terrainToggle,this.globe?.terrainActive],[this.tiltToggle,this.globe?.tiltActive]] as const){if(b){b.disabled=!this.globe;b.setAttribute('aria-pressed',String(!!active));}}if(this.tiltToggle)this.tiltToggle.textContent=this.globe?.tiltActive?'俯视地球':'倾斜视角';
    if(this.qualityLabel){
      const requested=String(this.plugin.settings.quality);const names:Record<string,string>={auto:'自动',low:'流畅',standard:'标准',clear:'清晰',ultra:'超清',high:'旧版高画质'};
      const active=Number(this.canvas.dataset.activeTexture)||0;const upgrading=!!this.globe&&active>0&&active<this.globe.profile.width&&!this.canvas.dataset.qualityError;
      const styleSwitching=!!(reqMapStyle&&actMapStyle&&reqMapStyle!==actMapStyle);
      this.qualityLabel.textContent=this.globe?'画质 · '+(names[requested]||'自动')+' · '+(active?active/1024+'K':'加载中')+(upgrading?' ↑':''):this.fallback?'画质 · 列表模式':'画质 · 加载中';
      const legacyOption=this.qualitySelect.querySelector('option[value=high]');
      if(requested==='high'&&!legacyOption){const option=element('option','','旧版高画质 · 兼容设置',this.contentEl.ownerDocument||document);option.value='high';this.qualitySelect.append(option);}
      else if(requested!=='high')legacyOption?.remove();
      this.qualitySelect.value=requested;
      let reason=this.globe?((active?'实际地表 '+active+' 像素':'底图正在加载')+(upgrading?' · 正在加载 '+this.globe.profile.width/1024+'K 地表':'')+' · '+this.globe.profile.reason):this.fallback?'地球暂不可用，可调整画质后重新加载。':'地球资源正在加载，完成后显示实际画质。';
      if(mapError)reason+=' · 底图加载失败：'+mapError+'，保留当前底图';
      else if(styleSwitching)reason+=' · 正在切换底图为 '+mapStyleName(reqMapStyle);
      this.qualityReason.textContent=reason;
    }
  }
  private toFallback(message:string){const cancel=this.pickCancel;this.globe?.dispose();this.globe=undefined;this.fallback=true;this.cancelPick();this.canvas.replaceChildren();
    const notice=element('div','tg-fallback',message);if(!this.plugin.settings.listOnly)notice.append(button('重新加载地球',()=>{void this.initializeGlobe();}));this.canvas.append(notice);this.listVisible=true;this.updateListVisibility();this.updateAppearance();cancel?.();}
  refresh(){
    if(this.closed||!this.root)return;
    const all=this.plugin.store.records;
    const years=[...new Set(all.flatMap(r=>tripYears(r)))].sort().reverse();
    const countries=new Map(all.map(r=>[r.country_code,r.country_name]));
    if(this.yearValue&&!years.includes(this.yearValue))this.yearValue='';
    if(this.countryValue&&!countries.has(this.countryValue))this.countryValue='';
    this.fillSelect(this.year,[['','全部年份'],...years.map(y=>[y,y] as [string,string])],this.yearValue);
    this.fillSelect(this.country,[['',Platform.isMobile?'全部地区':'全部国家或地区'],...[...countries].sort((a,b)=>a[1].localeCompare(b[1],'zh'))],this.countryValue);
    const filtered=filterRecords(all,{year:this.yearValue,country:this.countryValue});this.places=groupRecords(filtered);
    const stats={cities:this.places.length,countries:new Set(filtered.map(r=>r.country_code)).size,records:filtered.length};this.stats.replaceChildren();
    for(const [value,label] of [[stats.cities,'城市'],[stats.countries,'国家或地区'],[stats.records,'旅行记录']] as [number,string][]){
      const item=element('div','tg-stat');item.append(element('strong','',String(value)),element('span','',label));this.stats.append(item);
    }
    this.globe?.setPlaces(this.places);this.renderList();
    const current=this.places.find(p=>p.id===this.selected);
    if(current)this.renderDetail(current);else{this.selected='';this.renderDetail();}
    this.status.replaceChildren();
    const text=element('span','',filtered.length?'统计为当前筛选结果 · 数据来自仓库内 Markdown':'还没有足迹，点击「添加足迹」开始记录。');this.status.append(text);
    if(this.plugin.store.issues.length){
      const info=element('details','tg-issues');info.append(element('summary','',this.plugin.store.issues.length+' 条笔记需要检查'));
      for(const issue of this.plugin.store.issues)info.append(button(issue.path+'：'+issue.message,()=>this.openNote(issue.path)));
      this.status.append(info);
    }
    if(this.plugin.lastError)this.status.append(element('span','tg-error',this.plugin.lastError));
  }
  private fillSelect(select:HTMLSelectElement,items:[string,string][],value:string){
    select.replaceChildren();for(const [id,label]of items){const option=element('option','',label);option.value=id;select.append(option);}select.value=value;
  }
  private renderList(){
    this.listDirty=true;if(!this.listVisible)return;
    this.listDirty=false;
    this.list.replaceChildren(element('h3','','旅行足迹'));
    if(!this.places.length)this.list.append(element('p','tg-muted','当前筛选下没有旅行记录。'));
    for(const p of this.places.slice(0,this.listCount)){
      const b=button('',()=>this.select(p),'tg-place-row');b.append(element('strong','',p.city),element('span','',p.country_name+' · '+p.records.length+' 次'));
      b.classList.toggle('is-selected',p.id===this.selected);this.list.append(b);
    }
    if(this.places.length>this.listCount)this.list.append(button('显示更多地点（'+(this.places.length-this.listCount)+'）',()=>{this.listCount+=100;this.renderList();},'tg-place-row'));
  }
  private updateListVisibility(){this.root.classList.toggle('tg-list-open',this.listVisible&&!this.fallback);this.list.hidden=!this.listVisible;if(this.listVisible&&this.listDirty)this.renderList();this.listToggle.textContent=this.listVisible&&!this.fallback?'收起列表':'旅行列表';
    this.listToggle.setAttribute('aria-expanded',String(this.listVisible));this.stage.classList.toggle('tg-list-mode',this.fallback);}
  select(p:Place){if(this.pickCallback){const cb=this.pickCallback;this.cancelPick();cb(p.latitude,p.longitude);return;}const changed=this.selected!==p.id;this.selected=p.id;if(changed)this.globe?.focus(p);this.detailCollapsed=Platform.isMobile&&this.root.clientHeight<560;if(!this.fallback&&(Platform.isMobile||this.root.classList.contains('tg-compact'))){this.listVisible=false;this.updateListVisibility();}this.renderDetail(p);this.renderList();this.detail.scrollTop=0;}
  reveal(p:Place){this.yearValue='';this.countryValue='';this.refresh();this.select(p);}
  private renderDetail(p?:Place){
    this.root.classList.toggle('tg-has-selection',!!p);this.root.classList.toggle('tg-detail-collapsed',!!p&&this.detailCollapsed);
    this.detailGeneration++;this.photoObserver?.disconnect();this.photoObserver=undefined;for(const component of this.memoryComponents)component.unload();this.memoryComponents=[];
    this.detail.replaceChildren();
    const head=element('div','tg-detail-heading');head.append(element('h3','',Platform.isMobile&&p?p.city:'旅行回忆'));
    if(p){
      const controls=element('div','tg-detail-controls');
      const collapse=button(this.detailCollapsed?'展开':'收起',()=>{this.detailCollapsed=!this.detailCollapsed;this.renderDetail(p);},'tg-collapse');collapse.setAttribute('aria-expanded',String(!this.detailCollapsed));collapse.title='收起或展开旅行回忆';
      controls.append(collapse,button('关闭',()=>{this.selected='';this.renderDetail();this.renderList();},'tg-close'));head.append(controls);
    }this.detail.append(head);
    if(!p){this.detail.append(element('div','tg-empty','每一个光点，都是一段回忆。'),element('p','tg-muted','点击地球上的城市，或从旅行列表选择地点。'));return;}
    this.detail.append(element('h2','tg-city',p.city),element('p','tg-muted',p.country_name+' · '+p.records.length+' 次旅行'));
    const coordinates=element('p','tg-coordinates',p.latitude.toFixed(4)+'°, '+p.longitude.toFixed(4)+'°');
    const satellite=button('放大到这里',()=>this.globe?.focusDetail(p.latitude,p.longitude),'tg-open-note');satellite.disabled=!this.globe;
    for(const r of p.records){
      const entry=element('article','tg-memory');const date=element('time','',formatTripDate(r));date.dateTime=r.date;
      const summary=element('p','tg-summary',r.summary||'这次旅行还没有写下回忆。');
      if(r.photos.length){
        const gallery=element('div','tg-photos');const photos:TravelPhoto[]=[];const photoFiles:TFile[]=[];
        for(const photo of r.photos){
          const path=photo.replace(/^!?(\[\[)(.*?)(\]\])$/,'$2').split('|')[0]!;
          if(!/\.(png|jpe?g|gif|webp|avif)$/i.test(path))continue;
          const file=this.app.metadataCache.getFirstLinkpathDest(path,r.path);
          if(file instanceof TFile){photos.push({src:this.app.vault.getResourcePath(file),alt:r.city+' · '+formatTripDate(r)+' · '+file.basename});photoFiles.push(file);}
          else gallery.append(element('span','tg-photo-unavailable','照片尚未同步或已移动：'+path));
        }
        photos.forEach((photo,index)=>{
          const generation=this.detailGeneration;let loading=false;const item=element('div','tg-photo-item');
          const open=button('',()=>new TravelPhotoModal(this.app,photos,index,this.plugin).open(),'tg-photo-button');open.setAttribute('aria-label','放大照片 '+(index+1)+'：'+photo.alt);
          const image=element('img');image.alt=photo.alt;image.loading='lazy';image.decoding='async';
          const retry=button('重试预览',()=>{void loadPreview();},'tg-photo-retry');retry.hidden=true;
          const loadPreview=async()=>{
            if(loading||this.closed||generation!==this.detailGeneration)return;loading=true;retry.hidden=true;open.setAttribute('aria-busy','true');open.replaceChildren(element('span','tg-photo-loading','正在读取照片…'));
            try{
              const src=await this.plugin.photoPreviews.get(photoFiles[index]!);
              if(this.closed||generation!==this.detailGeneration)return;
              image.src=src;open.replaceChildren(image);open.setAttribute('aria-label','放大照片 '+(index+1)+'：'+photo.alt);
            }catch{if(generation===this.detailGeneration){retry.hidden=false;open.replaceChildren(element('span','tg-photo-unavailable','预览未同步或不可读取 · 点击查看原图'));open.setAttribute('aria-label','查看原图 '+(index+1)+'：'+photo.alt);}}
            finally{loading=false;open.removeAttribute('aria-busy');}
          };
          image.addEventListener('error',()=>{retry.hidden=false;open.replaceChildren(element('span','tg-photo-unavailable','预览不可读取 · 点击查看原图'));});
          open.append(element('span','tg-photo-loading','旅行照片'));item.append(open,retry);gallery.append(item);
          if(typeof IntersectionObserver==='undefined'){void loadPreview();}
          else{
            if(!this.photoObserver)this.photoObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const target=entry.target as HTMLElement;this.photoObserver?.unobserve(target);target.dispatchEvent(new Event('tg-preview-visible'));}},{root:this.detail,rootMargin:'160px'});
            open.addEventListener('tg-preview-visible',()=>{void loadPreview();},{once:true});this.photoObserver.observe(open);
          }
        });entry.append(gallery);
      }
      entry.append(date,summary);
      const expanded=element('div','tg-full-memory');expanded.hidden=true;const generation=this.detailGeneration;
      const expand=button('展开回忆',()=>{void (async()=>{
        if(!expanded.hidden){expanded.hidden=true;summary.hidden=false;expand.textContent='展开回忆';expand.setAttribute('aria-expanded','false');return;}
        if(!expanded.hasChildNodes()){
          expand.disabled=true;expand.textContent='正在读取回忆…';let renderingComponent:Component|undefined;
          try{
            const file=this.app.vault.getAbstractFileByPath(r.path);if(!(file instanceof TFile))throw new Error('笔记已移动或删除。');
            const body=splitNote(await this.app.vault.cachedRead(file)).body;if(this.closed||generation!==this.detailGeneration)return;
            const component=renderingComponent=new Component();component.load();this.memoryComponents.push(component);
            await MarkdownRenderer.render(this.app,body,expanded,r.path,component);
            if(this.closed||generation!==this.detailGeneration){component.unload();this.memoryComponents=this.memoryComponents.filter(c=>c!==component);return;}
          }catch(error){renderingComponent?.unload();this.memoryComponents=this.memoryComponents.filter(c=>c!==renderingComponent);expanded.replaceChildren();if(generation!==this.detailGeneration)return;new Notice('无法读取回忆：'+String(error));expand.disabled=false;expand.textContent='重试读取回忆';return;}
          finally{expand.disabled=false;}
        }
        expanded.hidden=false;summary.hidden=true;expand.textContent='收起回忆';expand.setAttribute('aria-expanded','true');
      })();},'tg-open-note tg-expand-memory');expand.setAttribute('aria-expanded','false');entry.append(expanded,expand);
      entry.append(button('打开原始笔记',()=>this.openNote(r.path),'tg-open-note'));this.detail.append(entry);
    }
    this.detail.append(coordinates,satellite);
  }
  private openNote(path:string){const file=this.app.vault.getAbstractFileByPath(path);if(file instanceof TFile)void this.app.workspace.getLeaf('tab').openFile(file).catch(e=>new Notice(String(e)));else new Notice('笔记已移动或删除：'+path);}
  beginPick(callback:(lat:number,lng:number)=>void,onCancel?:()=>void):boolean {
    if(!this.globe){new Notice('列表模式下请手动输入坐标。');return false;}
    const old=this.pickCancel;this.cancelPick();old?.();this.pickCancel=onCancel;this.pickCallback=callback;this.picker.replaceChildren(element('span','','移动地图后，点击旅行地点获取坐标。'),button('取消选点',()=>{const cancel=this.pickCancel;this.cancelPick();cancel?.();}));
    this.picker.hidden=false;return true;
  }
  cancelPick(){this.pickCallback=undefined;this.pickCancel=undefined;if(this.picker)this.picker.hidden=true;}
  refreshSatellite(){this.globe?.refreshImagery();}
  async onClose(){this.closed=true;this.plugin.forgetTheme(this.root);++this.detailGeneration;this.photoObserver?.disconnect();this.photoObserver=undefined;for(const component of this.memoryComponents)component.unload();this.memoryComponents=[];++this.globeGeneration;this.unsubscribe?.();this.resize?.disconnect();this.resizeWindow?.clearTimeout(this.resizeTimer);this.resizeTimer=undefined;this.resizeWindow=undefined;const cancel=this.pickCancel;this.cancelPick();cancel?.();this.globe?.dispose();this.globe=undefined;this.contentEl.empty();}
}
