import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
new vm.Script(source);
const functions=source.slice(source.indexOf('function workbookStatus('),source.indexOf('function render('));
test('version review clears after choosing a replacement or excluding a week',()=>{
 const old={id:'week',hash:'draft',active:false};
 const completed={id:'week',hash:'completed',active:false};
 const db={weeks:[old,completed],selections:[],importLog:[]};
 const context=vm.createContext({db,allClaims:()=>[]});
 vm.runInContext(functions,context);
 assert.equal(context.unresolved(),2);
 completed.active=true;
 db.selections=[{id:'week',hash:'completed'}];
 assert.equal(context.workbookStatus(old),'Superseded');
 assert.equal(context.workbookStatus(completed),'Included');
 assert.equal(context.unresolved(),0);
 completed.active=false;
 db.selections=[{id:'week',hash:''}];
 assert.equal(context.workbookStatus(old),'Excluded');
 assert.equal(context.unresolved(),0);
 db.selections=[{id:'week',hash:'missing'}];
 assert.equal(context.unresolved(),2);
});
