import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const S=process.argv[2];
const R='../../';
const { default: worker } = await import(R+'worker.js');
const db=new DatabaseSync(':memory:');
for (const f of ['schema.sql','migration_entity_graph.sql','migration_entity_graph_upstream_compat.sql',...fs.readdirSync(R).filter(f=>/^migration_(permit|alert).*\.sql$/.test(f))]) {
  const sql=fs.readFileSync(R+f,'utf8');
  for (const stmt of sql.split(/;\s*\n/)) { try{ db.exec(stmt+';'); }catch(e){ if(!/duplicate column|already exists|no such table/i.test(e.message)) console.log('migr warn',f,e.message.slice(0,80)); } }
}
const cols=new Set(db.prepare("PRAGMA table_info(permits)").all().map(c=>c.name));
const permits=JSON.parse(fs.readFileSync(S+'/permits_all.json','utf8')).sort((a,b)=>a.id-b.id);
// contractors referenced
const ctr=new Map(); for(const p of permits) if(p.contractor_id) ctr.set(p.contractor_id,p.contractor_name||('c'+p.contractor_id));
const ccols=new Set(db.prepare("PRAGMA table_info(contractors)").all().map(c=>c.name));
for(const [id,name] of ctr){ try{db.prepare(`INSERT INTO contractors (id,name${ccols.has('slug')?',slug':''}) VALUES (?,?${ccols.has('slug')?',?':''})`).run(...(ccols.has('slug')?[id,name,'c'+id]:[id,name]));}catch(e){} }
const use=[...cols].filter(c=>c in permits[0] && !['address_id','project_id'].includes(c));
const ins=db.prepare(`INSERT INTO permits (${use.join(',')}) VALUES (${use.map(()=>'?').join(',')})`);
db.exec('BEGIN'); for(const p of permits) ins.run(...use.map(c=>p[c]===undefined?null:p[c])); db.exec('COMMIT');
console.log('seeded permits',db.prepare('SELECT COUNT(*) n FROM permits').get().n,'cols used',use.length);
let calls=0;
const wrap=(sql,binds=[])=>({
  bind:(...b)=>wrap(sql,b),
  all:async()=>{calls++;return {results:db.prepare(sql).all(...binds)};},
  first:async()=>{calls++;return db.prepare(sql).get(...binds)??null;},
  run:async()=>{calls++;const r=db.prepare(sql).run(...binds);return {meta:{changes:r.changes}};},
  _run:()=>db.prepare(sql).run(...binds),
});
const env={ADMIN_API_TOKEN:'x',DB:{prepare:(s)=>wrap(s),batch:async(ss)=>{calls++;db.exec('BEGIN');try{for(const s of ss)s._run();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return ss.map(()=>({success:true}));}}};
const t0=Date.now();
const res=await worker.fetch(new Request('https://buildingseattle.com/admin/build-graph',{method:'POST',headers:{'X-Admin-Token':'x'}}),env,{waitUntil(){}});
console.log('status',res.status,await res.text(),'| D1 calls',calls,'| ms',Date.now()-t0);
const q=(s)=>db.prepare(s).get();
console.log(JSON.stringify({permits:q('SELECT COUNT(*) n FROM permits').n,linked_address:q('SELECT COUNT(*) n FROM permits WHERE address_id IS NOT NULL').n,linked_project:q('SELECT COUNT(*) n FROM permits WHERE project_id IS NOT NULL').n,addresses:q('SELECT COUNT(*) n FROM addresses').n,orphan_addresses:q('SELECT COUNT(*) n FROM addresses a WHERE NOT EXISTS (SELECT 1 FROM permits p WHERE p.address_id=a.id)').n,projects:q('SELECT COUNT(*) n FROM projects').n}));
