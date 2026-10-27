import {test} from 'node:test';import assert from 'node:assert/strict';
import {RendererWorkers} from '../src/renderer-workers';
test('engine-owned workers terminate on unload without touching other workers',()=>{
 class FakeWorker {terminated=false;constructor(_url:string|URL,_options?:WorkerOptions){}terminate(){this.terminated=true;}}
 const unrelated=new FakeWorker('other'),scope=new RendererWorkers(FakeWorker as unknown as typeof Worker);
 const a=new scope.Worker('a') as unknown as FakeWorker,b=new scope.Worker('b') as unknown as FakeWorker;
 assert.equal(scope.size,2);a.terminate();assert.equal(scope.size,1);scope.dispose();assert.equal(b.terminated,true);assert.equal(unrelated.terminated,false);assert.equal(scope.size,0);
 assert.throws(()=>new scope.Worker('late'),/关闭/);scope.dispose();
});
