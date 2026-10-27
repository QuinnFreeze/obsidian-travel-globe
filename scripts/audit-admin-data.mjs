import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const validPoint = pair => Array.isArray(pair) && pair.length === 2 &&
  pair.every(Number.isFinite) && Math.abs(pair[0]) <= 180 && Math.abs(pair[1]) <= 90;

export function summarizeLocalData(cities, borders, provenance, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) ||
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
    throw new Error('核验日期须为有效的 YYYY-MM-DD。');
  }
  if (!Array.isArray(cities) || cities.length === 0) throw new Error('地名目录为空或格式不符。');
  const ids = new Set();
  const countries = new Map();
  for (const row of cities) {
    if (!Array.isArray(row) || row.length !== 7 || !/^\d+$/.test(row[0]) ||
        typeof row[1] !== 'string' || !row[1].trim() || !/^[A-Z]{2}$/.test(row[2]) ||
        typeof row[3] !== 'string' || !validPoint([row[5], row[4]]) || typeof row[6] !== 'string') {
      throw new Error('地名记录格式、国家代码或经纬度不符。');
    }
    if (ids.has(row[0])) throw new Error('地名目录含重复来源 ID。');
    ids.add(row[0]);
    let country = countries.get(row[2]);
    if (!country) countries.set(row[2], country = {points: 0, adminCodes: new Set()});
    country.points++;
    if (row[3]) country.adminCodes.add(row[3]);
  }
  if (provenance?.cities !== cities.length || typeof provenance?.source !== 'string') {
    throw new Error('地名溯源记录与本地条目数不一致。');
  }
  if (!Array.isArray(borders) || borders.length === 0 ||
      borders.some(line => !Array.isArray(line) || line.length < 2 || !line.every(validPoint))) {
    throw new Error('现有国界折线坐标格式不符。');
  }
  return {
    标题: '行政区本地核验清单',
    格式版本: 1,
    核验日期: date,
    核验范围: '现有 GeoNames 地名点及粗略国界折线；未纳入全球行政区完整数据。',
    闸门: {
      状态: '未通过（未证明）',
      允许完整功能实施: false,
      全球城市覆盖率: null,
      原因: ['没有经核验的逐国城市参照名录', '没有已读取并逐市核验的城市行政多边形', '详细边界许可和数据版本尚未逐国核验'],
    },
    本地数据: {
      地名点条目数: cities.length,
      地名国家或地区代码数: countries.size,
      地名生成日期: provenance.generatedDate,
      地名原始来源: provenance.source,
      地名原始包登记SHA256: provenance.sourceZipSHA256,
      国界折线数: borders.length,
      国界坐标对数: borders.reduce((sum, line) => sum + line.length, 0),
      国界来源: `world-atlas ${provenance.worldAtlasVersion} / Natural Earth 110m`,
      坐标范围检查: '通过；仅验证数值范围，不代表来源 CRS 或几何语义正确。',
    },
    已执行: ['地名记录格式、坐标范围、来源ID唯一性及登记条目数核对', '现有国界折线格式和坐标范围核对', '按本地地名国家或地区代码生成待核验清单'],
    未执行: ['全球国家或地区名录完整性', '逐国城市行政定义与城市名录', '城市多边形覆盖率、拓扑、精度与来源CRS核验', '详细离线包大小和解析性能', '新图层WebGL、Obsidian和实体手机验收'],
    解释: [
      '地名点条目数不是行政城市数，地名国家代码集合不是全球完整国家或地区清单。',
      '一级行政代码不是城市多边形，也不能把某一固定行政层级等同于全球市级。',
      '所有未知覆盖率保持 null，不把未核验写成 0% 或 100%。',
      '折线只是现有粗略国界绘制数据，不是完整国家或城市行政面。',
    ],
    国家或地区: [...countries].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([code, data]) => ({
      代码: code,
      本地点条目数: data.points,
      本地一级行政代码数: data.adminCodes.size,
      城市行政口径: '待核验',
      城市参照名录: null,
      城市行政多边形已读取: false,
      城市边界覆盖率: null,
      许可核验: '未核验',
      状态: '未通过（未证明）',
    })),
  };
}

export async function auditLocalData(root, date) {
  const files = ['assets/cities.json', 'assets/provenance.json', 'assets/realistic/borders.json'];
  const bytes = await Promise.all(files.map(file => readFile(resolve(root, file))));
  const [cities, provenance, borders] = bytes.map(data => JSON.parse(data.toString('utf8')));
  const result = summarizeLocalData(cities, borders, provenance, date);
  result.输入文件 = files.map((file, i) => ({路径: file, 字节数: bytes[i].length, SHA256: createHash('sha256').update(bytes[i]).digest('hex')}));
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const date = process.argv[2] || new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(new Date());
  const output = resolve(root, 'docs/行政区核验清单.json');
  const result = await auditLocalData(root, date);
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({输出: 'docs/行政区核验清单.json', 地名点: result.本地数据.地名点条目数, 国家或地区代码: result.本地数据.地名国家或地区代码数, 国界折线: result.本地数据.国界折线数, 闸门: result.闸门}, null, 2));
}
