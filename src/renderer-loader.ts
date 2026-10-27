import {RendererWorkers} from './renderer-workers';
import type {GlobeCanvas} from './globe';

export interface RendererModule {
  GlobeCanvas: typeof GlobeCanvas;
  [key: string]: unknown;
}

export interface LoaderHost {
  isStopped: () => boolean;
  getWorkerConstructor: () => typeof Worker;
  setRendererWorkers: (workers: RendererWorkers) => void;
  createRenderer: (WorkerClass: typeof Worker) => RendererModule;
}

export function executeRendererLoader(host: LoaderHost): RendererModule {
  if (host.isStopped()) throw Error('插件已关闭');
  const localWorkers = new RendererWorkers(host.getWorkerConstructor());
  let exports: RendererModule;
  try {
    exports = host.createRenderer(localWorkers.Worker);
  } catch (e) {
    localWorkers.dispose();
    throw e;
  }
  if (host.isStopped()) {
    localWorkers.dispose();
    throw Error('插件已关闭');
  }
  if (typeof exports?.GlobeCanvas !== 'function') {
    localWorkers.dispose();
    throw Error('地球渲染文件不完整，请重新安装插件。');
  }
  host.setRendererWorkers(localWorkers);
  return exports;
}
