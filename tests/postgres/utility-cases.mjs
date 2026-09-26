import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { utilityMeters, utilityBills, utilitySites } from '../../db/postgres/schema.ts';
import { createSite, mapMeter } from '../../lib/infrastructure/sites.ts';
import { createMeter, recordBill, listBills } from '../../lib/infrastructure/meters.ts';
import { importUtilityBills } from '../../lib/infrastructure/import.ts';
import { runOperationsTool } from '../../lib/ask-aval/operations-tools.ts';
import { withVerifiedIdentityHeaders } from '../../lib/auth/request-identity.ts';
import { env } from 'cloudflare:workers';
import { POST as importRoute } from '../../app/api/infrastructure/import/route.ts';
import { POST as followUpRoute } from '../../app/api/infrastructure/follow-up/route.ts';
import { POST as metersRoute } from '../../app/api/infrastructure/meters/route.ts';
import { POST as sitesRoute } from '../../app/api/infrastructure/sites/route.ts';
import { POST as billsRoute } from '../../app/api/infrastructure/bills/route.ts';
import { GET as investigationsRoute } from '../../app/api/infrastructure/investigations/route.ts';

export async function runUtilityCases(t,{session,userA,userB,propertyId,administrator,config}) {
  const run = work => session(userA,s=>work(s,s.identity.organizationId));
  let site, meter, child;
  await t.test('utilities: site and meter creation persists scoped property links',async()=>{
    site = await run((s,o)=>createSite(s,o,{name:'Sitio sintético Astra',propertyId}));
    meter = await run((s,o)=>createMeter(s,o,{siteId:site.id,propertyLabel:'ignored',utilityType:'water',unitOfMeasure:'m3'}));
    child = await run((s,o)=>createMeter(s,o,{siteId:site.id,parentMeterId:meter.id,propertyLabel:'ignored',utilityType:'water',unitOfMeasure:'m3'}));
    assert.equal(meter.propertyLabel,site.name); assert.equal(child.parentMeterId,meter.id);
    await assert.rejects(run((s,o)=>createMeter(s,o,{siteId:site.id,parentMeterId:meter.id,utilityType:'electricity',unitOfMeasure:'kWh'})),/same utility type/);
    await assert.rejects(run((s,o)=>s.db.insert(utilityMeters).values({id:randomUUID(),organizationId:o,siteId:site.id,parentMeterId:meter.id,utilityType:'electricity',unitOfMeasure:'kWh',propertyLabel:'bad parent',createdAt:new Date(),updatedAt:new Date()})));
  });
  await t.test('utilities: foreign workspace cannot read or attach properties, sites or meters',async()=>{
    await session(userB,async s=>{
      assert.equal((await s.db.select().from(utilitySites).where(eq(utilitySites.id,site.id))).length,0);
      assert.equal((await s.db.select().from(utilityMeters).where(eq(utilityMeters.id,meter.id))).length,0);
      await assert.rejects(createSite(s,s.identity.organizationId,{name:'bad',propertyId}),/not found/);
      await assert.rejects(createMeter(s,s.identity.organizationId,{siteId:site.id,propertyLabel:'bad',utilityType:'water',unitOfMeasure:'m3'}),/not found/);
    });
  });
  await t.test('utilities: missing database context fails closed for all new read paths',async()=>{
    await administrator.query('BEGIN');
    try {
      await administrator.query('SET LOCAL ROLE aval_app');
      for(const table of ['utility_sites','utility_meters','utility_bills']) {
        assert.equal((await administrator.query(`SELECT id FROM ${table}`)).rows.length,0);
      }
    }finally{await administrator.query('ROLLBACK');}
  });
  await t.test('utilities: composite keys protect direct writes; hierarchy cycles fail',async()=>{
    await assert.rejects(run((s,o)=>mapMeter(s,o,meter.id,site.id,child.id)),/cycle/);
    const other = await session(userB,s=>s.identity.organizationId);
    await assert.rejects(run(s=>s.db.insert(utilitySites).values({id:randomUUID(),organizationId:site.organizationId,propertyId:propertyId,name:'valid',createdAt:new Date()}).then(async()=>{
      await s.db.execute(sql`UPDATE utility_meters SET organization_id=${other} WHERE id=${meter.id}`);
    })));
    // Administrator bypasses RLS: the FK must still protect the relationship.
    await assert.rejects(administrator.query('INSERT INTO utility_sites(id,organization_id,property_id,name,created_at) VALUES($1,$2,$3,$4,now())',[randomUUID(),other,propertyId,'bad']),{code:'23503'});
  });
  await t.test('utilities: explicit legacy mapping preserves identity and historical unit',async()=>{
    const id=randomUUID();
    await run((s,o)=>s.db.insert(utilityMeters).values({id,organizationId:o,utilityType:'water',propertyLabel:'Ambiguous legacy label',unitOfMeasure:'gal',createdAt:new Date(),updatedAt:new Date()}));
    const mapped=await run((s,o)=>mapMeter(s,o,id,site.id,null));
    assert.equal(mapped.id,id); assert.equal(mapped.unitOfMeasure,'gal');assert.equal(mapped.propertyLabel,'Ambiguous legacy label');
    await assert.rejects(run(s=>s.db.update(utilityMeters).set({unitOfMeasure:'m3'}).where(eq(utilityMeters.id,id))));
  });
  await t.test('utilities: snapshot bill units, reject incompatible units, isolate bills',async()=>{
    const row=await run((s,o)=>recordBill(s,o,{meterId:meter.id,periodStart:new Date('2026-01-01'),periodEnd:new Date('2026-02-01'),usageAmount:30,costCents:10000,currency:'MXN',source:'manual',unitOfMeasure:'m3',readingKind:'actual'}));
    assert.equal(row.unitOfMeasure,'m3');
    await assert.rejects(run((s,o)=>recordBill(s,o,{...row,unitOfMeasure:'gal',source:'manual'})),/unit differs/);
    assert.equal((await session(userB,s=>listBills(s,s.identity.organizationId))).length,0);
    await assert.rejects(session(userB,s=>s.db.insert(utilityBills).values({...row,id:randomUUID(),organizationId:s.identity.organizationId})));
    await assert.rejects(run((s,o)=>s.db.insert(utilityBills).values({...row,id:randomUUID(),organizationId:o,unitOfMeasure:'gal'})));
  });
  const imported=()=>({meterId:meter.id,sourceSystem:'synthetic-sap-core/company-001',externalId:'000001',periodStart:'2026-02-01',periodEnd:'2026-03-01',usageAmount:42,costCents:11600,currency:'MXN',unitOfMeasure:'m3',readingKind:'actual',subtotalCents:10000,taxCents:1600});
  await t.test('utilities: preview writes nothing; import replay is idempotent',async()=>{
    const before=await run((s,o)=>listBills(s,o));
    const preview=await run((s,o)=>importUtilityBills(s,o,[imported()]));
    assert.equal(preview.counts.insert,1);
    assert.equal((await run((s,o)=>listBills(s,o))).length,before.length);
    await run((s,o)=>importUtilityBills(s,o,[imported()],preview.previewToken));
    const replay=await run((s,o)=>importUtilityBills(s,o,[imported()]));
    assert.equal(replay.counts.unchanged,1);
    await run((s,o)=>importUtilityBills(s,o,[imported()],replay.previewToken));
    assert.equal((await run((s,o)=>listBills(s,o))).length,before.length+1);
  });
  await t.test('utilities: corrections preserve old bills and stale previews cannot apply',async()=>{
    const original=(await run((s,o)=>listBills(s,o))).find(b=>b.externalId==='000001');
    await assert.rejects(run((s,o)=>importUtilityBills(s,o,[{...imported(),usageAmount:45}])),/supersedesBillId/);
    const correction={...imported(),usageAmount:45,supersedesBillId:original.id};
    const preview=await run((s,o)=>importUtilityBills(s,o,[correction]));
    await run((s,o)=>importUtilityBills(s,o,[correction],preview.previewToken));
    await assert.rejects(run((s,o)=>importUtilityBills(s,o,[correction],preview.previewToken)),/Preview changed/);
    const history=await administrator.query('SELECT id,superseded_at FROM utility_bills WHERE organization_id=$1 AND external_id=$2',[site.organizationId,'000001']);
    assert.equal(history.rows.length,2);assert.equal(history.rows.filter(b=>b.superseded_at===null).length,1);
  });
  await t.test('utilities: bad mappings reject whole import and competing applies produce one bill',async()=>{
    const row={...imported(),externalId:'concurrency'};
    const before=(await run((s,o)=>listBills(s,o))).length;
    await assert.rejects(run((s,o)=>importUtilityBills(s,o,[row,{...row,externalId:'bad',meterId:'not-here'}])),/Map the meter/);
    assert.equal((await run((s,o)=>listBills(s,o))).length,before);
    const preview=await run((s,o)=>importUtilityBills(s,o,[row]));
    const results=await Promise.allSettled([run((s,o)=>importUtilityBills(s,o,[row],preview.previewToken)),run((s,o)=>importUtilityBills(s,o,[row],preview.previewToken))]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await run((s,o)=>listBills(s,o))).length,before+1);
  });
  await t.test('utilities: public import, Spanish read tool and reviewed task survive reload and retries',async()=>{
    const saved={...env};env.DATABASE_URL=config.connectionString;delete env.HYPERDRIVE;
    const request=(user,path,body)=>new Request(`https://aval.test${path}`,{method:body?'POST':'GET',headers:withVerifiedIdentityHeaders(new Headers({'content-type':'application/json'}),{userId:user,email:`${user}@example.test`,displayName:user,emailVerified:true}),...(body?{body:JSON.stringify(body)}:{})});
    try {
      const row={...imported(),externalId:'route-import',periodStart:'2026-03-01',periodEnd:'2026-04-01'};
      const previewResponse=await importRoute(request(userA,'/api/infrastructure/import',{rows:[row],mode:'preview'}));
      assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
      const applied=await importRoute(request(userA,'/api/infrastructure/import',{rows:[row],mode:'apply',previewToken:preview.previewToken}));
      assert.equal(applied.status,200);
      const tool=await run((s,o)=>runOperationsTool(s,'get_utility_investigations',{locale:'es-mx'},o));
      assert.equal(tool.json.liveSapValidated,false);
      const findings=(await (await investigationsRoute(request(userA,'/api/infrastructure/investigations?locale=es-mx'))).json()).findings;
      const finding=findings.find(f=>f.meterId===meter.id);
      assert.match(finding.title,/Revisión de servicios/);assert.match(finding.caveat,/no prueban una fuga/);
      assert.ok(finding.evidence.some(b=>b.externalId==='route-import'));
      const body={meterId:meter.id,currentBillId:finding.currentBillId,priorBillId:finding.priorBillId,locale:'es-mx',...finding.followUpDraft};
      assert.equal((await followUpRoute(new Request('https://aval.test/api/infrastructure/follow-up',{method:'POST',headers:request(userA,'/').headers,body:'null'}))).status,400);
      for(const route of [importRoute,metersRoute,sitesRoute,billsRoute])assert.equal((await route(new Request('https://aval.test/api/infrastructure',{method:'POST',headers:request(userA,'/').headers,body:'null'}))).status,400);
      const first=await followUpRoute(request(userA,'/api/infrastructure/follow-up',body));assert.equal(first.status,200);
      const item=(await first.json()).item;assert.equal(item.status,'planned');
      const second=await followUpRoute(request(userA,'/api/infrastructure/follow-up',body));assert.equal((await second.json()).item.id,item.id);
      const other=await investigationsRoute(request(userB,'/api/infrastructure/investigations?locale=es-mx'));assert.equal((await other.json()).findings.length,0);
      assert.equal((await followUpRoute(request(userB,'/api/infrastructure/follow-up',body))).status,409);
      assert.equal((await followUpRoute(request(userA,'/api/infrastructure/follow-up',{...body,currentBillId:'stale'}))).status,409);
      assert.equal((await importRoute(new Request('https://aval.test/api/infrastructure/import',{method:'POST'}))).status,401);
    } finally {for(const key of Object.keys(env))delete env[key];Object.assign(env,saved);}
  });
}
