"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Mail, ShieldAlert } from "iconoir-react";
import { BrandMark } from "./brand-mark";

/**
 * The Aval seat, as an operator sees it (docs/PMS_INTEGRATION.md, P1).
 *
 * Three things, in the order a customer meets them: the address they type into
 * their PMS, who is allowed to write to it, and who has written and been held.
 *
 * ## The held list is the one screen in Aval that renders a stranger's input
 *
 * Every domain under "waiting to be allowed" came from a message someone sent
 * to a public address, and each one is drawn next to a button that grants
 * standing access to an agent's context. That is why the API returns only
 * domains that *authenticated* — DMARC or DKIM — and why mail that authenticated
 * nothing arrives as a count with no domain to render. This component cannot
 * name an unauthenticated sender because it is never given one.
 *
 * ## Why the address field says "permanent"
 *
 * `claimSeatSlug` never releases a slug. The customer is about to type this into
 * a system outside Aval's control, and telling them afterwards is too late.
 */

type Allowed = { domain: string; providerId: string; displayName: string; addedAt: string };
type ProviderChoice = { id: string; displayName: string; suggestions: string[] };
type HeldSender = { domain: string; method: string | null; messages: number; firstSeen: string; lastSeen: string };
type SeatState = {
  address: string | null;
  addresses: string[];
  allowlist: Allowed[];
  providers: ProviderChoice[];
  review: {
    held: HeldSender[];
    unauthenticated: { messages: number; lastSeen: string | null };
    verified: number;
  };
  canEdit: boolean;
  storage?: string;
};

const EMPTY: SeatState = {
  address: null,
  addresses: [],
  allowlist: [],
  providers: [],
  review: { held: [], unauthenticated: { messages: 0, lastSeen: null }, verified: 0 },
  canEdit: false,
};

