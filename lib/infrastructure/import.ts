import { and, eq, isNull } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { utilityBills } from "@/db/postgres/schema";
import { listMeters, recordBill } from "./meters";
import { lockUtilityWorkspace } from "./sites";
import { UtilityError, textField, validateBill } from "./validation";
import { appendAuditEvents } from "@/lib/audit/log";

const digest = async(value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))).map(b=>b.toString(16).padStart(2,"0")).join("");
/** Preview token binds reviewed content to the current mappings and revisions.
 * Apply always revalidates inside the same serialized transaction. */
export async function importUtilityBills(s: DbSession, org: string, input: unknown, previewToken?: string) {
  if(!Array.isArray(input) || !input.length || input.length>500)throw new UtilityError("Import requires 1–500 rows");
  await lockUtilityWorkspace(s,org);
  const meters=new Map((await listMeters(s,org)).map(m=>[m.id,m]));
  const current=await s.db.select().from(utilityBills).where(and(eq(utilityBills.organizationId,org),isNull(utilityBills.supersededAt)));
  const seen=new Set<string>();
  const rows=input.map((raw,index)=>{
    if(!raw || typeof raw!=="object" || Array.isArray(raw))throw new UtilityError(`Invalid row ${index+1}`);
    const b=raw as Record<string,unknown>;
    const bill=validateBill(b);
    const sourceSystem=textField(b.sourceSystem,"sourceSystem");
    const externalId=textField(b.externalId,"externalId");
    const key=JSON.stringify([sourceSystem,externalId]);
    if(seen.has(key))throw new UtilityError(`Duplicate source identity at row ${index+1}`);
    seen.add(key);
    const meter=meters.get(bill.meterId);
    if(!meter?.siteId)throw new UtilityError(`Map the meter to a site before importing row ${index+1}`);
    if(meter.unitOfMeasure!==bill.unitOfMeasure)throw new UtilityError(`Meter unit mismatch at row ${index+1}`);
    const previous=current.find(r=>r.sourceSystem===sourceSystem && r.externalId===externalId);
    const unchanged=previous && Object.entries(bill).every(([k,v])=>{
      const old=previous[k as keyof typeof previous];
      return v instanceof Date && old instanceof Date ? v.getTime()===old.getTime() : v===old;
    });
    if(previous && !unchanged && b.supersedesBillId!==previous.id)throw new UtilityError(`Row ${index+1} changes a bill: explicitly supply supersedesBillId=${previous.id}`,409);
    if(!previous && b.supersedesBillId)throw new UtilityError("The bill to supersede is no longer current",409);
    return { bill,sourceSystem,externalId,siteId:meter.siteId,previousId:previous?.id ?? null, action:unchanged ? "unchanged" : previous ? "correct" : "insert" };
  });
  const token=await digest({org,rows});
  const counts={insert:rows.filter(r=>r.action==="insert").length,correct:rows.filter(r=>r.action==="correct").length,unchanged:rows.filter(r=>r.action==="unchanged").length};
  if(previewToken===undefined)return {previewToken:token,counts,rows,applied:false};
  if(previewToken!==token)throw new UtilityError("Preview changed; review it again before importing",409);
  await s.atomic(async()=>{
    for(const row of rows) {
      if(row.action==="unchanged")continue;
      if(row.previousId)await s.db.update(utilityBills).set({supersededAt:new Date()}).where(and(eq(utilityBills.organizationId,org),eq(utilityBills.id,row.previousId),isNull(utilityBills.supersededAt)));
      await recordBill(s,org,{...row.bill,sourceSystem:row.sourceSystem,externalId:row.externalId,source:"reviewed_export",supersedesBillId:row.previousId ?? undefined});
    }
    await appendAuditEvents(s,org,[{kind:"tool_call",label:"utility_export_import",payloadDigest:await digest({token,counts,actor:s.identity.actorId}),count:rows.length}]);
  });
  return {previewToken:token,counts,rows,applied:true};
}
