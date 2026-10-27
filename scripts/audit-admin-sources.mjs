import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const levels = ['ADM0', 'ADM1', 'ADM2', 'ADM3', 'ADM4', 'ADM5'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function summarizeMetadata(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('元数据必须为非空列表。');
  const countries = new Map(), licenses = new Map(), keys = new Map(), issues = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !/^[A-Z]{3}$/.test(row.boundaryISO) ||
        !levels.includes(row.boundaryType) || typeof row.boundaryID !== 'string' ||
        typeof row.boundaryLicense !== 'string' || !row.boundaryLicense.trim() ||
        !/^\d+$/.test(row.admUnitCount) || Number(row.admUnitCount) <= 0) {
      throw new Error('行政层元数据格式、许可或数量不符。');
    }
    const key = row.boundaryISO + ':' + row.boundaryType;
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(row);
    if (!row.boundaryID.startsWith(row.boundaryISO + '-' + row.boundaryType + '-')) {
      issues.push({问题: '来源ID与ISO/行政级不一致', 来源ID: row.boundaryID, 国家代码: row.boundaryISO, 行政级: row.boundaryType});
    }
    if (!countries.has(row.boundaryISO)) countries.set(row.boundaryISO, []);
    countries.get(row.boundaryISO).push({
      来源ID: row.boundaryID, 行政级: row.boundaryType, 实际行政名称: row.boundaryCanonical,
      表示年份: row.boundaryYearRepresented, 行政单位登记数: Number(row.admUnitCount),
      原始许可: row.boundaryLicense, 上游来源: row.boundarySource,
      数据整合日期: row.sourceDataUpdateDate, 构建日期: row.buildDate,
      已确认全部市域: false,
    });
    licenses.set(row.boundaryLicense, (licenses.get(row.boundaryLicense) || 0) + 1);
  }
  for (const [key, entries] of keys) {
    if (entries.length > 1) issues.push({问题: '同国家行政级存在多条记录，不能静默选一条', 键: key, 来源ID: entries.map(row => row.boundaryID)});
  }
  return {
    元数据记录数: rows.length,
    元数据国家或地区代码数: countries.size,
    行政级统计: levels.map(level => ({行政级: level, 记录数: rows.filter(row => row.boundaryType === level).length, 国家代码数: new Set(rows.filter(row => row.boundaryType === level).map(row => row.boundaryISO)).size})),
    许可证原始字符串分布: [...licenses].sort(([a], [b]) => compare(a, b)).map(([name, count]) => ({原始许可: name, 记录数: count})),
    异常: issues,
    国家或地区: [...countries].sort(([a], [b]) => compare(a, b)).map(([code, entries]) => ({代码: code, 已列行政级: [...new Set(entries.map(row => row.行政级))].sort(compare), 行政层: entries, 城市边界覆盖率: null, 城市参照名录: null})),
  };
}

