"use client";
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { REPORT_FIELDS, parseReportCsv, type ReportDataset } from '@/lib/operations/pms-reports';

export function PmsReportImport({provider}:{provider:string}) {
  const es = useLocale() === 'es-mx';
  const [dataset,setDataset] = useState<ReportDataset>('properties');
  const [csv,setCsv] = useState(''), [headers,setHeaders] = useState<string[]>([]);
  const [mapping,setMapping] = useState<Record<string,string>>({});
  const [profiles,setProfiles] = useState<{provider:string;dataset:string;mapping_json:Record<string,string>}[]>([]);
  const [preview,setPreview] = useState<{digest:string;counts:Record<string,number>;skipped:{detail:string}[];sample:unknown} | null>(null);
  const [busy,setBusy] = useState(false), [notice,setNotice] = useState('');
  useEffect(() => { const controller = new AbortController(); void fetch('/api/operations/reports',{signal:controller.signal}).then(r => r.json()).then(data => setProfiles((data as {profiles?:typeof profiles}).profiles ?? [])).catch(() => {}); return () => controller.abort(); },[]);
  const submit = async (action:'preview'|'apply') => {
    setBusy(true); setNotice('');
    try {
      const response = await fetch('/api/operations/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider,dataset,csv,mapping,currency:'USD',action,digest:preview?.digest})});
      const data = await response.json() as NonNullable<typeof preview> & {error?:string};
      if (!response.ok) throw Error(data.error || 'Import failed');
      if (action === 'preview') setPreview(data);
      else { setPreview(null); setNotice(es ? 'Reporte importado. No hay sincronización API activa.' : 'Report imported. API synchronization is not active.'); }
    } catch(error) { setNotice(error instanceof Error ? error.message : 'Import failed'); }
    finally { setBusy(false); }
  };
  return <section className="credential-form" aria-label={es ? 'Importar reporte' : 'Import report'}>
    <p>{es ? 'Importa propiedades primero, luego unidades, residentes, contratos y movimientos. USD solamente; cantidades en centavos. Revisa cada asignación.' : 'Import properties first, then units, residents, leases and ledger entries. USD only; money fields use cents. Review every mapping.'}</p>
    <label>{es ? 'Datos' : 'Dataset'}<select value={dataset} disabled={busy} onChange={e=>{setDataset(e.target.value as ReportDataset);setCsv('');setHeaders([]);setMapping({});setPreview(null);}}>{Object.keys(REPORT_FIELDS).map(key=><option key={key}>{key}</option>)}</select></label>
    <label>CSV<input type="file" accept=".csv,text/csv" disabled={busy} key={dataset} onChange={async e=>{
      setPreview(null); setNotice(''); const file=e.target.files?.[0]; if(!file)return;
      try { if(file.size>2_000_000)throw Error('Maximum 2 MB'); const text=await file.text();const parsed=parseReportCsv(text);setCsv(text);setHeaders(parsed.headers);
        const saved=profiles.find(p=>p.provider===provider&&p.dataset===dataset)?.mapping_json ?? {};
        setMapping(Object.fromEntries(REPORT_FIELDS[dataset].map(field=>[field,parsed.headers.includes(saved[field])?saved[field]:parsed.headers.find(h=>h.toLowerCase().replace(/[ _-]/g,'')===field.toLowerCase())??''])));
      }catch(error){setCsv('');setHeaders([]);setNotice(error instanceof Error?error.message:'Invalid CSV');}
    }}/></label>
    {headers.length>0&&REPORT_FIELDS[dataset].map(field=><label key={field}>{field}<select value={mapping[field]??''} disabled={busy} onChange={e=>{setMapping({...mapping,[field]:e.target.value});setPreview(null);}}><option value="">{es?'Sin asignar':'Not mapped'}</option>{headers.map(h=><option key={h}>{h}</option>)}</select></label>)}
    {csv&&<button className="soft-button" disabled={busy} onClick={()=>void submit('preview')}>{es?'Vista previa':'Preview import'}</button>}
    {preview&&<><p>{Object.entries(preview.counts).filter(([,n])=>n).map(([k,n])=>`${k}: ${n}`).join(' · ')}</p><pre style={{maxHeight:180,overflow:'auto'}}>{JSON.stringify(preview.sample,null,2)}</pre>{preview.skipped.map((row,i)=><p role="alert" key={i}>{row.detail}</p>)}<button className="primary-button" disabled={busy||preview.skipped.length>0} onClick={()=>void submit('apply')}>{es?'Confirmar importación revisada':'Confirm reviewed import'}</button></>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
