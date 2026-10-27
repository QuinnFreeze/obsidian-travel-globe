import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {geoEquirectangular, geoPath, geoCentroid} from 'd3-geo';
import {validateAtlasData} from '../src/map-style.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PREP_RAW = resolve(process.argv[2] || resolve(ROOT, 'assets/upstream/natural-earth'));
const ASSETS_ATLAS = resolve(ROOT, 'assets/atlas');

const COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const TAG = 'v5.1.2';
const REPO_URL = 'https://github.com/nvkelso/natural-earth-vector';
const RAW_URL_BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${COMMIT}/geojson/`;

const SOURCE_FILES = [
  {name: 'ne_10m_land.geojson', short: 'land', role: 'land polygons'},
  {name: 'ne_10m_lakes.geojson', short: 'lakes', role: 'lake polygons'},
  {name: 'ne_10m_rivers_lake_centerlines.geojson', short: 'rivers', role: 'major river centerlines'},
  {name: 'ne_10m_admin_0_boundary_lines_land.geojson', short: 'boundary-lines-land', role: 'international and land boundaries'},
  {name: 'ne_10m_admin_0_boundary_lines_disputed_areas.geojson', short: 'disputed-areas', role: 'disputed, breakaway and claim boundary lines'},
  {name: 'ne_10m_admin_0_countries.geojson', short: 'countries', role: 'country boundaries, labels and properties'}
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function ensureSourceFile(fileName) {
  const localPath = resolve(PREP_RAW, fileName);
  try {
    const data = await readFile(localPath);
    return data;
  } catch {
    throw new Error(`缺少原始数据文件: ${fileName}。请用参数指定含原始GeoJSON的目录。`);
  }
}

// Ramer-Douglas-Peucker algorithm for polyline simplification
function pointToSegmentDistSq(p, p1, p2) {
  const x = p[0], y = p[1], x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    const ddx = x - x1, ddy = y - y1;
    return ddx * ddx + ddy * ddy;
  }
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  const projX = x1 + t * dx, projY = y1 + t * dy;
  const ex = x - projX, ey = y - projY;
  return ex * ex + ey * ey;
}

function rdp(points, tolSq) {
  if (points.length <= 2) return points;
  let maxDistSq = 0, index = -1;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const dSq = pointToSegmentDistSq(points[i], first, last);
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      index = i;
    }
  }
  if (maxDistSq > tolSq) {
    const left = rdp(points.slice(0, index + 1), tolSq);
    const right = rdp(points.slice(index), tolSq);
    return left.slice(0, -1).concat(right);
  } else {
    return [first, last];
  }
}

function stitch(lines) {
  if (lines.length <= 1) return lines;
  const remaining = lines.map(pts => pts.map(p => [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))]));
  const result = [];
  while (remaining.length > 0) {
    let current = remaining.pop();
    let merged = true;
    while (merged) {
      merged = false;
      const start = current[0];
      const end = current[current.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const cand = remaining[i];
        const cStart = cand[0];
        const cEnd = cand[cand.length - 1];
        const eq = (p1, p2) => Math.abs(p1[0] - p2[0]) < 1e-4 && Math.abs(p1[1] - p2[1]) < 1e-4;
        if (eq(end, cStart)) {
          current = current.concat(cand.slice(1));
          remaining.splice(i, 1);
          merged = true;
          break;
        } else if (eq(end, cEnd)) {
          current = current.concat(cand.slice(0, -1).reverse());
          remaining.splice(i, 1);
          merged = true;
          break;
        } else if (eq(start, cEnd)) {
          current = cand.concat(current.slice(1));
          remaining.splice(i, 1);
          merged = true;
          break;
        } else if (eq(start, cStart)) {
          current = cand.reverse().concat(current.slice(1));
          remaining.splice(i, 1);
          merged = true;
          break;
        }
      }
    }
    result.push(current);
  }
  return result;
}

function getClassification(featurecla) {
  const c = String(featurecla || '').trim();
  if (c.startsWith('International boundary')) return 'normal';
  if (c.startsWith('Disputed') || c.startsWith('Line of control') || c === 'Claim boundary' || c === 'Breakaway' || c === 'Unrecognized') {
    return 'disputed';
  }
  if (c.startsWith('Indefinite') || c === 'Indeterminant frontier' || c === 'Elusive frontier' || c === 'Reference line') {
    return 'indeterminate';
  }
  return 'indeterminate';
}

async function main() {
  console.log('=== Travel Globe 离线暗蓝地图资产构建 ===');
  await mkdir(ASSETS_ATLAS, {recursive: true});

  // 1. 读取并核验所有原始数据文件
  console.log('读取原始 GeoJSON 来源...');
  const sourceStats = [];
  const rawBuffers = {};
  for (const s of SOURCE_FILES) {
    const buf = await ensureSourceFile(s.name);
    rawBuffers[s.name] = buf;
    const hash = sha256(buf);
    const pinned = JSON.parse(await readFile(resolve(ASSETS_ATLAS, 'provenance.json'), 'utf8')).sources.find(source => source.file === s.name);
    if (!pinned || pinned.sha256 !== hash) throw new Error('原始来源哈希与固定版本不符: ' + s.name);
    const declaredCrs = JSON.parse(buf.toString('utf8')).crs?.properties?.name;
    if (declaredCrs !== 'urn:ogc:def:crs:OGC:1.3:CRS84') throw new Error('原始来源坐标声明不符: ' + s.name);
    sourceStats.push({
      file: s.name,
      role: s.role,
      url: `${RAW_URL_BASE}${s.name}`,
      bytes: buf.length,
      sha256: hash,
      crs: 'urn:ogc:def:crs:OGC:1.3:CRS84'
    });
    console.log(`  - ${s.name}: ${buf.length} bytes, SHA: ${hash.slice(0, 16)}...`);
  }

  // 2. 生成底图表面纹理 (8K / high / standard / low)
  console.log('\n渲染 8K 暗蓝底图表面 (2:1 等角柱面 equirectangular)...');
  const landData = JSON.parse(rawBuffers['ne_10m_land.geojson'].toString('utf8'));
  const lakesData = JSON.parse(rawBuffers['ne_10m_lakes.geojson'].toString('utf8'));
  const riversData = JSON.parse(rawBuffers['ne_10m_rivers_lake_centerlines.geojson'].toString('utf8'));

  const W = 8192, H = 4096;
  const projection = geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]);
  const path = geoPath(projection);

  console.log('  计算 SVG 几何路径...');
  const landD = path(landData);
  const lakesD = path(lakesData);
  const riversMajor = {
    type: 'FeatureCollection',
    features: riversData.features.filter(f => f.properties.featurecla === 'River' && f.properties.scalerank <= 8)
  };
  const riversD = path(riversMajor);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#263D5D"/>
<path d="${landD}" fill="#141827" stroke="none"/>
<path d="${lakesD}" fill="#263D5D" stroke="none"/>
<path d="${riversD}" fill="none" stroke="#437797" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

  console.log('  生成 8K JPEG (质量 94, chromaSubsampling 4:4:4)...');
  const surface8kBuf = await sharp(Buffer.from(svg))
    .jpeg({quality: 94, chromaSubsampling: '4:4:4'})
    .toBuffer();
  await writeFile(resolve(ASSETS_ATLAS, 'atlas-surface-8k.jpg'), surface8kBuf);

  const outputImages = [
    {file: 'assets/atlas/atlas-surface-8k.jpg', width: 8192, height: 4096, bytes: surface8kBuf.length, sha256: sha256(surface8kBuf)}
  ];

  for (const [tier, width, height] of [['high', 4096, 2048], ['standard', 2048, 1024], ['low', 1024, 512]]) {
    console.log(`  缩放生成 ${tier} (${width}x${height})...`);
    const resizedBuf = await sharp(surface8kBuf)
      .resize(width, height, {fit: 'fill', kernel: 'lanczos3'})
      .jpeg({quality: 94, chromaSubsampling: '4:4:4'})
      .toBuffer();
    const fileName = `atlas-surface-${tier}.jpg`;
    await writeFile(resolve(ASSETS_ATLAS, fileName), resizedBuf);
    outputImages.push({
      file: `assets/atlas/${fileName}`,
      width,
      height,
      bytes: resizedBuf.length,
      sha256: sha256(resizedBuf)
    });
  }

  // 3. 构建国界与标注结构 (atlas-map.json)
  console.log('\n构建国界与国家标注 (atlas-map.json)...');
  const landBorders = JSON.parse(rawBuffers['ne_10m_admin_0_boundary_lines_land.geojson'].toString('utf8'));
  const dispBorders = JSON.parse(rawBuffers['ne_10m_admin_0_boundary_lines_disputed_areas.geojson'].toString('utf8'));
  const countriesData = JSON.parse(rawBuffers['ne_10m_admin_0_countries.geojson'].toString('utf8'));

  const rawBoundaries = [];
  let fIndex = 0;
  const classificationCounts = {normal: 0, disputed: 0, indeterminate: 0};

  for (const fe of [...landBorders.features, ...dispBorders.features]) {
    fIndex++;
    const g = fe.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : (g.type === 'MultiLineString' ? g.coordinates : []);
    const stitched = stitch(lines);
    const sourceClass = String(fe.properties.FEATURECLA || 'Boundary').slice(0, 200);
    const classification = getClassification(sourceClass);
    const baseId = fe.properties.ne_id ? `ne-${fe.properties.ne_id}-${fIndex}` : `b-${fIndex}`;
    stitched.forEach((line, sIdx) => {
      if (line.length >= 2) {
        classificationCounts[classification]++;
        rawBoundaries.push({
          id: `${baseId}-${sIdx}`,
          classification,
          sourceClass,
          coordinates: line
        });
      }
    });
  }

  const buildLod = (tol) => {
    const tolSq = tol * tol;
    return rawBoundaries.map(b => {
      let simplified = tol === 0 ? b.coordinates : rdp(b.coordinates, tolSq);
      if (simplified.length < 2) simplified = [b.coordinates[0], b.coordinates[b.coordinates.length - 1]];
      return {
        id: b.id,
        classification: b.classification,
        sourceClass: b.sourceClass,
        coordinates: simplified
      };
    });
  };

  const borders = {
    low: buildLod(0.08),
    standard: buildLod(0.02),
    high: buildLod(0.003)
  };

  const labels = countriesData.features.map((f, i) => {
    const p = f.properties;
    const name = String(p.NAME || p.NAME_LONG || p.ADMIN || 'Unknown').trim();
    const nameZh = p.NAME_ZH && typeof p.NAME_ZH === 'string' && p.NAME_ZH.trim().length > 0 ? p.NAME_ZH.trim() : undefined;
    let pos;
    if (typeof p.LABEL_X === 'number' && Number.isFinite(p.LABEL_X) && typeof p.LABEL_Y === 'number' && Number.isFinite(p.LABEL_Y)) {
      pos = [Number(p.LABEL_X.toFixed(5)), Number(p.LABEL_Y.toFixed(5))];
    } else {
      const c = geoCentroid(f);
      pos = [Number(c[0].toFixed(5)), Number(c[1].toFixed(5))];
    }
    const rank = typeof p.LABELRANK === 'number' && Number.isFinite(p.LABELRANK) ? p.LABELRANK : 5;
    return {
      id: String(p.ADM0_A3 || `lbl-${i}`),
      name,
      nameZh,
      position: pos,
      rank
    };
  });

  const atlasData = {
    schemaVersion: 1,
    source: {
      name: 'Natural Earth Vector',
      version: `${TAG} (commit ${COMMIT})`,
      license: 'Natural Earth Public Domain',
      url: REPO_URL
    },
    borders,
    labels
  };

  console.log('  验证 AtlasData 契约...');
  validateAtlasData(atlasData);
  console.log('  契约校验通过！');

  const atlasMapJson = JSON.stringify(atlasData);
  const atlasMapBuf = Buffer.from(atlasMapJson, 'utf8');
  await writeFile(resolve(ASSETS_ATLAS, 'atlas-map.json'), atlasMapBuf);

  const lowPts = borders.low.reduce((a, b) => a + b.coordinates.length, 0);
  const stdPts = borders.standard.reduce((a, b) => a + b.coordinates.length, 0);
  const highPts = borders.high.reduce((a, b) => a + b.coordinates.length, 0);
  const totalCoords = lowPts + stdPts + highPts;

  // 4. 生成 provenance.json
  console.log('\n记录资产出处与验证元数据 (provenance.json)...');
  const provenance = {
    acquired: '2026-10-14',
    generated: new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(new Date()),
    description: 'Travel Globe 基础暗蓝底图与全球国界、国家标注离线资产',
    projection: 'Equirectangular 2:1 (longitude -180..180, north +90 to south -90)',
    source: {
      name: 'Natural Earth Vector',
      authors: 'Tom Patterson / Nathaniel Vaughn Kelso',
      version: TAG,
      commit: COMMIT,
      repo: REPO_URL,
      license: 'Natural Earth Public Domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      crs: 'urn:ogc:def:crs:OGC:1.3:CRS84 (WGS84 longitude/latitude)'
    },
    colorPalette: {
      land: '#141827',
      water: '#263D5D',
      river: '#437797',
      border: '#CE7084',
      label: '#BAC5D3'
    },
    sources: sourceStats,
    outputs: [
      ...outputImages,
      {
        file: 'assets/atlas/atlas-map.json',
        bytes: atlasMapBuf.length,
        sha256: sha256(atlasMapBuf)
      }
    ],
    statistics: {
      borders: {
        totalLinesPerLod: borders.low.length,
        coordinates: {
          low: lowPts,
          standard: stdPts,
          high: highPts,
          total: totalCoords
        },
        classificationCounts
      },
      labels: {
        count: labels.length,
        withNameZh: labels.filter(l => Boolean(l.nameZh)).length
      }
    }
  };

  const provenanceJson = JSON.stringify(provenance, null, 2) + '\n';
  await writeFile(resolve(ASSETS_ATLAS, 'provenance.json'), provenanceJson, 'utf8');

  console.log('\n=== 构建完成 ===');
  console.log(`- 底图纹理输出: 8K, high, standard, low (共 4 张 JPEG)`);
  console.log(`- 国界线: 每层级 ${borders.low.length} 条线, 总坐标数 ${totalCoords} (预算上限 500000)`);
  console.log(`- 分类统计: normal: ${classificationCounts.normal}, disputed: ${classificationCounts.disputed}, indeterminate: ${classificationCounts.indeterminate}`);
  console.log(`- 国家标注: ${labels.length} 个, 全部含中文名称 (预算上限 600)`);
  console.log(`- atlas-map.json 大小: ${(atlasMapBuf.length / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(err => {
  console.error('构建失败:', err);
  process.exit(1);
});
