import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeRecord,renderNote,filterRecords,validateInput,type TravelInput} from '../src/model';
import {formatTripDate,tripYears} from '../src/trip-dates';
const input:TravelInput={place_id:'synthetic:1',city:'测试城',country_code:'CN',country_name:'测试国',latitude:30,longitude:120,date:'2026-12-31',photos:[],body:'合成测试，不是用户笔记。'};
const parse=(yaml:string)=>Object.fromEntries(yaml.split('\n').map(line=>{const at=line.indexOf(':');const value=line.slice(at+1).trim();return [line.slice(0,at),value==='travel'?value:JSON.parse(value)];}));
test('old single-day notes retain byte-identical output and absent optional keys',()=>{
 const note=renderNote(input);
 const expected=['---','type: travel','place_id: "synthetic:1"','city: "测试城"','country_code: "CN"','country_name: "测试国"','latitude: 30','longitude: 120','date: "2026-12-31"','photos: []','---','','# 测试城 · 2026-12-31','','合成测试，不是用户笔记。',''].join('\n');
 assert.equal(note,expected);const record=decodeRecord('synthetic.md',note,parse)!;
 assert.equal(Object.hasOwn(record,'end_date'),false);assert.equal(Object.hasOwn(record,'time_of_day'),false);assert.equal(formatTripDate(record),'2026-12-31');
});
test('two-day evening round trip displays both years and participates in both filters',()=>{
 const extended={...input,end_date:'2027-01-01',time_of_day:'evening' as const};
 const text=renderNote(extended),record=decodeRecord('synthetic.md',text,parse)!;
 assert.equal(record.end_date,'2027-01-01');assert.equal(record.time_of_day,'evening');
 assert.equal(formatTripDate(record),'2026-12-31 – 2027-01-01 · 晚上');assert.deepEqual(tripYears(record),['2026','2027']);
 assert.equal(filterRecords([record],{year:'2027',country:'CN'}).length,1);assert.match(text,/# 测试城 · 2026-12-31 – 2027-01-01 · 晚上/);
});
test('single-day optional time and equal end date do not repeat dates',()=>{
 assert.equal(formatTripDate({...input,end_date:input.date,time_of_day:'night'}),'2026-12-31 · 深夜');
 assert.equal(decodeRecord('a.md',renderNote({...input,time_of_day:'morning'}),parse)!.time_of_day,'morning');
});
test('invalid calendar/range/time fail before note writes; malformed optional YAML is rejected',()=>{
 for(const end of ['2026-12-30','2027-02-29','not-date'])assert.throws(()=>validateInput({...input,end_date:end}),/结束日期/);
 assert.throws(()=>renderNote({...input,time_of_day:'bogus' as any}),/时段/);
 assert.throws(()=>decodeRecord('bad.md',renderNote(input).replace('photos: []','end_date: 42\nphotos: []'),parse),/结束日期/);
 assert.throws(()=>decodeRecord('bad.md',renderNote(input).replace('photos: []','time_of_day: 42\nphotos: []'),parse),/时段/);
});

test('hand-written Chinese time labels decode without rewriting the source note',()=>{
 const original=renderNote(input).replace('photos: []','time_of_day: "晚上"\nphotos: []');
 const record=decodeRecord('synthetic-chinese-evening.md',original,parse)!;
 assert.equal(record.time_of_day,'evening');assert.equal(formatTripDate(record),'2026-12-31 · 晚上');
 assert.match(original,/time_of_day: "晚上"/);
 for(const [label,value] of [['上午','morning'],['下午','afternoon'],['深夜','night']]) {
  const text=renderNote(input).replace('photos: []','time_of_day: '+JSON.stringify(label)+'\nphotos: []');
  assert.equal(decodeRecord('synthetic.md',text,parse)!.time_of_day,value);
 }
});
