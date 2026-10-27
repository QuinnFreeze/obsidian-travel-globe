import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zoomAltitude,MIN_ALTITUDE,MAX_ALTITUDE,mercatorY,tileLatitude,visibleTiles} from '../src/zoom';
test('zoom scales height continuously across the old handoff boundary and reverses',()=>{
 for(const start of [2,.3,.251,.25,.01,.001]){const next=zoomAltitude(start,-.2);assert.ok(next<start);assert.ok(Math.abs(zoomAltitude(next,.2)-start)<1e-10);}
 assert.equal(zoomAltitude(MIN_ALTITUDE,-.5),MIN_ALTITUDE);assert.equal(zoomAltitude(MAX_ALTITUDE,.5),MAX_ALTITUDE);
});
test('Mercator inverse preserves WGS84 latitude at city, equator and polar limits',()=>{
 for(const lat of [-85,-33.86,0,31.23,80,85])assert.ok(Math.abs(tileLatitude(mercatorY(lat)*2**14,14)-lat)<1e-10);
});
test('date-line footprints wrap locally rather than loading a world-spanning strip',()=>{
 const tiles=visibleTiles([{lat:1,lng:179.9},{lat:-1,lng:-179.9}],{lat:0,lng:180},.01,800,50,64);
 assert.ok(tiles.length>0&&tiles.length<=64);assert.ok(tiles.some(t=>t.x===0)&&tiles.some(t=>t.x===2**t.z-1));
 assert.equal(new Set(tiles.map(t=>t.key)).size,tiles.length);
});
test('LOD obeys viewport budget, native resolution and offline polar fallback',()=>{
 const samples=[{lat:31.2,lng:121.4},{lat:31.3,lng:121.5}];
 const coarse=visibleTiles(samples,{lat:31.25,lng:121.45},.2,800,50,40),fine=visibleTiles(samples,{lat:31.25,lng:121.45},.001,800,50,40);
 assert.ok(coarse.length&&fine.length);assert.ok(fine[0].z>coarse[0].z);assert.ok(fine.length<=40&&fine[0].z<=14);
 assert.deepEqual(visibleTiles(samples,{lat:89,lng:0},.01,800,50,40),[]);
 assert.deepEqual(visibleTiles(samples,{lat:31,lng:121},1,800,50,40),[]);
});
