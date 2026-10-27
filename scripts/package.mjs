import {readFile, writeFile as writeRaw, mkdir, readdir, rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {zipSync} from 'fflate';
import {
  writeAtomic,
  verifyBuildReceipt,
  verifyReleaseInventory,
  collectSourceFiles
} from './build-helper.mjs';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));

// Verify that a fresh, valid build receipt exists before packaging
await verifyBuildReceipt(manifest);

await mkdir('dist', {recursive: true});

async function listFiles(dir) {
  const result = [];
  for (const e of await readdir(dir, {withFileTypes: true})) {
    const name = dir + '/' + e.name;
    if (e.isDirectory()) result.push(...await listFiles(name));
    else result.push(name);
  }
  return result;
}

const releaseFiles = [
  'main.js', 'manifest.json', 'styles.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  '安装说明.md', '安装或修复.command', 'Mac本地安装.command', 'Mac恢复iCloud安装.command',
  ...(await listFiles('runtime-assets')).sort()
];

// Verify full release inventory
verifyReleaseInventory(releaseFiles);

// Compute hashes and prepare install archive data in a single read
const install = {};
const fileEntries = await Promise.all(releaseFiles.map(async name => {
  const data = new Uint8Array(await readFile(name));
  const hash = createHash('sha256').update(data).digest('hex') + '  ' + name;
  return {name, data, hash};
}));

await writeAtomic('FILES.sha256', fileEntries.map(e => e.hash).join('\n') + '\n');
const shaData = new Uint8Array(await readFile('FILES.sha256'));

for (const {name, data} of fileEntries) {
  install['travel-globe/' + name] = name.endsWith('.command') ? [data, {os: 3, attrs: (0o100755 << 16) >>> 0}] : data;
}
install['travel-globe/FILES.sha256'] = shaData;

const installZip = zipSync(install, {level: 6});
await writeAtomic('dist/travel-globe-' + manifest.version + '.zip', installZip);

// Source archive: strictly allowlisted sources only
const sourceFileNames = await collectSourceFiles();
const sources = {};
await Promise.all(sourceFileNames.map(async name => {
  const data = new Uint8Array(await readFile(name));
  sources['travel-globe-source/' + name] = name.endsWith('.command') ? [data, {os: 3, attrs: (0o100755 << 16) >>> 0}] : data;
}));

const sourceZip = zipSync(sources, {level: 6});
await writeAtomic('dist/travel-globe-source-' + manifest.version + '.zip', sourceZip);

// Examples archive
const examples = {};
for (const [path, data] of Object.entries(sources)) {
  if (path.startsWith('travel-globe-source/examples/')) {
    examples[path.replace('travel-globe-source/examples/', 'Travel Globe 示例/')] = data;
  }
}
const examplesZip = zipSync(examples, {level: 6});
await writeAtomic('dist/travel-globe-examples-' + manifest.version + '.zip', examplesZip);

// Update SHA256SUMS.txt
const hashes = new Map();
try {
  for (const line of (await readFile('dist/SHA256SUMS.txt', 'utf8')).trim().split('\n')) {
    const [hash, file] = line.split('  ');
    if (file) hashes.set(file, hash);
  }
} catch {}

const generatedZips = [
  ['travel-globe-' + manifest.version + '.zip', installZip],
  ['travel-globe-source-' + manifest.version + '.zip', sourceZip],
  ['travel-globe-examples-' + manifest.version + '.zip', examplesZip]
];

for (const [filename, buffer] of generatedZips) {
  hashes.set(filename, createHash('sha256').update(buffer).digest('hex'));
  console.log(filename, buffer.length + ' bytes');
}

await writeAtomic('dist/SHA256SUMS.txt', [...hashes].sort((a, b) => a[0].localeCompare(b[0])).map(([file, hash]) => hash + '  ' + file).join('\n') + '\n');
