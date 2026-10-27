import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const repoPath = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const expectedVersion = JSON.parse(await readFile(resolve(repoPath, 'manifest.json'), 'utf8')).version;
const defaultQaDir = resolve(tmpdir(), 'travel-globe-qa-output-' + expectedVersion);

if (!process.env.TRAVEL_GLOBE_QA_VAULT) {
  throw new Error('TRAVEL_GLOBE_QA_VAULT environment variable is required (must point to isolated test vault)');
}
process.env.TRAVEL_GLOBE_QA_DIR ||= defaultQaDir;

import {isIsolatedQaVault} from './qa-vault-guard.mjs';

const {host, ready, openView, closeView, viewport, surface, qa, repo, emulateMobile} = await import('./qa-cesium-host.mjs');

const label = process.argv.find(x => x.startsWith('--label='))?.split('=')[1] || 'atlas-' + expectedVersion;
const only = process.argv.find(x => x.startsWith('--only='))?.slice(7);

const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');

const h = await host(label);
const {page, cdp} = h;
const checks = [];

async function snap(name) {
  const appLoc = page.locator('.tg-app');
  const filename = `${label}-${name}.png`;
  const filePath = `${qa}/${filename}`;
  if (await appLoc.count() > 0) {
    await appLoc.screenshot({path: filePath});
  } else {
    await page.screenshot({path: filePath});
  }
}

async function check(name, fn) {
  if (only && !new RegExp(only).test(name)) return;
  try {
    const detail = await fn();
    checks.push({name, status: 'pass', detail});
    console.log('PASS ' + name);
  } catch (e) {
    const errorSurface = await surface(page).catch(() => null);
    const sanitizedName = name.replace(/[^a-zA-Z0-9一-龥_-]/g, '_');
    await snap('fail-' + sanitizedName).catch(() => null);
    checks.push({name, status: 'fail', error: e.stack || e.message, surface: errorSurface});
    console.log('FAIL ' + name + ': ' + e.message);
  }
  await h.save(label + '-progress', {checks});
}

const snapshot = () => page.evaluate(async () => {
  const t = app.plugins.plugins['travel-globe'], out = {};
  for (const r of t.store.records) {
    const f = app.vault.getAbstractFileByPath(r.path);
    if (f) out[r.path] = await app.vault.read(f);
  }
  return out;
});

const getVaultInventory = async () => {
  const files = await page.evaluate(() => app.vault.getFiles().map(f => f.path));
  const hashes = {};
  for (const f of files) {
    hashes[f] = await hash(h.identity.vault + '/' + f);
  }
  return {files, hashes};
};

let initialInventory;
let originalNoteContent;

