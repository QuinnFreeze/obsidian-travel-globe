export type Quality='auto'|'low'|'standard'|'high'|'clear'|'ultra';
export interface DeviceCapabilities {mobile:boolean;intel:boolean;cores:number;memory?:number;maxTextureSize:number;pixelRatio:number}
/** Surface quality is independent of coarse terrain and clouds, whose CPU/GPU budgets stay bounded. */
export function chooseQuality(request:Quality,device:DeviceCapabilities){
  if(device.maxTextureSize<1024)throw new Error('设备纹理能力不足，使用旅行列表。');
  const lowMemory=device.memory!==undefined&&device.memory<=2;
  const weak=device.cores<=2||lowMemory;
  let desired:number;
  if(request==='low')desired=1024;
  else if(request==='standard')desired=2048;
  else if(request==='clear')desired=4096;
  else if(request==='ultra')desired=8192;
  // Keep the legacy high setting's desktop semantics for existing installations.
  else if(request==='high')desired=device.mobile?4096:device.maxTextureSize>=8192?8192:4096;
  else desired=device.mobile?(weak?1024:4096):lowMemory?2048:device.intel||weak?4096:8192;
  const budget=lowMemory?2048:device.mobile?4096:8192;
  const limit=Math.min(device.maxTextureSize,budget);
  const width=desired>=8192&&limit>=8192?8192:desired>=4096&&limit>=4096?4096:desired>=2048&&limit>=2048?2048:1024;
  const tier: 'low'|'standard'|'high'=width===1024?'low':width===2048?'standard':'high';
  const low=tier==='low';
  const reason=width<desired?(device.maxTextureSize<desired?'设备最大纹理尺寸不足，已使用 '+width/1024+'K':lowMemory?'设备内存预算不足，已使用 '+width/1024+'K':'手机内存预算限制为 4K'):'';
  return {tier,width,requested:request,reason,low,heightWidth:low?1024:2048,cloudWidth:device.mobile?low?1024:2048:width,
    pixelRatio:Math.min(device.pixelRatio||1,low?1:device.mobile?(weak?1:1.5):device.intel?1.5:2),
    curvature:low?6:device.mobile?4:tier==='high'?2:3,
    markerLimit:device.mobile?120:low?120:350,mobile:device.mobile};
}

/** Reduce only automatic rendering while the camera moves; keep the selected surface texture. */
export function movingRenderScale(request:Quality,restingScale:number,device:Pick<DeviceCapabilities,'mobile'|'intel'>){
  if(request!=='auto')return restingScale;
  return Math.min(restingScale,device.mobile?1:device.intel?0.85:1.25);
}
