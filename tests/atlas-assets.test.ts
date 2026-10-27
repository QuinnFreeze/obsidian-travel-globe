import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {validateAtlasData, MAP_COLORS} from '../src/map-style.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ATLAS_DIR = resolve(ROOT, 'assets/atlas');

const sha256 = (buffer: Buffer | Uint8Array) => createHash('sha256').update(buffer).digest('hex');

test('离线暗蓝地图契约与预算严格通过 validateAtlasData', async () => {
  const mapPath = resolve(ATLAS_DIR, 'atlas-map.json');
  const content = await readFile(mapPath, 'utf8');
  assert.ok(content.length < 12 * 1024 * 1024, 'atlas-map.json 必须在 12MiB 读取预算内');

  const data = JSON.parse(content);
  const validated = validateAtlasData(data);
  assert.equal(validated.schemaVersion, 1);
  assert.ok(validated.source.name.includes('Natural Earth'));
  assert.ok(validated.source.version.includes('v5.1.2'));
  assert.ok(validated.source.url.startsWith('https://'));

  let totalCoords = 0;
  for (const lod of ['low', 'standard', 'high'] as const) {
    const lines = validated.borders[lod];
    assert.ok(lines.length > 0 && lines.length <= 8000, `${lod} LOD 线段数必须在 1..8000 内`);
    const lineIds = new Set<string>();
    for (const line of lines) {
      assert.ok(!lineIds.has(line.id), `ID 必须在 ${lod} 层级内唯一: ${line.id}`);
      lineIds.add(line.id);
      assert.ok(['normal', 'disputed', 'indeterminate'].includes(line.classification));
      assert.ok(typeof line.sourceClass === 'string' && line.sourceClass.length <= 200);
      assert.ok(line.coordinates.length >= 2 && line.coordinates.length <= 50000);
      for (const [lon, lat] of line.coordinates) {
        assert.ok(lon >= -180 && lon <= 180, `经度超出范围: ${lon}`);
        assert.ok(lat >= -90 && lat <= 90, `纬度超出范围: ${lat}`);
      }
      totalCoords += line.coordinates.length;
    }
  }
  assert.ok(totalCoords <= 500000, `国界总坐标数 (${totalCoords}) 必须 <= 500000`);

  // 检查标注
  assert.ok(validated.labels.length > 0 && validated.labels.length <= 600, '国家标注数量必须 <= 600');
  const labelIds = new Set<string>();
  for (const label of validated.labels) {
    assert.ok(!labelIds.has(label.id), `国家标注 ID 必须唯一: ${label.id}`);
    labelIds.add(label.id);
    assert.ok(label.name.length > 0 && label.name.length <= 160);
    if (label.nameZh) assert.ok(label.nameZh.length > 0 && label.nameZh.length <= 160);
    assert.ok(label.position[0] >= -180 && label.position[0] <= 180);
    assert.ok(label.position[1] >= -90 && label.position[1] <= 90);
    assert.ok(label.rank >= 0 && label.rank <= 100);
  }

  // 检查中国等重点国家标注及国界分类
  const chn = validated.labels.find(l => l.id === 'CHN');
  assert.ok(chn, '必须包含中国标注 (CHN)');
  assert.equal(chn?.nameZh, '中华人民共和国');
  assert.ok(Math.abs(chn!.position[0] - 106.337) < 1);
  assert.ok(Math.abs(chn!.position[1] - 32.498) < 1);

  // 检查国界分类存在性 (不能一律判为 disputed)
  const highLines = validated.borders.high;
  const normals = highLines.filter(l => l.classification === 'normal');
  const disputeds = highLines.filter(l => l.classification === 'disputed');
  const indeterminates = highLines.filter(l => l.classification === 'indeterminate');
  assert.ok(normals.length > 200, '必须保留大量正常国界线');
  assert.ok(disputeds.length > 20, '必须保留争议国界线');
  assert.ok(indeterminates.length > 10, '必须保留未定/控制线');
});

