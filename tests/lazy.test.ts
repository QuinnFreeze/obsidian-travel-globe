import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lazyResource} from '../src/lazy';

test('renderer is untouched until requested; concurrent and later opens share the same load',async()=>{
  let calls=0;let release!:(value:object)=>void;
  const load=lazyResource(()=>{calls++;return new Promise<object>(resolve=>release=resolve);});
  assert.equal(calls,0);
  const first=load(),second=load();assert.equal(first,second);
  await Promise.resolve();assert.equal(calls,1);
  const renderer={};release(renderer);
  assert.equal(await first,renderer);assert.equal(await load(),renderer);assert.equal(calls,1);
});

test('failed local renderer reads and synchronous failures can be retried',async()=>{
  let calls=0;const load=lazyResource(async()=>{if(++calls===1)throw Error('iCloud pending');return 'ready';});
  await assert.rejects(load(),/iCloud pending/);assert.equal(await load(),'ready');assert.equal(calls,2);
  let attempts=0;const sync=lazyResource(()=>{if(++attempts===1)throw Error('incomplete');return Promise.resolve('ready');});
  await assert.rejects(sync(),/incomplete/);assert.equal(await sync(),'ready');
});
