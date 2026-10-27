import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeRendererLoader,type LoaderHost,type RendererModule} from '../src/renderer-loader';
import {RendererWorkers} from '../src/renderer-workers';
import {lazyResource} from '../src/lazy';

class FakeWorker {
  terminated = false;
  constructor(public url: string | URL) {}
  terminate() { this.terminated = true; }
}

test('executeRendererLoader creates scoped workers and returns valid GlobeCanvas', () => {
  let assignedWorkers: RendererWorkers | undefined;
  let receivedWorkerConstructor: typeof Worker | undefined;
  let activeWorker: FakeWorker | undefined;

  const host: LoaderHost = {
    isStopped: () => false,
    getWorkerConstructor: () => FakeWorker as unknown as typeof Worker,
    setRendererWorkers: workers => { assignedWorkers = workers; },
    createRenderer: WorkerClass => {
      receivedWorkerConstructor = WorkerClass;
      activeWorker = new WorkerClass('cesium-task.js') as unknown as FakeWorker;
      return {
        GlobeCanvas: function MockCanvas() {} as unknown as typeof import('../src/globe').GlobeCanvas
      };
    }
  };

  const result = executeRendererLoader(host);
  assert.equal(typeof result.GlobeCanvas, 'function');
  assert.ok(assignedWorkers instanceof RendererWorkers);
  assert.equal(assignedWorkers.size, 1);
  assert.equal(activeWorker?.terminated, false);

  // When plugin unloads, scoped workers terminate
  assignedWorkers.dispose();
  assert.equal(activeWorker?.terminated, true);
  assert.equal(assignedWorkers.size, 0);
});

test('executeRendererLoader cleans up workers and throws if createRenderer fails', () => {
  let assignedWorkers: RendererWorkers | undefined;
  let createdWorker: FakeWorker | undefined;

  const host: LoaderHost = {
    isStopped: () => false,
    getWorkerConstructor: () => FakeWorker as unknown as typeof Worker,
    setRendererWorkers: workers => { assignedWorkers = workers; },
    createRenderer: WorkerClass => {
      createdWorker = new WorkerClass('failing-init.js') as unknown as FakeWorker;
      throw new Error('WebGL 模拟初始化错误');
    }
  };

  assert.throws(() => executeRendererLoader(host), /WebGL 模拟初始化错误/);
  assert.equal(assignedWorkers, undefined);
  assert.equal(createdWorker?.terminated, true, '失败时创建的 Worker 必须被立即销毁终止');
});

test('executeRendererLoader rejects incomplete exports and disposes workers', () => {
  let assignedWorkers: RendererWorkers | undefined;
  let createdWorker: FakeWorker | undefined;

  const host: LoaderHost = {
    isStopped: () => false,
    getWorkerConstructor: () => FakeWorker as unknown as typeof Worker,
    setRendererWorkers: workers => { assignedWorkers = workers; },
    createRenderer: WorkerClass => {
      createdWorker = new WorkerClass('task.js') as unknown as FakeWorker;
      return {} as unknown as RendererModule; // Missing GlobeCanvas
    }
  };

  assert.throws(() => executeRendererLoader(host), /地球渲染文件不完整/);
  assert.equal(assignedWorkers, undefined);
  assert.equal(createdWorker?.terminated, true, '导出缺失时已创建的 Worker 必须被销毁');
});

test('executeRendererLoader rejects when stopped guard is active', () => {
  let createCalled = false;
  const host: LoaderHost = {
    isStopped: () => true,
    getWorkerConstructor: () => FakeWorker as unknown as typeof Worker,
    setRendererWorkers: () => {},
    createRenderer: () => {
      createCalled = true;
      return { GlobeCanvas: function MockCanvas() {} as unknown as typeof import('../src/globe').GlobeCanvas };
    }
  };

  assert.throws(() => executeRendererLoader(host), /插件已关闭/);
  assert.equal(createCalled, false);
});

test('executeRendererLoader wrapped in lazyResource deduplicates and cleans up on failure', async () => {
  let loadCount = 0;
  let shouldFail = true;
  let capturedWorkers: RendererWorkers | undefined;

  const loadRenderer = lazyResource(async () => {
    loadCount++;
    return executeRendererLoader({
      isStopped: () => false,
      getWorkerConstructor: () => FakeWorker as unknown as typeof Worker,
      setRendererWorkers: w => { capturedWorkers = w; },
      createRenderer: WorkerClass => {
        if (shouldFail) {
          new WorkerClass('error.js');
          throw new Error('首次加载异常');
        }
        new WorkerClass('success.js');
        return { GlobeCanvas: function Canvas() {} as unknown as typeof import('../src/globe').GlobeCanvas };
      }
    });
  });

  // Concurrent failed attempts share same failure and reset lazyResource cache
  await Promise.all([
    assert.rejects(loadRenderer(), /首次加载异常/),
    assert.rejects(loadRenderer(), /首次加载异常/)
  ]);
  assert.equal(loadCount, 1);
  assert.equal(capturedWorkers, undefined);

  // Subsequent attempt succeeds and deduplicates concurrent calls
  shouldFail = false;
  const [res1, res2] = await Promise.all([loadRenderer(), loadRenderer()]);
  assert.equal(res1, res2);
  assert.equal(loadCount, 2);
  assert.equal(typeof res1.GlobeCanvas, 'function');
  assert.ok(capturedWorkers);
  assert.equal(capturedWorkers.size, 1);
  capturedWorkers.dispose();
  assert.equal(capturedWorkers.size, 0);
});