export function inspectGeometry(collection, country, level, metadata) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features) || !collection.features.length) {
    throw new Error('几何必须为非空FeatureCollection。');
  }
  const rows = metadata.filter(row => row.boundaryISO === country && row.boundaryType === level);
  const counts = {Polygon: 0, MultiPolygon: 0, 面片数: 0, 环数: 0, 孔洞数: 0, 坐标数: 0, 日期线长边数: 0};
  const errors = [], ids = new Set();
  for (const feature of collection.features) {
    const props = feature?.properties || {}, id = props.shapeID;
    if (typeof id !== 'string' || !id || ids.has(id)) errors.push({问题: 'shapeID缺失或重复', 要素ID: id || null});
    ids.add(id);
    if (props.shapeGroup !== country || props.shapeType !== level) errors.push({问题: '要素国家/行政级不符', 要素ID: id});
    const geometry = feature?.geometry, type = geometry?.type;
    if (type !== 'Polygon' && type !== 'MultiPolygon') {errors.push({问题: '几何非行政面', 要素ID: id}); continue;}
    counts[type]++;
    const polygons = type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length) {errors.push({问题: '空几何', 要素ID: id}); continue;}
    for (const polygon of polygons) {
      counts.面片数++;
      if (!Array.isArray(polygon) || !polygon.length) {errors.push({问题: '空面片', 要素ID: id}); continue;}
      for (const [index, ring] of polygon.entries()) {
        counts.环数++; if (index) counts.孔洞数++;
        if (!Array.isArray(ring) || ring.length < 4) {errors.push({问题: '环坐标不足', 要素ID: id}); continue;}
        if (JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) errors.push({问题: '环未闭合', 要素ID: id});
        for (const point of ring) {
          counts.坐标数++;
          if (!Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
            errors.push({问题: '坐标格式/经纬范围不符', 要素ID: id});
          }
        }
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1], b = ring[i];
          if (Array.isArray(a) && Array.isArray(b) && Math.abs(a[0] - b[0]) > 180) counts.日期线长边数++;
        }
      }
    }
  }
  const declared = rows.length === 1 ? Number(rows[0].admUnitCount) : null;
  return {
    国家代码: country, 行政级: level, 元数据记录数: rows.length,
    实际行政名称: rows.length === 1 ? rows[0].boundaryCanonical : null,
    元数据登记要素数: declared, 实际要素数: collection.features.length,
    数量一致: declared === null ? null : declared === collection.features.length,
    文件CRS声明: collection.crs?.properties?.name || null,
    CRS独立核验: '未执行；文件声明和合法数值范围不证明实际基准正确。',
    原始许可: rows.length === 1 ? rows[0].boundaryLicense : null,
    统计: counts, 结构错误数: errors.length, 结构错误: errors,
    已执行: ['逐要素ID/国家/行政级', 'Polygon/MultiPolygon、环长与闭合', '全部坐标数值及经纬范围', '实际要素数与元数据比对'],
    未执行: ['自相交、孔洞实际位置和相邻面拓扑', '城市官方名录逐项匹配、现行行政准确性', '上游许可全文及衍生包分发审查', '地形贴合、WebGL和设备性能'],
    已确认完整市域: false,
  };
}

export async function auditSources(metadataPath, sampleManifestPath, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw new Error('核验日期不符。');
  const metaBytes = await readFile(metadataPath), rows = JSON.parse(metaBytes.toString('utf8'));
  const summary = summarizeMetadata(rows);
  const manifest = JSON.parse(await readFile(sampleManifestPath, 'utf8'));
  if (!Array.isArray(manifest) || !manifest.length) throw new Error('样本清单为空。');
  const samples = [];
  for (const item of manifest) {
    const file = resolve(dirname(sampleManifestPath), item.原始文件);
    const bytes = await readFile(file);
    if (sha(bytes) !== item.SHA256) throw new Error('样本哈希不符：' + item.国家代码);
    samples.push({...inspectGeometry(JSON.parse(bytes.toString('utf8')), item.国家代码, item.行政级, rows), 来源: item.来源, 原始文件: item.原始文件, 字节数: bytes.length, SHA256: sha(bytes)});
  }
  return {
    标题: '行政区元数据与完整几何样本核验', 格式版本: 1, 核验日期: date,
    核验范围: '完整读取本次ALL/ALL元数据响应与所列五个国家行政层样本，非全球全部城市数据库。',
    闸门: {状态: '未通过（未证明）', 允许完整功能实施: false, 全球城市覆盖率: null, 原因: ['国家/行政层不等于城市名录与市域', '元数据重复、ID和样本数量异常需处理', '全球城市口径、名录与实际市域尚未逐项核验']},
    元数据原始文件: {来源: 'user-supplied metadata', 字节数: metaBytes.length, SHA256: sha(metaBytes)},
    元数据: summary,
    几何样本: samples,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [metadata, manifest, output, suppliedDate] = process.argv.slice(2);
  if (!metadata || !manifest || !output) throw new Error('用法：node scripts/audit-admin-sources.mjs <metadata.json> <samples.json> <output.json> [YYYY-MM-DD]');
  const date = suppliedDate || new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(new Date());
  const result = await auditSources(resolve(metadata), resolve(manifest), date);
  await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({输出: output, 闸门: result.闸门}, null, 2));
}
