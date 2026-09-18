"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Check, NavArrowDown, Refresh, Search, ShieldCheck, WarningTriangle } from "iconoir-react";
import { BrandMark } from "@/app/components/brand-mark";
import { REASONING_EFFORT_LEVELS, modelOptionsFor, supportsReasoningEffort } from "@/lib/integrations/model-providers";
import { Foldout } from "@/app/components/foldout";
import type { Provider } from "@/app/components/connection-dialog";
import { useDesktopCodex } from "@/app/components/desktop-codex";
import type { DesktopCodexState } from "@/app/components/desktop-codex";

type SubscriptionSession = { state: string; authorizeUrl: string };
type AuthMode = "apiKey" | "subscription";

/**
 * One "Configure Providers" row: a flat pill, icon+name+badge on one line,
 * expanding to a plain description, a single "connect with" selector when
 * a subscription alternative exists (`twin` — anthropic ↔ claude, openai ↔
 * chatgpt, lib/integrations/catalog.ts's `subscriptionOf`), and exactly one
 * input area below it at a time — never both an API-key form and a
 * subscription button stacked together. Matches a real reference
 * screenshot's pattern (a single provider pill: icon/name/badge, one line
 * of description, one connect action, one footer link) rather than this
 * page's earlier denser layout.
 */
