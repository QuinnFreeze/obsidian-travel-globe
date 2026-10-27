# 立体地形来源

- 渲染引擎：[CesiumJS 1.146.0](https://github.com/CesiumGS/cesium)，Apache-2.0。引擎与 Workers / Assets / ThirdParty 打包在插件内，无需 CDN 或 Cesium ion。
- 全球离线粗略高程：现有 NASA / GEBCO 灰度图，以 0–6400 米解释，仅作粗略地形后备，不是精密 DEM。
- 区域精细高程：[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)，[Terrarium 格式](https://github.com/tilezen/joerd/blob/master/docs/formats.md)。PNG 的 RGB 原始数值解码为米：R×256+G+B/256−32768；不做颜色管理或翻转，经纬度转换采用 Web Mercator。
- 公共源：https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png 。各区域精度、来源和取得时间不同，属于历史 DEM，不是实时测量。负高程按海平面显示。
- 完整数据署名与许可说明保存在 [ATTRIBUTION.md](ATTRIBUTION.md)，取得于 2026-10-07。珠峰区域响应标明来源 SRTM / GMTED，Last-Modified 为 2017 年。
- 采用 Cesium 地形分块 / 视距细化，65×65 高程采样；地形默认 2 倍视觉起伏。没有加入虚构山体或建筑。原始高程保持米单位，夸张只在场景渲染中应用。
- 高程 PNG 按浏览范围下载到仓库「地球资源/地形高程」，最多 4 个网络请求、64 MiB，30 天后台复查；关闭「联网更新地球底图」时只读本地。缺失时继续使用 NASA 粗略地形，不保证未缓存区域离线时有精细地形。
