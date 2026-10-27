// Structural contract against the shipped stylesheet and view DOM, not a copied layout.
// Browser geometry/scroll accessibility must additionally be checked by the host QA.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../styles-base.css',import.meta.url),'utf8');
const view=readFileSync(new URL('../src/view.ts',import.meta.url),'utf8');
const compact=css.slice(css.indexOf('/* Compact maps allocate real rows'));
test('compact controls reserve separate zoom and layer grid columns',()=>{
 assert.ok(compact.length>1000);assert.match(compact,/grid-template-columns:94px minmax\(0,1fr\)/);
 assert.match(compact,/grid-template-rows:auto auto minmax\(64px,1fr\) auto/);
 assert.match(compact,/>\.tg-zoom-controls\s*\{[^}]*grid-column:1/);
 assert.match(compact,/>\.tg-layers\s*\{[^}]*grid-column:2/);
 assert.match(compact,/overflow-x:auto/);assert.match(compact,/flex-wrap:nowrap/);
 assert.doesNotMatch(css,/@container[^}]*\{\s*\.tg-mobile \.tg-zoom-controls\s*\{\s*display:none/);
});
test('existing DOM exposes every layer control and 44px compact targets',()=>{
 assert.match(view,/layers\.append\(this\.mapStyleSelect,this\.borderToggle,this\.labelToggle,this\.cloudToggle,terrain,this\.qualityMenu\)/);
 assert.match(view,/this\.stage\.append\(zoom\)/);
 assert.match(compact,/min-width:44px/);assert.match(compact,/min-height:44px!important/);
});
test('banner list footer and credits do not share the toolbar row',()=>{
 for(const [cls,row] of [['tg-pick-banner',2],['tg-list',3],['tg-stage-footer',4]]){
  assert.match(compact,new RegExp('>\\.'+cls+'\\s*\\{[^}]*grid-row:'+row));
 }
 assert.match(compact,/>\.tg-canvas\s*\{[^}]*grid-row:3/);
 assert.match(compact,/\.tg-credit-disclosure\s*\{[^}]*bottom:6px/);
 assert.match(css,/\.tg-app>\.tg-quality-panel/);
 assert.doesNotMatch(compact,/\.tg-(?:zoom-controls|layers)[^}]*display:none/);
});
