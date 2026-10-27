import {readFile, mkdir, readdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import esbuild from 'esbuild';
import {collectCesiumNotices} from './scripts/cesium-notices.mjs';
import {writeAtomic, createBuildReceipt, verifyReleaseInventory} from './scripts/build-helper.mjs';

const isWatch = process.argv.includes('--watch');

// Styles and static data
await mkdir('runtime-assets', {recursive: true});
await writeAtomic('styles.css',
  (await readFile('node_modules/cesium/Build/Cesium/Widgets/CesiumWidget/CesiumWidget.css', 'utf8')) + '\n' +
  (await readFile('node_modules/cesium/Build/Cesium/Widgets/CesiumWidget/InfoBoxDescription.css', 'utf8').catch(() => '')) + '\n' +
  (await readFile('node_modules/cesium/Build/Cesium/Widgets/shared.css', 'utf8').catch(() => '')) + '\n' +
  (await readFile('styles-base.css', 'utf8'))
);

await writeAtomic('runtime-assets/cities.json', await readFile('assets/cities.json'));
await writeAtomic('runtime-assets/atlas-map.json', await readFile('assets/atlas/atlas-map.json'));
await writeAtomic('runtime-assets/atlas-provenance.json', await readFile('assets/atlas/provenance.json'));

// Stage every supported static tier explicitly. A clean checkout has no old
// runtime-assets directory, including compatibility resources not imported by TS.
for (const name of ['surface-low.jpg','surface-standard.jpg','surface-high.jpg','surface-8k.jpg',
  'height-low.png','height-standard.png','height-high.png',
  'clouds-hd-low.png','clouds-hd-standard.png','clouds-hd-high.png','clouds-hd-8k.png']) {
  await writeAtomic('runtime-assets/' + name, await readFile('assets/realistic/' + name));
}
for (const tier of ['low','standard','high','8k']) {
  const name = 'atlas-surface-' + tier + '.jpg';
  await writeAtomic('runtime-assets/' + name, await readFile('assets/atlas/' + name));
}


async function copyTree(from, to) {
  await mkdir(to, {recursive: true});
  for (const e of await readdir(from, {withFileTypes: true})) {
    const a = from + '/' + e.name, b = to + '/' + e.name;
    if (e.isDirectory()) await copyTree(a, b);
    else await writeAtomic(b, await readFile(a));
  }
}

for (const dir of ['Assets', 'Workers', 'ThirdParty']) {
  await copyTree('node_modules/cesium/Build/Cesium/' + dir, 'runtime-assets/cesium/' + dir);
}

await collectCesiumNotices('runtime-assets/cesium/');

const common = {
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  loader: {'.png': 'file', '.jpg': 'file'},
  minify: !isWatch,
  sourcemap: isWatch ? 'inline' : false,
  banner: {js: '/* Travel Globe — bundled offline assets. See THIRD_PARTY_NOTICES.md */'}
};

let childGlobeCtx, childCloudWorkerCtx;

function embeddedRuntimePlugin(opts) {
  return {
    name: 'embedded-runtime-plugin',
    setup(build) {
      build.onResolve({filter: /^embedded:(renderer|cloud-worker)$/}, args => ({
        path: args.path,
        namespace: 'embedded-runtime-ns'
      }));

      build.onLoad({filter: /^embedded:renderer$/, namespace: 'embedded-runtime-ns'}, async () => {
        let result;
        if (isWatch) {
          if (!childGlobeCtx) {
            childGlobeCtx = await esbuild.context({
              ...opts,
              entryPoints: ['src/globe.ts'],
              outdir: 'runtime-assets',
              assetNames: '[name]',
              publicPath: 'runtime-assets',
              metafile: true,
              write: false
            });
          }
          result = await childGlobeCtx.rebuild();
        } else {
          result = await esbuild.build({
            ...opts,
            entryPoints: ['src/globe.ts'],
            outdir: 'runtime-assets',
            assetNames: '[name]',
            publicPath: 'runtime-assets',
            metafile: true,
            write: false
          });
        }

        for (const file of result.outputFiles) {
          if (!file.path.endsWith('.js')) {
            await writeAtomic(file.path, file.contents);
          }
        }

        const jsEntry = Object.entries(result.metafile.outputs).find(([, meta]) => meta.entryPoint === 'src/globe.ts')?.[0];
        const jsFile = jsEntry ? result.outputFiles.find(f => f.path === resolve(jsEntry)) : result.outputFiles.find(f => f.path.endsWith('.js'));
        if (!jsFile) throw new Error('渲染器编译未生成 JS 模块');

        const contents = `export function createRenderer(Worker) {\n  const module = { exports: {} };\n  const exports = module.exports;\n${jsFile.text}\n  return module.exports;\n}\n`;
        const watchFiles = Object.keys(result.metafile.inputs).map(f => resolve(f));
        return {contents, loader: 'js', watchFiles};
      });

      build.onLoad({filter: /^embedded:cloud-worker$/, namespace: 'embedded-runtime-ns'}, async () => {
        let result;
        if (isWatch) {
          if (!childCloudWorkerCtx) {
            childCloudWorkerCtx = await esbuild.context({
              ...opts,
              entryPoints: ['src/cloud-worker.ts'],
              format: 'iife',
              outdir: 'runtime-assets',
              metafile: true,
              write: false
            });
          }
          result = await childCloudWorkerCtx.rebuild();
        } else {
          result = await esbuild.build({
            ...opts,
            entryPoints: ['src/cloud-worker.ts'],
            format: 'iife',
            outdir: 'runtime-assets',
            metafile: true,
            write: false
          });
        }

        const jsFile = result.outputFiles.find(f => f.path.endsWith('.js'));
        if (!jsFile) throw new Error('云层 Worker 编译未生成 JS 模块');

        const contents = `export const CLOUD_WORKER_SOURCE = ${JSON.stringify(jsFile.text)};\n`;
        const watchFiles = Object.keys(result.metafile.inputs).map(f => resolve(f));
        return {contents, loader: 'js', watchFiles};
      });
    }
  };
}

const config = {
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  plugins: [embeddedRuntimePlugin(common)]
};

if (isWatch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
} else {
  const result = await esbuild.build({...config, write: false});
  for (const file of result.outputFiles) {
    await writeAtomic(file.path, file.contents);
  }

  // Only remove legacy external scripts AFTER new main.js has successfully built
  for (const name of ['renderer.js', 'cloud-worker.js', 'clouds-low.png', 'clouds-standard.png', 'clouds-high.png']) {
    await rm('runtime-assets/' + name, {force: true});
  }

  // Generate verified build receipt
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  async function listFiles(dir) {
    const res = [];
    for (const e of await readdir(dir, {withFileTypes: true})) {
      const name = dir + '/' + e.name;
      if (e.isDirectory()) res.push(...await listFiles(name));
      else res.push(name);
    }
    return res;
  }
  const releaseFiles = [
    'main.js', 'manifest.json', 'styles.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    '安装说明.md', '安装或修复.command', 'Mac本地安装.command', 'Mac恢复iCloud安装.command',
    ...(await listFiles('runtime-assets')).sort()
  ];
  verifyReleaseInventory(releaseFiles);
  await createBuildReceipt(manifest, releaseFiles);
}