test('暗蓝底图纹理尺寸、比例与已知海陆经纬锚点正确', async () => {
  const tiers = [
    {name: 'low', width: 1024, height: 512},
    {name: 'standard', width: 2048, height: 1024},
    {name: 'high', width: 4096, height: 2048},
    {name: '8k', width: 8192, height: 4096}
  ];

  for (const tier of tiers) {
    const file = resolve(ATLAS_DIR, `atlas-surface-${tier.name}.jpg`);
    const buf = await readFile(file);
    const meta = await sharp(buf).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, tier.width);
    assert.equal(meta.height, tier.height);

    const getPixel = async (lat: number, lon: number): Promise<[number, number, number]> => {
      const left = Math.floor((lon + 180) / 360 * tier.width);
      const top = Math.floor((90 - lat) / 180 * tier.height);
      const raw = await sharp(buf).extract({left, top, width: 1, height: 1}).raw().toBuffer();
      return [raw[0], raw[1], raw[2]];
    };

    // 太平洋深海 (0, -140): 应为水体颜色 #263D5D (R~38, G~61, B~93)
    const ocean = await getPixel(0, -140);
    assert.ok(Math.abs(ocean[0] - 0x26) < 10, `Ocean R 偏差过大: ${ocean[0]}`);
    assert.ok(Math.abs(ocean[1] - 0x3d) < 10, `Ocean G 偏差过大: ${ocean[1]}`);
    assert.ok(Math.abs(ocean[2] - 0x5d) < 10, `Ocean B 偏差过大: ${ocean[2]}`);

    // 撒哈拉腹地陆地 (24, 10): 应为陆地颜色 #141827 (R~20, G~24, B~39)
    const sahara = await getPixel(24, 10);
    assert.ok(Math.abs(sahara[0] - 0x14) < 10, `Sahara R 偏差过大: ${sahara[0]}`);
    assert.ok(Math.abs(sahara[1] - 0x18) < 10, `Sahara G 偏差过大: ${sahara[1]}`);
    assert.ok(Math.abs(sahara[2] - 0x27) < 10, `Sahara B 偏差过大: ${sahara[2]}`);

    // 贝加尔湖湖水 (53.5, 108): 应为水体颜色 #263D5D
    const baikal = await getPixel(53.5, 108);
    assert.ok(baikal[2] > baikal[0] && baikal[1] > baikal[0], `Baikal 应呈现水体色彩: ${baikal}`);
  }
});

test('出处记录 provenance.json 字段完整、哈希匹配且不含绝对用户路径', async () => {
  const provPath = resolve(ATLAS_DIR, 'provenance.json');
  const text = await readFile(provPath, 'utf8');

  // 严禁泄露绝对路径
  assert.ok(!text.includes('/Users/'), 'provenance.json 严禁包含开发机绝对路径');
  assert.ok(!text.includes('/home/'), 'provenance.json 严禁包含绝对路径');

  const prov = JSON.parse(text);
  assert.equal(prov.source.version, 'v5.1.2');
  assert.equal(prov.source.commit, 'ca96624a56bd078437bca8184e78163e5039ad19');
  assert.ok(prov.source.license.includes('Public Domain'));

  // 验证 outputs 文件哈希真实性
  for (const out of prov.outputs) {
    const full = resolve(ROOT, out.file);
    const buf = await readFile(full);
    assert.equal(buf.length, out.bytes, `文件大小不一致: ${out.file}`);
    assert.equal(sha256(buf), out.sha256, `文件哈希不一致: ${out.file}`);
  }

  // 验证 assets/atlas 目录下无多余临时巨型文件
  const files = await readdir(ATLAS_DIR);
  assert.ok(!files.some(f => f.endsWith('.geojson') || f.endsWith('.zip') || f.endsWith('.svg')), 'assets/atlas/ 不得遗留原始大文件');
  assert.equal(files.length, 6, 'assets/atlas/ 应仅包含 4 张图片 + atlas-map.json + provenance.json');
});
