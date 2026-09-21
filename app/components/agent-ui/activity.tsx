"use client";
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { summarizeActivity, settledRun, visualActivity, type SafeStep } from '@/lib/ask-aval/visual-activity';
import { AvalThinkingOrb } from './effects';
export function AvalActivityTrace({ status, steps, startedAt, finishedAt }: { status: string; steps: SafeStep[]; startedAt?: string | number; finishedAt?: string | number | null }) {
  const t = useTranslations('MinimalChat');
  const [disclosure, setDisclosure] = useState({ terminal: false, open: false });
  const [now, setNow] = useState(() => Date.now());
  const done = settledRun(status);
  const waiting = status.startsWith('WAITING_') || ['BLOCKED', 'SCHEDULED', 'PENDING_VERIFICATION'].includes(status);
  const expanded = disclosure.terminal === done && disclosure.open;
  useEffect(() => { if (done || waiting) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [done, waiting]);
  const summary = summarizeActivity(steps);
  const elapsed = startedAt ? Math.max(0, Math.round(((finishedAt ? new Date(finishedAt).getTime() : now) - new Date(startedAt).getTime()) / 1000)) : 0;
  const label = status === 'COMPLETED' ? t('worked', { seconds: elapsed }) : t.has(`status.${status}`) ? t(`status.${status}`) : t('working');
  const rows = expanded ? summary.steps : done ? [] : summary.steps.slice(-3);
  return <div className="aval-activity-rail" data-status={status}>
    <button type="button" className="aval-activity-summary" aria-expanded={expanded} onClick={() => setDisclosure({ terminal: done, open: !expanded })}>
      <AvalThinkingOrb activity={visualActivity({ status, steps })} paused={done || waiting}/><span>{label}{!done && !waiting && elapsed >= 3 ? ` · ${elapsed}s` : ''}{done && summary.lookups > 0 ? ` · ${t('lookups', { count: summary.lookups })}` : ''}{done && summary.actions > 0 ? ` · ${t('actions', { count: summary.actions })}` : ''}</span><span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
    </button>
    <div className="sr-only" role="status">{label}</div>
    {rows.length > 0 && <ol>{rows.map(step => <li key={step.id}>{(step.kind === 'tool_call' && step.policy !== 'deny' || step.kind === 'approval_decided' && step.policy === 'allow') && step.tool && t.has(`tools.${step.tool}`) ? t(`tools.${step.tool}`) : step.kind === 'tool_call' && step.mutates && step.policy !== 'deny' ? t('actionCompleted') : t.has(`step.${step.kind}`) ? t(`step.${step.kind}`) : t('working')}{step.repetitions > 1 ? ` ×${step.repetitions}` : ''}</li>)}</ol>}
  </div>;
}
