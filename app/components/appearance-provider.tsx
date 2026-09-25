"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_APPEARANCE, parseAppearance, type AppearancePreferences } from "@/lib/appearance";

type AppearanceContextValue = {
  appearance: AppearancePreferences;
  saved: AppearancePreferences;
  setAppearance: (next: AppearancePreferences) => void;
  save: (next?: AppearancePreferences) => Promise<void>;
  reload: () => void;
  loading: boolean;
  saving: boolean;
  error: "load" | "save" | null;
  isGuest: boolean;
};
const AppearanceContext = createContext<AppearanceContextValue | null>(null);
const GUEST_KEY = "aval.guest.appearance.v1";

export function AppearanceProvider({ children, isGuest }: { children: ReactNode; isGuest: boolean }) {
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const [saved, setSaved] = useState(DEFAULT_APPEARANCE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        let next: AppearancePreferences;
        if (isGuest) {
          const raw = window.localStorage.getItem(GUEST_KEY);
          try { next = raw ? parseAppearance(JSON.parse(raw)) ?? DEFAULT_APPEARANCE : DEFAULT_APPEARANCE; }
          catch { next = DEFAULT_APPEARANCE; }
        } else {
          const response = await fetch("/api/appearance", { cache: "no-store" });
          if (!response.ok) throw new Error("load");
          const body = await response.json() as { appearance?: unknown };
          const parsed = parseAppearance(body.appearance);
          if (!parsed) throw new Error("load");
          next = parsed;
        }
        if (live) { setAppearance(next); setSaved(next); setError(null); }
      } catch { if (live) setError("load"); }
      finally { if (live) setLoading(false); }
    }
    void load();
    return () => { live = false; };
  }, [isGuest, revision]);

  const save = async (next = appearance) => {
    if (saving || loading || error === "load") return;
    setSaving(true);
    setError(null);
    try {
      if (isGuest) window.localStorage.setItem(GUEST_KEY, JSON.stringify(next));
      else {
        const response = await fetch("/api/appearance", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
        if (!response.ok) throw new Error("save");
      }
      setSaved(next);
    } catch { setError("save"); }
    finally { setSaving(false); }
  };

  return <AppearanceContext.Provider value={{ appearance, saved, setAppearance, save, reload: () => { setLoading(true); setRevision((value) => value + 1); }, loading, saving, error, isGuest }}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance requires AppearanceProvider");
  return value;
}

/** Legacy SVG swatches can still render outside the dashboard provider. */
export function useOptionalAppearance() { return useContext(AppearanceContext); }
