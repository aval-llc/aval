import type { DbSession } from "@/db/postgres/session";
import { listBills, listMeters } from "./meters";
import { listSites } from "./sites";
import { summarizeUtilityRecords } from "./utility-analysis";

export async function utilityInvestigations(s: DbSession, org: string, locale = "es-mx", siteId?: string) {
  const sites=new Map((await listSites(s,org)).map(site=>[site.id,site.name]));
  const allMeters=await listMeters(s,org);
  const meters=allMeters.filter(m=>!siteId || m.siteId===siteId);
  if(meters.length>200) return {blocked:"Select a site with at most 200 meters",findings:[]};
  const ids=new Set(meters.map(m=>m.id));
  const bills=(await listBills(s,org)).filter(b=>ids.has(b.meterId));
  const es=locale==="es-mx";
  const reasons: Record<string,string> = es ? {
    unmapped_meter:"Falta vincular el medidor a un sitio.", insufficient_history:"Faltan periodos para comparar.",
    incomplete_period:"El periodo aún no termina.", invalid_period:"Las fechas no son válidas.", overlapping_periods:"Los periodos se superponen.",
    gap_between_periods:"Falta continuidad entre periodos.", unit_changed:"Las unidades no coinciden.", estimated_reading:"La lectura es estimada o no está confirmada.", zero_baseline:"El consumo anterior es cero.",
  } : { unmapped_meter:"Map this meter to a site.", insufficient_history:"Insufficient billing history.", incomplete_period:"The period has not ended.", invalid_period:"Invalid period dates.", overlapping_periods:"Periods overlap.", gap_between_periods:"There is a gap between periods.", unit_changed:"Units differ.", estimated_reading:"Reading is estimated or unconfirmed.", zero_baseline:"The baseline is zero." };
  const findings=summarizeUtilityRecords(meters,bills).flatMap(r=>r.meterComparisons.map(c=>{
    const meter=meters.find(m=>m.id===c.meterId)!;
    const evidence=[c.priorBillId,c.currentBillId].filter(Boolean).map(id=>bills.find(b=>b.id===id)!).map(b=>({
      id:b.id,meterId:b.meterId,periodStart:b.periodStart.toISOString().slice(0,10),periodEndExclusive:b.periodEnd.toISOString().slice(0,10),
      usageAmount:b.usageAmount,unitOfMeasure:b.unitOfMeasure,costCents:b.costCents,currency:b.currency,readingKind:b.readingKind,
      sourceSystem:b.sourceSystem,externalId:b.externalId,recordedAt:b.createdAt.toISOString(),tariffCode:b.tariffCode,subtotalCents:b.subtotalCents,taxCents:b.taxCents,
    }));
    const siteName=sites.get(meter.siteId ?? "") ?? meter.propertyLabel;
    const title=es ? `Revisión de servicios: ${siteName}` : `Utility review: ${siteName}`;
    const change=c.variancePct===null ? null : Math.round(c.variancePct*100)/100;
    const explanation=c.reason ? reasons[c.reason] ?? c.reason : es ? `El consumo diario cambió ${change}% respecto al periodo anterior del mismo medidor.` : `Daily usage changed ${change}% versus the preceding period on the same meter.`;
    const caveat=es ? "Los recibos no prueban una fuga, falla ni ahorro. Confirme lecturas, fechas y cargos con el responsable del sitio." : "Bills do not prove a leak, equipment failure or savings. Confirm readings, dates and charges with the site operator.";
    return {...c,title,explanation,caveat,evidence,unitOfMeasure:meter.unitOfMeasure,
      followUpDraft:{title,description:[explanation,caveat,...evidence.map(e=>`${e.id}: ${e.periodStart} / ${e.periodEndExclusive}; ${e.usageAmount} ${e.unitOfMeasure}; ${e.costCents} ${e.currency} (${es?'centavos':'minor units'})`)].join('\n')}};
  }));
  return {generatedAt:new Date().toISOString(),locale,source:"recorded_bills",liveSapValidated:false,findings};
}
