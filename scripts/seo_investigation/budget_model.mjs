import fs from 'fs';
import { buildEntityGraph } from '../../entity_graph.js';
const S=process.argv[2];
const all=JSON.parse(fs.readFileSync(S+'/permits_all.json','utf8')).sort((a,b)=>a.id-b.id).map(p=>({...p,contractor_name:p.contractor_name||null}));
const c=(n)=>Math.ceil(n/50);
function preCalls(g){return 4+c(g.addresses.length)+1+c(g.peopleOrgs.length)+1+c(g.projects.length)+1+c(g.neighborhoods.length)+1
  +c(g.projects.reduce((s,p)=>s+p.permitIds.length,0))+c(g.permitParticipants.length)+c(g.projectParticipants.length)+c(g.addressNeighborhoods.length);}
function stats(rows){const g=buildEntityGraph(rows,{});return {g,pre:preCalls(g),relink:c(g.permitAddress.size)};}
const full=stats(all); const L=full.pre+170; // calibrate: at N=15231 relink completes 170 batches
console.log('N=15231 pre-relink calls',full.pre,'relink batches done 170 -> implied budget L=',L);
function orphansAt(rows,B){const g=buildEntityGraph(rows,{});const first=new Map();const seen=new Set();
  const idx=new Map(rows.map((r,i)=>[r.id,i]));const cnt=new Map();
  for(const r of rows){const a=g.permitAddress.get(r.id); if(!cnt.has(a))cnt.set(a,0); if(idx.get(r.id)<B)cnt.set(a,cnt.get(a)+1);}
  return [...cnt.values()].filter(v=>v===0).length;}
const dates=[['2026-06-19 23:59:59'],['2026-07-27 23:59:59'],['2026-08-31 23:59:59'],['2026-09-27 23:59:59'],['2026-10-19 23:59:59']];
for(const [d] of dates){
  const rows=all.filter(p=>p.created_at<=d); const s=stats(rows);
  const Bpred=Math.min(rows.length,50*(L-s.pre));
  console.log(JSON.stringify({asof:d.slice(0,10),N:rows.length,pre:s.pre,pred_linked_permits:Bpred,pred_orphan_addresses:orphansAt(rows,Bpred),total_addresses:s.g.addresses.length}));
}
