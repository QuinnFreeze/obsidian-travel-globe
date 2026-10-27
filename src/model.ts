import {formatTripDate,isTimeOfDay,normalizeTimeOfDay,type TimeOfDay} from './trip-dates';
import type {Quality} from './quality';
import type {ThemePreference} from './theme';
import type {MapStyle} from './map-style';
export interface TravelRecord {
  path: string; place_id: string; city: string; country_code: string; country_name: string;
  latitude: number; longitude: number; date: string; end_date?: string; time_of_day?: TimeOfDay; photos: string[]; summary: string;
}
export type TravelInput = Omit<TravelRecord, 'path' | 'summary'> & { body: string };
export interface Place {
  id: string; city: string; country_code: string; country_name: string;
  latitude: number; longitude: number; records: TravelRecord[];
}
export interface Filters { year: string; country: string }
export interface Settings {
  recordsFolder: string; attachmentsFolder: string; quality: Quality; theme: ThemePreference;
  listOnly: boolean; showBorders: boolean; showClouds: boolean; satelliteOnline: boolean; earthOnline: boolean;
  settingsVersion: number; mapStyle: MapStyle; atlasBorders: boolean; atlasLabels: boolean; showCountryNames: boolean;
}
export const DEFAULTS: Settings = {
  recordsFolder: '旅行记录', attachmentsFolder: '旅行附件', quality: 'auto', theme: 'auto',
  listOnly: false, showBorders: false, showClouds: false, satelliteOnline: true, earthOnline: true,
  settingsVersion: 4, mapStyle: 'natural', atlasBorders: true, atlasLabels: true, showCountryNames: false
};
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value+'T00:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0,10) === value;
}
export function safeFolder(value: string): string {
  if (/^[/\\]/.test(value.trim())) throw new Error('请使用仓库内的相对文件夹路径。');
  const path = value.trim().replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
  if (!path || path.split('/').some(p=>!p || p==='.' || p==='..' || p.startsWith('.')) || /[:\x00-\x1f]/.test(path))
    throw new Error('请使用仓库内的普通文件夹路径，不含 ..、隐藏目录或绝对路径。');
  return path;
}
export function validateInput(input: TravelInput): void {
  if (!input.city.trim() || !input.country_name.trim()) throw new Error('请填写城市与国家或地区。');
  if (!/^[A-Z]{2}$/.test(input.country_code)) throw new Error('国家或地区代码须为两位大写字母，例如 CN、JP。');
  if (!validDate(input.date)) throw new Error('请填写有效日期 YYYY-MM-DD。');
  if (input.end_date && (!validDate(input.end_date) || input.end_date<input.date)) throw new Error('结束日期须为有效日期，且不能早于开始日期。');
  if (input.time_of_day && !isTimeOfDay(input.time_of_day)) throw new Error('请选择有效的旅行时段。');
  if (!Number.isFinite(input.latitude) || Math.abs(input.latitude)>90 || !Number.isFinite(input.longitude) || Math.abs(input.longitude)>180)
    throw new Error('纬度范围 -90～90，经度范围 -180～180。');
  if (!input.place_id.trim()) throw new Error('地点标识不能为空。');
}
export function splitNote(text: string): {yaml: string;body: string} {
  const match = text.replace(/^\uFEFF/,'').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? {yaml:match[1]!,body:text.replace(/^\uFEFF/,'').slice(match[0].length)} : {yaml:'',body:text};
}
export function summary(body: string): string {
  return body.replace(/!\[\[[^\]]*\]\]/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(_,a,b)=>b||a)
    .replace(/^[#>\s-]+/gm,'').replace(/[*_`]/g,'').replace(/\s+/g,' ').trim().slice(0,240);
}
export function decodeRecord(path: string, text: string, parse: (yaml:string)=>unknown): TravelRecord | null {
  const {yaml,body}=splitNote(text);
  if (!yaml) return null;
  const data=parse(yaml) as Record<string,unknown> | null;
  if (!data || data.type!=='travel') return null;
  const str=(key:string)=>typeof data[key]==='string'?String(data[key]).trim():'';
  const num=(key:string)=>typeof data[key]==='number'?Number(data[key]):NaN;
  const record:TravelRecord={path,place_id:str('place_id'),city:str('city'),country_code:str('country_code').toUpperCase(),
    country_name:str('country_name'),latitude:num('latitude'),longitude:num('longitude'),date:str('date'),
    photos:Array.isArray(data.photos)?data.photos.filter((v):v is string=>typeof v==='string'):[],summary:summary(body)};
  if(data.end_date!==undefined && data.end_date!==null && data.end_date!=='') {
    if(typeof data.end_date!=='string')throw new Error('结束日期须为有效日期，且不能早于开始日期。');
    const end=data.end_date.trim();if(end)record.end_date=end;
  }
  if(data.time_of_day!==undefined && data.time_of_day!==null && data.time_of_day!=='') {
    const time=normalizeTimeOfDay(data.time_of_day);
    if(!time)throw new Error('请选择有效的旅行时段。');
    record.time_of_day=time;
  }
  validateInput({...record,body});
  return record;
}
export function filterRecords(records: TravelRecord[], filters: Filters): TravelRecord[] {
  return records.filter(r=>(!filters.year || (r.date.slice(0,4)<=filters.year && (r.end_date||r.date).slice(0,4)>=filters.year)) && (!filters.country || r.country_code===filters.country));
}
export function groupRecords(records: TravelRecord[]): Place[] {
  const map=new Map<string,Place>();
  for(const r of [...records].sort((a,b)=>b.date.localeCompare(a.date)||a.path.localeCompare(b.path))) {
    // country prevents accidentally merging different jurisdictions with a reused user-supplied ID.
    const key=r.country_code+':'+r.place_id;
    let p=map.get(key);
    if(!p) {p={id:key,city:r.city,country_code:r.country_code,country_name:r.country_name,latitude:r.latitude,longitude:r.longitude,records:[]};map.set(key,p);}
    p.records.push(r);
  }
  return [...map.values()].sort((a,b)=>a.city.localeCompare(b.city,'zh'));
}
export function statistics(records:TravelRecord[]) {return {cities:groupRecords(records).length,countries:new Set(records.map(r=>r.country_code)).size,records:records.length};}
export function localDate(): string {
  const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}
export function distanceKm(lat1:number,lng1:number,lat2:number,lng2:number) {
  const rad=Math.PI/180;const a=Math.sin((lat2-lat1)*rad/2)**2+Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin((lng2-lng1)*rad/2)**2;
  return 6371*2*Math.asin(Math.min(1,Math.sqrt(a)));
}
export function placeId(city:string,country:string,lat:number,lng:number,records:TravelRecord[]):string {
  const similar=records.filter(r=>r.country_code===country && r.city.normalize('NFKC').toLowerCase()===city.trim().normalize('NFKC').toLowerCase()
    && distanceKm(lat,lng,r.latitude,r.longitude)<25);
  const ids=new Set(similar.map(r=>r.place_id));
  if(ids.size===1)return similar[0]!.place_id;
  return 'manual:'+country+':'+encodeURIComponent(city.trim().normalize('NFKC').toLowerCase())+':'+lat.toFixed(3)+':'+lng.toFixed(3);
}
export function renderNote(input:TravelInput):string {
  validateInput(input);
  const quote=(s:string)=>JSON.stringify(s);
  const rows=['---','type: travel','place_id: '+quote(input.place_id),'city: '+quote(input.city.trim()),
    'country_code: '+quote(input.country_code),'country_name: '+quote(input.country_name.trim()),'latitude: '+input.latitude,
    'longitude: '+input.longitude,'date: '+quote(input.date),
    ...(input.end_date?['end_date: '+quote(input.end_date)]:[]),
    ...(input.time_of_day?['time_of_day: '+quote(input.time_of_day)]:[]),
    'photos: '+JSON.stringify(input.photos),'---','',
    '# '+input.city.trim()+' · '+formatTripDate(input),'',input.body.trim()||'在这里写下这次旅行的回忆。',''];
  return rows.join('\n');
}
