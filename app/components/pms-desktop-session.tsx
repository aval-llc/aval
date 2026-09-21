"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Computer, Refresh, ShieldCheck, WarningTriangle } from "iconoir-react";
import { desktopBridge } from "@/lib/pms/browser/desktop-runner";

/**
 * Connecting a PMS by signing into it yourself.
 *
 * The screen that was missing. Every other connection in Aval asks for a
 * secret; this one asks the customer to sign into their own system on their own
 * computer, and there is deliberately no field here in which a password or an
 * authenticator code could be typed. Aval opens the provider's own page and
 * waits.
 *
 * The order of what it shows is the argument it is making. Signing in produces
 * a list of what that login can *reach*, said in those words, immediately
 * followed by the statement that reaching is not permission and each action
 * still has to be enabled. A customer who clicks the one button on this screen
 * must not thereby be in breach of their own PMS contract.
 */

type SessionState =
  | "CONNECTED" | "SESSION_REQUIRED" | "SESSION_EXPIRED" | "PERMISSION_DENIED"
  | "PROVIDER_UNAVAILABLE" | "UI_CHANGED" | "DEGRADED";

interface SessionView {
  displayName: string;
  connected: boolean;
  session: { state: SessionState; detail?: string; lastVerifiedAt?: string | null };
  discovered: string[];
  canEdit: boolean;
}

/** States where the remedy is the customer signing in again. */
const SIGN_IN_FIXES: ReadonlySet<SessionState> = new Set(["SESSION_REQUIRED", "SESSION_EXPIRED"]);

/** Reads the connection. Outside the component so it holds no state of its own. */
async function fetchView(provider: string): Promise<SessionView | null> {
  try {
    const response = await fetch(`/api/pms/session?provider=${encodeURIComponent(provider)}`);
    return response.ok ? (await response.json() as SessionView) : null;
  } catch {
    // Offline is not an error worth a banner on a settings panel.
    return null;
  }
}

export function PmsDesktopSession({ provider }: { provider: string }) {
  const t = useTranslations();
  const [view, setView] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = desktopBridge();

  // A liveness flag rather than a bare call, so a slow response for a provider
  // the panel has already moved on from is discarded instead of arriving last
  // and overwriting the current one.
  useEffect(() => {
    let live = true;
    void (async () => {
      const next = await fetchView(provider);
      if (live && next) setView(next);
    })();
    return () => { live = false; };
  }, [provider]);

  const load = useCallback(async () => {
    const next = await fetchView(provider);
    if (next) setView(next);
  }, [provider]);

  /**
   * Show the provider's own sign-in page, then look at what the session reaches.
   *
   * Aval's entire involvement in authentication is opening the window. The
   * customer types their own password and completes their own second factor
   * with the provider; neither ever passes through this code.
   */
  const connect = useCallback(async () => {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const recovery = await bridge.recoverSession({ provider });
      const preflight = recovery.recovered
        ? await bridge.sessionStatus({ provider })
        : { ready: false, session: recovery.session, reason: recovery.reason };

      // Discovery only means anything against a session that is actually up,
      // and it asks the driver what this login reaches rather than what Aval
      // implemented — those differ, and the difference is the customer's role.
      const discovered = preflight.ready
        ? (await bridge.discoverCapabilities({ provider })).available
        : [];

      const response = await fetch("/api/pms/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, session: preflight.session, discovered }),
      });
      const body = await response.json() as SessionView & { error?: string };
      if (!response.ok) {
        setError(body.error ?? t("PmsSession.couldNotConnect"));
        return;
      }
      if (!preflight.ready) setError(preflight.reason ?? t("PmsSession.notSignedIn"));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("PmsSession.couldNotConnect"));
    } finally {
      setBusy(false);
    }
  }, [bridge, provider, load, t]);

  if (!view) return null;

  // In a browser tab there is no session to operate inside, and pretending
  // otherwise would offer a button that cannot work.
  if (!bridge) {
    return <section className="pms-session">
      <header className="pms-session-head">
        <Computer width={18} height={18}/>
        <div>
          <strong>{t("PmsSession.title", { provider: view.displayName })}</strong>
          <p>{t("PmsSession.desktopOnly")}</p>
        </div>
      </header>
    </section>;
  }

  const state = view.session.state;
  const healthy = state === "CONNECTED";

  return <section className="pms-session">
    <header className="pms-session-head">
      <Computer width={18} height={18}/>
      <div>
        <strong>{t("PmsSession.title", { provider: view.displayName })}</strong>
        <p>{t("PmsSession.explainer", { provider: view.displayName })}</p>
      </div>
      <span className={`pms-session-state is-${healthy ? "ok" : SIGN_IN_FIXES.has(state) ? "waiting" : "blocked"}`}>
        {healthy ? <Check width={13} height={13}/> : <WarningTriangle width={13} height={13}/>}
        {t(`PmsSession.state_${state}`)}
      </span>
    </header>

    {/* Said before the button, not after it. */}
    <p className="pms-session-note">
      <ShieldCheck width={15} height={15}/>
      {t("PmsSession.neverStoresCredentials")}
    </p>

    {view.session.detail && !healthy && <p className="pms-session-detail">{view.session.detail}</p>}

    {view.canEdit && <div className="pms-session-actions">
      <button className="primary-button" onClick={() => void connect()} disabled={busy}>
        {busy ? <Refresh width={15} height={15}/> : <Computer width={15} height={15}/>}
        {busy
          ? t("PmsSession.waitingForSignIn")
          : view.connected ? t("PmsSession.signInAgain") : t("PmsSession.useThisComputer")}
      </button>
      {view.session.lastVerifiedAt && <small className="quiet-label">
        {t("PmsSession.lastUsed", { when: new Date(view.session.lastVerifiedAt).toLocaleString() })}
      </small>}
    </div>}

    {view.discovered.length > 0 && <div className="pms-session-discovered">
      <p>{t("PmsSession.reaches", { count: view.discovered.length })}</p>
      <ul>{view.discovered.map((action) => <li key={action}><Check width={13} height={13}/>{action}</li>)}</ul>
      {/* The sentence this whole screen exists to be able to say honestly. */}
      <p className="pms-session-not-permission">{t("PmsSession.notPermission")}</p>
    </div>}

    {error && <p className="pms-session-error" role="alert">{error}</p>}
  </section>;
}