export function PmsSeat() {
  const t = useTranslations("PmsSeat");
  const [state, setState] = useState<SeatState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [slug, setSlug] = useState("");
  const [domain, setDomain] = useState("");
  const [provider, setProvider] = useState("");

  // Fetched inline in the effect rather than through the memoized helper below:
  // the helper form reads to the linter as setState during the effect body, and
  // every other settings panel here loads this way (see pms-matrix.tsx).
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/pms/seat", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(t("loadError"));
        return response.json() as Promise<SeatState>;
      })
      .then((data) => {
        setState(data);
        setProvider((current) => current || data.providers[0]?.id || "");
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : t("loadError"));
      });
    return () => controller.abort();
  }, [t]);

  const reload = useCallback(async () => {
    const response = await fetch("/api/pms/seat", { cache: "no-store" });
    if (!response.ok) throw new Error(t("loadError"));
    const data = await response.json() as SeatState;
    setState(data);
    setProvider((current) => current || data.providers[0]?.id || "");
  }, [t]);

  const send = async (label: string, body: Record<string, unknown>, onDone?: () => void) => {
    setBusy(label);
    setNotice("");
    try {
      const response = await fetch("/api/pms/seat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // Parsed before the status is judged so a refusal can explain itself,
      // but a body that is not JSON must not become the error the person reads.
      const data = await response.json().catch(() => ({})) as { error?: string; replacedProviderId?: string | null };
      if (!response.ok) throw new Error(data.error ?? t("saveError"));
      // A domain that changed provider changes how its mail is parsed, so it is
      // said out loud rather than left to be noticed later.
      if (data.replacedProviderId) setNotice(t("providerChanged", { domain: String(body.domain ?? "") }));
      else if (body.intent === "allow") setNotice(t("allowed"));
      onDone?.();
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("saveError"));
    } finally {
      setBusy("");
    }
  };

  const suggestions = state.providers.flatMap((choice) =>
    choice.suggestions.map((value) => ({ provider: choice, domain: value })));
  const disabled = !state.canEdit || busy !== "";

  return (
    <details className="pms-seat">
      <summary><Mail width={17} height={17}/>{t("title")}</summary>
      <p>{t("description")}</p>
      {notice && <p role="status" className="pms-seat-notice">{notice}</p>}
      {!loaded && !notice && <p role="status">{t("loading")}</p>}
      {loaded && state.storage === "unavailable" && <p className="pms-seat-empty">{t("storageUnavailable")}</p>}

      {loaded && state.storage !== "unavailable" && (
        <>
          <section className="pms-seat-address">
            <h4>{t("addressHeading")}</h4>
            {state.address
              ? (
                <>
                  <output className="pms-seat-value">{state.address}</output>
                  <p className="settings-muted">{t("addressInstruction")}</p>
                  {/* A renamed workspace keeps every address it ever held. A
                      customer whose PMS still has an old one on file needs to
                      see that it still reaches them. */}
                  {state.addresses.length > 1 && (
                    <p className="settings-muted">
                      {t("alsoReceiving", { addresses: state.addresses.slice(1).join(", ") })}
                    </p>
                  )}
                </>
              )
              : (
                <>
                  <p>{t("noAddressYet")}</p>
                  <div className="pms-seat-claim">
                    <label>
                      {t("slugLabel")}
                      <input
                        value={slug}
                        placeholder="acme-properties"
                        onChange={(event) => setSlug(event.target.value)}
                        disabled={disabled}
                      />
                    </label>
                    <output className="pms-seat-preview">{`agent-${slug || "…"}@aval.llc`}</output>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={disabled || slug.trim() === ""}
                      onClick={() => void send("claim", { intent: "claim", slug }, () => setSlug(""))}
                    >
                      {busy === "claim" ? t("claiming") : t("claim")}
                    </button>
                  </div>
                  {/* Said before the act, not after: the slug can never be
                      reissued, and it is about to live inside a system Aval
                      does not control. */}
                  <p className="pms-seat-warning"><ShieldAlert width={15} height={15}/>{t("slugPermanent")}</p>
                </>
              )}
          </section>

          <section className="pms-seat-senders">
            <h4>{t("sendersHeading")}</h4>
            <p className="settings-muted">{t("sendersExplanation")}</p>

            {state.allowlist.length === 0 && <p className="pms-seat-empty">{t("noSenders")}</p>}
            {state.allowlist.length > 0 && (
              <ul className="pms-seat-list">
                {state.allowlist.map((sender) => (
                  <li key={sender.domain}>
                    <BrandMark provider={sender.providerId} small/>
                    <span className="pms-seat-value">{sender.domain}</span>
                    <span className="pms-seat-meta">{sender.displayName}</span>
                    <button
                      type="button"
                      className="soft-button"
                      disabled={disabled}
                      onClick={() => void send(`revoke:${sender.domain}`, { intent: "revoke", domain: sender.domain })}
                    >
                      {busy === `revoke:${sender.domain}` ? t("revoking") : t("revoke")}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {suggestions.length > 0 && (
              <div className="pms-seat-suggestions">
                <p>{t("suggestionsHeading")}</p>
                <ul>
                  {suggestions.map(({ provider: choice, domain: value }) => (
                    <li key={`${choice.id}:${value}`}>
                      <span className="pms-seat-value">{value}</span>
                      <span className="pms-seat-meta">{choice.displayName}</span>
                      <button
                        type="button"
                        className="soft-button"
                        disabled={disabled}
                        onClick={() => void send(`allow:${value}`, { intent: "allow", domain: value, providerId: choice.id })}
                      >
                        {busy === `allow:${value}` ? t("allowing") : t("allow")}
                      </button>
                    </li>
                  ))}
                </ul>
                {/* These come from a descriptor somebody researched, not from
                    observed mail. The operator confirming one is what makes it
                    true, so the screen does not present it as established. */}
                <p className="settings-muted">{t("suggestionsCaveat")}</p>
              </div>
            )}

            <div className="pms-seat-add">
              <label>
                {t("domainLabel")}
                <input
                  value={domain}
                  placeholder="appfolio.com"
                  onChange={(event) => setDomain(event.target.value)}
                  disabled={disabled}
                />
              </label>
              <label>
                {t("providerLabel")}
                <select value={provider} onChange={(event) => setProvider(event.target.value)} disabled={disabled}>
                  {state.providers.map((choice) => (
                    <option key={choice.id} value={choice.id}>{choice.displayName}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={disabled || domain.trim() === "" || provider === ""}
                onClick={() => void send("add", { intent: "allow", domain, providerId: provider }, () => setDomain(""))}
              >
                {busy === "add" ? t("allowing") : t("allow")}
              </button>
            </div>
          </section>

          <section className="pms-seat-review">
            <h4>{t("reviewHeading")}</h4>
            {state.review.held.length === 0 && state.review.unauthenticated.messages === 0 && (
              <p className="pms-seat-empty">{t("nothingWaiting")}</p>
            )}

            {state.review.held.length > 0 && (
              <ul className="pms-seat-list">
                {state.review.held.map((sender) => (
                  <li key={sender.domain}>
                    <span className="pms-seat-value">{sender.domain}</span>
                    <span className="pms-seat-meta">
                      {t("heldCount", { count: sender.messages })}
                      {sender.method ? ` · ${t(`method.${sender.method}`)}` : ""}
                      {` · ${t("firstSeen", { date: new Date(sender.firstSeen).toLocaleDateString() })}`}
                    </span>
                    <select
                      aria-label={t("providerLabel")}
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                      disabled={disabled}
                    >
                      {state.providers.map((choice) => (
                        <option key={choice.id} value={choice.id}>{choice.displayName}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="soft-button"
                      disabled={disabled || provider === ""}
                      onClick={() => void send(`allow:${sender.domain}`, { intent: "allow", domain: sender.domain, providerId: provider })}
                    >
                      {busy === `allow:${sender.domain}` ? t("allowing") : t("allow")}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Counted, never named. The only domain an unauthenticated message
                carries is the one its sender wrote, so there is nothing here it
                would be safe to print. */}
            {state.review.unauthenticated.messages > 0 && (
              <p className="pms-seat-unauthenticated">
                {t("unauthenticated", { count: state.review.unauthenticated.messages })}
              </p>
            )}

            {state.review.verified > 0 && (
              <p className="settings-muted">{t("verifiedCount", { count: state.review.verified })}</p>
            )}
            <p className="settings-muted">{t("sweepDelay")}</p>
          </section>

          {!state.canEdit && <p className="settings-muted">{t("ownerOnly")}</p>}
        </>
      )}
    </details>
  );
}
