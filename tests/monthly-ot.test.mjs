import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyStore,mutate} from '../github/model.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const project='P100-01';
const fixture=()=>mutate(emptyStore(),'project',{code:project,description:'Test'});
const body=(month='2026-08')=>({project,workMonth:month,rows:[{date:month+'-20',project,kind:'onsite',hours:2,rate:100,pay:100},{date:month+'-21',project,kind:'travel',hours:1,rate:60,pay:30}]});
test('monthly claims save expected payment months and immutable calculation snapshots',()=>{
 const original=fixture(),db=mutate(original,'otClaim',body()),c=db.manualClaims[0];
 assert.equal(c.amount,130);assert.equal(c.date,'2026-08-31');assert.equal(c.expectedMonth,'2026-12');assert.equal(c.otRows.length,2);assert.equal(original.manualClaims.length,0);
 assert.equal(mutate(original,'otClaim',body('2026-09')).manualClaims[0].expectedMonth,'2027-01');
});
test('partial and full monthly receipts use existing claim matching',()=>{
 let db=mutate(fixture(),'otClaim',body());const id=db.manualClaims[0].id;
 for(const amount of [50,80])db=mutate(db,'payment',{date:'2026-12-15',amount,allocations:[{claimId:id,amount}]});
 assert.equal(db.payments.reduce((s,p)=>s+p.allocations[0].amount,0),130);assert.equal(db.payments[0].allocations[0].sourceAmount,130);
});
test('duplicate claims blocked; void permits replacement without deleting receipts',()=>{
 let db=mutate(fixture(),'otClaim',body());assert.throws(()=>mutate(db,'otClaim',body()),/already exists/);
 const id=db.manualClaims[0].id;db=mutate(db,'payment',{date:'2026-12-15',amount:50,allocations:[{claimId:id,amount:50}]});
 db=mutate(db,'voidClaim',{id});db=mutate(db,'otClaim',body());assert.equal(db.manualClaims.length,2);assert.equal(db.payments.length,1);assert.notEqual(db.manualClaims[1].id,id);
});
test('reject pending, mismatched and invalid monthly details',()=>{
 for(const change of [{pay:null},{date:'2026-09-01'},{pay:99},{kind:'unknown'},{hours:-1},{rate:-1}]){const b=body();b.rows[0]={...b.rows[0],...change};assert.throws(()=>mutate(fixture(),'otClaim',b));}
 assert.throws(()=>mutate(fixture(),'otClaim',{...body(),rows:[]}));
});
test('monthly grouping uses work date across month boundaries and ignores superseded weeks',()=>{
 const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');new vm.Script(source);
 const db=fixture();db.projects[0].rules=[{effective:'2026-01-01',billableOnsite:100,billableTravel:60}];
 const entries=[{date:'2026-08-30',hours:20,activity:'C',project},{date:'2026-08-31',hours:22,activity:'C',project},{date:'2026-09-01',hours:3,activity:'TFROM',project}];
 db.weeks=[{active:true,entries},{active:false,entries}];
 const ctx=vm.createContext({db,allClaims:()=>[],sum:(a,k)=>a.reduce((s,r)=>s+r[k],0)});
 vm.runInContext(source.slice(source.indexOf('function overtimeWeek('),source.indexOf('function overtimeView(')),ctx);
 vm.runInContext(source.slice(source.indexOf('function monthlyOTGroups('),source.indexOf('function monthlyOTView(')),ctx);
 const groups=ctx.monthlyOTGroups();assert.equal(groups.length,2);assert.equal(groups.find(g=>g.month==='2026-08').amount,100);assert.equal(groups.find(g=>g.month==='2026-09').amount,90);assert.equal(groups.find(g=>g.month==='2026-09').expected,'2027-01');
 Object.assign(ctx,{panel:(a,b)=>a+b,table:(a,b)=>a.join(' ')+b,esc:String,money:n=>'$'+n});
 vm.runInContext(source.slice(source.indexOf('function monthlyOTView('),source.indexOf('function confirmMonthlyOT(')),ctx);
 assert.match(ctx.monthlyOTView(),/Review claim/);assert.match(ctx.monthlyOTView(),/2027-01/);
 const saved={id:'saved',otMonth:'2026-08',project,amount:100,paid:40,balance:60};db.manualClaims=[saved];ctx.allClaims=()=>[saved];
 const html=ctx.monthlyOTView();assert.match(html,/data-pay="saved"/);assert.match(html,/\$40 received/);assert.doesNotMatch(html,/data-monthly-ot="2026-08\|P100-01"/);
});
