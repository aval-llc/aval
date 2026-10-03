"use client";
import { useState } from 'react';
import { useLocale } from 'next-intl';
import * as Dialog from '@radix-ui/react-dialog';
import { Xmark } from 'iconoir-react';
import { BrandMark } from './brand-mark';
import { PmsSeat } from './pms-seat';
import type { Provider } from './connection-dialog';
import { PmsReportImport } from './pms-report-import';
import { PmsDesktopSession } from './pms-desktop-session';

export function PmsConnectDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const es = useLocale() === 'es-mx';
  const [path, setPath] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const demo = async () => {
    setBusy(true); setError('');
    try {
      for (const action of ['create','seed']) {
        const response = await fetch('/api/organizations/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
        const data = await response.json() as { error?: string };
        if (!response.ok) throw Error(data.error || 'Demo setup failed');
      }
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Demo setup failed'); setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="connection-dialog sap-connect-dialog" style={{maxHeight:'85vh',overflowY:'auto'}}><div className="dialog-top"><BrandMark provider={provider.id} /><Dialog.Close className="icon-button" aria-label={es ? 'Cerrar' : 'Close'}><Xmark width={18} height={18} /></Dialog.Close></div>
      <Dialog.Title>{es ? 'Conectar' : 'Connect'} {provider.title}</Dialog.Title>
      <Dialog.Description>{es ? 'Trae tus datos a Aval con acceso de lectura.' : 'Bring your portfolio into Aval with read access.'}</Dialog.Description>
      <div className="credential-form">{[
        ['api', es ? 'Conectar API aprobada' : 'Connect approved API'],
        ['notifications', es ? 'Recibir notificaciones' : 'Receive notifications'],
        ['reports', es ? 'Importar reportes' : 'Import reports'],
        ...(provider.id==='buildium'?[['desktop',es?'Conectar usuario restringido':'Connect restricted staff']]:[]),
      ].map(([id,label]) => <button key={id} className={path === id ? 'primary-button' : 'soft-button'} onClick={() => setPath(id)}>{label}</button>)}</div>
      {path === 'api' && <p role="status">{es ? 'Pendiente de acceso aprobado por el proveedor. Puedes empezar con reportes o notificaciones; la sincronización API aún no está habilitada.' : 'Awaiting approved vendor access. Start with reports or notifications; API synchronization is not enabled yet.'}</p>}
      {path === 'notifications' && <><p>{es ? 'Las notificaciones cubren los eventos recibidos, no todo tu portafolio.' : 'Notifications cover received events, not your complete portfolio.'}</p><PmsSeat initialProvider={provider.id} /></>}
      {path === 'reports' && <PmsReportImport provider={provider.id} />}
      {path === 'desktop' && <PmsDesktopSession provider={provider.id}/>}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><span>{provider.id==='buildium'?(es?'Escritura supervisada; sin pagos':'Supervised write; no payments'):(es ? 'Solo lectura' : 'Read-only access')}</span><button className="primary-button" disabled={busy} onClick={() => void demo()}>{busy ? (es ? 'Preparando…' : 'Preparing…') : (es ? 'Probar portafolio de ejemplo' : 'Try sample portfolio')}</button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
