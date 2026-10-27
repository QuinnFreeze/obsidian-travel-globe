## 写实地球资源（0.2.0）

所有素材均用于信息性地球展示，不暗示 NASA、GEBCO 或其他机构支持本插件。原始资源保存在 assets/upstream，精确下载 URL、取得日、尺寸和 SHA-256 见 assets/realistic/provenance.json。

- **自然色地表**：NASA Earth Observatory，[Blue Marble Next Generation / Base Topography](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography/)，Reto Stöckli；MODIS 2004 年 7 月合成。全球 5400×2700 和 21600×10800 JPEG，Lanczos 缩小为 1K / 2K / 4K / 8K；未改色、裁切、翻转或移动经线。原始产品包含地形阴影，非实时影像。
- **凹凸高程**：NASA Earth Observatory，[Topography Maps](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/topography-bathymetry-maps/)，Jesse Allen / GEBCO；gebco_08_rev_elev_5400x2700.jpg，灰度范围 0–6400 m。缩小为 1K / 2K / 4K PNG，0.7.0 用于离线低精度高程网格（旧版本仅用于光照凹凸）；放大后由公开 Terrarium DEM 细化。保留 [GEBCO 来源与公共领域使用条件](https://www.gebco.net/data-products/gridded-bathymetry-data)。没有将该灰度图当成精密导航 DEM。
- **云层**：NASA Goddard Space Flight Center / Reto Stöckli，[Blue Marble Clouds](https://visibleearth.nasa.gov/images/57747/blue-marble-clouds/77558l)，2002 年发表的历史合成；原始 [cloud_combined_8192.tif](https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif)（8192×4096）生成 4K / 8K 灰度 PNG；[cloud_combined_2048.jpg](https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg) 生成 1K / 2K。均为线性灰度透明度，白色球壳透明度最高 0.28；放大到街区时淡出。高清来源取得于 2026-10-07，原始文件与 SHA-256 保存在 provenance.json。与地表不是同一时期的观测，不用于天气判断。
- **NASA 许可**：[NASA Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)。NASA 图像等内容通常在美国不受版权保护，可作事实性、信息性展示，须署名来源；第三方素材权利及 NASA 标识另行适用。本项目没有使用 NASA 徽标或声称官方背书。
- **国界细线**：[Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/)，公共领域；world-atlas 2.0.2 110m 数据，ISC（完整许可另附）。仅抽取内部边界，生成一个线段网格；属于地理示意，不用于决定记录的国家/地区或界定争议。旧版 earth.png 保留在历史源码，运行时不加载。

地表、高程、云层均为完整等距经纬投影：西 -180° / 东 +180°，上北 +90° / 下南 -90°。0.7.0 使用 Cesium WGS84 椭球、经纬度投影与按需高程网格；云层位于地表上方约 40 km，保持与地表经线对齐，近距离淡出且不拦截选点。地形默认视觉放大 2 倍，地图坐标仍为 WGS84。

## Cesium 与地形（0.7.0）

- CesiumJS 1.146.0，Apache-2.0：[上游仓库](https://github.com/CesiumGS/cesium)。随包提供 `runtime-assets/cesium/LICENSE.md`、`ThirdParty.json` 与 `DEPENDENCY_LICENSES.txt`，保留 Cesium 及实际运行依赖的版权和许可文本。旧 Three.js 相关许可作为历史保留，当前地球渲染由 Cesium 完成，云图解码器仍使用 Three.js 内附 UTIF。
- 细地形：[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)，Mapzen / USGS 与各地区数据机构。Terrarium RGB 存储米制高程，随视野重投影至 Cesium GeographicTilingScheme；不含建筑模型。地形数据多为历史数据，不保证每个区域精度相同，海面以下统一截为 0 m。
- 完整地区来源与许可在源码 `assets/terrain/ATTRIBUTION.md`，安装包 `runtime-assets/cesium/TERRAIN_CREDITS.md`；地图内同时显示来源链接。取得日、转换方法与校验见源码 `assets/terrain/provenance.json` 和 `assets/terrain/SOURCES.md`。2 倍高度仅用于视觉展示。
