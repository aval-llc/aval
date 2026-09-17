"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Star } from "iconoir-react";
import { AnimatedNumber } from "@/app/components/experience";
import { PILOT_POLICY } from "@/lib/pilot-policy";

interface PlanInfo { id: string; name: string; priceUsdCents: number; monthlyTokenAllowance: number; recommended?: boolean }
interface PackInfo { id: string; name: string; priceUsdCents: number; tokens: number }
interface UsageData {
  plan: PlanInfo;
  subscriptionStatus: string | null;
  tokensGranted: number;
  tokensConsumed: number;
  tokensRemaining: number;
  plans: PlanInfo[];
  tokenPacks: PackInfo[];
}

/** Usage meter and plan/top-up purchase card for the Settings page. Every purchase button redirects to a real Stripe Checkout session; nothing here fakes a charge. */
export function BillingSettings() {
  const t = useTranslations();
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/billing/usage");
        if (!response.ok) throw new Error("Usage unavailable");
        const json = (await response.json()) as UsageData;
        setData(json);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const checkout = async (kind: "plan" | "topup", id: string) => {
    setRedirecting(id);
    setError(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, id }),
      });
      const json = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !json.url) {
        setError(json.error ?? t("BillingSettings.checkoutFailed"));
        setRedirecting(null);
        return;
      }
      window.location.assign(json.url);
    } catch {
      setError(t("BillingSettings.checkoutFailed"));
      setRedirecting(null);
    }
  };

  if (!data) return <p className="settings-muted" role="status">{t(loading ? "SettingsModule.loading" : "SettingsModule.unavailable")}</p>;

  const usagePct = data.tokensGranted > 0 ? Math.min(100, Math.round((data.tokensConsumed / data.tokensGranted) * 100)) : 0;
  // Consumption can exceed the grant (a long turn finishing past the line), so
  // the bar caps at 100% — but a full bar shouldn't look the same whether you
  // are exactly at your limit or well past it.
  const overQuota = data.tokensConsumed > data.tokensGranted;
  const paidPlans = data.plans.filter((plan) => plan.priceUsdCents > 0);

  if (!PILOT_POLICY.paidCheckout) return (
    <article className="settings-card billing-card" data-reveal>
      <p className="eyebrow">{t("BillingSettings.eyebrow")}</p>
      <h2>BYOK pilot</h2>
      <p>Connect your own model API key in Intelligence. Aval plan and token-pack purchases are paused; your model provider bills API usage directly.</p>
      <p className="settings-muted">Existing billing record: {data.plan.name} · {data.subscriptionStatus ?? "No subscription"}. Existing subscriptions are not automatically canceled.</p>
    </article>
  );

  return (
    <article className="settings-card billing-card" data-reveal>
      <p className="eyebrow">{t("BillingSettings.eyebrow")}</p>
      <h2>{t("BillingSettings.title")}</h2>

      <div className="billing-usage">
        <div className="billing-usage-row">
          <span>{t("BillingSettings.currentPlan", { plan: data.plan.name })}</span>
          <strong>{t("BillingSettings.tokensRemaining", { count: data.tokensRemaining.toLocaleString() })}</strong>
        </div>
        <div className="billing-usage-bar"><div className={`billing-usage-bar-fill${overQuota ? " is-over" : ""}`} style={{ width: `${usagePct}%` }} /></div>
        <p className="billing-usage-detail">{t("BillingSettings.usageDetail", { used: data.tokensConsumed.toLocaleString(), granted: data.tokensGranted.toLocaleString() })}</p>
      </div>

      {error && <p className="auth-gate-error">{error}</p>}

      <div className="billing-plans">
        {paidPlans.map((plan) => {
          const isCurrent = data.plan.id === plan.id;
          // Every listed feature is derived from the plan's own numbers or its
          // position in the ladder. No invented service commitments ("24-hour
          // support response") — the catalog carries prices and allowances, so
          // those are the only things that can be stated truthfully here.
          const multipleOfCurrent = data.plan.monthlyTokenAllowance > 0
            ? Math.round(plan.monthlyTokenAllowance / data.plan.monthlyTokenAllowance)
            : 0;
          const previousPaid = paidPlans[paidPlans.indexOf(plan) - 1];
          const features = [
            t("BillingSettings.featureTokens", { count: plan.monthlyTokenAllowance.toLocaleString() }),
            previousPaid
              ? t("BillingSettings.featureEverythingIn", { plan: previousPaid.name })
              : t("BillingSettings.featureEveryAgent"),
            multipleOfCurrent > 1 && !isCurrent
              ? t("BillingSettings.featureMultiple", { times: multipleOfCurrent, plan: data.plan.name })
              : t("BillingSettings.featureTopUpsAnytime"),
          ];
          return (
            <article className={`billing-plan-card${plan.recommended ? " is-recommended" : ""}${isCurrent ? " is-current" : ""}`} key={plan.id}>
              {plan.recommended && !isCurrent && (
                <span className="billing-plan-badge"><Star width={12} height={12}/>{t("BillingSettings.popular")}</span>
              )}
              <strong>{plan.name}</strong>
              <p className="billing-plan-price">
                <span className="billing-plan-currency">$</span>
                <AnimatedNumber value={plan.priceUsdCents / 100}/>
                <span className="billing-plan-period">{t("BillingSettings.perMonth")}</span>
              </p>
              <ul className="billing-plan-features">
                {features.map((feature) => <li key={feature}><Check width={13} height={13}/><span>{feature}</span></li>)}
              </ul>
              <button
                type="button"
                className={plan.recommended && !isCurrent ? "primary-button" : "soft-button"}
                disabled={redirecting !== null || isCurrent}
                onClick={() => checkout("plan", plan.id)}
              >
                {isCurrent ? t("BillingSettings.currentPlanLabel") : redirecting === plan.id ? t("BillingSettings.redirecting") : t("BillingSettings.upgradeTo", { plan: plan.name })}
              </button>
            </article>
          );
        })}
      </div>

      <p className="billing-topup-label">{t("BillingSettings.outOfTokens")}</p>
      <div className="billing-packs">
        {data.tokenPacks.map((pack) => (
          <button key={pack.id} type="button" className="soft-button" disabled={redirecting !== null} onClick={() => checkout("topup", pack.id)}>
            {redirecting === pack.id ? t("BillingSettings.redirecting") : t("BillingSettings.buyPack", { tokens: pack.tokens.toLocaleString(), price: (pack.priceUsdCents / 100).toFixed(0) })}
          </button>
        ))}
      </div>
    </article>
  );
}
