import {projectCode} from './model.mjs';
const number=v=>v===undefined||v===null||v===''||v==='-'||!Number.isFinite(Number(v))?null:Number(v);
const sum=(items,key)=>items.reduce((s,x)=>s+Number(x[key]||0),0);
const nodes=(doc,name)=>[...doc.getElementsByTagNameNS('*',name)];
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
function row(c,col,pattern){return Object.keys(c).filter(k=>new RegExp('^'+col+'\\d+$').test(k)&&pattern.test(c[k])).map(k=>Number(k.replace(/\D/g,''))).sort((a,b)=>a-b)[0]}
async function unzip(buffer){
 const bytes=new Uint8Array(buffer),v=new DataView(buffer);let end=-1;
 for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(v.getUint32(p,true)===0x06054b50){end=p;break}
 if(end<0)throw Error('Not a supported Excel ZIP workbook.');
 const count=v.getUint16(end+10,true);let pos=v.getUint32(end+16,true),total=0;const entries=new Map();
 if(count>10000)throw Error('Workbook has too many ZIP entries.');
 for(let i=0;i<count;i++){
  if(pos+46>bytes.length||v.getUint32(pos,true)!==0x02014b50)throw Error('Invalid workbook ZIP directory.');
  const flags=v.getUint16(pos+8,true),method=v.getUint16(pos+10,true),compressed=v.getUint32(pos+20,true),size=v.getUint32(pos+24,true),nameLen=v.getUint16(pos+28,true),extra=v.getUint16(pos+30,true),comment=v.getUint16(pos+32,true),offset=v.getUint32(pos+42,true);
  total+=size;if(total>134217728||flags&1)throw Error('Encrypted or oversized workbook is not supported.');
  const name=new TextDecoder().decode(bytes.subarray(pos+46,pos+46+nameLen));entries.set(name,{method,compressed,size,offset});pos+=46+nameLen+extra+comment;
 }
 return async name=>{
  const e=entries.get(name);if(!e)return null;
  if(e.offset+30>bytes.length||v.getUint32(e.offset,true)!==0x04034b50)throw Error('Invalid workbook entry.');
  const start=e.offset+30+v.getUint16(e.offset+26,true)+v.getUint16(e.offset+28,true);
  if(start+e.compressed>bytes.length)throw Error('Truncated workbook.');
  let raw=bytes.slice(start,start+e.compressed);
  if(e.method===8){let stream;try{stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))}catch{throw Error('Use a current Chrome, Edge or Firefox browser for Excel uploads.')}const reader=stream.getReader(),chunks=[];let length=0;try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>e.size||length>67108864)throw Error('Workbook XML exceeds size limit.');chunks.push(value)}}finally{await reader.cancel()}raw=new Uint8Array(length);let offset=0;for(const c of chunks){raw.set(c,offset);offset+=c.length}}
  else if(e.method!==0)throw Error('Unsupported workbook compression.');
  if(raw.length!==e.size)throw Error('Workbook entry size mismatch.');
  const text=new TextDecoder().decode(raw);if(/<!DOCTYPE/i.test(text))throw Error('XML document types are not supported.');
  const doc=new DOMParser().parseFromString(text,'application/xml');if(nodes(doc,'parsererror').length)throw Error('Invalid workbook XML.');return doc;
 };
}
export async function parseWorkbook(file){
 if(file.size>12582912)throw Error(file.name+': maximum workbook size is 12 MB.');
 const buffer=await file.arrayBuffer(),hash=await digest(buffer),part=await unzip(buffer),shared=await part('xl/sharedStrings.xml'),strings=shared?nodes(shared,'si').map(n=>n.textContent):[],book=await part('xl/workbook.xml'),rels=await part('xl/_rels/workbook.xml.rels');
 if(!book||!rels)throw Error('Workbook metadata missing.');
 const sheets={};
 for(const sh of nodes(book,'sheet')){
  const id=sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id'),target=nodes(rels,'Relationship').find(r=>r.getAttribute('Id')===id)?.getAttribute('Target');
  if(!target)throw Error('Worksheet relationship missing.');
  const doc=await part(target.startsWith('/')?target.slice(1):'xl/'+target);if(!doc)throw Error('Worksheet missing.');
  const cells={},formulas=new Set(),errors=[];
  for(const c of nodes(doc,'c')){const ref=c.getAttribute('r'),type=c.getAttribute('t');let val=nodes(c,'v')[0]?.textContent||'';if(type==='s')val=strings[Number(val)]||'';if(type==='inlineStr')val=nodes(c,'is')[0]?.textContent||'';cells[ref]=val;if(nodes(c,'f').length)formulas.add(ref);if(type==='e')errors.push(ref)}
  for(const m of nodes(doc,'mergeCell')){const match=/^([AB])(\d+):\1(\d+)$/.exec(m.getAttribute('ref'));if(match){const [,col,a,b]=match;if(Number(b)-Number(a)>10000)throw Error('Merged range too large.');for(let r=Number(a)+1;r<=Number(b);r++)cells[col+r]=cells[col+a]}}
  sheets[sh.getAttribute('name')]={cells,formulas,errors};
 }
 if(!sheets.Timesheet||!sheets.Expenses)throw Error('Required Timesheet/Expenses sheets missing.');
 const t=sheets.Timesheet.cells,e=sheets.Expenses.cells,s=sheets.Service_Comp?.cells,serial=number(t.N5),employee=String(t.N4||'').trim();
 if(!employee||serial===null||serial<1)throw Error('Employee or week ending date is missing.');
 const date1904=['1','true'].includes(nodes(book,'workbookPr')[0]?.getAttribute('date1904'));
 const date=new Date(Date.UTC(1899,11,30)+(serial+(date1904?1462:0))*86400000);if(Number.isNaN(date.getTime()))throw Error('Invalid Excel date.');
 const day=d=>new Date(date.getTime()+(d-6)*86400000).toISOString().slice(0,10),week=day(6),id=(await digest(new TextEncoder().encode(employee.toUpperCase()+'|'+week))).slice(0,20),issues=[];
 if(date.getUTCDay()!==6)issues.push('Week ending is not Saturday.');
 const now=new Date(),localToday=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10);if(week>localToday)issues.push('Future week: may be a draft.');
 const totalRow=row(t,'D',/Totals\s*==>/),header=row(t,'A',/^Project Customer/),supportHeader=row(t,'A',/^Support Customer/);
 if(!totalRow||!header||totalRow>10000)throw Error('Could not identify time-entry section boundaries.');
 const entries=[],claims=[],companyExpenses=[],starts=['D','F','H','J','L','N','P'],durations=['E','G','I','K','M','O','Q'];
 for(let r=header+1;r<totalRow;r++){
  if(!sheets.Timesheet.formulas.has('R'+r)&&number(t['R'+r])===null)continue;
  for(let d=0;d<7;d++){const cell=durations[d]+r,hours=number(t[cell]);if(hours===null||hours===0)continue;if(hours<0||hours>24)issues.push('Unusual duration at Timesheet!'+cell+': '+hours);entries.push({id:id+'|Timesheet|'+cell,date:day(d),project:projectCode(t['B'+r]),rawProject:t['B'+r]||'',description:String(t['A'+r]||'').trim(),activity:t['C'+r]||'',hours,start:number(t[starts[d]+r]),service:!!supportHeader&&r>supportHeader,source:'Timesheet!'+cell})}
 }
 const hours=sum(entries,'hours'),reportedHours=number(t['R'+totalRow]);if(reportedHours===null||Math.abs(hours-reportedHours)>.01)issues.push('Daily hours do not match the saved weekly total (or the total is missing).');
 const jobRow=row(e,'A',/^\s*Job Number/),employeeRow=row(e,'A',/^\s*Expenses Paid by Employee/),companyRow=row(e,'A',/^\s*Expenses Paid by Company/),expenseTotal=Object.keys(e).filter(k=>/^A\d+$/.test(k)&&/^\s*Total\s*$/.test(e[k])).map(k=>Number(k.slice(1))).filter(r=>r>employeeRow).sort((a,b)=>a-b)[0];
 if(!jobRow||!employeeRow||!companyRow||!expenseTotal||expenseTotal>10000)throw Error('Could not identify expense section boundaries.');
 const cols=['B','C','D','E','F','G','H'];
 for(const range of [{first:companyRow+1,last:employeeRow-1,company:true},{first:employeeRow+1,last:expenseTotal-1,company:false}])for(let r=range.first;r<=range.last;r++){
  const label=String(e['A'+r]||'').trim();if(label==='Total')continue;
  for(let d=0;d<7;d++){const cell=cols[d]+r,a=number(e[cell]);if(a===null||a===0)continue;const item={id:id+'|Expenses|'+cell,week,date:day(d),project:projectCode(e[cols[d]+jobRow]),category:label==='Per Diem'?'Per diem':'Reimbursement',description:label,amount:Math.round(a*100)/100,source:'Expenses!'+cell,origin:'Workbook',unit:'USD'};(range.company?companyExpenses:claims).push(item)}
 }
 const expenseReported=number(e['I'+expenseTotal]);if(expenseReported!==null&&Math.abs(expenseReported-sum(claims,'amount'))>.02)issues.push('Expense line items do not match the saved employee expense total.');
 let compTime=0;
 if(s){const cash=number(s.H53);compTime=number(s.J53)||0;if(cash===null)issues.push('Service compensation total is missing; review workbook.');if(cash)claims.push({id:id+'|Service_Comp|H53',week,date:week,project:'UNASSIGNED',category:'Service compensation',description:'Saved service cash total (includes on-call if selected)',amount:Math.round(cash*100)/100,source:'Service_Comp!H53',origin:'Workbook',unit:'USD'});let timeSum=0;for(let r=43;r<=52;r++)timeSum+=number(s['J'+r])||0;if(Math.abs(timeSum-compTime)>.01)issues.push('Saved comp-time total excludes or differs from line items.')}
 else issues.push('Service_Comp sheet missing.');
 for(const name of ['Timesheet','Expenses','Service_Comp'])if(sheets[name]?.errors.length)issues.push('Excel errors in '+name+': '+sheets[name].errors.join(', '));
 if(!entries.length&&!claims.length&&!companyExpenses.length)issues.push('Empty dated workbook: no work or expenses.');
 if(claims.some(c=>c.project==='UNASSIGNED'))issues.push('Some claims have no clear project; assign them in Claims.');
 return {id,hash,file:file.name,week,employee,hours,reportedHours,expenseReported,compTime,entries,claims,companyExpenses,issues,active:true};
}
