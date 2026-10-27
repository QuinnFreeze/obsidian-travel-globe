import {readFile, writeFile as writeRaw, rename, stat, readdir, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, relative} from 'node:path';

export const ESSENTIAL_RELEASE_ASSETS = [
  'runtime-assets/cities.json',
  'runtime-assets/atlas-map.json',
  'runtime-assets/atlas-provenance.json',
  'runtime-assets/atlas-surface-low.jpg',
  'runtime-assets/atlas-surface-standard.jpg',
  'runtime-assets/atlas-surface-high.jpg',
  'runtime-assets/atlas-surface-8k.jpg',
  'runtime-assets/surface-low.jpg',
  'runtime-assets/surface-standard.jpg',
  'runtime-assets/surface-high.jpg',
  'runtime-assets/surface-8k.jpg',
  'runtime-assets/height-low.png',
  'runtime-assets/height-standard.png',
  'runtime-assets/height-high.png',
  'runtime-assets/clouds-hd-low.png',
  'runtime-assets/clouds-hd-standard.png',
  'runtime-assets/clouds-hd-high.png',
  'runtime-assets/clouds-hd-8k.png',
  'runtime-assets/cesium/Assets/approximateTerrainHeights.json',
  'runtime-assets/cesium/DEPENDENCY_LICENSES.txt',
  'runtime-assets/cesium/LICENSE.md',
  'runtime-assets/cesium/TERRAIN_CREDITS.md',
  'runtime-assets/cesium/ThirdParty.json',
  'runtime-assets/cesium/ThirdParty/basis_transcoder.wasm',
  'runtime-assets/cesium/Workers/createVerticesFromHeightmap.js',
  'runtime-assets/cesium/Workers/transcodeKTX2.js'
];

export const FORBIDDEN_RELEASE_FILES = [
  'runtime-assets/renderer.js',
  'runtime-assets/cloud-worker.js'
];

export const SOURCE_ALLOWLIST_DIRS = new Set([
  'src',
  'scripts',
  'tests',
  'assets',
  'docs',
  'examples'
]);

export const SOURCE_ALLOWLIST_FILES = new Set([
  'manifest.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'esbuild.config.mjs',
  'styles-base.css',
  'versions.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'README.md',
  'CHANGELOG.md',
  '安装说明.md',
  '安装或修复.command',
  'Mac本地安装.command',
  'Mac恢复iCloud安装.command',
  '.gitignore'
]);

/**
 * Atomically write a file only if contents differ, avoiding redundant writes and iCloud re-sync churn.
 */
export async function writeAtomic(filePath, contents) {
  const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  try {
    const existing = await readFile(filePath);
    if (Buffer.compare(existing, buf) === 0) {
      return false; // Unchanged, no disk write
    }
  } catch {}
  await writeRaw(filePath + '.tmp', buf);
  await rename(filePath + '.tmp', filePath);
  return true; // Written
}

/**
 * Verify release files against strict inventory:
 * - No forbidden legacy external scripts
 * - Contains all essential assets
 * - Has minimum Cesium Assets, Workers, and ThirdParty trees
 */
export function verifyReleaseInventory(releaseFiles) {
  const fileSet = new Set(releaseFiles);

  for (const forbidden of FORBIDDEN_RELEASE_FILES) {
    if (fileSet.has(forbidden)) {
      throw new Error(`打包安全检查未通过：发布产物中严禁包含外置可执行脚本 ${forbidden}`);
    }
  }

  for (const essential of ESSENTIAL_RELEASE_ASSETS) {
    if (!fileSet.has(essential)) {
      throw new Error(`打包完整性检查未通过：缺少核心必要资产 ${essential}`);
    }
  }

  let cesiumAssets = 0, cesiumWorkers = 0, cesiumThirdParty = 0;
  for (const f of releaseFiles) {
    if (f.startsWith('runtime-assets/cesium/Assets/')) cesiumAssets++;
    else if (f.startsWith('runtime-assets/cesium/Workers/')) cesiumWorkers++;
    else if (f.startsWith('runtime-assets/cesium/ThirdParty/')) cesiumThirdParty++;
  }

  if (cesiumAssets < 100) {
    throw new Error(`打包完整性检查未通过：Cesium Assets 资源不完整 (仅发现 ${cesiumAssets} 项，预期 > 100)`);
  }
  if (cesiumWorkers < 40) {
    throw new Error(`打包完整性检查未通过：Cesium Workers 脚本不完整 (仅发现 ${cesiumWorkers} 项，预期 > 40)`);
  }
  if (cesiumThirdParty < 3) {
    throw new Error(`打包完整性检查未通过：Cesium ThirdParty 库不完整 (仅发现 ${cesiumThirdParty} 项，预期 > 3)`);
  }

  return true;
}

/**
 * Generate a cryptographically verified build receipt recording all produced artifacts.
 */
export async function createBuildReceipt(manifest, releaseFiles) {
  const artifacts = {};
  for (const file of releaseFiles) {
    const data = await readFile(file);
    const hash = createHash('sha256').update(data).digest('hex');
    artifacts[file] = {
      size: data.length,
      sha256: hash
    };
  }

  const receipt = {
    receiptVersion: 1,
    buildTime: new Date().toISOString(),
    pluginId: manifest.id,
    version: manifest.version,
    totalFiles: releaseFiles.length,
    artifacts
  };

  await mkdir('.build', {recursive: true});
  await writeAtomic('.build/build-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

/**
 * Verify that build receipt exists, matches manifest version, and all files match recorded hashes.
 */
export async function verifyBuildReceipt(manifest) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile('.build/build-receipt.json', 'utf8'));
  } catch (e) {
    throw new Error('未找到有效的构建凭据 (.build/build-receipt.json)，请先运行 npm run build', {cause: e});
  }

  if (receipt.version !== manifest.version) {
    throw new Error(`构建凭据版本不匹配：凭据版本为 ${receipt.version}，当前 manifest 版本为 ${manifest.version}，请重新运行 npm run build`);
  }

  for (const [file, info] of Object.entries(receipt.artifacts)) {
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new Error(`构建产物丢失：${file} 在构建凭据中登记但磁盘文件不存在，请重新运行 npm run build`);
    }
    const currentHash = createHash('sha256').update(data).digest('hex');
    if (currentHash !== info.sha256) {
      throw new Error(`构建产物指纹不一致：${file} 当前哈希与构建凭据不符，请重新运行 npm run build`);
    }
  }

  return receipt;
}

/**
 * Collect project source files using strict whitelist.
 * Refuses untracked .env files, temporary test vaults, local backups, etc.
 */
export async function collectSourceFiles() {
  const sourceFiles = [];

  // Top-level files
  for (const name of SOURCE_ALLOWLIST_FILES) {
    try {
      const s = await stat(name);
      if (s.isFile()) sourceFiles.push(name);
    } catch {}
  }

  // Whitelisted subdirectories
  async function walkDir(dir) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.') || entry.name.endsWith('.tmp') || entry.name.endsWith('.test')) continue;
      const full = dir + '/' + entry.name;
      if (entry.isDirectory()) {
        await walkDir(full);
      } else if (entry.isFile()) {
        sourceFiles.push(full);
      }
    }
  }

  for (const dir of SOURCE_ALLOWLIST_DIRS) {
    try {
      const s = await stat(dir);
      if (s.isDirectory()) await walkDir(dir);
    } catch {}
  }

  return sourceFiles.sort();
}
