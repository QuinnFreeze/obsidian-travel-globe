declare module 'embedded:renderer' {
  export function createRenderer(Worker: typeof globalThis.Worker): typeof import('./globe');
}

declare module 'embedded:cloud-worker' {
  export const CLOUD_WORKER_SOURCE: string;
}
