"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BrandMark } from "./brand-mark";

/**
 * The capability matrix, as an operator sees it (docs/PMS_INTEGRATION.md, P2).
 *
 * Five states, five different sentences. The whole point of this surface is that
 * "AppFolio terms prohibit automated writes" and "not yet supported — flow
 * pending" never look the same: one is a policy wall the customer cannot climb,
 * the other is Aval's backlog. Only `off` renders as a control, because only
 * `off` is something this operator can change.
 *
 * Descriptor reasons arrive in English and are rendered verbatim rather than
 * translated. They quote contract clauses; a mistranslated terms citation is
 * worse than an untranslated one, and the `owner` field carries the meaning that
 * actually needs localising.
 */

type ActionRow = {
  action: string;
  kind: "read" | "write";
  tool: string | null;
  state: "allow" | "off" | "blocked" | "unlearned" | "unavailable";
  reason: string | null;
  remediation: string | null;
  owner: "aval" | "customer" | "provider" | null;
  mechanism: string | null;
  mandatoryApproval: boolean;
  actionable: boolean;
};

type ProviderRow = {
  provider: string;
  displayName: string;
  readMechanisms: string[];
  writeMechanisms: string[];
  runner: "cloud" | "desktop" | null;
  termsVerifiedAt: string | null;
  workflows: { workflow: string; writeDefault: "on" | "off" | "none"; actions: ActionRow[] }[];
};

export function PmsMatrix() {
  const t = useTranslations("PmsMatrix");
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  // Fetch inline in the effect rather than through a memoized async helper: the
  // helper form reads to the linter as setState during the effect body, and the
  // rest of this app's settings panels already load this way.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/pms/matrix", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json() as Promise<{ providers: ProviderRow[]; detail?: string }>)
      .then((data) => {
        setProviders(data.providers ?? []);
        if (data.detail) setNotice(data.detail);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : t("loadError"));
      });
    return () => controller.abort();
  }, [t]);

  const reload = useCallback(async () => {
    const response = await fetch("/api/pms/matrix", { cache: "no-store" });
    const data = await response.json() as { providers: ProviderRow[] };
    setProviders(data.providers ?? []);
  }, []);

  const toggle = async (row: ActionRow, provider: string, enable: boolean, needsSignature: boolean) => {
    setBusy(`${provider}:${row.action}`);
    setNotice("");
    try {
      const response = await fetch("/api/pms/matrix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          action: row.action,
          enabled: enable,
          // The UI cannot manufacture a signature. When one is required the
          // operator is sent to record it; this only ever forwards what the
          // workflow default already demands.
          signedAuthorization: enable && needsSignature,
        }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? t("saveError"));
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("saveError"));
    } finally {
      setBusy("");
    }
  };

  return (
    <details className="pms-matrix">
      <summary>{t("title")}</summary>
      <p>{t("description")}</p>
      {notice && <p role="status" className="pms-matrix-notice">{notice}</p>}
      {!loaded && !notice && <p role="status">{t("loading")}</p>}
      {loaded && providers.length === 0 && <p className="pms-matrix-empty">{t("noneConnected")}</p>}

      {providers.map((provider) => (
        <section key={provider.provider} className="pms-provider">
          <header>
            <BrandMark provider={provider.provider} small />
            <div>
              <strong>{provider.displayName}</strong>
              <span className="pms-provider-meta">
                {t("readsVia", { mechanisms: provider.readMechanisms.join(", ") || t("none") })}
                {provider.writeMechanisms.length > 0 && provider.runner
                  ? ` · ${t(provider.runner === "desktop" ? "writesOnDevice" : "writesInCloud")}`
                  : ""}
              </span>
              {/* Absent verification is stated, not hidden: these clause
                  citations came from secondary research, and an operator
                  deciding whether to sign an override needs to know that. */}
              <span className="pms-provider-terms">
                {provider.termsVerifiedAt
                  ? t("termsVerified", { date: provider.termsVerifiedAt })
                  : t("termsUnverified")}
              </span>
            </div>
          </header>

          {provider.workflows.map((group) => (
            <div key={group.workflow} className="pms-workflow">
              <h4>
                {t(`workflow.${group.workflow}`)}
                {group.writeDefault === "off" && <em className="pms-flag">{t("requiresAuthorization")}</em>}
                {group.writeDefault === "none" && <em className="pms-flag">{t("readOnlyByDesign")}</em>}
              </h4>
              <ul>
                {group.actions.map((row) => (
                  <li key={row.action} className={`pms-row state-${row.state}`}>
                    <span className={`pms-dot ${row.state}`} aria-hidden />
                    <span className="pms-action-label">
                      {t(`action.${row.action}`)}
                      {row.mandatoryApproval && (
                        <em className="pms-checkpoint" title={t("checkpointHint")}>{t("humanApprovalAlways")}</em>
                      )}
                    </span>
                    <span className="pms-state-label">{t(`state.${row.state}`)}</span>
                    <span className="pms-reason">
                      {row.reason}
                      {row.remediation && <em className="pms-remediation">{row.remediation}</em>}
                      {row.owner && <em className={`pms-owner owner-${row.owner}`}>{t(`owner.${row.owner}`)}</em>}
                    </span>
                    {/* Unavailable, blocked and unlearned are deliberately not
                        clickable. Offering a switch that cannot move is worse
                        than offering none. */}
                    {row.actionable && row.kind === "write" && (
                      <button
                        type="button"
                        className="soft-button"
                        disabled={busy === `${provider.provider}:${row.action}`}
                        onClick={() =>
                          void toggle(row, provider.provider, row.state !== "allow", group.writeDefault === "off")}
                      >
                        {row.state === "allow" ? t("turnOff") : t("turnOn")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </details>
  );
}
