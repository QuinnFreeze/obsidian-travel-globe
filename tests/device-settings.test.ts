import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEVICE_KEYS,devicePreferences,resolveSettings,sharedSettingsPatch} from '../src/device-settings';
import {DEFAULTS} from '../src/model';

test('one shared vault can resolve different device preferences without mutating the shared data',()=>{
 const saved={quality:'high',settingsVersion:3,recordsFolder:'旅行记录',showClouds:true,custom:'keep'};
 const snapshot=JSON.stringify(saved);
 assert.equal(resolveSettings(saved,{quality:'ultra'}).quality,'ultra');
 assert.equal(resolveSettings(saved,{quality:'standard',showClouds:false}).quality,'standard');
 assert.equal(resolveSettings(saved,{quality:'standard',showClouds:false}).showClouds,false);
 assert.equal(JSON.stringify(saved),snapshot);
 assert.deepEqual(sharedSettingsPatch({quality:'clear',theme:'light',showClouds:false,recordsFolder:'新记录'}),{recordsFolder:'新记录'});
});
test('old high migration, corrupt local data, and unsafe folders remain guarded',()=>{
 assert.equal(resolveSettings({quality:'high'},null).quality,'standard');
 assert.equal(resolveSettings({quality:'high'},{quality:'clear'}).quality,'clear');
 assert.equal(resolveSettings({quality:'high',settingsVersion:3},null).quality,'high');
 assert.deepEqual(devicePreferences({quality:'invalid',showClouds:'yes',listOnly:false}),{listOnly:false});
 assert.deepEqual(devicePreferences(null),{});
 assert.equal(resolveSettings({},null).theme,'auto');
 assert.equal(resolveSettings({theme:'invalid'},{theme:'dark'}).theme,'dark');
 assert.equal(resolveSettings({theme:'invalid'},{theme:'invalid'}).theme,'auto');
 assert.deepEqual(devicePreferences({theme:'light'}),{theme:'light'});
 assert.equal(resolveSettings({earthOnline:'invalid'},[]).earthOnline,true);
 assert.throws(()=>resolveSettings({recordsFolder:'../private'},null),/相对|普通/);
});

test('device isolation strips mapStyle and atlas preferences from shared patch', () => {
 for (const key of ['mapStyle', 'atlasBorders', 'atlasLabels', 'showCountryNames'] as const) {
  assert.ok(DEVICE_KEYS.includes(key), `DEVICE_KEYS should include ${key}`);
 }
 const patch = {
  mapStyle: 'atlas' as const,
  atlasBorders: false,
  atlasLabels: false,
  showCountryNames: true,
  recordsFolder: '新旅行记录'
 };
 const stripped = sharedSettingsPatch(patch);
 assert.deepEqual(stripped, {recordsFolder: '新旅行记录'});
 assert.equal((stripped as any).mapStyle, undefined);
 assert.equal((stripped as any).atlasBorders, undefined);
 assert.equal((stripped as any).atlasLabels, undefined);
 assert.equal((stripped as any).showCountryNames, undefined);
});

test('mapStyle and atlas preference validation with illegal fallback', () => {
 assert.equal(devicePreferences({mapStyle: 'atlas'}).mapStyle, 'atlas');
 assert.equal(devicePreferences({mapStyle: 'natural'}).mapStyle, 'natural');
 assert.equal(devicePreferences({mapStyle: 'satellite'}).mapStyle, undefined);
 assert.equal(devicePreferences({mapStyle: 123}).mapStyle, undefined);
 assert.equal(devicePreferences({mapStyle: null}).mapStyle, undefined);

 assert.deepEqual(devicePreferences({atlasBorders: false, atlasLabels: true, showCountryNames: false}), {
  atlasBorders: false,
  atlasLabels: true,
  showCountryNames: false
 });
 assert.deepEqual(devicePreferences({atlasBorders: 'yes', atlasLabels: 1, showCountryNames: null}), {});

 const fallbackFromSaved = resolveSettings({mapStyle: 'invalid_style'}, null);
 assert.equal(fallbackFromSaved.mapStyle, 'natural');
 const fallbackFromLocal = resolveSettings({}, {mapStyle: 'unsupported'});
 assert.equal(fallbackFromLocal.mapStyle, 'natural');

 const corruptBooleans = resolveSettings({atlasBorders: 'bad', atlasLabels: null, showCountryNames: 42}, {});
 assert.equal(corruptBooleans.atlasBorders, DEFAULTS.atlasBorders);
 assert.equal(corruptBooleans.atlasLabels, DEFAULTS.atlasLabels);
 assert.equal(corruptBooleans.showCountryNames, DEFAULTS.showCountryNames);
 assert.equal(corruptBooleans.settingsVersion, 4);
});

test('natural and atlas switches are independent and do not interfere', () => {
 const resolved = resolveSettings(
  {showBorders: true, showClouds: true},
  {mapStyle: 'atlas', atlasBorders: false, atlasLabels: false, showCountryNames: true}
 );
 assert.equal(resolved.mapStyle, 'atlas');
 assert.equal(resolved.showBorders, true);
 assert.equal(resolved.atlasBorders, false);
 assert.equal(resolved.showCountryNames, true);
 assert.equal(resolved.atlasLabels, false);
 assert.equal(resolved.showClouds, true);

 const naturalResolved = resolveSettings(
  {},
  {mapStyle: 'natural', showBorders: false, atlasBorders: true, showCountryNames: false, atlasLabels: true}
 );
 assert.equal(naturalResolved.mapStyle, 'natural');
 assert.equal(naturalResolved.showBorders, false);
 assert.equal(naturalResolved.atlasBorders, true);
 assert.equal(naturalResolved.showCountryNames, false);
 assert.equal(naturalResolved.atlasLabels, true);
});
