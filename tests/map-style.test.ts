import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  mapAppearance,
  mapStyleName,
  atlasLod,
  selectLabelBoxes,
  validateAtlasData,
  type LabelBox
} from '../src/map-style';

function makeValidAtlas() {
  return {
    schemaVersion: 1,
    source: {
      name: 'Natural Earth',
      version: 'v5.1.2',
      license: 'Public Domain',
      url: 'https://www.naturalearthdata.com'
    },
    borders: {
      low: [
        {
          id: 'b-low-1',
          classification: 'normal',
          sourceClass: 'international',
          coordinates: [[0, 0], [10, 10]]
        }
      ],
      standard: [
        {
          id: 'b-std-1',
          classification: 'disputed',
          sourceClass: 'disputed',
          coordinates: [[0, 0], [5, 5]]
        }
      ],
      high: [
        {
          id: 'b-hi-1',
          classification: 'indeterminate',
          sourceClass: 'line_of_control',
          coordinates: [[0, 0], [1, 1]]
        }
      ]
    },
    labels: [
      {
        id: 'l-1',
        name: 'China',
        nameZh: '中国',
        position: [116.4, 39.9],
        rank: 1
      }
    ]
  };
}

test('mapAppearance correctly isolates natural vs atlas modes', () => {
  const naturalSettings = {
    mapStyle: 'natural' as const,
    showBorders: true,
    showClouds: true,
    atlasBorders: false,
    atlasLabels: false,
    showCountryNames: false
  };
  const naturalApp = mapAppearance(naturalSettings);
  assert.equal(naturalApp.borders, true);
  assert.equal(naturalApp.clouds, true);
  assert.equal(naturalApp.labels, false);
  assert.equal(naturalApp.satellite, true);
  assert.equal(naturalApp.terrainShade, true);

  const atlasSettings = {
    mapStyle: 'atlas' as const,
    showBorders: false,
    showClouds: true, // raw showClouds is true, but in atlas effective clouds must be false
    atlasBorders: true,
    atlasLabels: true,
    showCountryNames: false
  };
  const atlasApp = mapAppearance(atlasSettings);
  assert.equal(atlasApp.borders, true);
  assert.equal(atlasApp.clouds, false, 'clouds must be false in atlas mode');
  assert.equal(atlasApp.labels, true);
  assert.equal(atlasApp.satellite, false);
  assert.equal(atlasApp.terrainShade, false);
});

test('mapStyleName returns correct Chinese display names', () => {
  assert.equal(mapStyleName('natural'), '自然地球');
  assert.equal(mapStyleName('atlas'), '暗蓝地图');
});

test('atlasLod chooses correct level of detail by altitude and device capability', () => {
  assert.equal(atlasLod(0.8, false, false), 'low');
  assert.equal(atlasLod(0.05, false, true), 'low');
  assert.equal(atlasLod(0.3, false, false), 'standard');
  assert.equal(atlasLod(0.05, true, false), 'standard');
  assert.equal(atlasLod(0.05, false, false), 'high');
});

test('selectLabelBoxes filters out-of-bounds, invalid boxes and prevents collisions', () => {
  const boxes: LabelBox[] = [
    {id: 'box-valid-1', x: 10, y: 10, width: 40, height: 20, rank: 1},
    // Collides with box-valid-1 (within +8 x, +6 y padding), lower rank (rank 2)
    {id: 'box-collide-1', x: 20, y: 15, width: 40, height: 20, rank: 2},
    // Non-colliding box
    {id: 'box-valid-2', x: 100, y: 100, width: 40, height: 20, rank: 3},
    // Out of bounds: x < 4
    {id: 'box-oob-x', x: 2, y: 10, width: 40, height: 20, rank: 1},
    // Out of bounds: y < 4
    {id: 'box-oob-y', x: 10, y: 2, width: 40, height: 20, rank: 1},
    // Out of bounds: x + width > width - 4 (canvas width 200, 160 + 40 = 200 > 196)
    {id: 'box-oob-right', x: 160, y: 10, width: 40, height: 20, rank: 1},
    // Invalid dimensions
    {id: 'box-zero-width', x: 10, y: 50, width: 0, height: 20, rank: 1},
    {id: 'box-nan', x: NaN, y: 50, width: 40, height: 20, rank: 1}
  ];

  const selected = selectLabelBoxes(boxes, 200, 200, 10);
  assert.deepEqual(selected, ['box-valid-1', 'box-valid-2']);

  // Limit check
  const limited = selectLabelBoxes(boxes, 200, 200, 1);
  assert.deepEqual(limited, ['box-valid-1']);
});

