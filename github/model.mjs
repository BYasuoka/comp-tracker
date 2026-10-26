export function emptyStore(){return {version:1,source:'Private GitHub repository',importedAt:null,weeks:[],projects:[],payments:[],manualClaims:[],assignments:[],selections:[],importLog:[],audit:[]}}
export function validate(db){
 if(!db||db.version!==1)throw Error('Unsupported tracker backup.');
 for(const name of ['weeks','projects','payments','manualClaims','assignments','selections','importLog','audit'])if(!Array.isArray(db[name]))throw Error('Invalid backup: '+name);
 for(const w of db.weeks){if(!w.id||!w.hash||typeof w.file!=='string'||!Array.isArray(w.issues))throw Error('Invalid workbook.');for(const k of ['entries','claims','companyExpenses'])if(!Array.isArray(w[k]))throw Error('Invalid workbook '+k)}
 for(const p of db.projects)if(typeof p.code!=='string'||typeof p.description!=='string'||!Array.isArray(p.rules))throw Error('Invalid project.');
 for(const c of [...db.weeks.flatMap(w=>w.claims),...db.manualClaims])if(!c.id||!Number.isFinite(c.amount)||typeof c.category!=='string'||typeof c.date!=='string')throw Error('Invalid claim.');
 for(const p of db.payments)if(!Number.isFinite(p.amount)||p.amount<=0||!Array.isArray(p.allocations))throw Error('Invalid receipt.');
 return db;
}
function date(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw Error('Enter a valid date.');return v}
function amount(v,zero=false){if(v===null||v===undefined||v===''||!Number.isFinite(Number(v)))throw Error('Enter a valid amount.');const n=Math.round(Number(v)*100)/100;if(n<0||(!zero&&n===0)||n>10000000)throw Error('Amount is out of range.');return n}
export function projectCode(v){const s=String(v??'').trim().toUpperCase();return /^P\d+(?:-[A-Z0-9]+)*$/.test(s)?s:'UNASSIGNED'}
export function reconcile(db){
 for(const w of db.weeks){const chosen=db.selections.find(s=>s.id===w.id);w.active=chosen?w.hash===chosen.hash:db.weeks.filter(x=>x.id===w.id).length===1}
 for(const w of db.weeks)for(const item of [...w.entries,...w.claims,...w.companyExpenses])if(item.project!=='UNASSIGNED'&&!db.projects.some(p=>p.code===item.project)){
 const entry=db.weeks.flatMap(w=>w.entries).find(e=>e.project===item.project&&e.description);
 db.projects.push({code:item.project,description:entry?.description||'Project '+item.project,notes:'',rules:[]});
 }
 return db;
}
export function mutate(original,action,b){
 const db=structuredClone(validate(original));
 const claims=()=>[...db.weeks.filter(w=>w.active).flatMap(w=>w.claims),...db.manualClaims.filter(c=>!c.void)];
 const existingProject=code=>{if(!db.projects.some(p=>p.code===code))throw Error('Create the project first.');return code};
 switch(action){
 case 'otClaim':{
 const project=existingProject(projectCode(b.project)),month=String(b.workMonth||'');date(month+'-01');
 if(!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid work month.');
 if(db.manualClaims.some(c=>!c.void&&c.otMonth===month&&c.project===project))throw Error('An OT claim already exists for this project and month. Review or void it before replacing it.');
 if(!Array.isArray(b.rows)||!b.rows.length)throw Error('No calculated OT to claim.');
 const rows=b.rows.map(r=>{date(r.date);if(!r.date.startsWith(month+'-')||!['onsite','travel'].includes(r.kind)||r.project!==project)throw Error('Invalid OT claim detail.');const hours=Number(r.hours);if(!Number.isFinite(hours)||hours<=0)throw Error('Invalid OT hours.');const rate=amount(r.rate,true),pay=amount(r.pay,true);if(Math.round(hours*rate*0.5*100)!==Math.round(pay*100))throw Error('OT calculation does not match its rate.');return {date:r.date,project,kind:r.kind,hours,rate,pay};});
 const total=amount(rows.reduce((s,r)=>s+r.pay,0)),last=new Date(month+'-01T00:00:00Z');last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);const d=last.toISOString().slice(0,10),end=new Date(last);end.setUTCDate(end.getUTCDate()+6-end.getUTCDay());const due=new Date(month+'-01T00:00:00Z');due.setUTCMonth(due.getUTCMonth()+4);
 db.manualClaims.push({id:crypto.randomUUID(),date:d,week:end.toISOString().slice(0,10),project,category:'Project compensation',description:'OT worked '+month+'; expected payment '+due.toISOString().slice(0,7)+'. Confirmed calculated subtotal; unresolved entries excluded.',amount:total,source:'Monthly OT claim',origin:'Manual',unit:'USD',void:false,otMonth:month,expectedMonth:due.toISOString().slice(0,7),otRows:rows});break;
 }
 case 'project':{const code=projectCode(b.code);if(code==='UNASSIGNED')throw Error('Use a full project code.');let p=db.projects.find(p=>p.code===code);if(!p){p={code,description:'',notes:'',rules:[]};db.projects.push(p)}p.description=String(b.description||'').trim();p.notes=String(b.notes||'');if(b.rule){if(!['manual','daily8','weekly40','all'].includes(b.rule.mode))throw Error('Invalid eligibility rule.');const r={id:crypto.randomUUID(),effective:date(b.rule.effective),mode:b.rule.mode,notes:String(b.rule.notes||'')};for(const k of ['perDiem','travel','onsite','billableOnsite','billableTravel'])r[k]=b.rule[k]===null||b.rule[k]===undefined||b.rule[k]===''?null:amount(b.rule[k],true);p.rules.push(r)}break}
 case 'assign':{const all=[...db.weeks.flatMap(w=>[...w.entries,...w.claims,...w.companyExpenses]),...db.manualClaims];if(!all.some(x=>x.id===b.id))throw Error('Record not found.');const project=projectCode(b.project);if(project!=='UNASSIGNED')existingProject(project);db.assignments=db.assignments.filter(a=>a.id!==b.id);db.assignments.push({id:b.id,project});break}
 case 'select':{if(!db.weeks.some(w=>w.id===b.id&&(!b.hash||w.hash===b.hash)))throw Error('Version not found.');db.selections=db.selections.filter(s=>s.id!==b.id);db.selections.push({id:b.id,hash:b.hash||''});reconcile(db);break}
 case 'claim':{const d=date(b.date),project=existingProject(projectCode(b.project));if(!['Project compensation','Service compensation','Per diem','Reimbursement'].includes(b.category))throw Error('Invalid category.');if(!String(b.description||'').trim())throw Error('Describe the claim.');const end=new Date(d+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+6-end.getUTCDay());db.manualClaims.push({id:crypto.randomUUID(),date:d,week:end.toISOString().slice(0,10),project,category:b.category,description:String(b.description),amount:amount(b.amount),source:'Manual entry',origin:'Manual',unit:'USD',void:false});break}
 case 'voidClaim':{const c=db.manualClaims.find(c=>c.id===b.id);if(!c)throw Error('Manual claim not found.');c.void=true;break}
 case 'payment':{const total=amount(b.amount),allocations=[],ids=new Set();for(const a of b.allocations||[]){const c=claims().find(c=>c.id===a.claimId);if(!c||ids.has(c.id))throw Error('Invalid or duplicate allocation.');ids.add(c.id);allocations.push({claimId:c.id,amount:amount(a.amount),sourceAmount:c.amount,sourceCategory:c.category,sourceDate:c.date})}if(Math.round(allocations.reduce((s,a)=>s+a.amount,0)*100)>Math.round(total*100))throw Error('Allocations exceed the receipt.');db.payments.push({id:crypto.randomUUID(),date:date(b.date),amount:total,reference:String(b.reference||''),notes:String(b.notes||''),allocations,void:false,createdAt:new Date().toISOString()});break}
 case 'voidPayment':{const p=db.payments.find(p=>p.id===b.id);if(!p)throw Error('Receipt not found.');p.void=true;break}
 case 'importWeeks':{db.importLog=[];for(const w of b.weeks){if(!db.weeks.some(x=>x.hash===w.hash)){db.weeks.push(w);db.importLog.push({file:w.file,status:'Imported',message:w.week})}else db.importLog.push({file:w.file,status:'Duplicate',message:'Already imported'});}db.importedAt=new Date().toISOString();reconcile(db);break}
 default:throw Error('Unknown action.');
 }
 db.audit.push({at:new Date().toISOString(),action,record:String(b.id||'')});return validate(db);
}
