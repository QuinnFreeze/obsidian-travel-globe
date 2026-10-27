import type {Settings} from './model';
export type MapStyle='natural'|'atlas';
export type AtlasLod='low'|'standard'|'high';
export type BorderClassification='normal'|'disputed'|'indeterminate';
export interface AtlasBoundary {id:string;classification:BorderClassification;sourceClass:string;coordinates:[number,number][]}
export interface AtlasLabel {id:string;name:string;nameZh?:string;position:[number,number];rank:number}
export interface AtlasData {
 schemaVersion:1;
 source:{name:string;version:string;license:string;url:string};
 borders:Record<AtlasLod,AtlasBoundary[]>;
 labels:AtlasLabel[];
}
export const MAP_COLORS={land:'#141827',water:'#263D5D',river:'#437797',border:'#CE7084',label:'#BAC5D3',outline:'#10121A'} as const;
export const ATLAS_DATA_PATH='runtime-assets/atlas-map.json';
export const mapStyleName=(style:MapStyle)=>style==='atlas'?'暗蓝地图':'自然地球';
export function mapAppearance(settings:Pick<Settings,'mapStyle'|'showBorders'|'showClouds'|'atlasBorders'|'atlasLabels'|'showCountryNames'>){
 const atlas=settings.mapStyle==='atlas';
 return {borders:atlas?settings.atlasBorders:settings.showBorders,clouds:!atlas&&settings.showClouds,labels:atlas?settings.atlasLabels:settings.showCountryNames,satellite:!atlas,terrainShade:!atlas};
}
export function atlasLod(altitude:number,mobile:boolean,low:boolean):AtlasLod {
 return low||altitude>.65?'low':mobile||altitude>.12?'standard':'high';
}
export interface LabelBox {id:string;x:number;y:number;width:number;height:number;rank:number}
export function selectLabelBoxes(boxes:LabelBox[],width:number,height:number,limit:number):string[]{
 const selected:LabelBox[]=[];if(limit<=0||width<=0||height<=0)return [];
 for(const box of [...boxes].sort((a,b)=>a.rank-b.rank||a.id.localeCompare(b.id))){
  if(![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.width<=0||box.height<=0||box.x<4||box.y<4||box.x+box.width>width-4||box.y+box.height>height-4)continue;
  if(selected.some(other=>box.x<other.x+other.width+8&&box.x+box.width+8>other.x&&box.y<other.y+other.height+6&&box.y+box.height+6>other.y))continue;
  selected.push(box);if(selected.length>=limit)break;
 }
 return selected.map(box=>box.id);
}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const text=(value:unknown,max=160)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x08\x0e-\x1f]/.test(value);
const position=(value:unknown):value is [number,number]=>Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='number'&&Number.isFinite(v))&&Math.abs(value[0])<=180&&Math.abs(value[1])<=90;
export function validateAtlasData(value:unknown):AtlasData {
 const data=object(value),source=object(data.source),borders=object(data.borders);
 if(data.schemaVersion!==1||!['name','version','license','url'].every(key=>text(source[key],500)))throw Error('基础地图来源信息或格式版本不符。');
 let total=0;
 for(const level of ['low','standard','high'] as const){
  const lines=borders[level];if(!Array.isArray(lines)||lines.length>8000||lines.length===0)throw Error('国界层级数据不完整。');
  const ids=new Set<string>();
  for(const item of lines){
   const line=object(item);
   if(!text(line.id)||ids.has(line.id as string)||!['normal','disputed','indeterminate'].includes(String(line.classification))||typeof line.sourceClass!=='string'||line.sourceClass.length>200||!Array.isArray(line.coordinates)||line.coordinates.length<2||line.coordinates.length>50000||!line.coordinates.every(position))throw Error('国界线标识、分类或坐标不符。');
   ids.add(line.id as string);total+=line.coordinates.length;if(total>500000)throw Error('国界数据超出设备预算。');
  }
 }
 if(!Array.isArray(data.labels)||data.labels.length===0||data.labels.length>600)throw Error('国家标注数据超出预算。');
 const ids=new Set<string>();
 for(const item of data.labels){
  const label=object(item);
  if(!text(label.id)||ids.has(label.id as string)||!text(label.name)||label.nameZh!==undefined&&!text(label.nameZh)||!position(label.position)||typeof label.rank!=='number'||!Number.isFinite(label.rank)||label.rank<0||label.rank>100)throw Error('国家标注名称或位置不符。');
  ids.add(label.id as string);
 }
 return value as AtlasData;
}
