import fs from 'fs';
import { buildEntityGraph } from '../../entity_graph.js';
const S=process.argv[2];
const rows=JSON.parse(fs.readFileSync(S+'/permits_all.json','utf8')).sort((a,b)=>a.id-b.id).map(p=>({...p,contractor_name:p.contractor_name||null}));
const g=buildEntityGraph(rows,{});
const idToNum=new Map(rows.map(r=>[r.id,r.permit_number]));
const aTmp=new Map(g.addresses.map(a=>[a.tmpId,a]));
const pTmp=new Map(g.projects.map(p=>[p.tmpId,p]));
const out=[];
for(const r of rows){const a=aTmp.get(g.permitAddress.get(r.id)); const pj=pTmp.get(g.permitProject.get(r.id));
 out.push({id:r.id,permit:r.permit_number,live_address_id:r.address_id,addr_slug:a.slug,addr_norm:a.normalized_address,proj_slug:pj?.slug||null,proj_permits:pj?.permitIds.length||0});}
fs.writeFileSync(S+'/graph_expected.json',JSON.stringify(out)); console.log(out.length);
