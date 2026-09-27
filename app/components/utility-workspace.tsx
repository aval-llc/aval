"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";

type Site = {id:string;name:string;propertyId:string|null};
type Meter = {id:string;meterNumber?:string|null;siteId:string|null;propertyLabel:string;unitOfMeasure:string;utilityType:string;parentMeterId:string|null};
type Finding = {meterId:string;siteId:string|null;currentBillId:string|null;priorBillId:string|null;title:string;explanation:string;caveat:string;evidence:Record<string,unknown>[];followUpDraft:{title:string;description:string}};
type Preview = {previewToken:string;counts:{insert:number;correct:number;unchanged:number};rows:{action:string;externalId:string;bill:Record<string,unknown>}[]};
const units:Record<string,string[]>={electricity:['kWh'],water:['m3','gal','ccf'],gas:['m3','ccf','therm']};

export function UtilityWorkspace() {
  const t=useTranslations('UtilityPilot'), locale=useLocale();
  const [sites,setSites]=useState<Site[]>([]),[meters,setMeters]=useState<Meter[]>([]),[properties,setProperties]=useState<{id:string;name:string}[]>([]);
  const [investigationSite,setInvestigationSite]=useState('');
  const [findings,setFindings]=useState<Finding[]>([]),[canEdit,setCanEdit]=useState(false);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [siteName,setSiteName]=useState(''),[propertyId,setPropertyId]=useState(''),[siteId,setSiteId]=useState(''),[parentId,setParentId]=useState('');
  const [meterNumber,setMeterNumber]=useState('');
  const [type,setType]=useState('water'),[unit,setUnit]=useState(locale==='es-mx'?'m3':'gal');
  const [content,setContent]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[draft,setDraft]=useState<Finding|null>(null);
  const request=useCallback(async<T,>(path:string,body?:unknown,method='POST',signal?:AbortSignal):Promise<T>=>{
    const response=await fetch(path,body===undefined?{signal,cache:'no-store'}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
    const data=await response.json() as T & {error?:string;errorEs?:string};
    if(!response.ok)throw new Error(response.status===403?t('ownerOnly'):(locale==='es-mx'?data.errorEs:undefined)||data.error||t('error'));
    return data;
  },[locale,t]);
  const load=useCallback(async(signal?:AbortSignal)=>{
    const [s,m,p,f]=await Promise.all([
      request<{sites:Site[];canEdit:boolean}>('/api/infrastructure/sites',undefined,'GET',signal),request<{meters:Meter[]}>('/api/infrastructure/meters',undefined,'GET',signal),
      request<{properties:{id:string;name:string}[]}>('/api/operations/properties',undefined,'GET',signal),request<{findings:Finding[];blocked?:string}>(`/api/infrastructure/investigations?locale=${locale}&siteId=${encodeURIComponent(investigationSite)}`,undefined,'GET',signal),
    ]);
    setSites(s.sites);setCanEdit(s.canEdit);setMeters(m.meters);setProperties(p.properties);setFindings(f.findings);
    setError(f.blocked?t('tooManyMeters'):'');
  },[request,locale,t,investigationSite]);
  useEffect(()=>{const controller=new AbortController();Promise.resolve().then(()=>load(controller.signal)).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[load]);
  async function mutate(work:()=>Promise<unknown>) {
    if(busy)return;setBusy(true);setError('');setNotice('');
    try{await work();await load();}catch(e){setError(e instanceof Error?e.message:t('error'));}finally{setBusy(false);}
  }
  const importBody=()=>content.trim().startsWith('[')?{rows:JSON.parse(content)}:{csv:content};
  function previewImport(){return mutate(async()=>{setPreview(null);setPreview(await request<Preview>('/api/infrastructure/import',{...importBody(),mode:'preview'}));});}
  const siteOptions=sites.map(s=><option key={s.id} value={s.id}>{s.name}</option>);
  return <div className="view-wrap infra-view utility-workspace">
    <header className="drawer-heading"><div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><button className="wide-button" disabled={busy||loading} onClick={()=>void mutate(()=>load())}>{t('refresh')}</button></header>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {loading?<p role="status">{t('loading')}</p>:<>
      {!canEdit&&<p>{t('ownerOnly')}</p>}
      <section className="panel" style={{padding:20,marginBottom:16}}>
        <h2>{t('sites')}</h2>
        {sites.length===0?<p>{t('noSites')}</p>:<ul>{sites.map(s=><li key={s.id}>{s.name}{s.propertyId?` · ${properties.find(p=>p.id===s.propertyId)?.name ?? s.propertyId}`:''}</li>)}</ul>}
        {canEdit&&<form className="aval-draft-panel" onSubmit={(e:FormEvent)=>{e.preventDefault();void mutate(async()=>{const r=await request<{site:Site}>('/api/infrastructure/sites',{name:siteName,propertyId:propertyId||null});setSiteId(r.site.id);setSiteName('');});}}>
          <label>{t('siteName')}<input required maxLength={200} value={siteName} onChange={e=>setSiteName(e.target.value)}/></label>
          <label>{t('property')}<select value={propertyId} onChange={e=>setPropertyId(e.target.value)}><option value="">{t('independentSite')}</option>{properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <button className="primary-button" disabled={busy||!siteName.trim()}>{t('createSite')}</button>
        </form>}
      </section>
      <section className="panel" style={{padding:20,marginBottom:16}}><h2>{t('meters')}</h2>
        {canEdit&&<form className="aval-draft-panel" onSubmit={e=>{e.preventDefault();void mutate(()=>request('/api/infrastructure/meters',{siteId,utilityType:type,unitOfMeasure:unit,meterNumber:meterNumber||undefined,parentMeterId:parentId||null}));}}>
          <label>{t('site')}<select required value={siteId} onChange={e=>{setSiteId(e.target.value);setParentId('');}}><option value="">{t('selectSite')}</option>{siteOptions}</select></label>
          <label>{t('meterNumber')}<input maxLength={200} value={meterNumber} onChange={e=>setMeterNumber(e.target.value)}/></label>
          <label>{t('service')}<select value={type} onChange={e=>{setType(e.target.value);setParentId('');setUnit(e.target.value==='water'&&locale!=='es-mx'?'gal':units[e.target.value][0]);}}>{['water','electricity','gas'].map(u=><option key={u} value={u}>{t(u)}</option>)}</select></label>
          <label>{t('unit')}<select value={unit} onChange={e=>setUnit(e.target.value)}>{units[type].map(u=><option key={u}>{u}</option>)}</select></label>
          <label>{t('parent')}<select value={parentId} onChange={e=>setParentId(e.target.value)}><option value="">{t('none')}</option>{meters.filter(m=>m.siteId===siteId&&m.utilityType===type).map(m=><option key={m.id} value={m.id}>{m.propertyLabel} · {m.id}</option>)}</select></label>
          <button className="primary-button" disabled={busy||!siteId}>{t('addMeter')}</button>
        </form>}
        <ul>{meters.map(m=><li key={m.id} style={{marginTop:12}}><strong>{m.propertyLabel}{m.meterNumber?` · ${m.meterNumber}`:''}</strong> · {m.unitOfMeasure}<br/><small>{t('meterId')}: {m.id}</small>
          {!m.siteId&&<div><span>{t('unmapped')}</span>{canEdit&&<select aria-label={`${t('mapMeter')}: ${m.id}`} value="" disabled={busy} onChange={e=>void mutate(()=>request('/api/infrastructure/meters',{meterId:m.id,siteId:e.target.value},'PATCH'))}><option value="">{t('selectSite')}</option>{siteOptions}</select>}</div>}
        </li>)}</ul>
      </section>
      {canEdit&&<section className="panel" style={{padding:20,marginBottom:16}}><h2>{t('import')}</h2><p>{t('importHelp')}</p>
        <a href="/utility-import-template.csv" download>{t('template')}</a>
        <label>{t('file')}<input type="file" accept=".csv,.json" disabled={busy} onChange={async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>500000){setError(t('tooLarge'));return;}try{setContent(await file.text());setPreview(null);}catch{setError(t('error'));}}}/></label>
        <label>{t('content')}<textarea rows={7} style={{width:'100%'}} value={content} disabled={busy} onChange={e=>{setContent(e.target.value);setPreview(null);}}/></label>
        <button className="primary-button" disabled={busy||!content.trim()} onClick={()=>void previewImport()}>{t('preview')}</button>
        {preview&&<div><p>{t('counts',{insert:preview.counts.insert,correct:preview.counts.correct,unchanged:preview.counts.unchanged})}</p><div style={{maxHeight:260,overflow:'auto'}}><table><thead><tr><th>{t('record')}</th><th>{t('action')}</th><th>{t('values')}</th></tr></thead><tbody>{preview.rows.map(r=><tr key={`${r.externalId}-${String(r.bill.meterId)}`}><td>{r.externalId}</td><td>{t(r.action)}</td><td>{t('site')}: {sites.find(s=>s.id===meters.find(m=>m.id===r.bill.meterId)?.siteId)?.name}<br/>{t('meterId')}: {String(r.bill.meterId)}<br/>{String(r.bill.periodStart).slice(0,10)} / {String(r.bill.periodEnd).slice(0,10)}<br/>{String(r.bill.usageAmount)} {String(r.bill.unitOfMeasure)} · {Number(r.bill.costCents)/100} {String(r.bill.currency)}<br/>{t('reading')}: {t(String(r.bill.readingKind))}<details><summary>{t('sourceDetails')}</summary><pre>{JSON.stringify(r.bill,null,2)}</pre></details></td></tr>)}</tbody></table></div>
          <button className="primary-button" disabled={busy} onClick={()=>void mutate(async()=>{await request('/api/infrastructure/import',{...importBody(),mode:'apply',previewToken:preview.previewToken});setPreview(null);setContent('');setNotice(t('imported'));})}>{t('confirmImport')}</button>
        </div>}
      </section>}
      <section className="panel" style={{padding:20}}><h2>{t('investigations')}</h2><label>{t('site')}<select value={investigationSite} disabled={busy} onChange={e=>{setInvestigationSite(e.target.value);setDraft(null);}}><option value="">{t('allSites')}</option>{siteOptions}</select></label><p>{t('freshness')}</p>
        {findings.length===0&&<p>{t('noFindings')}</p>}
        {findings.map(f=><article key={f.meterId} style={{marginBottom:20}}><h3>{f.title}</h3><p>{f.explanation}</p><p>{f.caveat}</p>
          <details><summary>{t('evidence')}</summary>{f.evidence.map(e=><p key={String(e.id)}>{String(e.id)} · {String(e.periodStart)} / {String(e.periodEndExclusive)} · {String(e.usageAmount)} {String(e.unitOfMeasure)} · {Number(e.costCents)/100} {String(e.currency)}<br/>{t('recorded')}: {String(e.recordedAt)}</p>)}</details>
          {canEdit&&f.siteId&&f.currentBillId&&<button className="wide-button" disabled={busy} onClick={()=>setDraft({...f,followUpDraft:{...f.followUpDraft,title:f.followUpDraft.title.slice(0,160)}})}>{t('prepareTask')}</button>}
        </article>)}
        {draft&&<form className="aval-draft-panel" onSubmit={e=>{e.preventDefault();void mutate(async()=>{await request('/api/infrastructure/follow-up',{meterId:draft.meterId,siteId:draft.siteId,currentBillId:draft.currentBillId,priorBillId:draft.priorBillId,locale,...draft.followUpDraft});setDraft(null);setNotice(t('taskSaved'));});}}>
          <label>{t('taskTitle')}<input required maxLength={160} value={draft.followUpDraft.title} onChange={e=>setDraft({...draft,followUpDraft:{...draft.followUpDraft,title:e.target.value}})}/></label>
          <label>{t('taskDescription')}<textarea required rows={6} maxLength={5000} value={draft.followUpDraft.description} onChange={e=>setDraft({...draft,followUpDraft:{...draft.followUpDraft,description:e.target.value}})}/></label>
          <button className="primary-button" disabled={busy}>{t('saveTask')}</button><button type="button" className="wide-button" onClick={()=>setDraft(null)}>{t('cancel')}</button>
        </form>}
      </section>
    </>}
  </div>;
}
