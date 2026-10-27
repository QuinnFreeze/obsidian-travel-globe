import {DEFAULTS,safeFolder,type Settings} from './model';

export const DEVICE_KEYS=['quality','theme','listOnly','showBorders','showClouds','mapStyle','atlasBorders','atlasLabels','showCountryNames'] as const;
export type DevicePreferences=Pick<Settings,typeof DEVICE_KEYS[number]>;
const qualities=['auto','low','standard','high','clear','ultra'];
const mapStyles=['natural','atlas'];
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

export function devicePreferences(value:unknown):Partial<DevicePreferences>{
  const source=object(value),result:Partial<DevicePreferences>={};
  if(qualities.includes(String(source.quality)))result.quality=source.quality as Settings['quality'];
  if(['auto','light','dark'].includes(String(source.theme)))result.theme=source.theme as Settings['theme'];
  if(mapStyles.includes(String(source.mapStyle)))result.mapStyle=source.mapStyle as Settings['mapStyle'];
  for(const key of ['listOnly','showBorders','showClouds','atlasBorders','atlasLabels','showCountryNames'] as const)if(typeof source[key]==='boolean')result[key]=source[key];
  return result;
}

/** Legacy data is read without rewriting it; subsequent display preferences stay on this device. */
export function resolveSettings(saved:unknown,local:unknown):Settings{
  const source=object(saved),next={...DEFAULTS,...source,...devicePreferences(local)} as Settings;
  if(!qualities.includes(next.quality))next.quality='auto';
  if(!['auto','light','dark'].includes(next.theme))next.theme='auto';
  if(!mapStyles.includes(next.mapStyle))next.mapStyle='natural';
  if(source.quality==='high'&&(!source.settingsVersion||Number(source.settingsVersion)<2)&&devicePreferences(local).quality===undefined)next.quality='standard';
  for(const key of ['listOnly','showBorders','showClouds','satelliteOnline','earthOnline','atlasBorders','atlasLabels','showCountryNames'] as const)if(typeof next[key]!=='boolean')next[key]=DEFAULTS[key];
  next.recordsFolder=safeFolder(String(next.recordsFolder));next.attachmentsFolder=safeFolder(String(next.attachmentsFolder));
  next.settingsVersion=4;
  return next;
}

export function sharedSettingsPatch(patch:Partial<Settings>):Partial<Settings>{
  const next={...patch};for(const key of DEVICE_KEYS)delete next[key];return next;
}
