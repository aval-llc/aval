"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, NavArrowDown, Packages, ShieldCheck, WarningTriangle } from "iconoir-react";

/**
 * What Aval knows how to drive in a provider, and how far it is proven.
 *
 * An inspection surface, not an editor. A workflow's steps are how Aval drives
 * somebody's PMS as their own signed-in user; they are not shown here and there
 * is no way to change them from this screen. The customer configures access and
 * grants — Aval owns the implementations.
 *
 * The column that carries the most weight is certification, because it is the
 * one a reader will otherwise assume. `simulator_e2e_tested` beside a workflow
 * for AppFolio has to be unmissable next to the provider's name, or the screen
 * quietly implies AppFolio has been exercised when it has not.
 */

type Status = "draft" | "testing" | "active" | "degraded" | "disabled";
type Certification =
  | "unimplemented" | "unit_tested" | "simulator_e2e_tested"
  | "customer_authorized_ui_tested" | "sandbox_tested" | "live_provider_tested";

interface Workflow {
  id: string;
  provider: string;
  providerName: string;
  capability: string;
  version: number;
  accessMode: string;
  status: Status;
  certification: Certification;
  riskClass: string;
  requiredRole: string | null;
  verificationStrategy: string;
  reconciliationStrategy: string;
  fallback: string;
  knownIssues: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  consecutiveFailures: number;
  shipped: boolean;
  canPromote: boolean;
}

/** The transitions a person can take from here, mirroring the runtime's table. */
const NEXT: Record<Status, readonly Status[]> = {
  draft: ["testing", "disabled"],
  testing: ["active", "draft", "disabled"],
  active: ["degraded", "disabled"],
  degraded: ["testing", "disabled"],
  disabled: ["draft"],
};

/** Only these mean a real provider was ever touched. */
const PROVEN_AGAINST_PROVIDER: ReadonlySet<Certification> = new Set([
  "sandbox_tested", "live_provider_tested",
]);

export function PmsWorkflows({ provider }: { provider?: string }) {
  const t = useTranslations();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch(`/api/pms/workflows${query}`);
        if (!response.ok) return;
        const body = await response.json() as { workflows: Workflow[] };
        if (live) setWorkflows(body.workflows);
      } catch {
        /* A settings panel that cannot load is quiet, not alarming. */
      }
    })();
    return () => { live = false; };
  }, [query]);

  const promote = useCallback(async (id: string, status: Status) => {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch("/api/pms/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) {
        // The runtime's own words. It knows why a transition was refused and
        // restating it here would let the two drift apart.
        setError(body.error ?? t("PmsWorkflows.couldNotChange"));
        return;
      }
      const refreshed = await fetch(`/api/pms/workflows${query}`);
      if (refreshed.ok) setWorkflows((await refreshed.json() as { workflows: Workflow[] }).workflows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("PmsWorkflows.couldNotChange"));
    } finally {
      setBusy(null);
    }
  }, [query, t]);

  if (!workflows || workflows.length === 0) return null;

  return <section className="pms-workflows">
    <header className="pms-workflows-head">
      <Packages width={18} height={18}/>
      <div>
        <strong>{t("PmsWorkflows.title")}</strong>
        <p>{t("PmsWorkflows.explainer")}</p>
      </div>
    </header>

    <ul className="pms-workflow-list">
      {workflows.map((flow) => {
        const expanded = open === flow.id;
        const unproven = !PROVEN_AGAINST_PROVIDER.has(flow.certification);
        return <li key={flow.id} className="pms-workflow">
          <button className="pms-workflow-row" onClick={() => setOpen(expanded ? null : flow.id)}
            aria-expanded={expanded}>
            <span className="pms-workflow-identity">
              <strong>{flow.capability}</strong>
              <small>{flow.providerName} · v{flow.version}{flow.shipped ? ` · ${t("PmsWorkflows.shipped")}` : ""}</small>
            </span>
            <span className={`pms-workflow-status is-${flow.status}`}>{t(`PmsWorkflows.status_${flow.status}`)}</span>
            {/* Next to the provider's name on purpose: this is the fact a
                reader would otherwise assume in Aval's favour. */}
            <span className={`pms-workflow-cert${unproven ? " is-unproven" : ""}`}>
              {unproven ? <WarningTriangle width={12} height={12}/> : <ShieldCheck width={12} height={12}/>}
              {t(`PmsWorkflows.cert_${flow.certification}`)}
            </span>
            <NavArrowDown width={15} height={15} className={expanded ? "is-open" : ""}/>
          </button>

          {expanded && <div className="pms-workflow-detail">
            <dl>
              <div><dt>{t("PmsWorkflows.accessMode")}</dt><dd>{flow.accessMode}</dd></div>
              <div><dt>{t("PmsWorkflows.risk")}</dt><dd>{flow.riskClass}</dd></div>
              <div><dt>{t("PmsWorkflows.verification")}</dt><dd>{flow.verificationStrategy}</dd></div>
              <div><dt>{t("PmsWorkflows.reconciliation")}</dt><dd>{flow.reconciliationStrategy}</dd></div>
              <div><dt>{t("PmsWorkflows.fallback")}</dt><dd>{flow.fallback}</dd></div>
              <div>
                <dt>{t("PmsWorkflows.lastTested")}</dt>
                <dd>{flow.lastTestedAt
                  ? `${new Date(flow.lastTestedAt).toLocaleString()}${flow.lastTestOk === false ? ` — ${t("PmsWorkflows.lastTestFailed")}` : ""}`
                  : t("PmsWorkflows.neverTested")}</dd>
              </div>
              {flow.requiredRole && <div className="is-wide">
                <dt>{t("PmsWorkflows.requiredRole")}</dt><dd>{flow.requiredRole}</dd>
              </div>}
              {flow.consecutiveFailures > 0 && <div>
                <dt>{t("PmsWorkflows.consecutiveFailures")}</dt><dd>{flow.consecutiveFailures}</dd>
              </div>}
            </dl>

            {flow.knownIssues && <p className="pms-workflow-issues">
              <WarningTriangle width={14} height={14}/>{flow.knownIssues}
            </p>}

            {flow.canPromote
              ? <div className="pms-workflow-actions">
                  {NEXT[flow.status].map((next) => <button key={next} className="soft-button"
                    disabled={busy === flow.id} onClick={() => void promote(flow.id, next)}>
                    {t(`PmsWorkflows.moveTo_${next}`)}
                  </button>)}
                </div>
              : <p className="pms-workflow-locked">
                  <Check width={13} height={13}/>
                  {flow.shipped ? t("PmsWorkflows.shippedLocked") : t("PmsWorkflows.needsAdministrator")}
                </p>}
          </div>}
        </li>;
      })}
    </ul>

    {error && <p className="pms-workflow-error" role="alert">{error}</p>}
  </section>;
}
