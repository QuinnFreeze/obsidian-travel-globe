import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

async function ensureMainJsBuilt(): Promise<string> {
  let needsBuild = false;
  try {
    const s = await stat('main.js');
    if (s.size < 1000) needsBuild = true;
  } catch {
    needsBuild = true;
  }

  if (needsBuild) {
    const buildProc = spawnSync(process.execPath, ['esbuild.config.mjs'], {
      encoding: 'utf8',
      timeout: 120000
    });
    if (buildProc.status !== 0) {
      throw new Error('自动构建 main.js 失败:\n' + (buildProc.stderr || buildProc.stdout));
    }
  }

  return readFile('main.js', 'utf8');
}

test('built main.js does not contain dynamic runtime renderer loader or external worker reads', async () => {
  const code = await ensureMainJsBuilt();

  // Verify that the old new Function wrapper and file read paths are eliminated
  assert.equal(code.includes('sourceURL=travel-globe-renderer.js'), false, '不得包含动态 new Function 渲染器加载器');
  assert.equal(code.includes('runtime-assets/renderer.js'), false, '不得包含运行时读取 runtime-assets/renderer.js');
  assert.equal(code.includes('runtime-assets/cloud-worker.js'), false, '不得包含运行时读取 runtime-assets/cloud-worker.js');

  // Verify GlobeCanvas is embedded directly inside main.js
  assert.ok(code.includes('GlobeCanvas'), '必须包含内嵌的 GlobeCanvas 渲染器');
  assert.ok(code.includes('Travel Globe — bundled offline assets'), '必须包含离线构建说明横幅');
});

test('built main.js instantiates in mock obsidian environment and loadRenderer returns GlobeCanvas', async () => {
  const code = await ensureMainJsBuilt();

  class MockWorker {
    terminated = false;
    constructor(public url: string | URL) {}
    terminate() { this.terminated = true; }
  }

  // Mock minimal obsidian API required for plugin evaluation and execution
  const mockObsidian = {
    Plugin: class Plugin {
      app = {
        vault: { adapter: {} },
        workspace: { detachLeavesOfType: () => {} }
      };
      manifest = { dir: '', version: '0.8.3' };
    },
    PluginSettingTab: class PluginSettingTab {},
    Setting: class Setting {
      setName() { return this; }
      setDesc() { return this; }
      addToggle() { return this; }
      addButton() { return this; }
      addDropdown() { return this; }
      addText() { return this; }
    },
    Notice: class Notice {},
    parseYaml: (_s: string) => ({}),
    TFolder: class TFolder {},
    TFile: class TFile {},
    normalizePath: (p: string) => p,
    requestUrl: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) }),
    ItemView: class ItemView {},
    Platform: { isMobile: false },
    Component: class Component {},
    MarkdownRenderer: { render: async () => {} },
    Modal: class Modal {}
  };

  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    require: (mod: string) => {
      if (mod === 'obsidian') return mockObsidian;
      throw new Error('Unknown module ' + mod);
    },
    Worker: MockWorker,
    console,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    Error,
    Promise,
    URL,
    Blob,
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  interface PluginInstance {
    loadRenderer: () => Promise<{ GlobeCanvas: unknown }>;
    rendererWorkers?: { size: number };
    stopped: boolean;
    onunload: () => void;
  }

  const PluginClass = (sandbox.module as { exports: { default?: new (...args: unknown[]) => PluginInstance } }).exports.default;
  assert.ok(typeof PluginClass === 'function', 'main.js 必须导出 Plugin 类');

  const plugin = new PluginClass();
  const renderer = await plugin.loadRenderer();
  assert.equal(typeof renderer.GlobeCanvas, 'function', 'loadRenderer 必须返回包含 GlobeCanvas 的渲染模块');
  assert.ok(plugin.rendererWorkers, 'plugin.rendererWorkers 必须在 loadRenderer 成功后被赋值');

  plugin.onunload();
  assert.equal(plugin.stopped, true, 'onunload 必须将 plugin.stopped 设为 true');
});
