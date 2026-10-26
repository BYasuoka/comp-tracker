import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {emptyStore,mutate} from '../github/model.mjs';
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
new vm.Script(source);
const ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function overtimeWeek('),source.indexOf('function overtimeView(')),ctx);
const rule={effective:'2026-01-01',billableOnsite:100,billableTravel:60};
const projects=[{code:'P1',rules:[rule]},{code:'P2',rules:[{...rule,billableOnsite:120}]}];
const entry=(day,hours,activity='C',project='P1',start=8/24)=>({id:day+activity+project,date:'2026-10-'+String(18+day).padStart(2,'0'),hours,activity,project,start});
const calc=entries=>ctx.overtimeWeek({entries},projects,[]);
const example=[entry(0,5,'TTO'),...Array.from({length:5},(_,i)=>entry(i+1,10)),entry(6,5,'TFROM')];
test('user example: 15 onsite and 5 travel OT hours at half billable rates',()=>{
 const o=calc(example);assert.equal(o.rows.filter(r=>r.kind==='onsite').reduce((s,r)=>s+r.hours,0),15);assert.equal(o.rows.filter(r=>r.kind==='travel').reduce((s,r)=>s+r.hours,0),5);assert.equal(o.rows.reduce((s,r)=>s+r.pay,0),900);assert.equal(o.rows[0].date,'2026-10-22');assert.equal(o.rows[0].hours,5);
});
test('no daily OT; 40 across projects, then correct project rate',()=>{
 assert.equal(calc([entry(0,10),entry(1,10),entry(2,10),entry(3,10)]).rows.length,0);
 const o=calc([entry(0,10),entry(1,10),entry(2,10),entry(3,10),entry(4,5,'C','P2')]);assert.equal(o.rows[0].pay,300);
});
test('travel and paid leave count toward threshold but leave does not earn OT',()=>{
 const o=calc([entry(0,8),entry(1,8),entry(2,8),entry(3,8),{...entry(4,8),rawProject:'Holiday'},entry(5,5,'TFROM'),{...entry(6,8),rawProject:'Vacation'}]);assert.equal(o.rows.length,1);assert.equal(o.rows[0].pay,150);
});
test('dated billable rates and assignment; legacy rates never substituted',()=>{
 const entries=[entry(0,24),entry(1,16),entry(2,2)];
 assert.equal(ctx.overtimeWeek({entries},[{code:'P1',rules:[{effective:'2026-01-01',onsite:999}]}],[]).rows[0].pay,null);
 const p=[{code:'P1',rules:[rule,{...rule,effective:'2026-10-20',billableOnsite:200}]}];assert.equal(ctx.overtimeWeek({entries},p,[]).rows[0].pay,200);
 assert.equal(ctx.overtimeWeek({entries},projects,[{id:entries[2].id,project:'P2'}]).rows[0].pay,120);
});
test('mixed threshold day uses start times; missing order requires review',()=>{
 const entries=[entry(0,20),entry(1,15),entry(2,5,'TTO','P1',6/24),entry(2,5,'C','P2',11/24)];
 assert.equal(calc(entries).rows[0].pay,300);entries[2].start=null;assert.equal(calc(entries).rows[0].pay,null);
});
test('unknown activity and missing rates never show zero pay',()=>{
 const entries=[entry(0,20),entry(1,20),entry(2,5,'M')];assert.equal(calc(entries).rows[0].pay,null);
 entries[2].activity='C';entries[2].project='P3';assert.equal(calc(entries).rows[0].pay,null);
});
test('billable rate fields persist and legacy rates are retained',()=>{
 const db=mutate(emptyStore(),'project',{code:'P100-01',description:'Example',rule:{effective:'2026-01-01',mode:'weekly40',onsite:55,billableOnsite:120,billableTravel:80}});
 assert.equal(db.projects[0].rules[0].billableOnsite,120);assert.equal(db.projects[0].rules[0].onsite,55);
 assert.throws(()=>mutate(db,'project',{code:'P100-01',rule:{effective:'2026-01-01',mode:'weekly40',billableOnsite:-1}}));
});
test('project filter applies after weekly allocation and excludes superseded workbooks',()=>{
 Object.assign(ctx,{db:{weeks:[{hash:'active',week:'2026-10-24',active:true,entries:example},{hash:'old',week:'2026-10-24',active:false,entries:example}],projects,assignments:[]},filter:{from:'2026-10-24',to:'2026-10-24',project:'P1'},num:String,esc:String,money:n=>'$'+n,sum:(a,k)=>a.reduce((s,x)=>s+x[k],0),panel:(a,b)=>a+b,card:(a,b)=>a+':'+b,table:(a,b)=>a.join(' ')+b});
 vm.runInContext(source.slice(source.indexOf('function overtimeView('),source.indexOf('function workbookStatus(')),ctx);
 const html=ctx.overtimeView();assert.match(html,/Combined OT pay:\$900/);assert.doesNotMatch(html,/data-week="old"/);assert.match(html,/Billable rate/);
});
test('General hours at week end fill initial 40 before project work',()=>{
 const general={...entry(6,1,'-','UNASSIGNED'),description:'General',start:null};
 const o=calc([entry(0,10),entry(1,10),entry(2,10),entry(3,10),general]);
 assert.equal(o.general,1);assert.equal(o.credited,41);assert.equal(o.rows.length,1);assert.equal(o.rows[0].hours,1);assert.equal(o.rows[0].kind,'onsite');assert.equal(o.rows[0].pay,50);
 assert.equal(calc([entry(0,10),entry(1,10),entry(2,10),entry(3,9),general]).rows.length,0);
});
test('General credit shifts OT to project travel and never earns its own OT',()=>{
 const general={...entry(6,0.5,'-','UNASSIGNED'),description:' General '};
 const o=calc([entry(0,20),entry(1,18),entry(2,6,'TFROM'),general]);
 assert.equal(o.rows[0].hours,4.5);assert.equal(o.rows[0].pay,135);
 assert.equal(calc([{...general,hours:41}]).rows.length,0);
});
test('summary cards retain known pay and show caution only for incomplete totals',()=>{
 vm.runInContext(source.slice(source.indexOf('function card('),source.indexOf('function panel(')),ctx);
 const entries=example.map(e=>({...e}));entries[6].project='P3';entries.push(entry(6,1,'TFROM','P1',14/24));
 ctx.db={weeks:[{hash:'active',week:'2026-10-24',active:true,entries}],projects,assignments:[]};ctx.filter={};
 const html=ctx.overtimeView(),cards=html.slice(html.indexOf('<div class="cards">'),html.indexOf('OT by project'));
 assert.match(cards,/Travel OT pay<\/div><div class="value">\$30/);
 assert.match(cards,/Combined OT pay<\/div><div class="value">\$780/);
 assert.equal((cards.match(/class="card-warning"/g)||[]).length,2);
 assert.match(cards,/1 pending entry excluded/);
 entries[6].project='P1';const complete=ctx.overtimeView();assert.doesNotMatch(complete,/class="card-warning"/);
});
