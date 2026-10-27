import {readFile,writeFile} from 'node:fs/promises';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
let text='# 第三方许可与来源\n\n';
text+='全球地球、城市目录与旅行功能离线，纹理和目录放在离线 runtime-assets 中按需读取。用户放大地球时按视野读取 EOX 瓦片并缓存；关闭联网设置后只读缓存。没有 CDN、字体或在线城市搜索请求。\n\n';
text+='## 数据与素材\n\n- 城市目录：[GeoNames cities15000](https://download.geonames.org/export/dump/cities15000.zip)，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。取得日 2026-10-06。保留地名 ID、坐标、国家/行政区与部分别名；添加常用中文显示名；按人口排序。34,153 个地点，不保证完整或最新。国家中文名由系统 Intl.DisplayNames 提供。\n- 旧版地球底图（不再加载）：[Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/)，公共领域；使用 world-atlas 2.0.2 的 110m 简化数据，重新投影、配色并栅格化为 2048×1024 PNG。边界仅作地理示意，不用于确定地点所属；所属代码与名称由记录决定。哈希和数据变换见 assets/provenance.json 与 scripts/build-assets.mjs。\n- [world-atlas](https://github.com/topojson/world-atlas)，ISC 许可，Michael Bostock，完整许可如下。\n- 示例风景为本项目创作的明确标注 DEMO 的矢量插画转 PNG，MIT；不是真实旅行照片。\n- 界面概念使用内置 ImageGen 生成，仅作设计参考；产品运行时不加载此图。\n- 构建方式参考 [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin)（0BSD），未复制其示例业务逻辑。宿主 API 为外部依赖，不打入插件。\n\n';
text+=await readFile('assets/realistic/SOURCES.md','utf8')+'\n\n';
text+='## 城市卫星影像\n\n[Sentinel-2 cloudless 2024](https://s2maps.com/#license) by [EOX IT Services GmbH](https://eox.at) (Contains modified Copernicus Sentinel data 2024)，[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)。WMTS HTTPS 服务提供约 10 米分辨率的年度合成影像，非实时；仅非商业用途，商业使用需要与 EOX 另行许可。服务明确允许在应用内使用并下载影像；仅按当前视野加载，没有全城或全球预下载。缓存为未修改的 JPEG，最多 128 MiB，不进入安装包和源码包。插件代码的 MIT 许可不改变卫星数据许可。图上持续显示来源与许可链接。来源及条款核对日 2026-10-06；服务 https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg。\n\n';
text+='## world-atlas (仅离线生成国界时使用)\n\n'+await readFile('node_modules/world-atlas/LICENSE','utf8')+'\n\n';
const seen=new Set();
for(const [path,info]of Object.entries(lock.packages)){
  if(!path||info.dev||!path.startsWith('node_modules/'))continue;
  try{
    const pkg=JSON.parse(await readFile(path+'/package.json','utf8'));
    if(seen.has(pkg.name))continue;seen.add(pkg.name);
    text+='## '+pkg.name+' '+pkg.version+' — '+(pkg.license||'see package')+'\n\n';
    let found=false;
    for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md','LICENSE-MIT','COPYING']){
      try{text+='\n'+await readFile(path+'/'+name,'utf8')+'\n';found=true;break;}catch{}
    }
    if(!found)throw Error('缺少许可全文: '+path);
  }catch(error){throw error;}
}
await writeFile('THIRD_PARTY_NOTICES.md',text);console.log('Included licenses for '+seen.size+' runtime packages');
