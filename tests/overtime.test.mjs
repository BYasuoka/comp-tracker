import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
new vm.Script(source);
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function overtimeWeek('),source.indexOf('function overtimeView(')),context);
const calc=(hours,extra=[])=>context.overtimeWeek({entries:[...hours.map((hours,i)=>({hours,date:`day${i}`,description:'Work',activity:'TTO'})),...extra]});
test('40-hour gate and daily overtime',()=>{
 assert.equal(calc([10,8,8,8]).total,0);
 assert.equal(calc([10,8,8,8,6]).total,2);
 assert.equal(calc([8,8,8,8,8]).total,0);
});
test('daily and weekly overtime do not overlap',()=>{
 const o=calc([10,10,10,10,10]);assert.equal(o.daily,10);assert.equal(o.weekly,0);assert.equal(o.total,10);
 const six=calc([10,10,10,10,10,8]);assert.equal(six.daily,10);assert.equal(six.weekly,8);assert.equal(six.total,18);
 assert.equal(calc([8,8,8,8,8,8]).total,8);
});
test('PTO and holiday credit count toward 40 without daily OT',()=>{
 const pto={hours:8,date:'day4',rawProject:'Vacation'};
 assert.equal(calc([10,8,8,8],[pto]).total,2);
 assert.equal(calc([8,8,8,8],[{...pto,rawProject:'Holiday'}]).total,0);
 assert.equal(calc([],[{...pto,hours:48}]).total,0);
 assert.equal(calc([8,8,8,8],[{...pto,description:'Vacation / Sick / Holiday',rawProject:''}]).credit,8);
});
test('same-day work across projects combines before daily threshold',()=>{
 assert.equal(calc([6,8,8,8,8],[{hours:4,date:'day0',rawProject:'P123-01',activity:'TFROM'}]).total,2);
});
test('uncertain sick leave and invalid durations require review',()=>{
 assert.equal(calc([8,8,8,8],[{hours:8,date:'day4',rawProject:'Sick'}]).total,null);
 assert.equal(calc([25,8,8]).total,null);
 assert.equal(calc([-1,8,8]).total,null);
});
test('OT view excludes superseded weeks and filters complete weeks by ending date',()=>{
 const week=(hash,week,active)=>({hash,week,active,entries:[{hours:10,date:'a'},{hours:10,date:'b'},{hours:10,date:'c'},{hours:10,date:'d'}]});
 Object.assign(context,{db:{weeks:[week('selected','2026-09-19',true),week('old','2026-09-19',false),week('outside','2026-09-26',true)]},filter:{from:'2026-09-19',to:'2026-09-19',project:'P999'},num:String,esc:String,card:(a,b)=>a+':'+b,panel:(a,b)=>a+b,table:(a,b)=>b});
 vm.runInContext(source.slice(source.indexOf('function overtimeView('),source.indexOf('function workbookStatus(')),context);
 const html=context.overtimeView();
 assert.match(html,/Estimated OT:8 h/);
 assert.match(html,/data-week="selected"/);
 assert.doesNotMatch(html,/data-week="old"|data-week="outside"/);
});
