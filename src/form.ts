import {Modal,Notice,TFile,normalizePath,Platform} from 'obsidian';
import type TravelGlobePlugin from './main';
import {button,element} from './view';
import {localDate,placeId,validateInput,type TravelInput} from './model';
import {TIME_OF_DAY_LABELS,type TimeOfDay} from './trip-dates';
import {searchCities,type City} from './cities';
const imagePattern=/\.(png|jpe?g|gif|webp|avif)$/i;
export class AddTripModal extends Modal {
  private draft={city:'',country_code:'',country_name:'',latitude:'',longitude:'',date:localDate(),end_date:'',time_of_day:'' as TimeOfDay|'',photos:'',body:''};
  private selected?:City;private files:File[]=[];private saving=false;
  private opened=false;private finished=false;private picking=false;private pickStarting=false;
  private closing=false;private reopenAfterClose=false;
  private lastSaveError='';private errorEl?:HTMLElement;private fileStatus?:HTMLElement;
  private inputs=new Map<string,HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>();
  private searchTimer?:number;private searchVersion=0;
  constructor(private plugin:TravelGlobePlugin){super(plugin.app);}
  open(){
    if(this.finished)return;
    if(this.picking||this.pickStarting){new Notice('正在地球上选点；完成或取消选点后会恢复同一草稿。');return;}
    if(this.closing){this.reopenAfterClose=true;return;}
    if(this.opened)return;
    super.open();
  }
  close(){
    if(!this.opened||this.closing)return;
    this.closing=true;super.close();
  }
  onOpen(){
    this.opened=true;
    this.modalEl.classList.add('tg-trip-modal');this.modalEl.classList.toggle('tg-mobile-form',Platform.isMobile);
    this.plugin.applyTheme(this.modalEl);
    for(const leaf of this.app.workspace.getLeavesOfType('travel-globe-view'))(leaf.view as import('./view').TravelGlobeView).globe?.suspend(true);
    const {contentEl}=this;contentEl.empty();contentEl.addClass('tg-form');this.inputs.clear();
    contentEl.append(element('h2','','添加足迹'),element('p','tg-muted','保存为普通 Markdown 笔记，回忆与照片留在你的仓库。'));
    const searchLabel=element('label','tg-field','离线城市搜索');
    const search=element('input');search.type='search';search.placeholder='例如 上海、Paris、London';searchLabel.append(search);contentEl.append(searchLabel);
    const results=element('div','tg-search-results');results.setAttribute('aria-live','polite');contentEl.append(results);
    search.addEventListener('input',()=>{
      if((search as HTMLInputElement&{composing?:boolean}).composing)return;
      const version=++this.searchVersion,query=search.value;window.clearTimeout(this.searchTimer);this.searchTimer=window.setTimeout(async()=>{
        if(!search.isConnected)return;
        results.replaceChildren();if(query.trim().length<2)return;
        results.append(element('p','tg-muted','正在读取离线城市目录…'));
        let found;try{found=await searchCities(query);}catch(error){if(search.isConnected&&version===this.searchVersion)results.replaceChildren(element('p','tg-error','城市目录暂不可读，可重试或手动填写：'+String(error)));return;}
        if(!search.isConnected||version!==this.searchVersion)return;results.replaceChildren();
        results.append(element('p','tg-muted',found.total?'找到 '+found.total+' 个地点'+(found.total>30?'，显示前 30 个；请细化城市名称。':'，请选择具体地点。'):'未收录此地点，请手动填写。'));
        for(const city of found.results){
          const b=button('',()=>{this.useCity(city);results.replaceChildren();search.value=city.city;},'tg-search-result');
          b.append(element('strong','',city.city),element('span','',city.country_name+' ('+city.country_code+') · 行政区 '+(city.admin||'未知')),
            element('small','',city.latitude.toFixed(4)+'°, '+city.longitude.toFixed(4)+'° · '+city.id));results.append(b);
        }
      },160);
    });
    search.addEventListener('compositionstart',()=>{(search as HTMLInputElement&{composing?:boolean}).composing=true;++this.searchVersion;window.clearTimeout(this.searchTimer);});
    search.addEventListener('compositionend',()=>{(search as HTMLInputElement&{composing?:boolean}).composing=false;search.dispatchEvent(new Event('input'));});
    const grid=element('div','tg-form-grid');contentEl.append(grid);
    this.field(grid,'city','城市','text');this.field(grid,'country_name','国家或地区','text');
    this.field(grid,'country_code','国家或地区代码（CN / JP）','text');this.field(grid,'date','开始日期','date');
    this.field(grid,'end_date','结束日期（可选，单日可留空）','date');
    const timeLabel=element('label','tg-field','时段（可选）'),time=element('select');time.name='time_of_day';
    const anytime=element('option','','不指定');anytime.value='';time.append(anytime);
    for(const [value,label]of Object.entries(TIME_OF_DAY_LABELS)){const option=element('option','',label);option.value=value;time.append(option);}
    time.value=this.draft.time_of_day;time.addEventListener('change',()=>{this.draft.time_of_day=time.value as TimeOfDay|'';});
    this.inputs.set('time_of_day',time);timeLabel.append(time);grid.append(timeLabel);
    this.field(grid,'latitude','纬度（-90～90）','number');this.field(grid,'longitude','经度（-180～180）','number');
    const pick=button('在地球上选点',()=>{
      if(this.saving||this.finished||this.pickStarting||this.picking)return;
      this.pickStarting=true;this.lockControls();
      void this.plugin.activateView().then(view=>{
        this.pickStarting=false;if(this.finished){this.lockControls();return;}
        if(view.beginPick((lat,lng)=>{this.picking=false;this.selected=undefined;this.draft.latitude=lat.toFixed(5);this.draft.longitude=lng.toFixed(5);this.open();},()=>{this.picking=false;this.open();})){
          this.picking=true;this.close();new Notice('点击地球选取坐标；完成后表单自动恢复。');
        }else this.lockControls();
      }).catch(error=>{this.pickStarting=false;this.lockControls();new Notice('暂时无法选点：'+String(error));});
    });contentEl.append(pick,element('p','tg-muted','选点只获取坐标，请核对并填写城市和国家或地区。重复访问同一城市时，优先搜索选择同一个地点。'));
    this.field(contentEl,'photos','已有照片路径（每行一条，仓库内附件）','textarea','旅行附件/照片.jpg');
    const uploadLabel=element('label','tg-field','导入照片');
    const upload=element('input');upload.type='file';upload.accept='.jpg,.jpeg,.png,.webp,.gif,.avif';upload.multiple=true;
    upload.addEventListener('change',()=>{this.files=Array.from(upload.files||[]);fileStatus.textContent=this.files.map(f=>f.name).join('、');});
    uploadLabel.append(upload);contentEl.append(uploadLabel);
    const fileStatus=this.fileStatus=element('p','tg-muted',this.files.map(f=>f.name).join('、'));contentEl.append(fileStatus);
    this.field(contentEl,'body','旅行回忆','textarea','写下路上的人、风景与心情……');
    contentEl.append(element('p','tg-muted','关闭窗口会保留本次插件运行中的草稿；再次点击“添加足迹”恢复。重启或停用插件不会保留未保存的草稿。'));
    const error=this.errorEl=element('p','tg-error',this.lastSaveError);error.setAttribute('role','alert');contentEl.append(error);
    const actions=element('div','tg-form-actions');
    const save=button('保存足迹',()=>{void this.save(save,error);},'mod-cta');
    let discardArmed=false;
    const discard=button('丢弃草稿',()=>{
      if(this.saving||this.pickStarting||this.finished)return;
      if(!discardArmed){discardArmed=true;discard.textContent='确认丢弃草稿';error.textContent='再次点击确认丢弃未保存内容；已导入照片及原附件不会删除。';return;}
      this.finished=true;this.files=[];this.plugin.releaseTripModal(this);this.close();new Notice('草稿已丢弃；已导入照片及原附件均保留。');
    });
    actions.append(button('暂存并关闭',()=>this.close()),discard,save);contentEl.append(actions);this.lockControls();
  }
  private lockControls(){
    for(const control of this.contentEl.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>('input,textarea,select,button'))control.disabled=this.saving||this.pickStarting||this.finished;
  }
  private recoveryNotice(message:string){
    const fragment=document.createDocumentFragment();
    fragment.append(message+' ',button('恢复草稿',()=>{if(!this.finished)this.plugin.addTrip();}));new Notice(fragment,15000);
  }
  private field(parent:HTMLElement,key:Exclude<keyof typeof this.draft,'time_of_day'>,label:string,type:string,placeholder=''){
    const wrapper=element('label','tg-field',label);
    const input=type==='textarea'?element('textarea'):element('input');
    if(input instanceof HTMLInputElement){input.type=type;if(type==='number'){input.step='any';if(Platform.isMobile){input.type='text';input.inputMode='text';input.spellcheck=false;}else input.inputMode='decimal';}if(key==='country_code'){input.maxLength=2;input.autocapitalize='characters';input.autocomplete='off';input.spellcheck=false;}}
    input.value=this.draft[key];input.placeholder=placeholder;input.name=key;
    input.addEventListener('input',()=>{
      this.draft[key]=key==='country_code'?input.value.toUpperCase():input.value;
      if(['city','country_code','latitude','longitude'].includes(key))this.selected=undefined;
    });
    this.inputs.set(key,input);wrapper.append(input);parent.append(wrapper);
  }
  private useCity(city:City){
    this.selected=city;Object.assign(this.draft,{city:city.city,country_code:city.country_code,country_name:city.country_name,
      latitude:String(city.latitude),longitude:String(city.longitude)});
    for(const [key,input]of this.inputs)input.value=this.draft[key as keyof typeof this.draft];
  }
  private async save(save:HTMLButtonElement,error:HTMLElement){
    if(this.saving||this.finished||this.pickStarting||this.picking)return;
    error.textContent='';this.lastSaveError='';this.saving=true;this.lockControls();
    const createdPhotos:string[]=[];
    try {
      if(!this.draft.latitude.trim()||!this.draft.longitude.trim())throw new Error('请填写经纬度，或搜索城市、在地球上选点。');
      const latitude=Number(this.draft.latitude),longitude=Number(this.draft.longitude);
      const code=this.draft.country_code.trim().toUpperCase();
      const photos=this.draft.photos.split('\n').map(p=>p.trim()).filter(Boolean).map(p=>p.replace(/^!?(\[\[)(.*?)(\]\])$/,'$2').split('|')[0]!);
      for(let i=0;i<photos.length;i++){const path=photos[i]!;
        if(!imagePattern.test(path)||/^(https?:|data:|\/)/i.test(path)||path.split('/').includes('..'))throw new Error('照片须为仓库内 PNG、JPG、WebP、GIF 或 AVIF 附件。');
        const file=this.app.metadataCache.getFirstLinkpathDest(path,'')||this.app.vault.getAbstractFileByPath(path);
        if(!(file instanceof TFile))throw new Error('找不到照片附件：'+path);photos[i]=file.path;
      }
      const input:TravelInput={city:this.draft.city.trim(),country_code:code,country_name:this.draft.country_name.trim(),
        latitude,longitude,date:this.draft.date,...(this.draft.end_date?{end_date:this.draft.end_date}:{}),
        ...(this.draft.time_of_day?{time_of_day:this.draft.time_of_day}:{}),photos,body:this.draft.body,
        place_id:this.selected?.id||placeId(this.draft.city,code,latitude,longitude,this.plugin.store.records)};
      validateInput(input);
      for(const file of this.files){
        if(!imagePattern.test(file.name))throw new Error('不支持此照片格式：'+file.name);
        if(file.size>25*1024*1024)throw new Error('单张照片不能超过 25 MB，请先压缩：'+file.name);
      }
      if(this.files.length)await this.plugin.store.ensureFolder(this.plugin.settings.attachmentsFolder);
      for(const file of [...this.files]){
        const filename=file.name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'-').replace(/^\.+/,'').slice(-120);
        const folder=this.plugin.settings.attachmentsFolder;
        const prefix=Date.now()+'-'+Math.random().toString(36).slice(2,9);
        let path=normalizePath(folder+'/'+prefix+'-'+filename);
        for(let n=1;this.app.vault.getAbstractFileByPath(path);n++)path=normalizePath(folder+'/'+prefix+'-'+n+'-'+filename);
        await this.app.vault.createBinary(path,await file.arrayBuffer());createdPhotos.push(path);input.photos.push(path);
        // Record each successful import immediately, even if a later photo or note write fails.
        this.draft.photos=[this.draft.photos,path].filter(Boolean).join('\n');this.files=this.files.filter(pending=>pending!==file);
        const photosInput=this.inputs.get('photos');if(photosInput)photosInput.value=this.draft.photos;
        if(this.fileStatus)this.fileStatus.textContent=this.files.map(pending=>pending.name).join('、');
      }
      const path=await this.plugin.store.create(input);
      this.finished=true;this.files=[];this.plugin.releaseTripModal(this);
      this.close();new Notice('足迹已保存：'+path);
      try{await this.plugin.refresh();
      const view=await this.plugin.activateView();
      const record=this.plugin.store.records.find(r=>r.path===path);
      if(record){const {groupRecords}=await import('./model');const place=groupRecords(this.plugin.store.records).find(p=>p.records.some(r=>r.path===path));if(place)view.reveal(place);}
      }catch(e){new Notice('笔记已保存，但视图暂未更新：'+String(e));}
    }catch(e){
      const message=e instanceof Error?e.message:String(e);
      this.lastSaveError=message+(createdPhotos.length?' 已导入照片保留在附件文件夹，再次保存可复用。':'');
      error.textContent=this.lastSaveError;
      if(this.errorEl)this.errorEl.textContent=this.lastSaveError;
      // Notices live outside the modal: a host Escape/backdrop close must not swallow a failure.
      this.recoveryNotice('足迹保存失败：'+this.lastSaveError+' 草稿仍保留，可再次“添加足迹”恢复。');
    }finally{this.saving=false;this.lockControls();}
  }
  onClose(){this.opened=false;this.plugin.forgetTheme(this.modalEl);++this.searchVersion;window.clearTimeout(this.searchTimer);this.contentEl.empty();
    if(!this.finished&&!this.picking&&!this.pickStarting){
      if(this.saving)new Notice('保存仍在进行；请勿重复提交。失败时会提示，可通过“添加足迹”恢复同一草稿。');
      else new Notice('草稿已暂存于本次插件运行；点击“添加足迹”恢复。重启前请保存，或明确丢弃草稿。');
    }
    for(const leaf of this.app.workspace.getLeavesOfType('travel-globe-view'))(leaf.view as import('./view').TravelGlobeView).globe?.suspend(false);
    const reopen=this.reopenAfterClose;this.reopenAfterClose=false;this.closing=false;
    // Phone hosts finish their close animation asynchronously; reopen after the base
    // close call stack has detached the old root, retaining this same draft owner.
    if(reopen&&!this.finished&&!this.picking&&!this.pickStarting)queueMicrotask(()=>this.open());
  }
}
