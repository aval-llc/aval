"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, HalfMoon, SunLight, User } from "iconoir-react";
import { BACKGROUNDS, CHARACTER_IDS, PORTRAIT_IDS, defaultAgentAvatar, currentAvatar, type AvatarSelection, type AvatarMotion } from "@/lib/appearance";
import { PERSONA_IDS, PERSONA_PRESETS } from "./agent-avatar/personas";
import { useAppearance } from "./appearance-provider";
import { CharacterAvatar, ProfileAvatar } from "./character-avatar";
import { useExperience } from "./experience";

export function AppearanceSettings({ displayName }: { displayName: string }) {
  const t = useTranslations();
  const { theme, setTheme } = useExperience();
  const { appearance, saved, setAppearance, save, loading, saving, error, isGuest, reload } = useAppearance();
  const [target, setTarget] = useState("profile");
  const [family, setFamily] = useState<"portrait" | "character">("portrait");
  const [customAgents, setCustomAgents] = useState<{ id: string; label: string }[]>([]);
  const dirty = JSON.stringify(appearance) !== JSON.stringify(saved);
  const savedSelection = target === "profile" ? appearance.profile : appearance.agents[target] ?? null;
  const selected = savedSelection ? currentAvatar(savedSelection) : null;
  const builtIn = PERSONA_PRESETS[target as keyof typeof PERSONA_PRESETS];
  const targetName = target === "profile" ? displayName : builtIn ? t(builtIn.labelKey) : customAgents.find((agent) => agent.id === target)?.label ?? target;

  useEffect(() => {
    let live = true;
    void (async () => {
      const agents: { id: string; label: string }[] = [];
      try {
        const response = await fetch("/api/agents");
        if (response.ok) {
          const body = await response.json() as { personas?: { id: string; label: string }[] };
          agents.push(...(body.personas ?? []));
        }
        let offset = 0;
        while (live) {
          const response = await fetch(`/api/agents/employees?limit=100&offset=${offset}`);
          if (!response.ok) break;
          const body = await response.json() as { employees: { id: string; name: string; role: string }[]; total: number };
          agents.push(...body.employees.map(employee => ({ id: employee.id, label: `${employee.name} · ${employee.role}` })));
          offset += body.employees.length;
          if (!body.employees.length || offset >= body.total) break;
        }
      } catch { /* Built-in agents remain customizable if the directory is unavailable. */ }
      if (live) setCustomAgents(agents);
    })();
    return () => { live = false; };
  }, []);

  const choose = (avatar: AvatarSelection | null) => {
    if (target === "profile") setAppearance({ ...appearance, profile: avatar });
    else {
      const agents = { ...appearance.agents };
      if (avatar) agents[target] = avatar; else delete agents[target];
      setAppearance({ ...appearance, agents });
    }
  };
  const effectiveAvatar: AvatarSelection | null = selected ?? (target !== "profile" ? defaultAgentAvatar(target) : null);
  const selectTarget = (value: string) => { setTarget(value); const next = value === "profile" ? appearance.profile : appearance.agents[value]; setFamily(next ? currentAvatar(next).kind : value === "general" ? "character" : "portrait"); };

  return <div className="appearance-settings">
    <section className="settings-section">
      <div className="settings-section-label"><h3>{t("Appearance.display")}</h3><p>{t("Appearance.displayDescription")}</p></div>
      <div className="appearance-themes" role="group" aria-label={t("Appearance.display")}>
        {(["light", "dark"] as const).map((mode) => <button type="button" className={`appearance-theme ${mode} ${theme === mode ? "is-selected" : ""}`} key={mode} aria-pressed={theme === mode} onClick={() => setTheme(mode)}>
          <span className="theme-miniature" aria-hidden="true"><i/><span><i/><i/><i/></span></span>
          <span>{mode === "light" ? <SunLight width={17} height={17}/> : <HalfMoon width={17} height={17}/>} {t(`SettingsView.${mode}`)}{theme === mode && <Check width={17} height={17}/>}</span>
        </button>)}
      </div>
    </section>

    <section className="settings-section avatar-section">
      <div className="settings-section-label"><h3>{t("Appearance.characters")}</h3><p>{t("Appearance.charactersDescription")}</p></div>
      {error === "load" ? <div className="settings-feedback" role="alert"><p>{t("Appearance.loadError")}</p><button type="button" className="soft-button" onClick={reload}>{t("Appearance.retry")}</button></div> : <>
      <fieldset disabled={loading || saving} className="appearance-controls">
        <legend className="sr-only">{t("Appearance.characters")}</legend>
        <div className="avatar-target-bar">
          <div className="settings-choice-group" role="group" aria-label={t("Appearance.customize")}>
            <button type="button" aria-pressed={target === "profile"} onClick={() => selectTarget("profile")}><User width={16} height={16}/>{t("Appearance.yourProfile")}</button>
            <button type="button" aria-pressed={target !== "profile"} onClick={() => selectTarget("general")}>{t("Appearance.yourAgents")}</button>
          </div>
          {target !== "profile" && <select aria-label={t("Appearance.chooseAgent")} value={target} onChange={(event) => selectTarget(event.target.value)}>
            {PERSONA_IDS.map((id) => <option value={id} key={id}>{t(PERSONA_PRESETS[id].labelKey)}</option>)}
            {customAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label}</option>)}
          </select>}
        </div>

        <div className="avatar-workbench">
          <div className="avatar-library">
            <div className="avatar-library-heading"><div className="settings-choice-group" role="group" aria-label={t("Appearance.collection")}>
              <button type="button" aria-pressed={family === "portrait"} onClick={() => setFamily("portrait")}>{t("Appearance.portraits")} <span>{PORTRAIT_IDS.length}</span></button>
              <button type="button" aria-pressed={family === "character"} onClick={() => setFamily("character")}>{t("Appearance.avalIcon")} <span>{CHARACTER_IDS.length}</span></button>
            </div></div>
            <div className="avatar-gallery" role="group" aria-label={t("Appearance.chooseAvatar")}>
              {(family === "portrait" ? PORTRAIT_IDS : CHARACTER_IDS).map((id) => {
                const avatar: AvatarSelection = { kind: family, id, background: selected?.background ?? "paper" };
                const active = effectiveAvatar?.id === id && effectiveAvatar.kind === family;
                const label = t(`Appearance.${family === "portrait" ? "portraitsList" : "charactersList"}.${id}`);
                return <button type="button" key={id} className={`avatar-option ${active ? "is-selected" : ""}`} aria-pressed={active} aria-label={label} onClick={() => choose(avatar)}>
                  <span className="avatar-option-image"><CharacterAvatar avatar={avatar} size={72} label=""/>{active && <span className="avatar-check"><Check width={12} height={12}/></span>}</span>
                  <span>{label}</span>
                </button>;
              })}
            </div>
          </div>

          <aside className="avatar-preview" aria-label={t("Appearance.preview")}>
            <p className="avatar-preview-label">{t("Appearance.preview")}</p>
            {effectiveAvatar ? <CharacterAvatar avatar={effectiveAvatar} size={144} label={targetName}/> : target === "profile" ? <ProfileAvatar name={displayName} size={144}/> : <span className="avatar-default-preview"><User width={64} height={64}/></span>}
            <strong>{targetName}</strong>
            <span className="avatar-preview-caption">{target === "profile" ? t("Appearance.profilePreview") : t("Appearance.agentPreview")}</span>
            <div className="avatar-backgrounds" role="group" aria-label={t("Appearance.background")}>
              <p>{t("Appearance.background")}</p>
              {Object.entries(BACKGROUNDS).map(([id, color]) => <button type="button" key={id} style={{ backgroundColor: color }} disabled={!effectiveAvatar} aria-label={t(`Appearance.backgrounds.${id}`)} aria-pressed={effectiveAvatar?.background === id} onClick={() => effectiveAvatar && choose({ ...effectiveAvatar, background: id as AvatarSelection["background"] })}>{effectiveAvatar?.background === id && <Check width={14} height={14}/>}</button>)}
            </div>
            {target !== "profile" && effectiveAvatar && <button type="button" className="soft-button use-profile-button" onClick={() => { setAppearance({ ...appearance, profile: effectiveAvatar }); setTarget("profile"); }}>{t("Appearance.useForProfile")}</button>}
            <button type="button" className="avatar-reset" disabled={!selected} onClick={() => choose(null)}>{target === "profile" ? t("Appearance.useInitials") : t("Appearance.restoreAgent")}</button>
          </aside>
        </div>
      </fieldset>
      {loading && <p role="status" className="settings-muted">{t("Appearance.loading")}</p>}
      </>}
    </section>

    <section className="settings-section settings-inline-section">
      <div className="settings-section-label"><h3>{t("Appearance.motion")}</h3><p>{t("Appearance.motionDescription")}</p></div>
      <select aria-label={t("Appearance.motion")} value={appearance.motion} disabled={loading || saving || error === "load"} onChange={(event) => setAppearance({ ...appearance, motion: event.target.value as AvatarMotion })}>
        <option value="system">{t("Appearance.motionSystem")}</option><option value="animated">{t("Appearance.motionAnimated")}</option><option value="still">{t("Appearance.motionStill")}</option>
      </select>
    </section>
    <footer className="appearance-save-bar">
      <div aria-live="polite"><p className={error ? "settings-error" : ""}>{error === "save" ? t("Appearance.saveError") : error === "load" ? t("Appearance.loadError") : saving ? t("Appearance.saving") : dirty ? t("Appearance.unsaved") : t("Appearance.saved")}</p><small>{isGuest ? t("Appearance.guestStorage") : t("Appearance.accountStorage")}</small></div>
      <div><button type="button" className="soft-button" disabled={!dirty || saving || loading} onClick={() => setAppearance(saved)}>{t("Appearance.cancel")}</button><button type="button" className="primary-button" disabled={!dirty || saving || loading || error === "load"} onClick={() => void save()}>{saving ? t("Appearance.saving") : t("Appearance.save")}</button></div>
    </footer>
  </div>;
}
