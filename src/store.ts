import { decodeRecord, renderNote, safeFolder, type TravelRecord, type TravelInput } from './model';
export interface NoteFile {path:string;extension:string;stat:{mtime:number;size:number}}
export interface VaultPort {
  getMarkdownFiles(): NoteFile[]; read(file:NoteFile):Promise<string>;
  getFilesInFolder?(folder:string):NoteFile[];
  getAbstractFileByPath(path:string):unknown; createFolder(path:string):Promise<unknown>;
  create(path:string,text:string):Promise<unknown>;
}
export class TravelStore {
  records:TravelRecord[]=[]; issues:{path:string;message:string}[]=[];
  private generation=0;
  private cache=new Map<string,{stamp:string;record:TravelRecord|null;error?:string}>();
  constructor(private vault:VaultPort,private parse:(yaml:string)=>unknown,private folder:()=>string) {}
  invalidate(path?:string) {this.generation++;if(path){for(const key of this.cache.keys())if(key===path||key.startsWith(path+'/'))this.cache.delete(key);}else this.cache.clear();}
  async scan():Promise<boolean> {
    const generation=++this.generation;
    const folder=safeFolder(this.folder());
    const files=this.vault.getFilesInFolder?.(folder)??this.vault.getMarkdownFiles().filter(f=>f.path.startsWith(folder+'/'));
    const next=new Map<string,{stamp:string;record:TravelRecord|null;error?:string}>();
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(6,files.length)},async()=>{
      while(cursor<files.length) {
        const f=files[cursor++]!;const stamp=f.stat.mtime+':'+f.stat.size;
        const cached=this.cache.get(f.path);
        if(cached?.stamp===stamp){next.set(f.path,cached);continue;}
        try {next.set(f.path,{stamp,record:decodeRecord(f.path,await this.vault.read(f),this.parse)});}
        catch(e){next.set(f.path,{stamp,record:null,error:e instanceof Error?e.message:String(e)});}
      }
    }));
    if(generation!==this.generation)return false;
    this.cache=next;this.records=[];this.issues=[];
    for(const [path,value] of next) {if(value.record)this.records.push(value.record);if(value.error)this.issues.push({path,message:value.error});}
    return true;
  }
  async ensureFolder(path:string):Promise<void> {
    const parts=safeFolder(path).split('/');let current='';
    for(const part of parts){current=current?current+'/'+part:part;
      if(!this.vault.getAbstractFileByPath(current)){
        try{await this.vault.createFolder(current);}catch(e){if(!this.vault.getAbstractFileByPath(current))throw e;}
      }
    }
  }
  async create(input:TravelInput):Promise<string> {
    const text=renderNote(input);const folder=safeFolder(this.folder());
    await this.ensureFolder(folder);
    const city=input.city.replace(/[\\/:*?"<>|\x00-\x1f]/g,'-').replace(/^\.+/,'').trim().slice(0,70)||'旅行';
    const base=folder+'/'+input.date+'-'+city;
    // Vault.create is atomic with respect to existing files; collision retry also handles parallel saves.
    for(let n=0;n<1000;n++){
      const path=base+(n?'-'+(n+1):'')+'.md';
      if(this.vault.getAbstractFileByPath(path))continue;
      try {await this.vault.create(path,text);return path;}
      catch(e){if(!this.vault.getAbstractFileByPath(path))throw e;}
    }
    throw new Error('同名笔记过多，请更改日期或城市名称。');
  }
  dispose(){this.generation++;this.cache.clear();}
}
