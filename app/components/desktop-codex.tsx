"use client";

import { useEffect, useState } from "react";
import { CheckCircle, Refresh, WarningTriangle } from "iconoir-react";
import { useTranslations } from "next-intl";
import { DesktopAgentRunner } from './desktop-agent-runner';

export type DesktopCodexStatus =
  | "starting"
  | "signed_out"
  | "opening_browser"
  | "waiting_for_login"
  | "connected_chatgpt"
  | "connected_api_key"
  | "login_failed"
  | "rate_limited"
  | "restarting"
  | "unavailable"
  | "update_required";

export interface DesktopCodexState {
  available: boolean;
  status: DesktopCodexStatus;
  active: boolean;
  account: null | { type: "chatgpt"; email: string | null; planType: string } | { type: "apiKey" };
  models: Array<{ id: string; displayName: string; isDefault: boolean }>;
  selectedModel: string | null;
  rateLimits: null | {
    primary: null | { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null };
    secondary: null | { usedPercent: number | null; resetsAt: number | null; windowDurationMins: number | null };
    reached: boolean;
  };
  lastError: string | null;
}

export interface DesktopAskPayload {
  conversationId: string;
  question: string;
  locale: string;
  context: Record<string, unknown>;
}

export interface DesktopCodexBridge {
  setChatBackground?(background: "white" | "glass", theme?: "light" | "dark"): Promise<{ nativeGlass: boolean; nativeTitlebar?: boolean }>;
  getState(): Promise<DesktopCodexState>;
  connect(): Promise<DesktopCodexState>;
  cancelLogin(): Promise<DesktopCodexState>;
  logout(): Promise<DesktopCodexState>;
  refresh(): Promise<DesktopCodexState>;
  setActive(active: boolean): Promise<DesktopCodexState>;
  setModel(modelId: string): Promise<DesktopCodexState>;
  ask<T>(payload: DesktopAskPayload): Promise<T>;
  infer(payload: { model: string; params: unknown }): Promise<unknown>;
  cancelTurn(conversationId: string): Promise<null>;
  onEvent(listener: (event: { type: "state"; state: DesktopCodexState } | { type: "delta"; requestId: string; delta: string }) => void): () => void;
}

declare global {
  interface Window {
    avalDesktop?: DesktopCodexBridge;
  }
}

export function useDesktopCodex() {
  const bridge = typeof window === "undefined" ? null : window.avalDesktop ?? null;
  const [state, setState] = useState<DesktopCodexState | null>(null);

  useEffect(() => {
    const desktop = bridge;
    if (!desktop) return;
    let live = true;
    void desktop.getState().then((next) => { if (live) setState(next); }).catch(() => {});
    const unsubscribe = desktop.onEvent((event) => {
      if (live && event.type === "state") setState(event.state);
    });
    document.documentElement.classList.add("aval-desktop-runtime");
    return () => {
      live = false;
      unsubscribe();
      document.documentElement.classList.remove("aval-desktop-runtime");
    };
  }, [bridge]);

  const run = async (operation: () => Promise<DesktopCodexState>) => {
    const next = await operation();
    setState(next);
    return next;
  };

  return {
    bridge,
    state,
    connect: () => bridge ? run(() => bridge.connect()) : Promise.reject(new Error("Desktop bridge unavailable")),
    cancelLogin: () => bridge ? run(() => bridge.cancelLogin()) : Promise.reject(new Error("Desktop bridge unavailable")),
    logout: () => bridge ? run(() => bridge.logout()) : Promise.reject(new Error("Desktop bridge unavailable")),
    refresh: () => bridge ? run(() => bridge.refresh()) : Promise.reject(new Error("Desktop bridge unavailable")),
    setActive: (active: boolean) => bridge ? run(() => bridge.setActive(active)) : Promise.reject(new Error("Desktop bridge unavailable")),
    setModel: (modelId: string) => bridge ? run(() => bridge.setModel(modelId)) : Promise.reject(new Error("Desktop bridge unavailable")),
  };
}

export function DesktopServiceBar() {
  const t = useTranslations();
  const desktop = useDesktopCodex();
  if (!desktop.bridge || !desktop.state) return null;
  const connected = desktop.state.status === "connected_chatgpt";
  const warning = desktop.state.status === "unavailable" || desktop.state.status === "login_failed" || desktop.state.status === "rate_limited";
  const statusKey = `DesktopCodex.status.${desktop.state.status}` as const;
  return (
    <div className={`desktop-service-bar ${connected ? "connected" : ""} ${warning ? "warning" : ""}`} role="status">
      {connected ? <CheckCircle width={15} height={15} /> : warning ? <WarningTriangle width={15} height={15} /> : <Refresh width={15} height={15} className={desktop.state.status === "starting" || desktop.state.status === "restarting" ? "spinning" : ""} />}
      <span>{t(statusKey)}</span>
      {desktop.state.active && connected && <strong>{desktop.state.selectedModel ?? t("DesktopCodex.defaultModel")}</strong>}
      <DesktopAgentRunner desktop={desktop} />
    </div>
  );
}
