"use client";

/**
 * What business this workspace runs, which decides which Leads and
 * Specialists its work may reach.
 *
 * Rendered entirely from the taxonomy the server sends: adding a business model
 * or an asset class to lib/organizations/operating-profile.ts adds it here with
 * no change to this component.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

interface Entry { id: string; label: string; description: string }
interface ProfileResponse {
  profile: { businessModels: string[]; assetClasses: string[]; version: number };
  taxonomy: { businessModels: Entry[]; assetClasses: Entry[] };
  reachableLeads: { id: string; name: string; domain: string }[];
}

export function BusinessProfileSettings() {
  const t = useTranslations("BusinessProfile");
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [draft, setDraft] = useState<{ businessModels: string[]; assetClasses: string[] }>({ businessModels: [], assetClasses: [] });
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error" | "forbidden">("loading");

  useEffect(() => {
    let live = true;
    void fetch("/api/organizations/profile", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await response.json() as ProfileResponse;
      if (!live) return;
      setData(body);
      setDraft({ businessModels: body.profile.businessModels, assetClasses: body.profile.assetClasses });
      setState("idle");
    }).catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, []);

  const toggle = (axis: "businessModels" | "assetClasses", id: string) => setDraft((current) => ({
    ...current, [axis]: current[axis].includes(id) ? current[axis].filter((value) => value !== id) : [...current[axis], id],
  }));
  const changed = data && (draft.businessModels.slice().sort().join() !== data.profile.businessModels.join() || draft.assetClasses.slice().sort().join() !== data.profile.assetClasses.join());

  const save = async () => {
    setState("saving");
    const response = await fetch("/api/organizations/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }).catch(() => null);
    if (!response?.ok) { setState(response?.status === 403 ? "forbidden" : "error"); return; }
    const body = await response.json() as ProfileResponse;
    setData(body);
    setDraft({ businessModels: body.profile.businessModels, assetClasses: body.profile.assetClasses });
    setState("saved");
  };

  if (state === "loading") return <section className="settings-section"><p className="settings-muted">{t("loading")}</p></section>;
  if (!data) return <section className="settings-section"><p className="employee-error" role="alert">{t("loadFailed")}</p></section>;

  const axis = (key: "businessModels" | "assetClasses", entries: Entry[]) => <section className="settings-section business-profile-axis">
    <div className="settings-section-label"><h3>{t(`${key}Title`)}</h3><p>{t(`${key}Hint`)}</p></div>
    <div className="business-profile-options" role="group" aria-label={t(`${key}Title`)}>
      {entries.map((entry) => <button type="button" key={entry.id} className="business-profile-option" aria-pressed={draft[key].includes(entry.id)} onClick={() => toggle(key, entry.id)}>
        <strong>{entry.label}</strong><span>{entry.description}</span>
      </button>)}
    </div>
  </section>;

  return <>
    {axis("businessModels", data.taxonomy.businessModels)}
    {axis("assetClasses", data.taxonomy.assetClasses)}
    <section className="settings-section">
      <div className="settings-section-label"><h3>{t("reachTitle")}</h3><p>{draft.businessModels.length || draft.assetClasses.length ? t("reachHint") : t("reachEverything")}</p></div>
      <p className="business-profile-reach">{data.reachableLeads.map((lead) => lead.name).join(" · ")}</p>
      <div className="employee-form-actions">
        {state === "saved" && <span className="settings-muted" role="status">{t("saved")}</span>}
        {state === "error" && <span className="employee-error" role="alert">{t("saveFailed")}</span>}
        {state === "forbidden" && <span className="employee-error" role="alert">{t("ownersOnly")}</span>}
        <button type="button" className="primary-button" disabled={!changed || state === "saving"} onClick={() => void save()}>{state === "saving" ? t("saving") : t("save")}</button>
      </div>
    </section>
  </>;
}
