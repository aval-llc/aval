"use client";
import { ChatWindowPreferences } from "./chat-window-preferences";

import { useEffect, useState, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useLocale, useTranslations } from "next-intl";
import { Coins, Language, NavArrowRight, Settings, ShieldCheck, SoundHigh, SunLight, User, Group, Cpu, ControlSlider, City } from "iconoir-react";
import { BusinessProfileSettings } from "./business-profile-settings";
import { usePathname, useRouter } from "@/app/[locale]/navigation";
import { useExperience } from "./experience";
import { useAppearance } from "./appearance-provider";
import { ProfileAvatar } from "./character-avatar";
import { AppearanceSettings } from "./appearance-settings";
import { BillingSettings } from "./billing-settings";
import { IntelligenceSettings } from "./intelligence-settings";
import { FinancialAgentControls } from "./financial-agent-controls";
import { WorkspaceMembers } from "./workspace-members";
import { OnboardingPreferences } from "./onboarding";

const GROUPS = [
  { id: "personal", sections: [{ id: "profile", icon: User }, { id: "appearance", icon: SunLight }, { id: "preferences", icon: ControlSlider }] },
  { id: "workspace", sections: [{ id: "team", icon: Group }, { id: "business", icon: City }, { id: "intelligence", icon: Cpu }, { id: "agents", icon: Settings }, { id: "billing", icon: Coins }, { id: "security", icon: ShieldCheck }] },
] as const;
type SectionId = typeof GROUPS[number]["sections"][number]["id"];

