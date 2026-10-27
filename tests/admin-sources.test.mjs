import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeMetadata, inspectGeometry} from '../scripts/audit-admin-sources.mjs';

const row = (changes = {}) => ({boundaryISO: 'USA', boundaryType: 'ADM2', boundaryID: 'USA-ADM2-123', boundaryLicense: 'Public Domain', boundaryCanonical: 'Counties', admUnitCount: '1', ...changes});
const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
const feature = (changes = {}) => ({type: 'Feature', properties: {shapeID: 'a', shapeGroup: 'USA', shapeType: 'ADM2'}, geometry: {type: 'Polygon', coordinates: [ring]}, ...changes});
const collection = features => ({type: 'FeatureCollection', crs: {properties: {name: 'urn:ogc:def:crs:OGC:1.3:CRS84'}}, features});
const inspect = (features, rows = [row()]) => inspectGeometry(collection(features), 'USA', 'ADM2', rows);

test('元数据全部取得也不能证明城市覆盖', () => {
  const summary = summarizeMetadata([row()]);
  assert.equal(summary.元数据记录数, 1);
  assert.equal(summary.国家或地区[0].城市边界覆盖率, null);
  assert.equal(summary.国家或地区[0].行政层[0].已确认全部市域, false);
});

test('区分记录数与国家级数量并保留所有原始许可', () => {
  const summary = summarizeMetadata([row(), row({boundaryID: 'USA-ADM2-999', boundaryLicense: 'ODbL'})]);
  assert.equal(summary.行政级统计.find(x => x.行政级 === 'ADM2').记录数, 2);
  assert.equal(summary.行政级统计.find(x => x.行政级 === 'ADM2').国家代码数, 1);
  assert.equal(summary.许可证原始字符串分布.length, 2);
  assert.equal(summary.异常.length, 1);
});

test('来源ID前缀与行政级不一致被记录而非默默修正', () => {
  const summary = summarizeMetadata([row({boundaryID: 'USA-ADM0-123'})]);
  assert.equal(summary.异常[0].问题, '来源ID与ISO/行政级不一致');
  assert.equal(summary.国家或地区[0].行政层[0].来源ID, 'USA-ADM0-123');
});

test('拒绝空、无许可、非法行政级和非整数数量的元数据', () => {
  for (const value of [[], [row({boundaryLicense: ''})], [row({boundaryType: 'city'})], [row({admUnitCount: '1.5'})]]) {
    assert.throws(() => summarizeMetadata(value));
  }
});

test('面结构和数量通过不等于真实市域或CRS已独立核验', () => {
  const result = inspect([feature()]);
  assert.equal(result.结构错误数, 0);
  assert.equal(result.数量一致, true);
  assert.equal(result.已确认完整市域, false);
  assert.match(result.CRS独立核验, /未执行/);
});

test('实际数量不一致单独报告，重复元数据不强选一条', () => {
  assert.equal(inspect([feature()], [row({admUnitCount: '2'})]).数量一致, false);
  const ambiguous = inspect([feature()], [row(), row({boundaryID: 'USA-ADM2-456'})]);
  assert.equal(ambiguous.元数据登记要素数, null);
  assert.equal(ambiguous.数量一致, null);
});

test('拒绝点要素和错误国家或行政级，查出重复ID', () => {
  assert.ok(inspect([feature({geometry: {type: 'Point', coordinates: [0, 0]}})]).结构错误数 > 0);
  assert.ok(inspect([feature({properties: {shapeID: 'a', shapeGroup: 'JPN', shapeType: 'ADM2'}})]).结构错误数 > 0);
  assert.ok(inspect([feature(), feature()]).结构错误.some(error => error.问题 === 'shapeID缺失或重复'));
});

test('坏坐标、短环和未闭合环不作为通过', () => {
  for (const coordinates of [[[[0, 0]]], [[[0, 0], [181, 0], [0, 1], [0, 0]]], [[[0, 0], [1, 0], [0, 1], [2, 2]]]]) {
    assert.ok(inspect([feature({geometry: {type: 'Polygon', coordinates}})]).结构错误数 > 0);
  }
});

test('保留MultiPolygon和孔洞统计，提示日期线长边', () => {
  const result = inspect([feature({geometry: {type: 'MultiPolygon', coordinates: [[ring, ring], [[[179, 0], [-179, 0], [-179, 1], [179, 0]]]]}})]);
  assert.equal(result.统计.MultiPolygon, 1);
  assert.equal(result.统计.孔洞数, 1);
  assert.equal(result.统计.面片数, 2);
  assert.ok(result.统计.日期线长边数 > 0);
});

test('空几何集合拒绝，固定输入可复现且不修改源对象', () => {
  assert.throws(() => inspectGeometry(collection([]), 'USA', 'ADM2', [row()]));
  const features = [feature()], before = JSON.stringify(features);
  assert.deepEqual(inspect(features), inspect(features));
  assert.equal(JSON.stringify(features), before);
});
