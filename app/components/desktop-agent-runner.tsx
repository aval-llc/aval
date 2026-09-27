"use client";
import { useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import type { useDesktopCodex } from './desktop-codex';

export function DesktopAgentRunner({ desktop }: { desktop: ReturnType<typeof useDesktopCodex> }) {
  const es = useLocale() === 'es-mx';
  const [running, setRunning] = useState(false), [notice, setNotice] = useState('');
  const connection = useRef<{ organizationId: string; runnerId: string } | null>(null);
  const bridge = desktop.bridge;
  const call = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/agents/desktop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...connection.current, ...body }) });
    const data = await response.json() as { error?: string; job?: { id: string; claimToken: string; model: string; params: unknown } };
    if (!response.ok) throw Error(data.error || 'Desktop connection failed');
    return data;
  };
  const start = async () => {
    try {
      if (!bridge) throw Error('Open Aval Desktop');
      // The evaluation model is explicit; unavailable Luna never falls back.
      await desktop.setModel('gpt-6-luna');
      await desktop.setActive(true);
      const response = await fetch('/api/agents/desktop', { cache: 'no-store' });
      const state = await response.json() as { organizationId?: string; error?: string };
      if (!response.ok || !state.organizationId) throw Error(state.error || 'Workspace owner required');
      connection.current = { organizationId: state.organizationId, runnerId: crypto.randomUUID() };
      await call({ action: 'register', model: 'gpt-6-luna' });
      setNotice(''); setRunning(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Desktop unavailable'); }
  };
  useEffect(() => {
    if (!running || !bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const response = await fetch('/api/agents/desktop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...connection.current, action: 'claim' }) });
        const data = await response.json() as { error?: string; job?: { id: string; claimToken: string; model: string; params: unknown } };
        if (!response.ok) throw Error(data.error || 'Desktop disconnected');
        if (data.job && !stopped) {
          const result = await bridge.infer({ model: data.job.model, params: data.job.params });
          const saved = await fetch('/api/agents/desktop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...connection.current, action: 'complete', jobId: data.job.id, claimToken: data.job.claimToken, response: result }) });
          if (!saved.ok) throw Error('Could not save the model response; reconnect Desktop');
        }
      } catch (error) { if (!stopped) { setNotice(error instanceof Error ? error.message : 'Desktop unavailable'); setRunning(false); } return; }
      if (!stopped) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, bridge]);
  return <span><button className="soft-button" onClick={() => { if (running) { void call({ action: 'pause' }).catch(() => {}); setRunning(false); } else void start(); }}>
    {running ? (es ? 'Agentes conectados · Luna' : 'Agents connected · Luna') : (es ? 'Activar agentes con Luna' : 'Enable agents with Luna')}
  </button>{notice && <span role="status">{notice}</span>}</span>;
}
