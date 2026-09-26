"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle, NavArrowDown, ShieldCheck, Xmark } from "iconoir-react";
import { BrandMark } from "./brand-mark";
import type { Provider } from "./connection-dialog";

const SERVICE_FIELDS = ["collectionPath", "companyField", "companyId", "recordKeyFields"] as const;

/** Compact customer-facing setup; the administrator's one-time fields stay secondary. */
export function SapConnectionDialog({ provider, onClose, onRefresh }: {
  provider: Provider; onClose: () => void; onRefresh: () => void;
}) {
  const t = useTranslations("ConnectionDialog.sap");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [connected, setConnected] = useState(provider.connection?.status === "connected");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const serviceInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const blocked = Boolean(provider.setupBlocker) || provider.configured === false;
  useEffect(() => { if (advanced) serviceInput.current?.focus(); }, [advanced]);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || blocked) return;
    if (SERVICE_FIELDS.some(key => !credentials[key]?.trim())) {
      setAdvanced(true); setFailed(true); setMessage(t("setupNeeded")); return;
    }
    pending.current = true; setBusy(true); setMessage(""); setFailed(false);
    try {
      const saved = await fetch("/api/integrations/connect", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "sap_bydesign", credentials }), signal: AbortSignal.timeout(30_000) });
      const body = await saved.json() as { connection?: { id: string } };
      if (!saved.ok || !body.connection?.id) throw new Error("setup");
      const verified = await fetch("/api/integrations/verify", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: body.connection.id }), signal: AbortSignal.timeout(30_000) });
      if (!verified.ok) { onRefresh(); throw new Error("verification"); }
      setCredentials({}); setConnected(true); onRefresh();
    } catch {
      setFailed(true); setMessage(t("tryAgain"));
    } finally { pending.current = false; setBusy(false); }
  };

  const check = async () => {
    if (pending.current || !provider.connection?.id) return;
    pending.current = true; setBusy(true); setMessage(""); setFailed(false);
    try {
      const response = await fetch("/api/integrations/validate", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: provider.connection.id }), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("verification");
      setMessage(t("checkPassed"));
    } catch { setFailed(true); setMessage(t("tryAgain")); }
    finally { pending.current = false; setBusy(false); }
  };

  const field = (key: string, options: { secret?: boolean; placeholder?: string } = {}) => (
    <label key={key}>
      {t(`compactLabels.${key}`)}
      <input ref={key === "collectionPath" ? serviceInput : undefined}
        type={options.secret ? "password" : key === "tenantUrl" ? "url" : "text"}
        value={credentials[key] ?? ""} onChange={event => setCredentials(current => ({ ...current, [key]: event.target.value }))}
        placeholder={options.placeholder} autoComplete="off" autoCapitalize="none" spellCheck={false}
        maxLength={options.secret ? 2000 : 500} required disabled={busy} />
    </label>
  );

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="connection-dialog sap-connect-dialog">
      <div className="dialog-top"><BrandMark provider="sap_bydesign" />
        <Dialog.Close className="icon-button" aria-label={t("close")}><Xmark width={18} height={18} /></Dialog.Close>
      </div>
      <Dialog.Title>{connected ? t("connectedTitle") : t("connectTitle")}</Dialog.Title>
      <Dialog.Description>{connected ? t("connectedDescription") : t("shortDescription")}</Dialog.Description>
      {connected ? <>
        <div className="sap-connection-summary"><CheckCircle width={18} height={18} /><span>{t("accessReady")}</span></div>
        {message && <p role="status" className={`dialog-message ${failed ? "error" : ""}`}>{message}</p>}
        <div className="dialog-actions">
          {provider.connection?.id && <button className="soft-button" onClick={() => void check()} disabled={busy}>{busy ? t("connecting") : t("check")}</button>}
          <button className="primary-button" onClick={onClose}>{t("done")}</button>
        </div>
        <button className="sap-reconnect" onClick={() => { setConnected(false); setMessage(""); }} disabled={busy}>{t("changeAccount")}</button>
      </> : <form onSubmit={connect} aria-busy={busy}>
        <div className="credential-form sap-account-fields">
          {field("tenantUrl", { placeholder: "https://your-company.sapbydesign.com" })}
          {field("username")}
          {field("password", { secret: true })}
        </div>
        <div className="sap-service-setup">
          <button className="sap-setup-toggle" type="button" aria-expanded={advanced} aria-controls="sap-service-fields"
            onClick={() => setAdvanced(value => !value)} disabled={busy}>
            {t("adminSetup")}<NavArrowDown width={14} height={14} className={advanced ? "is-open" : ""} />
          </button>
          {advanced && <div id="sap-service-fields" className="credential-form sap-service-fields">
            <p>{t("adminHint")}</p>
            {SERVICE_FIELDS.map(key => field(key))}
          </div>}
        </div>
        {blocked && <p role="status" className="dialog-message error">{t("unavailable")}</p>}
        {message && <p role="status" className={`dialog-message ${failed ? "error" : ""}`}>{message}</p>}
        <div className="dialog-actions sap-connect-actions">
          <span className="sap-access-note"><ShieldCheck width={14} height={14} />{t("secureReadOnly")}</span>
          <button className="primary-button" type="submit" disabled={busy || blocked}>{busy ? t("connecting") : t("connectButton")}</button>
        </div>
      </form>}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
