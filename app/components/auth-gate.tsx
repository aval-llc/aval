"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslations } from "next-intl";

export type AuthMode = "password" | "chatgpt" | "local" | "guest";

/**
 * Real customer sign-in/sign-up for deployments outside ChatGPT Sites,
 * where there's no platform-injected identity header. Rendered server-side
 * by app/[locale]/page.tsx when no identity resolves — there is no client
 * loading state to manage, since the server already knows the visitor
 * isn't authenticated by the time this renders. On success, reloads so the
 * server re-evaluates identity from the now-set session cookie.
 */
export function SignInScreen({ recoveryError = false }: { recoveryError?: boolean } = {}) {
  const t = useTranslations();
  const [formMode, setFormMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(recoveryError ? t("AuthGate.recoveryLinkInvalid") : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canResend, setCanResend] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const endpoint = formMode === "signin" ? "/api/auth/login" : formMode === "signup" ? "/api/auth/signup" : "/api/auth/forgot-password";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, displayName }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string; verificationRequired?: boolean };
      if (!response.ok) {
        // A duplicate-email signup is a normal outcome, not a failure the
        // user needs to interpret — the useful next step is signing in,
        // not staring at an error (generic or specific) on the signup form.
        if (formMode === "signup" && response.status === 409) {
          setFormMode("signin");
          setError(t("AuthGate.accountExistsSignInInstead"));
          return;
        }
        setError(data.error ?? t("AuthGate.somethingWentWrong"));
        return;
      }
      if (data.verificationRequired) {
        setFormMode("signin");
        setPassword("");
        setCanResend(true);
        setNotice(t("AuthGate.checkEmail"));
        return;
      }
      if (formMode === "forgot") {
        setFormMode("signin");
        setNotice(data.message ?? t("AuthGate.resetEmailSent"));
        return;
      }
      window.location.reload();
    } catch {
      setError(t("AuthGate.somethingWentWrong"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-gate">
      <div className="auth-gate-card">
        <div className="auth-gate-brand">
          <span className="brand-symbol">a</span>
          <strong>aval</strong>
        </div>
        <h1>{formMode === "signin" ? t("AuthGate.signInTitle") : formMode === "signup" ? t("AuthGate.signUpTitle") : t("AuthGate.forgotTitle")}</h1>
        <p>{formMode === "signin" ? t("AuthGate.signInSubtitle") : formMode === "signup" ? t("AuthGate.signUpSubtitle") : t("AuthGate.forgotSubtitle")}</p>
        <form onSubmit={submit}>
          {formMode === "signup" && (
            <label>
              {t("AuthGate.nameLabel")}
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("AuthGate.namePlaceholder")} autoComplete="name" />
            </label>
          )}
          <label>
            {t("AuthGate.emailLabel")}
            <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("AuthGate.emailPlaceholder")} autoComplete="email" />
          </label>
          {formMode !== "forgot" && (
            <label>
              {t("AuthGate.passwordLabel")}
              <input
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("AuthGate.passwordPlaceholder")}
                autoComplete={formMode === "signin" ? "current-password" : "new-password"}
              />
            </label>
          )}
          {error && <p className="auth-gate-error">{error}</p>}
          {notice && <p>{notice}</p>}
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? t("AuthGate.pleaseWait") : formMode === "signin" ? t("AuthGate.signIn") : formMode === "signup" ? t("AuthGate.createAccount") : t("AuthGate.sendResetLink")}
          </button>
        </form>
        {formMode === "signin" && (
          <button className="auth-gate-switch" type="button" onClick={() => { setFormMode("forgot"); setError(null); setNotice(null); }}>
            {t("AuthGate.forgotPassword")}
          </button>
        )}
        {formMode === "signin" && canResend && (
          <button className="auth-gate-switch" type="button" disabled={submitting} onClick={async () => {
            setSubmitting(true); setError(null);
            try {
              const response = await fetch("/api/auth/resend-verification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
              const data = await response.json().catch(() => ({})) as { error?: string; message?: string };
              if (!response.ok) setError(data.error ?? t("AuthGate.somethingWentWrong"));
              else setNotice(data.message ?? t("AuthGate.verificationEmailSent"));
            } catch { setError(t("AuthGate.somethingWentWrong")); }
            finally { setSubmitting(false); }
          }}>{t("AuthGate.resendVerification")}</button>
        )}
        <button
          className="auth-gate-switch"
          type="button"
          onClick={() => {
            setFormMode((current) => (current === "signin" ? "signup" : "signin"));
            setError(null);
            setNotice(null);
          }}
        >
          {formMode === "signin" ? t("AuthGate.needAnAccount") : t("AuthGate.alreadyHaveAnAccount")}
        </button>
      </div>
    </div>
  );
}

export function PasswordRecoveryScreen() {
  const t = useTranslations();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) { setError(t("AuthGate.passwordsDoNotMatch")); return; }
    setSubmitting(true); setError(null);
    try {
      const response = await fetch("/api/auth/update-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) { setError(data.error ?? t("AuthGate.somethingWentWrong")); return; }
      window.location.replace("/en");
    } catch { setError(t("AuthGate.somethingWentWrong")); }
    finally { setSubmitting(false); }
  };
  return <div className="auth-gate"><div className="auth-gate-card">
    <div className="auth-gate-brand"><span className="brand-symbol">a</span><strong>aval</strong></div>
    <h1>{t("AuthGate.choosePasswordTitle")}</h1><p>{t("AuthGate.choosePasswordSubtitle")}</p>
    <form onSubmit={submit}>
      <label>{t("AuthGate.newPasswordLabel")}<input type="password" required minLength={8} value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" /></label>
      <label>{t("AuthGate.confirmPasswordLabel")}<input type="password" required minLength={8} value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" /></label>
      {error && <p className="auth-gate-error">{error}</p>}
      <button className="primary-button" type="submit" disabled={submitting}>{submitting ? t("AuthGate.pleaseWait") : t("AuthGate.updatePassword")}</button>
    </form>
  </div></div>;
}