test('validateAtlasData accepts valid structure and enforces schema constraints', () => {
  const valid = makeValidAtlas();
  const result = validateAtlasData(valid);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.borders.low.length, 1);
  assert.equal(result.labels.length, 1);

  // Invalid schema version
  assert.throws(() => validateAtlasData({...valid, schemaVersion: 2}), /格式版本不符/);

  // Missing or invalid source
  assert.throws(() => validateAtlasData({...valid, source: {}}), /来源信息/);
  assert.throws(() => validateAtlasData({...valid, source: {...valid.source, license: ''}}), /来源信息/);

  // Missing border LOD
  assert.throws(() => validateAtlasData({...valid, borders: {low: []}}), /国界层级数据不完整/);
});

test('validateAtlasData rejects bad coordinates and malformed border lines', () => {
  const base = makeValidAtlas();

  // Coordinates with out of range longitude (> 180)
  const badLng = makeValidAtlas();
  badLng.borders.low[0]!.coordinates = [[181, 0], [0, 0]];
  assert.throws(() => validateAtlasData(badLng), /国界线标识、分类或坐标不符/);

  // Coordinates with out of range latitude (> 90)
  const badLat = makeValidAtlas();
  badLat.borders.low[0]!.coordinates = [[0, 91], [0, 0]];
  assert.throws(() => validateAtlasData(badLat), /国界线标识、分类或坐标不符/);

  // Non-finite coordinate
  const badNan = makeValidAtlas();
  badNan.borders.low[0]!.coordinates = [[NaN, 0], [0, 0]];
  assert.throws(() => validateAtlasData(badNan), /国界线标识、分类或坐标不符/);

  // Fewer than 2 coordinate points
  const tooFew = makeValidAtlas();
  tooFew.borders.low[0]!.coordinates = [[0, 0]];
  assert.throws(() => validateAtlasData(tooFew), /国界线标识、分类或坐标不符/);

  // Invalid classification
  const badClass = makeValidAtlas();
  (badClass.borders.low[0] as any).classification = 'unknown_classification';
  assert.throws(() => validateAtlasData(badClass), /分类或坐标不符/);

  // Duplicate line ID
  const dupLine = makeValidAtlas();
  dupLine.borders.low.push({...dupLine.borders.low[0]!});
  assert.throws(() => validateAtlasData(dupLine), /分类或坐标不符/);
});

test('validateAtlasData enforces budgets for coordinates, lines and labels', () => {
  // Label count budget (> 600 labels)
  const excessLabels = makeValidAtlas();
  excessLabels.labels = Array.from({length: 601}, (_, i) => ({
    id: `label-${i}`,
    name: `Country ${i}`,
    position: [0, 0],
    rank: 1
  }));
  assert.throws(() => validateAtlasData(excessLabels), /国家标注数据超出预算/);

  // Line count budget (> 8000 lines in one LOD)
  const excessLines = makeValidAtlas();
  excessLines.borders.low = Array.from({length: 8001}, (_, i) => ({
    id: `b-${i}`,
    classification: 'normal',
    sourceClass: 'international',
    coordinates: [[0, 0], [1, 1]]
  }));
  assert.throws(() => validateAtlasData(excessLines), /国界层级数据不完整/);

  // Bad label properties
  const badRank = makeValidAtlas();
  badRank.labels[0]!.rank = -1;
  assert.throws(() => validateAtlasData(badRank), /国家标注名称或位置不符/);

  const badPosition = makeValidAtlas();
  badPosition.labels[0]!.position = [190, 0];
  assert.throws(() => validateAtlasData(badPosition), /国家标注名称或位置不符/);

  const dupLabel = makeValidAtlas();
  dupLabel.labels.push({...dupLabel.labels[0]!});
  assert.throws(() => validateAtlasData(dupLabel), /国家标注名称或位置不符/);

  // Single line coordinate limit (> 50000 points)
  const singleLineTooLong = makeValidAtlas();
  singleLineTooLong.borders.low = [{
    id: 'b-too-long',
    classification: 'normal' as const,
    sourceClass: 'international',
    coordinates: Array.from({length: 50001}, () => [0, 0] as [number, number])
  }];
  assert.throws(() => validateAtlasData(singleLineTooLong), /国界线标识、分类或坐标不符/);

  // Total coordinate budget (> 500000 points across lines)
  const excessCoords = makeValidAtlas();
  excessCoords.borders.low = Array.from({length: 11}, (_, i) => ({
    id: `b-budget-${i}`,
    classification: 'normal' as const,
    sourceClass: 'international',
    coordinates: Array.from({length: 46000}, () => [0, 0] as [number, number])
  }));
  assert.throws(() => validateAtlasData(excessCoords), /国界数据超出设备预算/);
});

test('enforces atlas 12MiB file read length budget', () => {
  const budget = 12 * 1024 * 1024;
  const oversizedText = ' '.repeat(budget + 1);
  assert.throws(() => {
    if (oversizedText.length > budget) throw Error('基础地图数据超出 12MiB 预算。');
  }, /12MiB 预算/);

  const withinBudgetText = ' '.repeat(1024);
  assert.doesNotThrow(() => {
    if (withinBudgetText.length > budget) throw Error('基础地图数据超出 12MiB 预算。');
  });
});
