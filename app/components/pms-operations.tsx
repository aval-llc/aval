"use client";
import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';

type Operation = {
  id:string; provider:string; status:string; external_id:string|null; reference:string|null;
  last_error:string|null; review_due_at:string|null; responsible_user_id:string|null; submitted_at:string|null;
};

/** Operational truth comes from PostgreSQL, not the Desktop's last toast. */
export function PmsOperations() {
  const t=useTranslations('PmsOperations'),locale=useLocale();
  const [operations,setOperations]=useState<Operation[]|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    let inFlight=false;
    const refresh=async()=>{
      if(inFlight || controller.signal.aborted)return;
      inFlight=true;
      try {
        const response=await fetch('/api/pms/browser-v2',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])});
        if(response.status===403) {if(!controller.signal.aborted)setOperations(null);return;}
        if(!response.ok)throw Error('Could not load PMS operations');
        const data=await response.json() as {operations?:Operation[]};
        if(!Array.isArray(data.operations))throw Error('Invalid PMS status');
        if(!controller.signal.aborted){setOperations(data.operations);setFailed(false);}
      } catch {if(!controller.signal.aborted)setFailed(true);}
      finally {inFlight=false;}
    };
    void refresh();const timer=setInterval(()=>void refresh(),15_000);
    return()=>{controller.abort();clearInterval(timer);};
  },[]);
  if(!operations?.length && !failed)return null;
  return <section className="pms-session" aria-label={t('title')}>
    <header className="pms-session-head"><div><strong>{t('title')}</strong><p>{t('explanation')}</p></div></header>
    {failed && <p role="alert" className="pms-session-error">{t('loadError')}</p>}
    {operations?.map(operation=>{
      const confirmed=operation.status==='confirmed' && Boolean(operation.external_id);
      const state=confirmed?'confirmed':operation.status==='needs_review'?'review':operation.submitted_at?'unknown':operation.status==='leased'?'preparing':'waiting';
      return <article className="pms-session" key={operation.id}>
        <header className="pms-session-head"><strong>{operation.provider}</strong><span>{t(state)}</span></header>
        <p>{t(operation.submitted_at?'mayHaveSubmitted':'notSubmitted')}</p>
        {operation.reference && <p>{t('reference')}: <code>{operation.reference}</code></p>}
        {confirmed && <p>{t('workOrder')}: <code>{operation.external_id}</code></p>}
        {!confirmed && operation.last_error && <p>{operation.last_error}</p>}
        {!confirmed && operation.review_due_at && <p>{t('reviewDue')}: {new Date(operation.review_due_at).toLocaleString(locale)}</p>}
        {!confirmed && operation.responsible_user_id && <p>{t('responsible')}: {operation.responsible_user_id}</p>}
      </article>;
    })}
  </section>;
}