function ProviderAccordionRow({ provider, twin, isOpen, onToggle, isActive, switching, apiKeySetupRequest, onSetActive, onRefresh }: {
  provider: Provider;
  twin: Provider | null;
  isOpen: boolean;
  onToggle: () => void;
  isActive: boolean;
  switching: boolean;
  apiKeySetupRequest: number;
  onSetActive: (providerId: string) => void;
  onRefresh: () => void;
}) {
  const t = useTranslations();
  const connected = provider.connection?.status === "connected";
  const twinConnected = twin?.connection?.status === "connected";

  const [authMode, setAuthMode] = useState<AuthMode>(apiKeySetupRequest > 0 ? "apiKey" : twinConnected ? "subscription" : "apiKey");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  // Reasoning effort is a per-request parameter the flagship models accept,
  // stored alongside the model override rather than folded into the id.
  const [effort, setEffort] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState("");
  const [subscriptionSession, setSubscriptionSession] = useState<SubscriptionSession | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  // Device-code login (found via RayBytes/ChatMock — see docs/DECISIONS.md).
  // No redirect URI, so nothing must listen on localhost and there is nothing
  // to paste. The paste flow below is kept as a fallback for Claude, whose
  // OAuth surface has no device endpoint.
  const [device, setDevice] = useState<{ deviceAuthId: string; userCode: string; verificationUrl: string; intervalSeconds: number } | null>(null);
  const [deviceError, setDeviceError] = useState("");
  const [copied, setCopied] = useState(false);
  // True when the account has device-code authorization disabled.
  const [needsDeviceAuth, setNeedsDeviceAuth] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState<"idle" | "working" | "error">("idle");
  const [subscriptionError, setSubscriptionError] = useState("");
  const apiKeyInput = useRef<HTMLInputElement>(null);

  // The blocked ChatGPT picker links straight to the usable alternative.
  // Open this row in API-key mode and put the cursor where the user needs it,
  // even when their connected subscription would normally make that row open
  // on the subscription tab.
  useEffect(() => {
    if (apiKeySetupRequest === 0) return;
    window.requestAnimationFrame(() => apiKeyInput.current?.focus());
  }, [apiKeySetupRequest]);

  const connectApiKey = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("working");
    setMessage("");
    try {
      const response = await fetch("/api/integrations/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, credentials: model ? { apiKey, model } : { apiKey } }),
      });
      const data = await response.json() as { error?: string; connection?: { id: string } };
      if (!response.ok || !data.connection?.id) throw new Error(data.error ?? t("IntelligenceSettings.connectFailed"));
      const verification = await fetch("/api/integrations/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: data.connection.id }) });
      const verified = await verification.json().catch(() => ({})) as { error?: string };
      if (!verification.ok) throw new Error(verified.error ?? t("IntelligenceSettings.connectFailed"));
      setApiKey("");
      onRefresh();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : t("IntelligenceSettings.connectFailed"));
      return;
    }
    setStatus("idle");
  };

  const reset = async (targetProviderId: string) => {
    await fetch("/api/integrations/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: targetProviderId }) });
    onRefresh();
  };

  const startDeviceLogin = async () => {
    setSubscriptionStatus("working");
    setDeviceError("");
    setNeedsDeviceAuth(false);
    try {
      const response = await fetch("/api/integrations/subscription/device", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const data = await response.json() as { deviceAuthId?: string; userCode?: string; verificationUrl?: string; intervalSeconds?: number; error?: string };
      if (!response.ok || !data.deviceAuthId || !data.userCode || !data.verificationUrl) {
        throw new Error(data.error ?? t("IntelligenceSettings.connectFailed"));
      }
      setDevice({ deviceAuthId: data.deviceAuthId, userCode: data.userCode, verificationUrl: data.verificationUrl, intervalSeconds: data.intervalSeconds ?? 5 });
      // Opened for them, so the only manual step is typing the code.
      window.open(data.verificationUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : t("IntelligenceSettings.connectFailed"));
    }
    setSubscriptionStatus("idle");
  };

  const startSubscription = async () => {
    if (!twin) return;
    setSubscriptionStatus("working");
    setSubscriptionError("");
    try {
      const response = await fetch("/api/integrations/subscription/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: twin.id }) });
      const data = await response.json() as { authorizeUrl?: string; state?: string; error?: string };
      if (!response.ok || !data.authorizeUrl || !data.state) throw new Error(data.error ?? t("IntelligenceSettings.connectFailed"));
      window.open(data.authorizeUrl, "_blank", "noopener,noreferrer");
      setSubscriptionSession({ state: data.state, authorizeUrl: data.authorizeUrl });
    } catch (error) {
      setSubscriptionError(error instanceof Error ? error.message : t("IntelligenceSettings.connectFailed"));
    }
    setSubscriptionStatus("idle");
  };

  const completeSubscription = async (event: FormEvent) => {
    event.preventDefault();
    await exchange(pasteValue);
  };

  /**
   * Trades a pasted redirect URL (or bare code) for tokens.
   *
   * Split out from the submit handler so the same path serves an automatic
   * hand-off: the redirect always dead-ends on a loopback address no web page
   * can listen on, so the value arrives via the clipboard rather than a
   * callback, and the user should not also have to press a button once it is
   * in hand.
   */
  const exchange = useCallback(async (input: string) => {
    const value = input.trim();
    if (!twin || !subscriptionSession || !value) return;
    setSubscriptionStatus("working");
    setSubscriptionError("");
    try {
      const response = await fetch("/api/integrations/subscription/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: twin.id, state: subscriptionSession.state, pastedInput: value }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? t("IntelligenceSettings.connectFailed"));
      setSubscriptionSession(null);
      setPasteValue("");
      onRefresh();
    } catch (error) {
      setSubscriptionStatus("error");
      setSubscriptionError(error instanceof Error ? error.message : t("IntelligenceSettings.connectFailed"));
      return;
    }
    setSubscriptionStatus("idle");
  }, [twin, subscriptionSession, t, onRefresh]);

  // Polls until the user approves the code on OpenAI's page.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    // setInterval does not wait for an async callback, so a poll slower than
    // the interval overlaps the next one. That matters here because the
    // approval response hands back a single-use authorization code: two
    // overlapping polls each receive it and each try to exchange it, one wins
    // and the other gets a 400 for a spent code — which is exactly the
    // "Approved, but the token exchange failed (400)" seen in practice.
    let inFlight = false;
    const timer = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/integrations/subscription/device", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "poll", deviceAuthId: device.deviceAuthId, userCode: device.userCode }),
        });
        const data = await response.json() as { status?: string; error?: string };
        if (cancelled) return;
        if (data.status === "connected") { setDevice(null); onRefresh(); return; }
        // Device-code auth is off on this ChatGPT account. Stop polling and
        // show the one-time setting to enable, with a direct link.
        if (data.status === "needs_device_auth_enabled") {
          setDevice(null);
          setNeedsDeviceAuth(true);
          return;
        }
        // Pending is the normal state while waiting; only a real 4xx (expired,
        // revoked) should surface as an error.
        if (!response.ok && data.status !== "pending") {
          setDevice(null);
          setDeviceError(data.error ?? t("IntelligenceSettings.connectFailed"));
        }
      } catch {
        // A dropped poll is expected on a flaky link; the next tick retries.
      } finally {
        inFlight = false;
      }
    }, Math.max(device.intervalSeconds, 3) * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [device, onRefresh, t]);

  const pasteInput = useRef<HTMLInputElement>(null);

  /**
   * Looks for the authorization value on the clipboard and, if it's there,
   * finishes the connection without further input.
   *
   * Reading the clipboard needs permission the browser only grants to a
   * focused document, and it can be denied outright — so every failure here
   * is silent and simply leaves the manual paste field in place. This is an
   * accelerator, never the only route.
   */
  const tryClipboardHandoff = useCallback(async () => {
    if (!subscriptionSession || subscriptionStatus === "working") return;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      // Only act on something that actually looks like this flow's redirect —
      // never on whatever the user happened to copy earlier.
      if (!text || !/[?&]code=/.test(text)) return;
      if (!text.includes(subscriptionSession.state)) return;
      setPasteValue(text);
      await exchange(text);
    } catch {
      // No permission, no clipboard API, or nothing readable. Manual paste stands.
    }
  }, [subscriptionSession, subscriptionStatus, exchange]);

  // The user leaves for the approval tab and comes back with the URL copied.
  // Returning focus is the moment to check, and to put the cursor in the field
  // so a manual paste needs no aiming either.
  useEffect(() => {
    if (!subscriptionSession) return;
    const onFocus = () => { pasteInput.current?.focus(); void tryClipboardHandoff(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [subscriptionSession, tryClipboardHandoff]);

  return (
    <div className={`provider-row ${isOpen ? "is-open" : ""} ${isActive ? "active" : ""}`} data-provider-id={provider.id}>
      <button type="button" className="provider-row-summary" aria-expanded={isOpen} onClick={onToggle}>
        <BrandMark provider={provider.id} small />
        <span className="provider-row-name">{provider.title}</span>
        {twin && <span className="provider-row-badge">{t("IntelligenceSettings.subscriptionBadge")}</span>}
        {isActive && <span className="connection-status connected">{t("IntelligenceSettings.inUse")}</span>}
        <NavArrowDown width={14} height={14} className={isOpen ? "provider-row-chevron open" : "provider-row-chevron"} />
      </button>
      <div className="provider-row-body" style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}>
        <div className="provider-row-body-inner">
          <p className="provider-row-description">
            {twin ? t("IntelligenceSettings.pasteOrConnect", { provider: twin.title }) : provider.description}
          </p>

          {twin && (
            <label className="provider-row-auth-select">
              {t("IntelligenceSettings.connectWith")}
              <select value={authMode} onChange={(event) => setAuthMode(event.target.value as AuthMode)}>
                <option value="subscription">{twin.title}</option>
                <option value="apiKey">{t("IntelligenceSettings.apiKeyOption")}</option>
              </select>
            </label>
          )}

          {(!twin || authMode === "apiKey") && (
            !connected ? (
              <form className="credential-form" onSubmit={connectApiKey}>
                <label>
                  {t("IntelligenceSettings.apiKeyLabel")}
                  <input ref={apiKeyInput} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" required />
                </label>
                <button className="soft-button" type="submit" disabled={status === "working" || !apiKey}>
                  {status === "working" ? t("IntelligenceSettings.connecting") : t("IntelligenceSettings.connect")}
                </button>
                {status === "error" && <p className="auth-gate-error">{message}</p>}
              </form>
            ) : (
              <div className="provider-connected-row">
                <span className="connection-status connected"><ShieldCheck width={13} height={13} />{t("IntelligenceSettings.connectedWithKey")}</span>
                <button type="button" className="text-button" onClick={() => void reset(provider.id)}>{t("IntelligenceSettings.resetConnection")}</button>
              </div>
            )
          )}

          {twin && authMode === "subscription" && (
            twinConnected ? (
              <div className="provider-connected-row">
                <span className="connection-status connected"><ShieldCheck width={13} height={13} />{t("IntelligenceSettings.connectedWithSubscription", { provider: twin.title })}</span>
                <button type="button" className="text-button" onClick={() => void reset(twin.id)}>{t("IntelligenceSettings.resetConnection")}</button>
              </div>
            ) : device ? (
              <div className="device-login">
                <p className="device-login-lead">{t("IntelligenceSettings.deviceEnterCode")}</p>
                <div className="device-code-row">
                  <code className="device-code">{device.userCode}</code>
                  <button type="button" className="soft-button" onClick={() => { void navigator.clipboard.writeText(device.userCode).then(() => setCopied(true)).catch(() => {}); }}>
                    {copied ? t("IntelligenceSettings.deviceCopied") : t("IntelligenceSettings.deviceCopy")}
                  </button>
                </div>
                <p className="device-login-status"><span className="presence-dot"/>{t("IntelligenceSettings.deviceWaiting")}</p>
                <div className="device-login-actions">
                  <a className="text-button" href={device.verificationUrl} target="_blank" rel="noopener noreferrer">{t("IntelligenceSettings.deviceReopen")}</a>
                  <button type="button" className="text-button quiet" onClick={() => setDevice(null)}>{t("IntelligenceSettings.deviceCancel")}</button>
                </div>
              </div>
            ) : subscriptionSession ? (
              <form className="credential-form subscription-paste" onSubmit={completeSubscription}>
                {/* The browser is showing an error page at this moment. Lead
                    with that, before the input, or the user reads it as a
                    failure and closes the tab that holds the code. */}
                <div className="subscription-step">
                  <span className="subscription-step-number">2</span>
                  <div>
                    <strong>{t("IntelligenceSettings.pasteStepTitle")}</strong>
                    <p>{t("IntelligenceSettings.pasteRedirectHint")}</p>
                  </div>
                </div>
                <label>
                  {t("IntelligenceSettings.pasteRedirectLabel")}
                  <input
                    ref={pasteInput}
                    type="text"
                    value={pasteValue}
                    onChange={(event) => setPasteValue(event.target.value)}
                    onPaste={(event) => {
                      // Submit the moment a valid redirect lands, so pasting
                      // is the last action required.
                      const pasted = event.clipboardData.getData("text").trim();
                      if (/[?&]code=/.test(pasted)) {
                        event.preventDefault();
                        setPasteValue(pasted);
                        void exchange(pasted);
                      }
                    }}
                    placeholder={t("IntelligenceSettings.pasteRedirectPlaceholder")}
                    autoComplete="off"
                    required
                  />
                </label>
                <div className="subscription-paste-actions">
                  <button className="soft-button" type="submit" disabled={subscriptionStatus === "working" || !pasteValue}>
                    {subscriptionStatus === "working" ? t("IntelligenceSettings.connecting") : t("IntelligenceSettings.finishConnecting")}
                  </button>
                  <button type="button" className="text-button" onClick={() => void tryClipboardHandoff()}>
                    {t("IntelligenceSettings.pasteFromClipboard")}
                  </button>
                  <a className="text-button" href={subscriptionSession.authorizeUrl} target="_blank" rel="noopener noreferrer">
                    {t("IntelligenceSettings.reopenApproval")}
                  </a>
                </div>
                {subscriptionStatus === "error" && <p className="auth-gate-error">{subscriptionError}</p>}
              </form>
            ) : (
              <div className="subscription-start">
                {/* ChatGPT has a device-code endpoint, so it needs no redirect
                    and nothing pasted. Claude's OAuth surface has no such
                    endpoint, so it keeps the paste flow and the warning that
                    its redirect dead-ends on a loopback address. */}
                <p className="foldout-hint">{twin.id === "chatgpt" ? t("IntelligenceSettings.devicePreamble") : t("IntelligenceSettings.subscriptionPreamble")}</p>
                <button
                  type="button"
                  className="soft-button"
                  onClick={() => void (twin.id === "chatgpt" ? startDeviceLogin() : startSubscription())}
                  disabled={subscriptionStatus === "working"}
                >
                  {subscriptionStatus === "working" ? t("IntelligenceSettings.connecting") : t("IntelligenceSettings.connectSubscription", { provider: twin.title })}
                </button>
                {needsDeviceAuth && (
                  <div className="device-setup-needed">
                    <WarningTriangle width={16} height={16}/>
                    <div>
                      <strong>{t("IntelligenceSettings.deviceAuthDisabledTitle")}</strong>
                      <p>{t("IntelligenceSettings.deviceAuthDisabledBody")}</p>
                      <a href="https://chatgpt.com/#settings/Security" target="_blank" rel="noopener noreferrer">{t("IntelligenceSettings.deviceAuthOpenSettings")}</a>
                    </div>
                  </div>
                )}
                {deviceError && <p className="auth-gate-error">{deviceError}</p>}
                {subscriptionStatus === "error" && <p className="auth-gate-error">{subscriptionError}</p>}
              </div>
            )
          )}

          {provider.defaultModel && (
            <Foldout summary={t("ConnectionDialog.advanced")}>
              {/* A picker, not a text field: a typo in a model id fails at
                  send time with a provider error that reads like a broken
                  integration, and "enter an exact model id from this
                  provider's docs" makes the user do research for no gain. */}
              <label>
                {t("ConnectionDialog.modelOverrideLabel")}
                <select className="model-select" value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="">{t("ConnectionDialog.modelRecommended", { model: provider.defaultModel })}</option>
                  {modelOptionsFor(provider.id).map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
              {supportsReasoningEffort(model || provider.defaultModel) && (
                <label>
                  {t("ConnectionDialog.reasoningEffortLabel")}
                  <select className="model-select" value={effort} onChange={(event) => setEffort(event.target.value)}>
                    <option value="">{t("ConnectionDialog.reasoningEffortDefault")}</option>
                    {REASONING_EFFORT_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                </label>
              )}
              <p className="foldout-hint">{t("ConnectionDialog.modelOverrideHint")}</p>
            </Foldout>
          )}

          {/* A soft-button, not .wide-button: "Use this" is two words, and a
              full-width bar for it both overflows this row's padding and reads
              as far more consequential than switching providers is. */}
          {(connected || twinConnected) && !isActive && (
            <button type="button" className="soft-button" disabled={switching} onClick={() => onSetActive(connected ? provider.id : (twin as Provider).id)}>
              {t("IntelligenceSettings.useThis")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "Model being used": provider on the left, the actual model on the right,
 * separated by a plain "/" — a live, real picker, not a static echo. The
 * model side fetches the connected provider's real, current model list
 * (`GET /api/integrations/models`) rather than a hand-typed guess frozen
 * at whenever this catalog was written. When no provider is selected, the
 * row directs the workspace to connect one before model-backed features run.
 */
function ModelBeingUsedRow({ providers, activeProvider, activeEntry, onSwitchProvider, onConfigureProvider, onModelChanged }: {
  providers: Provider[];
  activeProvider: string | null;
  activeEntry: Provider | undefined;
  onSwitchProvider: (providerId: string) => void;
  onConfigureProvider: (providerId: string) => void;
  onModelChanged: () => void;
}) {
  const t = useTranslations();
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // True when the list came from the static fallback because the account's own
  // catalog was unreachable — shown to the user rather than hidden.
  const [modelsUnverified, setModelsUnverified] = useState(false);
  // The token was sent and refused, which needs a reconnect rather than a retry.
  const [modelsRejected, setModelsRejected] = useState(false);
  // OpenAI blocks this backend at its edge for datacenter origins, which no
  // reconnect can fix — see IntelligenceSettings.modelsEdgeBlocked.
  const [modelsEdgeBlocked, setModelsEdgeBlocked] = useState(false);
  // The provider's own error text, shown so a failure can be acted on.
  const [modelsDetail, setModelsDetail] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [savingModel, setSavingModel] = useState(false);

  const connectedProviders = providers.filter((provider) => provider.category === "Model" && provider.connection?.status === "connected");
  const currentModel = activeEntry?.defaultModel ?? (activeProvider ? t("IntelligenceSettings.subscriptionDefaultModelShort") : t("IntelligenceSettings.notConnected"));

  const loadModels = async () => {
    if (!activeProvider) return;
    setLoadingModels(true);
    setModelsError(null);
    try {
      const response = await fetch(`/api/integrations/models?provider=${encodeURIComponent(activeProvider)}`);
      const data = await response.json() as { models?: string[]; error?: string; verified?: boolean; unverifiedReason?: string | null; unverifiedDetail?: string | null };
      if (!response.ok) throw new Error(data.error ?? t("IntelligenceSettings.modelListFailed"));
      setModels(data.models ?? []);
      setModelsUnverified(data.verified === false);
      setModelsRejected(data.unverifiedReason === "credential_rejected");
      setModelsEdgeBlocked(data.unverifiedReason === "edge_blocked");
      setModelsDetail(data.unverifiedDetail ?? "");
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : t("IntelligenceSettings.modelListFailed"));
    } finally {
      setLoadingModels(false);
    }
  };

  const openModelMenu = () => {
    if (!activeProvider) return;
    setModelMenuOpen((current) => !current);
    setModelSearch("");
    if (!models) void loadModels();
  };

  const chooseModel = async (modelId: string) => {
    if (!activeProvider) return;
    setSavingModel(true);
    try {
      await fetch("/api/integrations/set-model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: activeProvider, model: modelId }) });
      onModelChanged();
    } finally {
      setSavingModel(false);
      setModelMenuOpen(false);
    }
  };

  const filteredModels = (models ?? []).filter((id) => id.toLowerCase().includes(modelSearch.trim().toLowerCase()));

  return (
    <section className="intelligence-model-row">
      <p className="intelligence-model-row-label">{t("IntelligenceSettings.modelBeingUsed")}</p>
      <div className="intelligence-model-row-controls">
        <div className="intelligence-model-picker">
          <button type="button" className="intelligence-model-picker-trigger" onClick={() => setProviderMenuOpen((current) => !current)}>
            {activeProvider ? <BrandMark provider={activeProvider} small /> : <WarningTriangle width={16} height={16} />}
            <span>{activeProvider ? (activeEntry?.title ?? activeProvider) : t("IntelligenceSettings.noProvider")}</span>
            <NavArrowDown width={13} height={13} className={providerMenuOpen ? "provider-row-chevron open" : "provider-row-chevron"} />
          </button>
          {providerMenuOpen && (
            <div className="menu-popover intelligence-model-menu">
              {connectedProviders.length === 0 && <p className="intelligence-model-menu-status">{t("IntelligenceSettings.connectProviderFirst")}</p>}
              {connectedProviders.map((provider) => (
                <button type="button" key={provider.id} onClick={() => { onSwitchProvider(provider.id); setProviderMenuOpen(false); }}>
                  <BrandMark provider={provider.id} small />{provider.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="intelligence-model-row-divider">/</span>
        <div className="intelligence-model-picker">
          <button
            type="button"
            className={`intelligence-model-picker-trigger ${modelsEdgeBlocked ? "unavailable" : ""}`}
            onClick={openModelMenu}
            disabled={!activeProvider}
            aria-label={modelsEdgeBlocked ? t("IntelligenceSettings.modelsEdgeBlockedTitle") : undefined}
          >
            {modelsEdgeBlocked ? (
              <>
                <WarningTriangle width={14} height={14} className="intelligence-model-trigger-warning" />
                <span>{t("IntelligenceSettings.modelUnavailableShort")}</span>
              </>
            ) : (
              <>
                <span>{currentModel}</span>
                {activeProvider && <Check width={14} height={14} className="intelligence-model-check" />}
              </>
            )}
          </button>
          {modelMenuOpen && activeProvider && (
            <div className={`menu-popover intelligence-model-menu intelligence-model-search-menu ${modelsEdgeBlocked ? "edge-blocked" : ""}`}>
              {modelsEdgeBlocked ? (
                <div className="intelligence-model-unavailable" role="status">
                  <div className="intelligence-model-unavailable-head">
                    <span className="intelligence-model-warning-tile" aria-hidden="true">
                      <WarningTriangle width={18} height={18} />
                    </span>
                    <strong>{t("IntelligenceSettings.modelsEdgeBlockedTitle")}</strong>
                  </div>
                  <p>{t("IntelligenceSettings.modelsEdgeBlockedBody")}</p>
                  <button
                    type="button"
                    className="intelligence-model-unavailable-primary"
                    onClick={() => { setModelMenuOpen(false); onConfigureProvider("openai"); }}
                  >
                    {t("IntelligenceSettings.setUpOpenAiApiKey")}
                  </button>
                </div>
              ) : (
                <>
                  <label className="intelligence-model-search">
                    <Search width={13} height={13} />
                    <input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder={t("IntelligenceSettings.searchModels")} />
                  </label>
                  {loadingModels && <p className="intelligence-model-menu-status">{t("IntelligenceSettings.loadingModels")}</p>}
                  {modelsError && <p className="intelligence-model-menu-status error">{modelsError}</p>}
                  {!modelsError && modelsUnverified && (
                    <p className="intelligence-model-menu-status warn">
                      {modelsRejected
                        ? t("IntelligenceSettings.modelsCredentialRejected")
                        : t("IntelligenceSettings.modelsUnverified")}
                      {modelsDetail && <span className="intelligence-model-menu-detail">{modelsDetail}</span>}
                    </p>
                  )}
                  {!loadingModels && !modelsError && filteredModels.map((id) => (
                    <button type="button" key={id} disabled={savingModel} onClick={() => void chooseModel(id)}>{id}</button>
                  ))}
                  {!loadingModels && !modelsError && filteredModels.length === 0 && (
                    <p className="intelligence-model-menu-status">{t("IntelligenceSettings.noModelsMatch")}</p>
                  )}
                  <div className="intelligence-model-menu-footer">
                    <button type="button" onClick={() => void loadModels()} disabled={loadingModels} aria-label={t("IntelligenceSettings.refreshModels")}>
                      <Refresh width={13} height={13} className={loadingModels ? "spinning" : ""} />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function DesktopModelBeingUsedRow({ state, onModel }: { state: DesktopCodexState; onModel: (model: string) => Promise<unknown> }) {
  const t = useTranslations();
  return (
    <section className="intelligence-model-row desktop-model-row">
      <p className="intelligence-model-row-label">{t("IntelligenceSettings.modelBeingUsed")}</p>
      <div className="intelligence-model-row-controls">
        <span className="intelligence-model-picker-trigger desktop-model-provider">
          <BrandMark provider="chatgpt" small />
          <span>ChatGPT</span>
        </span>
        <span className="intelligence-model-row-divider">/</span>
        <label className="desktop-model-select-label">
          <span className="sr-only">{t("DesktopCodex.chooseModel")}</span>
          <select value={state.selectedModel ?? ""} onChange={(event) => void onModel(event.target.value)} disabled={state.models.length === 0}>
            {state.models.length === 0 && <option value="">{t("DesktopCodex.defaultModel")}</option>}
            {state.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}

function DesktopChatGPTCard({ state, connect, cancelLogin, logout, setActive, refresh }: {
  state: DesktopCodexState;
  connect: () => Promise<unknown>;
  cancelLogin: () => Promise<unknown>;
  logout: () => Promise<unknown>;
  setActive: (active: boolean) => Promise<unknown>;
  refresh: () => Promise<unknown>;
}) {
  const t = useTranslations();
  const [actionError, setActionError] = useState<string | null>(null);
  const chatgptAccount = state.account?.type === "chatgpt" ? state.account : null;
  const connected = chatgptAccount !== null;
  const waiting = state.status === "opening_browser" || state.status === "waiting_for_login";
  const starting = state.status === "starting" || state.status === "restarting";
  const run = async (operation: () => Promise<unknown>) => {
    setActionError(null);
    try { await operation(); } catch (error) { setActionError(error instanceof Error ? error.message : t("IntelligenceSettings.connectFailed")); }
  };
  return (
    <section className={`desktop-chatgpt-card ${connected ? "connected" : ""} ${state.active ? "active" : ""}`}>
      <div className="desktop-chatgpt-heading">
        <BrandMark provider="chatgpt" />
        <div>
          <span><strong>ChatGPT</strong><i>{t("DesktopCodex.experimental")}</i></span>
          <p>{t("DesktopCodex.planConnection")}</p>
        </div>
        {state.active && <span className="connection-status connected">{t("IntelligenceSettings.inUse")}</span>}
      </div>
      {connected ? (
        <div className="desktop-chatgpt-connected">
          <span><ShieldCheck width={16} height={16} /><span><strong>{chatgptAccount?.email ?? t("DesktopCodex.chatgptAccount")}</strong><small>{t("DesktopCodex.planLabel", { plan: chatgptAccount?.planType ?? "unknown" })}</small></span></span>
          <div>
            {!state.active && <button type="button" className="soft-button" onClick={() => void run(() => setActive(true))}>{t("IntelligenceSettings.useThis")}</button>}
            <button type="button" className="text-button" onClick={() => void run(logout)}>{t("DesktopCodex.disconnect")}</button>
          </div>
        </div>
      ) : waiting ? (
        <div className="desktop-chatgpt-waiting">
          <Refresh width={16} height={16} className="spinning" />
          <span><strong>{t("DesktopCodex.finishInBrowser")}</strong><small>{t("DesktopCodex.waitingSecurely")}</small></span>
          <button type="button" className="text-button" onClick={() => void run(cancelLogin)}>{t("DesktopCodex.cancel")}</button>
        </div>
      ) : (
        <div className="desktop-chatgpt-actions">
          <button type="button" className="soft-button" disabled={starting || !state.available} onClick={() => void run(connect)}>{starting ? t("DesktopCodex.starting") : t("DesktopCodex.connectPlan")}</button>
          {!state.available && <button type="button" className="text-button" onClick={() => void run(refresh)}>{t("DesktopCodex.retry")}</button>}
        </div>
      )}
      {(actionError || state.lastError) && <p className="auth-gate-error">{actionError ?? state.lastError}</p>}
      <p className="desktop-chatgpt-privacy"><ShieldCheck width={14} height={14} />{t("DesktopCodex.privacy")}</p>
    </section>
  );
}

/**
 * Settings → Intelligence: which model powers agents and Ask Aval for this
 * org. Reuses the exact same /api/integrations catalog, connect/verify
 * flow, and encrypted-credential storage as every other provider on the
 * Connections page — a model provider is just an IntegrationProvider with
 * category "Model" (lib/integrations/catalog.ts). The workspace must connect
 * and select a provider; there is no shared server-side model credential.
 */
export function IntelligenceSettings() {
  const t = useTranslations();
  const desktop = useDesktopCodex();
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [apiKeySetupRequest, setApiKeySetupRequest] = useState(0);

  const load = async () => {
    try {
      const response = await fetch("/api/integrations");
      const data = await response.json() as { providers?: Provider[]; activeModelProvider?: string | null };
      setProviders(data.providers ?? []);
      setActiveProvider(data.activeModelProvider ?? null);
    } catch {
      setProviders([]);
    }
  };

  useEffect(() => { (async () => { await load(); })(); }, []);

  const setActive = async (providerId: string) => {
    setSwitching(providerId);
    setError(null);
    try {
      if (desktop.state?.active) await desktop.setActive(false);
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await response.json().catch(() => ({})) as { activeModelProvider?: string | null; error?: string };
      if (!response.ok) { setError(data.error ?? t("IntelligenceSettings.switchFailed")); return; }
      setActiveProvider(data.activeModelProvider ?? null);
    } catch {
      setError(t("IntelligenceSettings.switchFailed"));
    } finally {
      setSwitching(null);
    }
  };

  if (!providers) return null;
  const modelProviders = providers.filter((provider) => provider.category === "Model" && !provider.subscriptionOf);
  // Hosted pilot supports API keys only. The local desktop bridge is separate.
  const twinByProvider = new Map<string, Provider>();
  const filtered = modelProviders.filter((provider) => provider.title.toLowerCase().includes(search.trim().toLowerCase()));
  const activeEntry = providers.find((provider) => provider.id === activeProvider);
  const desktopInUse = desktop.state?.active === true && desktop.state.account?.type === "chatgpt";

  return (
    <article className="settings-card intelligence-card" data-reveal>
      <p className="eyebrow">{t("IntelligenceSettings.eyebrow")}</p>
      <h2>{t("IntelligenceSettings.title")}</h2>
      <p className="settings-muted">The hosted pilot uses your workspace API key. Existing subscription connections must be replaced; Aval will not silently switch providers.</p>

      {desktopInUse && desktop.state ? (
        <DesktopModelBeingUsedRow state={desktop.state} onModel={desktop.setModel} />
      ) : (
        <ModelBeingUsedRow
          key={activeProvider ?? "none"}
          providers={modelProviders}
          activeProvider={activeProvider}
          activeEntry={activeEntry}
          onSwitchProvider={(id) => void setActive(id)}
          onConfigureProvider={(providerId) => {
            setSearch("");
            setExpanded(providerId);
            setApiKeySetupRequest((current) => current + 1);
            window.requestAnimationFrame(() => document.querySelector(`[data-provider-id="${providerId}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
          }}
          onModelChanged={load}
        />
      )}

      {error && <p className="auth-gate-error">{error}</p>}

      <section className="intelligence-configure">
        <div className="intelligence-configure-header">
          <h3>{t("IntelligenceSettings.configureProviders")}</h3>
          <label className="search-field intelligence-search">
            <Search width={15} height={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("IntelligenceSettings.searchProviders")} />
          </label>
        </div>
        <div className="provider-row-list">
          {desktop.bridge && desktop.state && (
            <DesktopChatGPTCard
              state={desktop.state}
              connect={desktop.connect}
              cancelLogin={desktop.cancelLogin}
              logout={desktop.logout}
              setActive={desktop.setActive}
              refresh={desktop.refresh}
            />
          )}
          {filtered.map((provider) => {
            // In the desktop shell ChatGPT has its own safe local card. The
            // OpenAI row remains an explicitly separate API-key option.
            const twin = desktop.bridge && provider.id === "openai" ? null : twinByProvider.get(provider.id) ?? null;
            const isActive = activeProvider === provider.id || (twin ? activeProvider === twin.id : false);
            return (
              <ProviderAccordionRow
                key={`${provider.id}:${provider.id === "openai" ? apiKeySetupRequest : 0}`}
                provider={provider}
                twin={twin}
                isOpen={expanded === provider.id}
                onToggle={() => setExpanded((current) => (current === provider.id ? null : provider.id))}
                isActive={isActive}
                switching={switching !== null}
                apiKeySetupRequest={provider.id === "openai" ? apiKeySetupRequest : 0}
                onSetActive={(id) => void setActive(id)}
                onRefresh={load}
              />
            );
          })}
        </div>
      </section>
    </article>
  );
}
