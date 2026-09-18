"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Check, Lock, WarningTriangle } from "iconoir-react";
import { centsToDollars, dollarsToCents, parseAccountIds, parseCurrencies } from "@/lib/agents/financial-policy-form";

interface PolicyView {
  status: "draft" | "approved" | "suspended";
  singleApprovalMaxCents: number;
  hardCeilingCents: number;
  dailyLimitCents: number;
  allowedCurrencies: string[];
  allowedAccountCount: number;
  version: number;
  approvedAt: string | number | null;
}

const CONFIRMATION = "APPROVE FINANCIAL POLICY";

async function fetchPolicy(): Promise<PolicyView | null> {
  const response = await fetch("/api/agents/policy", { cache: "no-store" });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({})) as { policy?: PolicyView };
  return data.policy ?? null;
}

/** Owner-operated controls for the deterministic financial envelope. */
export function FinancialAgentControls() {
  const t = useTranslations();
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [singleMax, setSingleMax] = useState("");
  const [hardCeiling, setHardCeiling] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const [currencies, setCurrencies] = useState("USD");
  const [accounts, setAccounts] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void fetchPolicy().then((next) => {
      if (!next) return;
      setAvailable(true);
      setPolicy(next);
      setSingleMax(centsToDollars(next.singleApprovalMaxCents));
      setHardCeiling(centsToDollars(next.hardCeilingCents));
      setDailyLimit(centsToDollars(next.dailyLimitCents));
      setCurrencies(next.allowedCurrencies.join(", "));
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const activate = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");
    const singleApprovalMaxCents = dollarsToCents(singleMax);
    const hardCeilingCents = dollarsToCents(hardCeiling);
    const dailyLimitCents = dollarsToCents(dailyLimit);
    if (singleApprovalMaxCents === null || hardCeilingCents === null || dailyLimitCents === null) {
      setError(t("FinancialAgentControls.invalidMoney"));
      return;
    }
    setWorking(true);
    try {
      const response = await fetch("/api/agents/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          singleApprovalMaxCents,
          hardCeilingCents,
          dailyLimitCents,
          allowedCurrencies: parseCurrencies(currencies),
          allowedAccountIds: parseAccountIds(accounts),
          confirmation,
        }),
      });
      const data = await response.json().catch(() => ({})) as { policy?: PolicyView; error?: string };
      if (!response.ok || !data.policy) throw new Error(data.error ?? t("FinancialAgentControls.saveFailed"));
      setPolicy(data.policy);
      setAccounts("");
      setConfirmation("");
      setMessage(t("FinancialAgentControls.activated", { version: data.policy.version }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("FinancialAgentControls.saveFailed"));
    } finally {
      setWorking(false);
    }
  };

  const suspend = async () => {
    if (!window.confirm(t("FinancialAgentControls.suspendConfirm"))) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/agents/policy", { method: "DELETE" });
      if (!response.ok) throw new Error(t("FinancialAgentControls.suspendFailed"));
      const next = await fetchPolicy();
      if (next) setPolicy(next);
      setMessage(t("FinancialAgentControls.suspended"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("FinancialAgentControls.suspendFailed"));
    } finally {
      setWorking(false);
    }
  };

  if (!available || !policy) return <p className="settings-muted" role="status">{t(loading ? "SettingsModule.loading" : "SettingsModule.unavailable")}</p>;
  const active = policy.status === "approved";

  return (
    <article className="settings-card financial-agent-controls" data-reveal>
      <div className="financial-policy-header">
        <div>
          <p className="eyebrow">{t("FinancialAgentControls.eyebrow")}</p>
          <h2>{t("FinancialAgentControls.title")}</h2>
        </div>
        <span className={`financial-policy-status ${active ? "active" : "inactive"}`}>
          {active ? <Check width={13} height={13}/> : <Lock width={13} height={13}/>}
          {t(`FinancialAgentControls.status_${policy.status}`)}
        </span>
      </div>

      <div className="financial-policy-invariant">
        <WarningTriangle width={17} height={17}/>
        <p><strong>{t("FinancialAgentControls.humanGateTitle")}</strong>{t("FinancialAgentControls.humanGateBody")}</p>
      </div>

      <form onSubmit={activate} className="financial-policy-form">
        <div className="financial-policy-limits">
          <label><span>{t("FinancialAgentControls.singleMax")}</span><small>{t("FinancialAgentControls.singleMaxHint")}</small><div><b>$</b><input inputMode="decimal" value={singleMax} onChange={(event) => setSingleMax(event.target.value)} required/></div></label>
          <label><span>{t("FinancialAgentControls.hardCeiling")}</span><small>{t("FinancialAgentControls.hardCeilingHint")}</small><div><b>$</b><input inputMode="decimal" value={hardCeiling} onChange={(event) => setHardCeiling(event.target.value)} required/></div></label>
          <label><span>{t("FinancialAgentControls.dailyLimit")}</span><small>{t("FinancialAgentControls.dailyLimitHint")}</small><div><b>$</b><input inputMode="decimal" value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} required/></div></label>
        </div>

        <div className="financial-policy-scope">
          <label><span>{t("FinancialAgentControls.currencies")}</span><small>{t("FinancialAgentControls.currenciesHint")}</small><input value={currencies} onChange={(event) => setCurrencies(event.target.value)} required/></label>
          <label><span>{t("FinancialAgentControls.destinations")}</span><small>{active ? t("FinancialAgentControls.destinationsReplace", { count: policy.allowedAccountCount }) : t("FinancialAgentControls.destinationsHint")}</small><textarea rows={3} value={accounts} onChange={(event) => setAccounts(event.target.value)} required/></label>
        </div>

        <div className="financial-policy-activation">
          <label><span>{t("FinancialAgentControls.confirmLabel")}</span><code>{CONFIRMATION}</code><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={CONFIRMATION} autoComplete="off" required/></label>
          <div className="financial-policy-actions">
            {active && <button type="button" className="soft-button financial-policy-suspend" disabled={working} onClick={suspend}>{t("FinancialAgentControls.suspend")}</button>}
            <button type="submit" className="primary-button" disabled={working || confirmation !== CONFIRMATION}>{working ? t("FinancialAgentControls.saving") : active ? t("FinancialAgentControls.publishNewVersion") : t("FinancialAgentControls.activate")}</button>
          </div>
        </div>
      </form>
      {(error || message) && <p className={error ? "financial-policy-feedback error" : "financial-policy-feedback success"} role="status">{error || message}</p>}
      <p className="financial-policy-meta">{t("FinancialAgentControls.policyMeta", { version: policy.version, accounts: policy.allowedAccountCount })}</p>
    </article>
  );
}
