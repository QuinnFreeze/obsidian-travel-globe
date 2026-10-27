import {App,Modal} from 'obsidian';
import {applyTheme} from './theme';
import type TravelGlobePlugin from './main';

export interface TravelPhoto {src:string;alt:string}
/** Original Vault resources remain immutable; only the viewing position changes. */
export class TravelPhotoModal extends Modal {
  private index:number;
  private image!:HTMLImageElement;
  private caption!:HTMLElement;
  private error!:HTMLElement;
  private previous!:HTMLButtonElement;
  private next!:HTMLButtonElement;
  private returnFocus:HTMLElement|null;private generation=0;private closed=false;
  constructor(app:App,private photos:TravelPhoto[],start=0,private themeHost?:Pick<TravelGlobePlugin,'applyTheme'|'forgetTheme'>){
    super(app);this.index=Math.max(0,Math.min(start,photos.length-1));this.returnFocus=document.activeElement as HTMLElement|null;
    this.scope.register([],'ArrowLeft',()=>{this.move(-1);return false;});
    this.scope.register([],'ArrowRight',()=>{this.move(1);return false;});
  }
  onOpen(){
    this.closed=false;this.modalEl.addClass('tg-photo-modal');this.contentEl.empty();
    if(this.themeHost)this.themeHost.applyTheme(this.modalEl);else applyTheme(this.modalEl,'auto');
    const toolbar=document.createElement('div');toolbar.className='tg-gallery-toolbar';
    const control=(label:string,action:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',action);return b;};
    this.caption=document.createElement('div');this.caption.className='tg-gallery-caption';this.caption.setAttribute('aria-live','polite');
    toolbar.append(this.caption,control('关闭',()=>this.close()));
    const stage=document.createElement('div');stage.className='tg-gallery-stage';
    this.image=document.createElement('img');this.image.decoding='async';
    this.error=document.createElement('div');this.error.className='tg-gallery-error';this.error.hidden=true;
    this.error.append(document.createTextNode('照片尚未下载或暂不可读。'),control('重试',()=>this.show()));
    stage.append(this.image,this.error);
    const navigation=document.createElement('div');navigation.className='tg-gallery-navigation';
    this.previous=control('← 上一张',()=>this.move(-1));this.next=control('下一张 →',()=>this.move(1));
    navigation.append(this.previous,this.next);this.contentEl.append(toolbar,stage,navigation);this.show();
  }
  private move(offset:number){if(!this.photos.length)return;this.index=(this.index+offset+this.photos.length)%this.photos.length;this.show();}
  private show(){
    const photo=this.photos[this.index];if(!photo)return;
    const generation=++this.generation;const old=this.image;old.removeAttribute('src');
    const image=this.image=document.createElement('img');image.decoding='async';image.alt=photo.alt;
    image.addEventListener('error',()=>{if(this.closed||generation!==this.generation)return;image.hidden=true;this.error.hidden=false;});
    image.addEventListener('load',()=>{if(this.closed||generation!==this.generation)return;image.hidden=false;this.error.hidden=true;});
    this.error.hidden=true;old.replaceWith(image);image.src=photo.src;
    this.caption.textContent=(this.index+1)+' / '+this.photos.length+' · '+photo.alt;
    this.previous.disabled=this.next.disabled=this.photos.length<2;
  }
  onClose(){this.closed=true;++this.generation;this.themeHost?.forgetTheme(this.modalEl);this.image?.removeAttribute('src');this.contentEl.empty();if(this.returnFocus?.isConnected)this.returnFocus.focus();}
}
