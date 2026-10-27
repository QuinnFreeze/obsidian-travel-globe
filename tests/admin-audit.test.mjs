import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeLocalData} from '../scripts/audit-admin-data.mjs';

const cities = [
  ['1', '武汉', 'CN', '12', 30.6, 114.3, 'Wuhan|武汉'],
  ['2', '广州', 'CN', '30', 23.1, 113.3, 'Guangzhou|广州'],
  ['3', '巴黎', 'FR', '11', 48.8, 2.3, 'Paris|巴黎'],
];
const borders = [[[113, 23], [114, 24]]];
const provenance = {cities: 3, source: 'https://example.invalid/cities15000.zip', generatedDate: '2026-10-06', worldAtlasVersion: '2.0.2'};
const audit = (rows = cities, lines = borders, meta = provenance) => summarizeLocalData(rows, lines, meta, '2026-10-12');

test('地名点只构成待核验清单，不能证明行政城市覆盖', () => {
  const result = audit();
  assert.equal(result.本地数据.地名点条目数, 3);
  assert.equal(result.本地数据.地名国家或地区代码数, 2);
  assert.equal(result.闸门.允许完整功能实施, false);
  assert.equal(result.闸门.全球城市覆盖率, null);
  assert.equal(result.国家或地区.find(row => row.代码 === 'CN').本地点条目数, 2);
  assert.ok(result.国家或地区.every(row => row.城市边界覆盖率 === null && row.城市参照名录 === null && !row.城市行政多边形已读取));
});

test('点数量增加、同名异地或粗国界存在不会打开实施闸门', () => {
  const more = [...cities, ['4', '巴黎', 'US', 'TX', 33.6, -95.6, 'Paris']];
  const result = audit(more, borders, {...provenance, cities: 4});
  assert.equal(result.本地数据.地名国家或地区代码数, 3);
  assert.equal(result.本地数据.国界折线数, 1);
  assert.equal(result.闸门.允许完整功能实施, false);
});

test('拒绝空目录及错误的来源条目数', () => {
  assert.throws(() => audit([]), /地名目录为空/);
  assert.throws(() => audit(cities, borders, {...provenance, cities: 30}), /溯源记录/);
});

test('拒绝地名坏坐标、非法国家代码和重复来源ID', () => {
  assert.throws(() => audit([['1', '无效', 'CN', '', 91, 114, '']]), /经纬度/);
  assert.throws(() => audit([['1', '无效', 'CHN', '', 30, 114, '']]), /国家代码/);
  assert.throws(() => audit([cities[0], cities[0]]), /重复来源 ID/);
});

test('拒绝把面、坏坐标或空折线当作已核对的国界数据', () => {
  assert.throws(() => audit(cities, {type: 'Polygon', coordinates: []}), /国界折线/);
  assert.throws(() => audit(cities, [[[181, 0], [0, 0]]]), /国界折线/);
  assert.throws(() => audit(cities, [[]]), /国界折线/);
});

test('重复核验可复现，且不修改输入数据', () => {
  const before = JSON.stringify({cities, borders, provenance});
  assert.deepEqual(audit(), audit());
  assert.equal(JSON.stringify({cities, borders, provenance}), before);
});

test('拒绝非法或不存在的核验日期', () => {
  assert.throws(() => summarizeLocalData(cities, borders, provenance, 'today'), /核验日期/);
  assert.throws(() => summarizeLocalData(cities, borders, provenance, '2026-02-30'), /核验日期/);
  assert.throws(() => summarizeLocalData(cities, borders, provenance, '2026-13-01'), /核验日期/);
});