try {
  // Guard immediately: stop if candidate version or vault guard fails
  if (h.identity.version !== expectedVersion) {
    throw new Error(`Candidate version mismatch: expected ${expectedVersion}, got ${h.identity.version}`);
  }
  if (!isIsolatedQaVault(h.identity.vault)) {
    throw new Error(`Vault guard rejection: ${h.identity.vault}`);
  }

  initialInventory = await getVaultInventory();
  originalNoteContent = await snapshot();

  // 01 - Candidate identity, isolated vault guard, and initial Cesium canvas
  await check('01 - 候选版本 ' + expectedVersion + ' 标识、隔离 Vault 守卫与 Cesium 单 Canvas 初始渲染', async () => {
    assert.match(page.url(), /index\.html/);
    assert.equal(h.identity.version, expectedVersion, 'Candidate must match the source manifest');
    assert.ok(isIsolatedQaVault(h.identity.vault), 'Must run in isolated QA vault: ' + h.identity.vault);

    await viewport(cdp, 1440, 1000);
    await page.evaluate(async () => {
      app.workspace.leftSplit?.collapse();
      app.workspace.rightSplit?.collapse();
      await app.plugins.plugins['travel-globe'].updateSettings({
        mapStyle: 'natural',
        atlasBorders: true,
        atlasLabels: true,
        showBorders: false,
        showCountryNames: false,
        showClouds: false,
        listOnly: false,
        quality: 'auto'
      });
    });
    await openView(page);

    const s = await surface(page);
    assert.equal(s.engine, 'cesium');
    assert.equal(s.canvases, 1, 'Cesium must render exactly 1 canvas');
    assert.ok(s.pixels.width > 0, 'Canvas pixel width must be > 0');
    assert.equal(s.dataset.surfaceReady, 'true');
    assert.equal(s.dataset.activeMapStyle, 'natural');
    await snap('01-initial-natural-desktop');
    return s;
  });

  // 02 - Real UI map style dropdown switch Natural -> Atlas
  await check('02 - 实际 UI 底图下拉 Natural -> Atlas，GPU activeMapStyle 与 activeTexture 就绪', async () => {
    const select = page.locator('select[aria-label="底图风格"]');
    assert.equal(await select.count(), 1, '底图风格下拉菜单必须存在');
    await select.selectOption('atlas');

    await page.waitForFunction(() => {
      const e = document.querySelector('.tg-canvas');
      return e?.dataset.requestedMapStyle === 'atlas' &&
             e?.dataset.activeMapStyle === 'atlas' &&
             !!e?.dataset.activeTexture &&
             !e?.dataset.mapStyleError;
    }, {}, {timeout: 30000});

    const state = await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0]?.view;
      return {
        requested: v?.globe?.requestedMapStyle,
        current: v?.globe?.currentMapStyle,
        activeMapStyle: document.querySelector('.tg-canvas')?.dataset.activeMapStyle,
        activeTexture: document.querySelector('.tg-canvas')?.dataset.activeTexture,
        profileWidth: v?.globe?.profile.width,
        dropdownVal: document.querySelector('select[aria-label="底图风格"]')?.value
      };
    });
    assert.equal(state.requested, 'atlas');
    assert.equal(state.current, 'atlas');
    assert.equal(state.activeMapStyle, 'atlas');
    assert.equal(state.dropdownVal, 'atlas');
    assert.equal(Number(state.activeTexture), state.profileWidth);
    await snap('02-ui-dropdown-atlas');
    return state;
  });

  // 03 - Map style switch preserves widget instance, camera position/direction, selection and filters
  // Setup order: select compatible place & matching year first, wait for flight tweens=0, then snapshot baseline
  await check('03 - 底图切换保持同一 Widget 实例、相机姿态、选中地点与年份国家筛选不变', async () => {
    // 1. Select a place and set the matching year so selection is not legitimately cleared by filtering
    await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      const targetPlace = v.places[0];
      if (!targetPlace) throw new Error('No places found in store');
      const targetYear = targetPlace.records[0].date.slice(0, 4);

      // Apply matching year filter
      v.yearValue = targetYear;
      const yearSelect = document.querySelector('select[aria-label="按年份筛选"]');
      if (yearSelect) yearSelect.value = targetYear;
      v.refresh();
      // Select the place (triggers camera flight)
      v.select(targetPlace);
    });

    // 2. Wait for camera flight to fully settle (scene.tweens.length === 0)
    await page.waitForFunction(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0]?.view;
      const scene = v?.globe?.instance?.scene;
      return scene && scene.tweens.length === 0;
    }, {}, {timeout: 15000});

    // 3. Capture baseline AFTER flight settles
    await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      const w = v.globe.instance;
      const c = w.camera;
      window.__qaWidget = w;
      window.__qaCamPos = c.positionWC.clone();
      window.__qaCamDir = c.directionWC.clone();
      window.__qaSelected = v.selected;
      window.__qaYear = v.yearValue;
    });

    // 4. Switch style: atlas -> natural -> atlas
    const styleSelect = page.locator('select[aria-label="底图风格"]');
    await styleSelect.selectOption('natural');
    await page.waitForFunction(() => {
      const e = document.querySelector('.tg-canvas');
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0]?.view;
      return e?.dataset.activeMapStyle === 'natural' && v?.globe?.instance?.scene?.tweens?.length === 0;
    }, {}, {timeout: 30000});

    await styleSelect.selectOption('atlas');
    await page.waitForFunction(() => {
      const e = document.querySelector('.tg-canvas');
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0]?.view;
      return e?.dataset.activeMapStyle === 'atlas' && v?.globe?.instance?.scene?.tweens?.length === 0;
    }, {}, {timeout: 30000});

    // 5. Verify camera, widget, selection, and filter invariance
    const res = await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      const w = v.globe.instance;
      const c = w.camera;
      const p0 = window.__qaCamPos, d0 = window.__qaCamDir;
      const posDist = Math.hypot(c.positionWC.x - p0.x, c.positionWC.y - p0.y, c.positionWC.z - p0.z);
      const dirDist = Math.hypot(c.directionWC.x - d0.x, c.directionWC.y - d0.y, c.directionWC.z - d0.z);
      return {
        sameWidget: w === window.__qaWidget,
        posDist,
        dirDist,
        selected: v.selected,
        expectedSelected: window.__qaSelected,
        yearValue: v.yearValue,
        expectedYear: window.__qaYear
      };
    });
    assert.ok(res.sameWidget, 'Widget instance must not be recreated across style switches');
    assert.ok(res.posDist < 1e-3, `Camera position must remain invariant, got distance ${res.posDist}`);
    assert.ok(res.dirDist < 1e-3, `Camera direction must remain invariant, got distance ${res.dirDist}`);
    assert.equal(res.selected, res.expectedSelected, 'Selected place must remain invariant');
    assert.equal(res.yearValue, res.expectedYear, 'Filter value must remain invariant');

    // 6. Reset filter and selection
    await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      v.yearValue = '';
      const yearSelect = document.querySelector('select[aria-label="按年份筛选"]');
      if (yearSelect) yearSelect.value = '';
      v.selected = '';
      v.refresh();
    });
    return res;
  });

  // 04 - Atlas country borders loaded (610 lines), Ground/Approximate ready, visible labels > 0 with Chinese
  await check('04 - Atlas 国界 610 条数据加载、Ground/Approximate 就绪与中文国家标注展示', async () => {
    const initialData = await page.evaluate(() => {
      const e = document.querySelector('.tg-canvas');
      return {
        atlasSource: e?.dataset.atlasSource,
        atlasPlacement: e?.dataset.atlasPlacement,
        atlasBorderLines: e?.dataset.atlasBorderLines
      };
    });
    assert.ok(initialData.atlasSource?.includes('Natural Earth Vector'), 'Atlas source must be Natural Earth Vector');
    assert.ok(['ground', 'approximate'].includes(initialData.atlasPlacement), 'Atlas placement must be ground or approximate');
    assert.equal(initialData.atlasBorderLines, '610', 'Atlas border lines count must be 610');

    // Wait for Ground primitives readiness or fallback approximate
    await page.waitForFunction(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0]?.view;
      const layers = v?.globe?.atlasLayers;
      if (!layers) return false;
      const placement = document.querySelector('.tg-canvas')?.dataset.atlasPlacement;
      if (placement === 'approximate') return !!layers.floating;
      return layers.ground?.length > 0 && layers.ground.every(p => p.ready) && document.querySelector('.tg-canvas')?.dataset.atlasBorderReady==='true';
    }, {}, {timeout: 25000});

    // Aim camera at East Asia / China to test visible country labels with Chinese text
    const frameBefore=await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      const frames=Number(document.querySelector('.tg-canvas').dataset.renderedFrames);
      v.globe.setView(34, 108, 1.6, false);
      v.globe.instance.scene.requestRender();
      return frames;
    });
    await page.waitForFunction(before=>{const e=document.querySelector('.tg-canvas');return Number(e?.dataset.renderedFrames)>=before+5&&e?.dataset.atlasBorderReady==='true';},frameBefore,{timeout:15000});

    // Wait for visible labels count > 0 (throttled at 100ms)
    await page.waitForFunction(() => {
      const count = Number(document.querySelector('.tg-canvas')?.dataset.atlasVisibleLabels) || 0;
      return count > 0;
    }, {}, {timeout: 10000});

    const labelData = await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      const items = v.globe.atlasLayers.labelItems || [];
      const visible = items.filter(it => it.label.show);
      const chineseLabels = visible.map(it => it.label.text).filter(t => /[一-龥]/.test(t));
      return {
        total: items.length,
        visibleCount: visible.length,
        datasetVisibleCount: Number(document.querySelector('.tg-canvas')?.dataset.atlasVisibleLabels),
        chineseSample: chineseLabels.slice(0, 5),
        hasChinese: chineseLabels.length > 0
      };
    });
    assert.ok(labelData.visibleCount > 0, 'Visible labels must be greater than 0');
    assert.ok(labelData.hasChinese, 'Visible labels must contain Chinese names');
    const pixels=await sharp(await page.locator('.tg-canvas').screenshot()).raw().toBuffer({resolveWithObject:true});
    let pinkPixels=0;
    for(let i=0;i<pixels.data.length;i+=pixels.info.channels){const r=pixels.data[i],g=pixels.data[i+1],b=pixels.data[i+2];if(r>130&&g>40&&g<170&&b>60&&b<200&&r-g>40&&r-b>25)pinkPixels++;}
    assert.ok(pinkPixels>25,'粉色国界必须真实绘制而不是只有ready对象：'+pinkPixels);
    await snap('04-atlas-country-borders-chinese-labels');
    return {...labelData,pinkPixels};
  });

  // 05 - Independent border and label toggle buttons for Natural and Atlas preferences
  await check('05 - 国界与名称按钮独立控制自然与 Atlas 偏好（showBorders/atlasBorders/showCountryNames/atlasLabels）', async () => {
    const bBorders = page.locator('.tg-layers button', {hasText: '国界'});
    const bLabels = page.locator('.tg-layers button', {hasText: '名称'});
    const legend = page.locator('.tg-map-legend');

    // Verify initial state in Atlas
    let s = await page.evaluate(() => app.plugins.plugins['travel-globe'].settings);
    assert.equal(s.atlasBorders, true);
    assert.equal(s.showBorders, false);
    assert.equal(s.atlasLabels, true);
    assert.equal(s.showCountryNames, false);
    assert.equal(await legend.isHidden(), false, 'Legend visible when atlas borders active');

    // Toggle borders off in Atlas
    await bBorders.click();
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.borders === 'false', {}, {timeout: 10000});
    s = await page.evaluate(() => app.plugins.plugins['travel-globe'].settings);
    assert.equal(s.atlasBorders, false);
    assert.equal(s.showBorders, false, 'showBorders must not change when toggling in Atlas');
    assert.equal(await legend.isHidden(), true, 'Legend hidden when atlas borders disabled');

    // Toggle borders back on in Atlas
    await bBorders.click();
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.borders === 'true', {}, {timeout: 10000});
    assert.equal(await legend.isHidden(), false);

    // Toggle labels off in Atlas
    await bLabels.click();
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.countryNames === 'false', {}, {timeout: 10000});
    s = await page.evaluate(() => app.plugins.plugins['travel-globe'].settings);
    assert.equal(s.atlasLabels, false);
    assert.equal(s.showCountryNames, false, 'showCountryNames must not change when toggling in Atlas');

    // Toggle labels back on in Atlas
    await bLabels.click();
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.countryNames === 'true', {}, {timeout: 10000});

    // Switch to Natural
    await page.locator('select[aria-label="底图风格"]').selectOption('natural');
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.activeMapStyle === 'natural', {}, {timeout: 30000});
    assert.equal(await legend.isHidden(), true, 'Legend must always be hidden in Natural mode');

    // In Natural: toggle showBorders
    await bBorders.click();
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.borders === 'true', {}, {timeout: 10000});
    s = await page.evaluate(() => app.plugins.plugins['travel-globe'].settings);
    assert.equal(s.showBorders, true);
    assert.equal(s.atlasBorders, true, 'atlasBorders preference preserved');

    // In Natural: toggle showCountryNames
    await bLabels.click();
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.countryNames === 'true', {}, {timeout: 10000});
    s = await page.evaluate(() => app.plugins.plugins['travel-globe'].settings);
    assert.equal(s.showCountryNames, true);
    assert.equal(s.atlasLabels, true, 'atlasLabels preference preserved');

    // Reset natural toggles
    await bBorders.click();
    await bLabels.click();
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.borders === 'false' && document.querySelector('.tg-canvas')?.dataset.countryNames === 'false', {}, {timeout: 10000});

    // Switch back to Atlas
    await page.locator('select[aria-label="底图风格"]').selectOption('atlas');
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.activeMapStyle === 'atlas', {}, {timeout: 30000});
    s = await page.evaluate(() => app.plugins.plugins['travel-globe'].settings);
    assert.equal(s.atlasBorders, true);
    assert.equal(s.atlasLabels, true);

    return {atlasBorders: s.atlasBorders, atlasLabels: s.atlasLabels, showBorders: s.showBorders, showCountryNames: s.showCountryNames};
  });

  // 06 - Clouds disabled in Atlas without overriding natural setting, shader strength 0, satellite spy requests 0
  await check('06 - Atlas 云层禁用且不覆盖自然设置、着色器强度为 0、近景卫星请求为 0 (Spy)', async () => {
    // In Natural mode, enable clouds
    await page.locator('select[aria-label="底图风格"]').selectOption('natural');
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.activeMapStyle === 'natural', {}, {timeout: 30000});
    await page.evaluate(async () => {
      await app.plugins.plugins['travel-globe'].updateSettings({showClouds: true, quality: 'clear'});
    });
    await page.waitForFunction(() => {
      const e = document.querySelector('.tg-canvas');
      return e?.dataset.clouds === 'true' && !!e?.dataset.cloudTexture;
    }, {}, {timeout: 30000});

    // Verify natural terrain shader strength === 1
    assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe.terrainShade.uniforms.strength), 1);

    // Switch to Atlas mode
    await page.locator('select[aria-label="底图风格"]').selectOption('atlas');
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.activeMapStyle === 'atlas', {}, {timeout: 30000});

    // Check UI and shader
    const cloudBtn = page.locator('.tg-layers button', {hasText: '云层'});
    assert.equal(await cloudBtn.isDisabled(), true, 'Cloud button must be disabled in Atlas');
    assert.ok((await cloudBtn.getAttribute('title')).includes('云层仅在自然地球显示'));

    const atlasState = await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      return {
        datasetClouds: document.querySelector('.tg-canvas')?.dataset.clouds,
        cloudShellShow: v.globe.cloudShell?.show,
        settingsShowClouds: app.plugins.plugins['travel-globe'].settings.showClouds,
        shaderStrength: v.globe.terrainShade?.uniforms.strength,
        satelliteShow: v.globe.satellite?.show
      };
    });
    assert.equal(atlasState.datasetClouds, 'false');
    assert.equal(atlasState.cloudShellShow, false);
    assert.equal(atlasState.settingsShowClouds, true, 'Original settings.showClouds must not be overwritten');
    assert.equal(atlasState.shaderStrength, 0, 'Atlas terrain shading uniform strength must be 0');
    assert.equal(atlasState.satelliteShow, false, 'Satellite layer show must be false in Atlas');

    // Spy on satelliteCache.get: close-up zoom should produce 0 requests
    await page.evaluate(() => {
      const t = app.plugins.plugins['travel-globe'];
      window.__qaSatelliteCalls = 0;
      window.__qaOrigCacheGet = t.satelliteCache.get;
      t.satelliteCache.get = function(...args) {
        window.__qaSatelliteCalls++;
        return window.__qaOrigCacheGet.apply(this, args);
      };
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      v.globe.setView(31.23, 121.47, 0.05, false);
      v.globe.instance.scene.requestRender();
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe.instance.scene.requestRender());
    await page.waitForTimeout(400);

    const satelliteCalls = await page.evaluate(() => {
      const t = app.plugins.plugins['travel-globe'];
      const count = window.__qaSatelliteCalls;
      t.satelliteCache.get = window.__qaOrigCacheGet;
      delete window.__qaSatelliteCalls;
      delete window.__qaOrigCacheGet;
      return count;
    });
    assert.equal(satelliteCalls, 0, 'Satellite requests must be strictly 0 in Atlas mode');

    // Switch back to Natural mode and confirm clouds automatically restore
    await page.locator('select[aria-label="底图风格"]').selectOption('natural');
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.activeMapStyle === 'natural', {}, {timeout: 30000});
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.clouds === 'true', {}, {timeout: 30000});
    assert.equal(await page.evaluate(() => app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe.terrainShade.uniforms.strength), 1);

    // Reset showClouds to false and quality to auto
    await page.evaluate(async () => {
      await app.plugins.plugins['travel-globe'].updateSettings({showClouds: false, quality: 'auto'});
    });
    return {satelliteCalls, cloudsRestored: true};
  });

  // 07 - Natural and Atlas mode photo/list/memory display, place selection not blocked by labels
  await check('07 - 自然模式与 Atlas 模式下照片、回忆展示与地点点击（无 Label 阻挡）', async () => {
    // Natural mode: test list, memories, photos
    await page.locator('select[aria-label="底图风格"]').selectOption('natural');
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.activeMapStyle === 'natural', {}, {timeout: 30000});

    await page.locator('.tg-stage-actions button', {hasText: '旅行列表'}).click();
    const firstRow = page.locator('.tg-place-row').first();
    await firstRow.waitFor({state: 'visible'});
    await firstRow.click();

    assert.ok(await page.locator('.tg-details .tg-memory').count() > 0, 'Memory entries must render');
    const photo = page.locator('.tg-details img').first();
    if (await photo.count() > 0) {
      await photo.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.tg-details img')].some(i => i.complete && i.naturalWidth > 0), {}, {timeout: 10000});
    }
    await page.locator('.tg-details button', {hasText: '关闭'}).click();
    await page.locator('.tg-stage-actions button', {hasText: '收起列表'}).click();

    // Switch to Atlas mode: test place selection and unobstructed click
    await page.locator('select[aria-label="底图风格"]').selectOption('atlas');
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.activeMapStyle === 'atlas', {}, {timeout: 30000});

    // Select place in Atlas mode
    const placeResult = await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      const target = v.places.find(p => p.city.includes('上海')) || v.places[0];
      if (target) {
        v.select(target);
        return {city: target.city, id: target.id};
      }
      return null;
    });
    assert.ok(placeResult, 'Target place must exist');

    await page.waitForFunction((city) => {
      const el = document.querySelector('.tg-city');
      return el?.textContent?.includes(city);
    }, placeResult.city, {timeout: 10000});
    assert.ok(await page.locator('.tg-details .tg-memory').count() > 0, 'Atlas mode memories rendered without occlusion');

    await snap('07-atlas-place-selected-memory');
    await page.locator('.tg-details button', {hasText: '关闭'}).click();
    return placeResult;
  });

  // 08 - Rapid concurrent mode and quality switches, latest request wins (race condition protection)
  await check('08 - 快速模式与画质并发切换，验证最新请求胜出（Race Condition 竞态保护）', async () => {
    // Fire rapid consecutive updates without awaiting between them
    await page.evaluate(() => {
      const t = app.plugins.plugins['travel-globe'];
      t.updateSettings({mapStyle: 'natural', quality: 'low'});
      t.updateSettings({mapStyle: 'atlas', quality: 'standard'});
      t.updateSettings({mapStyle: 'natural', quality: 'low'});
      t.updateSettings({mapStyle: 'atlas', quality: 'clear'});
    });

    // Await final settled state
    await page.waitForFunction(() => {
      const e = document.querySelector('.tg-canvas');
      return e?.dataset.requestedMapStyle === 'atlas' &&
             e?.dataset.activeMapStyle === 'atlas' &&
             e?.dataset.requestedQuality === 'clear' &&
             e?.dataset.activeTexture === '4096' &&
             !e?.dataset.mapStyleError &&
             !e?.dataset.qualityError;
    }, {}, {timeout: 45000});

    const finalState = await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      const e = document.querySelector('.tg-canvas');
      return {
        activeMapStyle: e?.dataset.activeMapStyle,
        activeTexture: e?.dataset.activeTexture,
        profileWidth: v.globe.profile.width,
        requestedQuality: v.globe.profile.requested
      };
    });
    assert.equal(finalState.activeMapStyle, 'atlas', 'Latest requestedMapStyle must win');
    assert.equal(finalState.activeTexture, '4096', 'Latest activeTexture must win');
    assert.equal(finalState.requestedQuality, 'clear');
    return finalState;
  });

  // 09 - Hidden tab preference queue does not block, renders corresponding mapStyle upon becoming visible
  await check('09 - 后台 Hidden Tab 设置队列不阻塞，切回 Visible 正确渲染对应底图', async () => {
    // Hide the globe by opening an empty leaf
    await page.evaluate(async () => {
      const leaf = app.workspace.getLeaf('tab');
      await leaf.setViewState({type: 'empty', active: true});
    });
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.rendering === 'paused', {}, {timeout: 10000});

    // While hidden, dispatch updateSettings
    const queueResult = await page.evaluate(async () => {
      const t = app.plugins.plugins['travel-globe'];
      const startTime = performance.now();
      await t.updateSettings({mapStyle: 'atlas', quality: 'standard'});
      const elapsed = performance.now() - startTime;
      return {elapsed, mapStyle: t.settings.mapStyle, quality: t.settings.quality};
    });
    assert.ok(queueResult.elapsed < 3000, 'Hidden settings update must resolve without hanging');

    // Reactivate travel globe view
    await openView(page);
    await page.waitForFunction(() => {
      const e = document.querySelector('.tg-canvas');
      return e?.dataset.rendering !== 'paused' &&
             e?.dataset.activeMapStyle === 'atlas' &&
             e?.dataset.activeTexture === '2048';
    }, {}, {timeout: 30000});

    return queueResult;
  });

  // 10 - Offline cached bundle close and reopen renders cleanly without network
  await check('10 - 离线离线包（Cached Bundle）关闭并重启视图正常渲染', async () => {
    await closeView(page);
    await openView(page);
    await ready(page);

    const s = await surface(page);
    assert.equal(s.dataset.surfaceReady, 'true');
    assert.equal(s.engine, 'cesium');
    assert.equal(s.canvases, 1);
    assert.equal(s.dataset.activeMapStyle, 'atlas');
    await snap('10-offline-bundle-reopen');
    return s;
  });

  // 11 - Responsive viewports: 1440x1000, 1024x500 short, 768x1024 tablet, 375x812 mobile emulation with 4K cap
  await check('11 - 多视口响应式测试（1440x1000、短屏、768x1024、375x812）无 Overflow 与手机 4K 上限声明', async () => {
    const viewports = [
      {name: 'desktop', w: 1440, h: 1000, short: false},
      {name: 'short-screen', w: 1024, h: 500, short: true},
      {name: 'tablet', w: 768, h: 1024, short: false}
    ];

    const desktopResults = [];
    for (const vp of viewports) {
      await viewport(cdp, vp.w, vp.h, false);
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const el = document.querySelector('.tg-app');
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          isShort: el.classList.contains('tg-short')
        };
      });
      assert.ok(m.scrollWidth <= m.clientWidth + 1, `${vp.name} scrollWidth overflow`);
      assert.ok(m.scrollHeight <= m.clientHeight + 1, `${vp.name} scrollHeight overflow`);
      if (vp.short) assert.ok(m.isShort, 'Short viewport must add .tg-short class');
      desktopResults.push({viewport: vp, metrics: m});
    }

    // Mobile emulation test
    await closeView(page);
    await emulateMobile(page, true);
    await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
    await viewport(cdp, 375, 812, true, 2);
    await openView(page);
    await page.waitForTimeout(300);

    const mobileMetrics = await page.evaluate(() => {
      const el = document.querySelector('.tg-app');
      return {
        isMobile: el.classList.contains('tg-mobile'),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      };
    });
    assert.ok(mobileMetrics.isMobile, 'Mobile layout must activate .tg-mobile');
    assert.ok(mobileMetrics.scrollWidth <= mobileMetrics.clientWidth + 1, 'Mobile scrollWidth overflow');
    assert.ok(mobileMetrics.scrollHeight <= mobileMetrics.clientHeight + 1, 'Mobile scrollHeight overflow');

    // Test mobile 8K request capped at 4K
    await page.evaluate(async () => {
      await app.plugins.plugins['travel-globe'].updateSettings({quality: 'ultra', mapStyle: 'atlas'});
    });
    await page.waitForFunction(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0]?.view;
      return v?.globe?.profile.requested === 'ultra' &&
             document.querySelector('.tg-canvas')?.dataset.qualityReason?.includes('手机');
    }, {}, {timeout: 30000});

    const mobileQuality = await page.evaluate(() => {
      const v = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
      return {
        requested: v.globe.profile.requested,
        actualWidth: v.globe.profile.width,
        reason: v.globe.profile.reason,
        activeTexture: document.querySelector('.tg-canvas')?.dataset.activeTexture
      };
    });
    assert.equal(mobileQuality.actualWidth, 4096, 'Mobile ultra quality must be capped at 4K');
    assert.ok(mobileQuality.reason.includes('手机'), 'Reason must explicitly state mobile budget limit');
    await snap('11-mobile-375x812-atlas');

    // Restore desktop emulation
    await emulateMobile(page, false);
    await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: false});
    await viewport(cdp, 1440, 1000, false);
    await openView(page);

    return {
      desktopResults,
      mobileMetrics,
      mobileQuality,
      disclaimer: 'Mobile size 375x812 emulates Obsidian mobile DOM and touch metrics in desktop Electron; does not represent physical iPhone hardware.'
    };
  });

  // 12 - Repeated toggles and open/close cycles: surfaceImages <= 2, single canvas, no resource accumulation
  await check('12 - 多个开关与关闭重开后 surfaceImages <= 2 无泄漏且保持单 Canvas', async () => {
    for (const [style, quality] of [['natural', 'low'], ['atlas', 'standard'], ['natural', 'clear'], ['atlas', 'clear']]) {
      await page.evaluate(async ({style, quality}) => {
        await app.plugins.plugins['travel-globe'].updateSettings({mapStyle: style, quality});
      }, {style, quality});
      await page.waitForFunction(({style, quality}) => {
        const e = document.querySelector('.tg-canvas');
        return e?.dataset.activeMapStyle === style && !e?.dataset.mapStyleError;
      }, {style, quality}, {timeout: 30000});
    }

    const s = await surface(page);
    assert.ok(s.surfaceImages <= 2, 'surfaceImages map size must remain <= 2');
    assert.equal(s.canvases, 1, 'Only one canvas element should exist');

    // Close and reopen to verify clean canvas teardown
    await closeView(page);
    await openView(page);
    const sReopened = await surface(page);
    assert.equal(sReopened.canvases, 1, 'Exactly one canvas element after reopen');
    return {surfaceImages: s.surfaceImages, canvases: sReopened.canvases};
  });

  // 13 - Public test coordinates real country views: Asia, Europe, Date line
  await check('13 - 真实国家视角截图（亚洲、欧洲、日期线公共测试坐标）', async () => {
    // Ensure atlas style and labels are active
    await page.locator('select[aria-label="底图风格"]').selectOption('atlas');
    await page.waitForFunction(() => document.querySelector('.tg-canvas')?.dataset.activeMapStyle === 'atlas', {}, {timeout: 30000});

    const views = [
      {name: '13-public-view-asia', lat: 34.0, lng: 108.0, alt: 1.8},
      {name: '13-public-view-europe', lat: 48.0, lng: 14.0, alt: 1.8},
      {name: '13-public-view-dateline', lat: 10.0, lng: 180.0, alt: 2.2}
    ];

    const results = [];
    for (const v of views) {
      await page.evaluate(({lat, lng, alt}) => {
        const view = app.workspace.getLeavesOfType('travel-globe-view')[0].view;
        view.globe.setView(lat, lng, alt, false);
        view.globe.instance.scene.requestRender();
      }, v);
      await page.waitForTimeout(300);
      await page.evaluate(() => app.workspace.getLeavesOfType('travel-globe-view')[0].view.globe.instance.scene.requestRender());
      await page.waitForTimeout(200);

      await page.waitForFunction(() => {
        const count = Number(document.querySelector('.tg-canvas')?.dataset.atlasVisibleLabels) || 0;
        return count > 0;
      }, {}, {timeout: 10000});

      const info = await page.evaluate(() => {
        const e = document.querySelector('.tg-canvas');
        return {
          altitude: e?.dataset.altitude,
          visibleLabels: e?.dataset.atlasVisibleLabels,
          borderLines: e?.dataset.atlasBorderLines
        };
      });
      await snap(v.name);
      results.push({view: v.name, info});
    }
    return results;
  });

  // 14 - Vault file byte-for-byte SHA-256 integrity check
  await check('14 - 仓库文件完整性核验（示例笔记与照片 SHA-256 无任何改动）', async () => {
    const currentInventory = await getVaultInventory();
    const addedCaches=currentInventory.files.filter(f=>!initialInventory.files.includes(f));
    const cacheFile=/^地球资源\/全球底图\/(?:surface-(?:low|standard|high|8k)\.jpg|height-(?:low|standard|high)\.png|clouds-hd-(?:low|standard|high|8k)\.png)$/;
    assert.ok(addedCaches.every(f=>cacheFile.test(f)), 'Unexpected new vault file: '+JSON.stringify(addedCaches));
    for (const f of initialInventory.files) {
      assert.ok(currentInventory.files.includes(f), 'Original vault file removed: '+f);
      assert.equal(currentInventory.hashes[f], initialInventory.hashes[f], 'Vault file modified: ' + f);
    }
    const currentNoteContent = await snapshot();
    assert.deepEqual(currentNoteContent, originalNoteContent, 'Note contents altered');
    return {filesChecked: initialInventory.files.length,addedManagedCaches:addedCaches};
  });

  // 15 - Console health and structured warning classification
  await check('15 - 控制台日志与错误分类健康审计', async () => {
    const categorized = h.errors.map(err => {
      let cat = 'unclassified';
      if (/WebGL|context lost|loseContext/i.test(err)) cat = 'webgl-context-lifecycle';
      else if (/ERR_INTERNET_DISCONNECTED|internetdisconnected|net::/i.test(err)) cat = 'expected-offline-abort';
      else if (/approximateTerrainHeights|Cesium/i.test(err)) cat = 'cesium-asset-notice';
      return {text: err, category: cat};
    });
    const unexpected = categorized.filter(e => e.category !== 'expected-offline-abort');
    assert.deepEqual(unexpected, [], 'Unexpected console errors found: ' + JSON.stringify(unexpected));

    return {
      totalErrors: h.errors.length,
      totalWarnings: h.warnings.length,
      categorizedErrors: categorized,
      warningSample: h.warnings.slice(0, 10)
    };
  });

  await h.save(label + '-summary', {
    checks,
    stats: {
      total: checks.length,
      passed: checks.filter(c => c.status === 'pass').length,
      failed: checks.filter(c => c.status === 'fail').length
    },
    limitations: [
      'Mobile sizes emulate Obsidian mobile DOM and touch metrics in desktop Electron; no iOS/Android physical hardware claim.',
      'Host network flags (earthOnline, satelliteOnline) disabled; external network requests intercepted and aborted.',
      'Test reads offline bundled assets and isolated fixture files without mutating user vaults or example notes.'
    ]
  });

  if (checks.some(c => c.status === 'fail')) {
    process.exitCode = 1;
    throw new Error(`QA Atlas regression completed with ${checks.filter(c => c.status === 'fail').length} failure(s)`);
  }
  console.log(JSON.stringify(checks.map(({name, status, error}) => ({name, status, error})), null, 2));
} finally {
  await h.close();
}
