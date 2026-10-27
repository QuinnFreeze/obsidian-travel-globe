import {test} from 'node:test';import assert from 'node:assert/strict';
import {configureCityLoader,searchCities} from '../src/cities';
test('city catalog is deferred, concurrent reads deduplicate and a failed read is retried',async()=>{
 let calls=0;configureCityLoader(async()=>{calls++;if(calls===1)throw Error('目录尚未下载');return [['1','上海','CN','31',31.2,121.4,'shanghai|上海']];});
 assert.equal(calls,0);assert.equal((await searchCities('上')).total,0);assert.equal(calls,0);
 await assert.rejects(searchCities('上海'),/尚未下载/);
 const results=await Promise.all([searchCities('上海'),searchCities('shanghai')]);
 assert.equal(calls,2);assert.ok(results.every(r=>r.total===1));assert.equal(results[0]!.results[0]!.country_name,'中国');
});
test('broad mobile search counts all matches but prioritizes exact aliases in bounded results',async()=>{
 const rows=Array.from({length:10000},(_,i)=>[String(i),'Paris '+i,'FR','',48,2,'paris'+i]);
 rows.push(['exact','巴黎','FR','',48,2,'paris|巴黎']);
 configureCityLoader(async()=>rows);
 const found=await searchCities('Paris');
 assert.equal(found.total,10001);assert.equal(found.results.length,30);
 assert.equal(found.results[0]!.id,'geonames:exact');
 assert.equal((await searchCities('Paris','CN')).total,0);
 assert.equal((await searchCities('paris9')).results[0]!.id,'geonames:9');
});
