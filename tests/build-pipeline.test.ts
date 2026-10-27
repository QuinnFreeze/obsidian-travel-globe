import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyReleaseInventory,
  collectSourceFiles,
  verifyBuildReceipt,
  ESSENTIAL_RELEASE_ASSETS,
  FORBIDDEN_RELEASE_FILES
} from '../scripts/build-helper.mjs';

test('verifyReleaseInventory catches missing Cesium or core assets', () => {
  // Pass with full essential list plus mock cesium assets
  const validFiles = [
    ...ESSENTIAL_RELEASE_ASSETS,
    ...Array.from({length: 120}, (_, i) => `runtime-assets/cesium/Assets/file-${i}.json`),
    ...Array.from({length: 50}, (_, i) => `runtime-assets/cesium/Workers/worker-${i}.js`),
    ...Array.from({length: 5}, (_, i) => `runtime-assets/cesium/ThirdParty/lib-${i}.js`)
  ];
  assert.equal(verifyReleaseInventory(validFiles), true);

  // Fails if essential asset is missing
  const missingCesiumHeights = validFiles.filter(f => f !== 'runtime-assets/cesium/Assets/approximateTerrainHeights.json');
  assert.throws(() => verifyReleaseInventory(missingCesiumHeights), /缺少核心必要资产/);

  // Fails if cities.json is missing
  const missingCities = validFiles.filter(f => f !== 'runtime-assets/cities.json');
  assert.throws(() => verifyReleaseInventory(missingCities), /缺少核心必要资产/);

  // Fails if Cesium Workers tree is incomplete (retains essential workers but total < 40)
  const tooFewWorkers = validFiles.filter(f => !f.startsWith('runtime-assets/cesium/Workers/worker-'));
  assert.throws(() => verifyReleaseInventory(tooFewWorkers), /Cesium Workers 脚本不完整/);
});

test('verifyReleaseInventory catches forbidden external scripts', () => {
  const validFiles = [
    ...ESSENTIAL_RELEASE_ASSETS,
    ...Array.from({length: 120}, (_, i) => `runtime-assets/cesium/Assets/file-${i}.json`),
    ...Array.from({length: 50}, (_, i) => `runtime-assets/cesium/Workers/worker-${i}.js`),
    ...Array.from({length: 5}, (_, i) => `runtime-assets/cesium/ThirdParty/lib-${i}.js`)
  ];

  for (const forbidden of FORBIDDEN_RELEASE_FILES) {
    const contaminated = [...validFiles, forbidden];
    assert.throws(() => verifyReleaseInventory(contaminated), /严禁包含外置可执行脚本/);
  }
});

test('collectSourceFiles enforces strict allowlist', async () => {
  const sources = await collectSourceFiles();
  assert.ok(sources.length > 50);

  // Verify none of the source files violate security rules
  for (const file of sources) {
    assert.equal(file.startsWith('.env'), false, `.env 文件严禁打入源码包: ${file}`);
    assert.equal(file.includes('/.env'), false, `.env 文件严禁打入源码包: ${file}`);
    assert.equal(file.endsWith('.tmp'), false, `临时文件严禁打入源码包: ${file}`);
    assert.equal(file.startsWith('node_modules'), false, `依赖目录严禁打入源码包: ${file}`);
    assert.equal(file.startsWith('.build'), false, `构建目录严禁打入源码包: ${file}`);
    assert.equal(file.startsWith('dist'), false, `发布目录严禁打入源码包: ${file}`);
  }

  // Verify critical project files are included
  assert.ok(sources.includes('manifest.json'));
  assert.ok(sources.includes('package.json'));
  assert.ok(sources.includes('src/main.ts'));
  assert.ok(sources.includes('src/renderer-loader.ts'));
});