export function SettingsModule({ header, openConnections, displayName, email }: { header: ReactNode; openConnections: () => void; displayName: string; email: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { sounds, setSounds } = useExperience();
  const { isGuest } = useAppearance();
  const [section, setSection] = useState<SectionId>("profile");
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("section");
    if (GROUPS.some((group) => group.sections.some((item) => item.id === requested))) queueMicrotask(() => setSection(requested as SectionId));
  }, []);
  const changeSection = (value: string) => {
    setSection(value as SectionId);
    const url = new URL(window.location.href);
    url.searchParams.set("section", value);
    window.history.replaceState(window.history.state, "", url);
  };
  const workspaceContent = (children: ReactNode) => isGuest ? <div className="settings-empty"><h3>{t("SettingsModule.signInTitle")}</h3><p>{t("SettingsModule.signInDescription")}</p><a className="primary-button" href="?signin=1">{t("DesktopApp.signIn")}</a></div> : children;

  return <div className="view-wrap settings-view">{header}
    <Tabs.Root className="settings-layout" value={section} onValueChange={changeSection} orientation="vertical" activationMode="automatic">
      <aside className="settings-navigation">
        <label className="settings-mobile-nav">{t("SettingsModule.navigate")}<select value={section} onChange={(event) => changeSection(event.target.value)}>{GROUPS.map((group) => <optgroup key={group.id} label={t(`SettingsModule.${group.id}`)}>{group.sections.map(({ id }) => <option key={id} value={id}>{t(`SettingsModule.sections.${id}`)}</option>)}</optgroup>)}</select></label>
        <Tabs.List aria-label={t("SettingsModule.navigate")} className="settings-nav-list">{GROUPS.map((group) => <div className="settings-nav-group" key={group.id}><p>{t(`SettingsModule.${group.id}`)}</p>{group.sections.map(({ id, icon: Icon }) => <Tabs.Trigger value={id} key={id} className="settings-nav-item"><Icon width={18} height={18}/><span>{t(`SettingsModule.sections.${id}`)}</span></Tabs.Trigger>)}</div>)}</Tabs.List>
        <p className="settings-navigation-note">{t("SettingsModule.navigationNote")}</p>
      </aside>
      <div className="settings-content">
        <div className="settings-page-heading"><p>{t(`SettingsModule.${GROUPS[0].sections.some((item) => item.id === section) ? "personal" : "workspace"}`)}</p><h2>{t(`SettingsModule.sections.${section}`)}</h2><span>{t(`SettingsModule.descriptions.${section}`)}</span></div>
        <Tabs.Content value="profile" forceMount hidden={section !== "profile"}>
          <section className="settings-section profile-summary"><ProfileAvatar name={displayName} size={88}/><div><h3>{displayName}</h3><p>{email}</p><button type="button" className="soft-button" onClick={() => changeSection("appearance")}>{t("SettingsModule.customizePicture")}<NavArrowRight width={16} height={16}/></button></div></section>
          <section className="settings-section"><dl className="settings-profile-details"><div><dt>{t("SettingsModule.displayName")}</dt><dd>{displayName}</dd></div><div><dt>{t("SettingsModule.email")}</dt><dd>{email}</dd></div></dl><p className="settings-muted">{t("SettingsView.workspaceIdentityChangesRequireAnAdministrator")}</p></section>
        </Tabs.Content>
        <Tabs.Content value="appearance" forceMount hidden={section !== "appearance"}><AppearanceSettings displayName={displayName}/></Tabs.Content>
        <Tabs.Content value="preferences" forceMount hidden={section !== "preferences"}>
          <ChatWindowPreferences/>
          <OnboardingPreferences/>
          <section className="settings-section settings-inline-section"><div className="settings-section-label"><h3><Language width={19} height={19}/>{t("SettingsView.language")}</h3><p>{t("SettingsView.englishOrSpanishForLatinAmerica")}</p></div><select aria-label={t("SettingsView.language")} value={locale} onChange={(event) => router.replace(`${pathname}?view=settings&section=preferences`, { locale: event.target.value as "en" | "es-mx" })}><option value="en">English</option><option value="es-mx">Español (México)</option></select></section>
          <section className="settings-section settings-inline-section"><div className="settings-section-label"><h3><SoundHigh width={19} height={19}/>{t("SettingsView.tactileSounds")}</h3><p>{t("SettingsView.quietTapRevealNotificationAndSuccess")}</p></div><button type="button" className={`switch ${sounds ? "on" : ""}`} role="switch" aria-label={t("SettingsView.tactileSounds")} aria-checked={sounds} onClick={() => setSounds(!sounds)}><i/></button></section>
          <p className="settings-muted settings-preferences-note">{t("SettingsModule.devicePreferences")}</p>
        </Tabs.Content>
        <Tabs.Content value="team" forceMount hidden={section !== "team"}>{workspaceContent(<WorkspaceMembers/>)}</Tabs.Content>
        <Tabs.Content value="business" forceMount hidden={section !== "business"}>{workspaceContent(section === "business" ? <BusinessProfileSettings/> : null)}</Tabs.Content>
        <Tabs.Content value="intelligence" forceMount hidden={section !== "intelligence"}><IntelligenceSettings/></Tabs.Content>
        <Tabs.Content value="agents" forceMount hidden={section !== "agents"}>{workspaceContent(<FinancialAgentControls/>)}</Tabs.Content>
        <Tabs.Content value="billing" forceMount hidden={section !== "billing"}>{workspaceContent(<BillingSettings/>)}</Tabs.Content>
        <Tabs.Content value="security" forceMount hidden={section !== "security"}>
          <section className="settings-section"><div className="settings-section-label"><h3>{t("SettingsView.permissionsSecurity")}</h3><p>{t("SettingsView.reviewScopesConnectionHealthAndRevocation")}</p></div><ul className="settings-security-list">{["securityPasswordHashing", "securitySessionSigning", "securityOrgIsolation", "securityFaithfulnessGate", "securityPreferenceMemory"].map((key) => <li key={key}><ShieldCheck width={18} height={18}/><span>{t(`SettingsView.${key}`)}</span></li>)}</ul><p className="settings-muted">{t("SettingsView.securityNoCertificationClaim")}</p><button type="button" className="soft-button" onClick={openConnections}>{t("SettingsView.manageConnections")}<NavArrowRight width={17} height={17}/></button></section>
        </Tabs.Content>
      </div>
    </Tabs.Root>
  </div>;
}
