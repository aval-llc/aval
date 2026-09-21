"use client";
/* eslint-disable jsx-a11y/no-autofocus */

import { useEffect, useMemo, useState } from "react";
import type { ComponentType, FormEvent, ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bell, Calendar, ChatLines, Check,
  Database, Flash, Globe, HalfMoon, Key,
  Language, LogOut, NetworkLeft, NavArrowDown, NavArrowRight, Page,
  Plus, Settings,
  Refresh, SoundHigh, SoundOff, SunLight, TaskList, User, WarningTriangle,
  ViewColumns3, Xmark,
} from "iconoir-react";
import { PanelLeftClose, PanelLeftOpen, LayoutGrid, Building2, KeyRound, Wrench, Landmark } from "lucide-react";
import { AnimatedNumber, ExperienceProvider, useExperience, usePrefersReducedMotion } from "@/app/components/experience";
import { useRouter, usePathname } from "./navigation";
import { AvalAssistant } from "@/app/components/aval-assistant";
import type { AuthMode } from "@/app/components/auth-gate";
import { useDraftJobs } from "@/app/components/ask-aval-tasks";
import { AppearanceProvider } from "@/app/components/appearance-provider";
import { ProfileAvatar } from "@/app/components/character-avatar";
import { UsageGrid, UsageRecorder } from "@/app/components/usage-activity";
import { ConnectedInbox } from "@/app/components/connected-inbox";
import { SettingsModule } from "@/app/components/settings-module";
import { BrandMark } from "@/app/components/brand-mark";
import { DesktopServiceBar } from "@/app/components/desktop-codex";
import { ConnectionDialog, type Provider } from "@/app/components/connection-dialog";
import type { NotificationItem } from "@/app/data/sample";
import { AvalAgentAvatar } from "@/app/components/agent-avatar/AgentAvatar";
import { DATA_SOURCE_NODES, PERSONA_IDS, PERSONA_PRESETS, PERSONA_TOOL_ACCESS, type PersonaId } from "@/app/components/agent-avatar/personas";
import type { UtilityType } from "@/lib/infrastructure/types";
import { DocumentUploader } from "@/app/components/document-uploader";
import { IntegrationsCatalog } from "@/app/components/integrations-catalog";
import { PlanningWorkspace } from "@/app/components/planning-workspace";
import { OperationsWorkspace } from "@/app/components/operations-workspace";
import { integrationCatalog } from "@/lib/integrations/catalog";
import { ModuleTour } from "@/app/components/module-tour";
import { useOnboarding } from "@/app/components/preference-context";
import { IndependenceControls } from "@/app/components/independence-controls";
import { OnboardingBoundary } from "@/app/components/onboarding";
import type { EmployeeWorkProps } from "@/app/components/employee-workspace";
import { EmployeeDirectory } from "@/app/components/employee-directory";
import type { DashboardDomain } from "@/lib/operations/dashboard-state";

type View = "calendar" | "projects" | "teams" | "overview" | "tasks" | "reviewCenter" | "inbox" | "properties" | "leasing" | "maintenance" | "accounting" | "infrastructure" | "connections" | "documents" | "setup" | "settings";
type IconComponent = ComponentType<{ width?: number; height?: number; className?: string }>;
type T = ReturnType<typeof useTranslations>;

const navGroups: { labelKey: string; items: { id: View; labelKey: string; icon: IconComponent; count?: number }[] }[] = [
  { labelKey: "Nav.agent", items: [
    { id: "overview", labelKey: "Nav.portfolioOverview", icon: LayoutGrid },
    { id: "setup", labelKey: "Nav.setup", icon: NetworkLeft },
    { id: "inbox", labelKey: "Nav.sharedInbox", icon: ChatLines },
  ]},
  { labelKey: "Nav.operations", items: [
    { id: "properties", labelKey: "Nav.properties", icon: Building2 },
    { id: "leasing", labelKey: "Nav.leasing", icon: KeyRound },
    { id: "maintenance", labelKey: "Nav.maintenance", icon: Wrench },
    { id: "accounting", labelKey: "Nav.accounting", icon: Landmark },
    { id: "infrastructure", labelKey: "Nav.infrastructure", icon: Flash },
  ]},
  { labelKey: "Nav.planning", items: [
    { id: "calendar", labelKey: "Nav.calendar", icon: Calendar },
    { id: "projects", labelKey: "Nav.projects", icon: ViewColumns3 },
    { id: "teams", labelKey: "Nav.teams", icon: User },
  ]},
  { labelKey: "Nav.workspace", items: [
    { id: "connections", labelKey: "Nav.connections", icon: NetworkLeft },
    { id: "documents", labelKey: "Nav.documents", icon: Page },
    { id: "settings", labelKey: "Nav.settings", icon: Settings },
  ]},
];

const fallbackProviders: Provider[] = integrationCatalog.map((provider) => ({ ...provider, configured: false }));
function formatMinutesAgo(minutesAgo: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutesAgo < 60) return rtf.format(-minutesAgo, "minute");
  const hours = Math.round(minutesAgo / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

function AppHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) { const t = useTranslations(); return <header className="app-header"><div><p className="eyebrow">{t("DesktopApp.avalWorkspaceEyebrow")}</p><h1>{title}</h1>{subtitle && <p className="header-subtitle">{subtitle}</p>}</div><div className="header-actions">{actions}<button className="icon-button" onClick={() => window.dispatchEvent(new Event("aval:notifications"))} aria-label={t("DesktopApp.notificationsLabel")}><Bell width={20} height={20}/><span className="notification-dot"/></button></div></header>; }

/** The phrases the hero cycles through. Each is a full sentence, typed then cleared. */
const HERO_PHRASE_KEYS = [
  "Overview.heroPhraseAllInOnePlace",
  "Overview.heroPhraseLeasingToLedger",
  "Overview.heroPhraseEveryDoorEveryDollar",
  "Overview.heroPhraseAnswersNotDashboards",
] as const;

/**
 * Types a phrase out, holds it, clears it, moves to the next — the marquee
 * line under the greeting.
 *
 * Honors `prefers-reduced-motion` by showing the first phrase statically:
 * a caret blinking through a retyping sentence is exactly the kind of
 * continuous motion that setting exists to turn off. Also pauses while the
 * tab is hidden, so returning to a backgrounded dashboard doesn't land
 * mid-word after thousands of wasted timer ticks.
 */
function useTypewriter(phrases: string[]): { text: string; typing: boolean } {
  const reduceMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [length, setLength] = useState(0);
  const [erasing, setErasing] = useState(false);

  const phrase = phrases[index % phrases.length] ?? "";

  useEffect(() => {
    if (reduceMotion || phrases.length === 0) return;
    // Typing is quick, erasing quicker, and a finished sentence holds long
    // enough to actually be read before it starts disappearing.
    const done = length >= phrase.length;
    const delay = erasing ? 24 : done ? 2100 : 52;
    const timer = window.setTimeout(() => {
      if (erasing) {
        if (length <= 0) { setErasing(false); setIndex((current) => (current + 1) % phrases.length); }
        else setLength((current) => current - 1);
        return;
      }
      if (done) { setErasing(true); return; }
      setLength((current) => current + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [length, erasing, phrase, phrases.length, reduceMotion]);

  if (reduceMotion) return { text: phrases[0] ?? "", typing: false };
  return { text: phrase.slice(0, length), typing: true };
}

/** Whole days since the workspace was created, inclusive of today. */
export function daysSince(createdAt: Date, now: Date): number {
  const start = Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), createdAt.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(1, Math.floor((today - start) / 86_400_000) + 1);
}

/**
 * The dashboard's opening block: who's here, how long they've been here, and
 * a typed line, over the year-of-activity heatmap.
 */
function OverviewHero({ displayName, t }: { displayName: string; t: T }) {
  const phrases = useMemo(() => HERO_PHRASE_KEYS.map((key) => t(key)), [t]);
  const { text, typing } = useTypewriter(phrases);
  const firstName = displayName.trim().split(/\s+/)[0] || displayName;
  const [days, setDays] = useState<number | null>(null);

  // Fetched rather than server-rendered (see page.tsx). Stays null — and the
  // counter stays hidden — if the call fails or the date is unparseable: a
  // fabricated "day 1" would be worse than no counter at all.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspace")
      .then((response) => (response.ok ? response.json() as Promise<{ createdAt?: string }> : null))
      .then((body) => {
        if (cancelled || !body?.createdAt) return;
        const created = new Date(body.createdAt);
        if (!Number.isNaN(created.getTime())) setDays(daysSince(created, new Date()));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return <><UsageGrid/><section className="overview-hero" data-reveal>
    <div className="overview-hero-copy">
      <p className="eyebrow">{t("Overview.heroEyebrow")}</p>
      <h1>{t("Overview.heroWelcome", { name: firstName })}</h1>
      {days !== null && <p className="overview-hero-days">
        <AnimatedNumber value={days}/> <span>{t("Overview.heroDaysWithAval", { count: days })}</span>
      </p>}
      <p className="overview-hero-typed" aria-live="off">
        <span>{text}</span>
        {typing && <i className="type-caret" aria-hidden="true"/>}
      </p>
      {/* The full set, readable by assistive tech and search without
          depending on the animation's current frame. */}
      <span className="visually-hidden">{phrases.join(". ")}</span>
    </div>
  </section></>;
}

function ConnectionsView({ providers, loading, onOpen, focus }: { providers: Provider[]; loading: boolean; onOpen: (id: string) => void; focus?: string }) {
  return <IntegrationsCatalog providers={providers} loading={loading} onOpen={onOpen} initialCategory={focus}/>;
}

interface DocumentRow { id: string; title: string; kind: string; charCount: number; createdAt: string }
interface ExtractedFieldRow { label: string; value: string | null; sourceQuote: string | null }
interface ExtractionResult { fields: ExtractedFieldRow[]; note: string | null; truncated: boolean }

const DOCUMENT_KIND_LABEL_KEY: Record<string, string> = {
  lease: "DocumentsView.kindLease",
  ownerStatement: "DocumentsView.kindOwnerStatement",
  lenderStatement: "DocumentsView.kindLenderStatement",
  vendorEstimate: "DocumentsView.kindVendorEstimate",
  other: "DocumentsView.kindOther",
};

const DOCUMENT_KINDS = ["lease", "ownerStatement", "lenderStatement", "vendorEstimate", "other"];

/**
 * Documents — what a workspace has given Aval to read, and the structured
 * reading of any one of them.
 *
 * Extraction is deliberately presented as a draft, not a result: every value
 * shows the document's own wording beside it, and a field the document does
 * not state renders as an explicit "not stated" rather than an empty cell that
 * could be mistaken for a rendering fault. That mirrors how the extraction
 * prompt is written — a blank is a correct answer, an invented value is not.
 */
function DocumentsView({ isGuest }: { isGuest: boolean }) {
  const t = useTranslations();
  const currentLocale = useLocale();
  const { notify } = useExperience();
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("lease");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [extracting, setExtracting] = useState(false);

  const dateFmt = useMemo(() => new Intl.DateTimeFormat(currentLocale, { dateStyle: "medium" }), [currentLocale]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/documents")
      .then((response) => (response.ok ? response.json() as Promise<{ documents: DocumentRow[] }> : null))
      .then((body) => { if (!cancelled && body) setDocuments(body.documents); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, kind, contentText: text }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { document: DocumentRow & { truncated: boolean } };
      setDocuments((current) => [body.document, ...current]);
      setTitle(""); setText(""); setAdding(false);
      // Truncation is surfaced, never silent — an answer drawn from a document
      // whose tail was dropped without saying so is the worst outcome here.
      notify(
        t("DocumentsView.savedTitle"),
        body.document.truncated ? t("DocumentsView.savedTruncated") : t("DocumentsView.savedDetail"),
      );
    } catch {
      notify(t("DocumentsView.saveFailedTitle"), t("DocumentsView.saveFailedDetail"));
    } finally {
      setSaving(false);
    }
  }

  async function extract(documentId: string) {
    setSelectedId(documentId);
    setExtraction(null);
    setExtracting(true);
    try {
      const response = await fetch("/api/documents/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { extraction: ExtractionResult };
      setExtraction(body.extraction);
    } catch {
      notify(t("DocumentsView.readFailedTitle"), t("DocumentsView.readFailedDetail"));
      setSelectedId(null);
    } finally {
      setExtracting(false);
    }
  }

  async function remove(documentId: string) {
    try {
      const response = await fetch(`/api/documents?id=${encodeURIComponent(documentId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { documents: DocumentRow[] };
      setDocuments(body.documents);
      if (selectedId === documentId) { setSelectedId(null); setExtraction(null); }
    } catch {
      notify(t("DocumentsView.saveFailedTitle"), t("DocumentsView.saveFailedDetail"));
    }
  }

  return <div className="view-wrap documents-view">
    <AppHeader
      title={t("DocumentsView.documents")}
      subtitle={t("DocumentsView.subtitle")}
      actions={<button className="primary-button" onClick={() => setAdding(!adding)}><Plus width={18} height={18}/>{t("DocumentsView.addDocument")}</button>}
    />

    {isGuest && <section className="panel guest-warning" data-reveal>
      <WarningTriangle width={18} height={18}/>
      <div>
        <strong>{t("DocumentsView.guestWarningTitle")}</strong>
        <p>{t("DocumentsView.guestWarningBody")}</p>
      </div>
    </section>}

    <DocumentUploader disabled={isGuest} onUploaded={row => setDocuments(current => [row, ...current.filter(document => document.id !== row.id)])}/>

    {adding && <section className="panel" data-reveal>
      <div className="panel-heading"><div><p className="eyebrow">{t("DocumentsView.newDocument")}</p><h2>{t("DocumentsView.pasteTheText")}</h2></div></div>
      <div className="document-form">
        <div className="document-form-row">
          <input
            className="teach-input"
            placeholder={t("DocumentsView.titlePlaceholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={t("DocumentsView.titlePlaceholder")}
          />
          <select className="document-kind-select" value={kind} onChange={(event) => setKind(event.target.value)} aria-label={t("DocumentsView.kind")}>
            {DOCUMENT_KINDS.map((option) => <option key={option} value={option}>{t(DOCUMENT_KIND_LABEL_KEY[option])}</option>)}
          </select>
        </div>
        <textarea
          className="document-textarea"
          placeholder={t("DocumentsView.textPlaceholder")}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={9}
          aria-label={t("DocumentsView.textPlaceholder")}
        />
        <div className="document-form-actions">
          <p className="empty-copy">{t("DocumentsView.privacyNote")}</p>
          <button className="primary-button" onClick={save} disabled={!text.trim() || saving}>
            {saving ? t("DocumentsView.saving") : t("DocumentsView.save")}
          </button>
        </div>
      </div>
    </section>}

    <section className="panel" data-reveal>
      <div className="panel-heading">
        <div><p className="eyebrow">{t("DocumentsView.library")}</p><h2>{t("DocumentsView.storedDocuments", { count: documents.length })}</h2></div>
      </div>
      {!loaded
        ? <p className="empty-copy">{t("DocumentsView.loading")}</p>
        : documents.length === 0
        ? <p className="empty-copy">{t("DocumentsView.emptyLibrary")}</p>
        : <div className="document-list">
            {documents.map((document) => <div className={`document-row${selectedId === document.id ? " is-selected" : ""}`} key={document.id}>
              <Page width={16} height={16}/>
              <div>
                <strong>{document.title}</strong>
                <span>{t(DOCUMENT_KIND_LABEL_KEY[document.kind] ?? "DocumentsView.kindOther")} · {t("DocumentsView.characters", { count: document.charCount.toLocaleString(currentLocale) })} · {dateFmt.format(new Date(document.createdAt))}</span>
              </div>
              <button className="soft-button" onClick={() => extract(document.id)} disabled={extracting}>
                {extracting && selectedId === document.id ? t("DocumentsView.reading") : t("DocumentsView.read")}
              </button>
              <button className="text-button quiet" onClick={() => remove(document.id)}>{t("DocumentsView.delete")}</button>
            </div>)}
          </div>}
    </section>

    {extraction && <section className="panel" data-reveal>
      <div className="panel-heading">
        <div><p className="eyebrow">{t("DocumentsView.reading_")}</p><h2>{t("DocumentsView.whatTheDocumentStates")}</h2></div>
        <span className="quiet-label">{t("DocumentsView.reviewBeforeActing")}</span>
      </div>
      {extraction.truncated && <p className="empty-copy infra-caveat">{t("DocumentsView.truncatedWarning")}</p>}
      <div className="extraction-grid">
        {extraction.fields.map((field) => <div className={`extraction-field${field.value ? "" : " is-absent"}`} key={field.label}>
          <p className="extraction-label">{field.label}</p>
          <p className="extraction-value">{field.value ?? t("DocumentsView.notStated")}</p>
          {field.sourceQuote && <p className="extraction-quote">&ldquo;{field.sourceQuote}&rdquo;</p>}
        </div>)}
      </div>
      {extraction.note && <p className="empty-copy">{extraction.note}</p>}
      <p className="empty-copy">{t("DocumentsView.extractionDisclaimer")}</p>
    </section>}
  </div>;
}

function OperationsView({ view, openConnections }: { view: View; openConnections: () => void; providers: Provider[] }) {
  return <OperationsWorkspace view={view as "properties" | "leasing" | "maintenance" | "accounting"} openConnections={openConnections}/>;
}

// Not gated behind a Provider connection like OperationsView's tabs — meters
// and bills are native Aval data (lib/infrastructure/), not synced from an
// upstream PMS/accounting system, so there's no "connect a source" story
// here. This surface stays empty until native meter data is available.
const UTILITY_LABEL_KEY: Record<UtilityType, string> = {
  electricity: "InfrastructureView.electricity",
  water: "InfrastructureView.water",
  gas: "InfrastructureView.gas",
};
function InfrastructureView({ onAddMeter }: { onAddMeter: () => void }) {
  const t = useTranslations();
  return <div className="view-wrap infra-view"><AppHeader title={t("InfrastructureView.infrastructure")} subtitle={t("InfrastructureView.infrastructureSubtitle")} actions={<button className="primary-button" onClick={onAddMeter}><Flash width={18} height={18}/>{t("InfrastructureView.addMeter")}</button>}/><section className="panel locked-panel"><div><h2>{t("InfrastructureView.emptyDescription")}</h2><button className="primary-button" onClick={onAddMeter}>{t("InfrastructureView.addMeter")}<NavArrowRight width={17} height={17}/></button></div></section></div>;
}

/** Where a chosen agent's answers land — fixed, since every persona routes the same way. */
const SETUP_OUTPUT_NODES: { labelKey: string; icon: IconComponent }[] = [
  { labelKey: "SetupView.outputAskAval", icon: ChatLines },
  { labelKey: "SetupView.outputDrafts", icon: Page },
  { labelKey: "SetupView.outputTaskBoard", icon: TaskList },
];

interface TaughtPreference { topic: string; statement: string; label: string; source: string }
interface PreferenceOption { topic: string; statements: { statement: string; label: string }[] }

/** Label keys for the fixed preference taxonomy, so the picker reads as English/Spanish, not as tags. */
const PREFERENCE_TOPIC_LABEL_KEY: Record<string, string> = {
  vendor_selection: "SetupView.topicVendorSelection",
  communication_channel: "SetupView.topicCommunicationChannel",
  reporting_style: "SetupView.topicReportingStyle",
  approval_threshold: "SetupView.topicApprovalThreshold",
};

/**
 * Aval Setup — the agent module's control panel: which agent sits at the
 * center, what it can reach, and what it has been taught.
 *
 * Two things here genuinely change how the assistant behaves rather than
 * just describing it:
 *   - the center agent's tool grant (PERSONA_TOOL_ACCESS), which decides
 *     which data tools the loop may call at all; and
 *   - taught preferences, which are read back into every future Ask Aval
 *     system prompt by getPreferenceContext(). Teaching here writes the same
 *     rows the assistant learns from mid-conversation corrections.
 */
function SetupView({ openConnections, work }: { openConnections: () => void; work: EmployeeWorkProps }) {
  const t = useTranslations();
  const { notify } = useExperience();
  const [selected, setSelected] = useState<PersonaId>("general");
  const [loaded, setLoaded] = useState(false);
  const [taught, setTaught] = useState<TaughtPreference[]>([]);
  const [options, setOptions] = useState<PreferenceOption[]>([]);
  const [teaching, setTeaching] = useState<string | null>(null);
  const [busyTopic, setBusyTopic] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftState, setDraftState] = useState<"idle" | "saving" | "noMatch">("idle");
  const [suggestions, setSuggestions] = useState<{ topic: string; text: string }[]>([]);
  const [suggestionSeed, setSuggestionSeed] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/agents/default").then((r) => (r.ok ? r.json() as Promise<{ defaultPersonaId?: string | null }> : null)).catch(() => null),
      fetch("/api/agents/memory").then((r) => (r.ok ? r.json() as Promise<{ taught: TaughtPreference[]; options: PreferenceOption[]; suggestions: { topic: string; text: string }[] }> : null)).catch(() => null),
    ]).then(([agent, memory]) => {
      if (cancelled) return;
      const saved = agent?.defaultPersonaId;
      if (saved && PERSONA_IDS.includes(saved as PersonaId)) setSelected(saved as PersonaId);
      if (memory) { setTaught(memory.taught); setOptions(memory.options); setSuggestions(memory.suggestions ?? []); }
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  const preset = PERSONA_PRESETS[selected];
  const access = PERSONA_TOOL_ACCESS[selected];
  const reachesEverything = access === null;
  const reachable = useMemo(() => new Set(access ?? DATA_SOURCE_NODES.map((node) => node.tool)), [access]);
  const taughtByTopic = useMemo(() => new Map(taught.map((row) => [row.topic, row])), [taught]);


  async function teach(topic: string, statement: string) {
    setBusyTopic(topic);
    try {
      const response = await fetch("/api/agents/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, statement }) });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { taught: TaughtPreference[]; suggestions: { topic: string; text: string }[] };
      setTaught(body.taught);
      setSuggestions(body.suggestions ?? []);
      setTeaching(null);
      notify(t("SetupView.taughtTitle"), t("SetupView.taughtDetail"));
    } catch {
      notify(t("SetupView.teachFailedTitle"), t("SetupView.teachFailedDetail"));
    } finally { setBusyTopic(null); }
  }

  /**
   * Teaches from a typed sentence. The server classifies it into the fixed
   * taxonomy and stores only the resulting tag — the sentence itself is never
   * persisted. A 422 means it couldn't be placed confidently, which is shown
   * as "pick from the list" rather than guessed at.
   */
  async function teachFromText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setDraftState("saving");
    try {
      const response = await fetch("/api/agents/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: trimmed }) });
      if (response.status === 422) { setDraftState("noMatch"); return; }
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { taught: TaughtPreference[]; suggestions: { topic: string; text: string }[]; matched?: { topic: string; statement: string } };
      setTaught(body.taught);
      setSuggestions(body.suggestions ?? []);
      setDraft("");
      setDraftState("idle");
      const label = body.taught.find((row) => row.topic === body.matched?.topic)?.label ?? "";
      notify(t("SetupView.taughtTitle"), label || t("SetupView.taughtDetail"));
    } catch {
      setDraftState("idle");
      notify(t("SetupView.teachFailedTitle"), t("SetupView.teachFailedDetail"));
    }
  }

  async function forget(topic: string) {
    setBusyTopic(topic);
    try {
      const response = await fetch(`/api/agents/memory?topic=${encodeURIComponent(topic)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { taught: TaughtPreference[]; suggestions: { topic: string; text: string }[] };
      setTaught(body.taught);
      setSuggestions(body.suggestions ?? []);
    } catch {
      notify(t("SetupView.teachFailedTitle"), t("SetupView.teachFailedDetail"));
    } finally { setBusyTopic(null); }
  }

  return <div className="view-wrap setup-view">
    <AppHeader
      title={t("SetupView.setup")}
      subtitle={t("SetupView.setupSubtitle")}
      actions={<button className="soft-button" onClick={openConnections}><NetworkLeft width={17} height={17}/>{t("SetupView.connectASource")}</button>}
    />

    <EmployeeDirectory work={work}/>
    <IndependenceControls/>
    <section className="panel setup-panel" data-reveal>
      <div className="panel-heading">
        <div><p className="eyebrow">{t("SetupView.wiring")}</p><h2>{t("SetupView.whatThisAgentCanReach")}</h2></div>
        <span className="quiet-label">{reachesEverything ? t("SetupView.allSources") : t("SetupView.sourcesOfTotal", { count: reachable.size, total: DATA_SOURCE_NODES.length })}</span>
      </div>

      <div className="setup-diagram">
        <div className="setup-column">
          <p className="setup-column-label">{t("SetupView.dataSources")}</p>
          {DATA_SOURCE_NODES.map((node) => {
            const on = reachable.has(node.tool);
            return <div className={`setup-node${on ? "" : " is-off"}`} key={node.tool}>
              <Database width={15} height={15}/>
              <span>{t(node.labelKey)}</span>
              {!on && <small>{t("SetupView.notAvailable")}</small>}
            </div>;
          })}
          <button type="button" className="setup-node setup-node-action" onClick={openConnections}>
            <Plus width={15} height={15}/><span>{t("SetupView.connectAPms")}</span>
          </button>
        </div>

        <div className="setup-rails" aria-hidden="true"/>

        <div className="setup-center">
          <div className="setup-agent-node">
            <AvalAgentAvatar personaId={preset.id} shape={preset.shape} theme={preset.theme} icon={preset.icon} size={56} label={t(preset.labelKey)}/>
            <strong>{t(preset.labelKey)}</strong>
            <small>{t("SetupView.workspaceDefault")}</small>
            <span className="setup-memory-count">{t("SetupView.factsRemembered", { count: taught.length })}</span>
          </div>
        </div>

        <div className="setup-rails is-out" aria-hidden="true"/>

        <div className="setup-column">
          <p className="setup-column-label">{t("SetupView.whereAnswersGo")}</p>
          {SETUP_OUTPUT_NODES.map((node) => { const Icon = node.icon; return <div className="setup-node" key={node.labelKey}>
            <Icon width={15} height={15}/><span>{t(node.labelKey)}</span>
          </div>; })}
        </div>
      </div>

      <p className="empty-copy">{t("SetupView.connectSourcesNote")}</p>
    </section>

    {/* The employee directory, rendered from rows. What stood here was a grid
        over PERSONA_IDS — a fixed eight cards that no customer could add to,
        and one of which could never be saved. */}
    {(<section className="panel memory-panel" data-reveal>
      <div className="panel-heading">
        <div><p className="eyebrow">{t("SetupView.memory")}</p><h2>{t("SetupView.whatAvalRemembers")}</h2></div>
        <span className="quiet-label">{t("SetupView.appliesEverywhere")}</span>
      </div>

      <div className="teach-box">
        <div className="teach-input-row">
          <input
            type="text"
            className="teach-input"
            placeholder={t("SetupView.teachPlaceholder")}
            value={draft}
            onChange={(event) => { setDraft(event.target.value); if (draftState === "noMatch") setDraftState("idle"); }}
            onKeyDown={(event) => { if (event.key === "Enter") teachFromText(draft); }}
            disabled={draftState === "saving" || !loaded}
            aria-label={t("SetupView.teachPlaceholder")}
          />
          <button type="button" className="primary-button" onClick={() => teachFromText(draft)} disabled={!draft.trim() || draftState === "saving" || !loaded}>
            {draftState === "saving" ? t("SetupView.saving") : t("SetupView.teachAval")}
          </button>
        </div>
        {draftState === "noMatch"
          ? <p className="teach-hint is-warning">{t("SetupView.noMatchHint")}</p>
          : <p className="teach-hint">{t("SetupView.teachHint")}</p>}

        {suggestions.length > 0 && <details className="teach-suggestions"><summary>{t("SetupView.notSureWhatToTeach")}</summary>
          <div className="teach-suggestions-head">
            <span>{t("SetupView.notSureWhatToTeach")}</span>
            <button type="button" className="text-button" onClick={() => setSuggestionSeed((seed) => seed + 1)}>
              <Refresh width={13} height={13}/>{t("SetupView.refresh")}
            </button>
          </div>
          <div className="teach-suggestion-chips">
            {/* One rotating window over the pool, so Refresh always changes
                what's on screen instead of reshuffling into the same three. */}
            {Array.from({ length: Math.min(3, suggestions.length) }, (_, offset) => suggestions[(suggestionSeed * 3 + offset) % suggestions.length]).map((suggestion, index) => (
              <button type="button" className="teach-chip" key={`${suggestion.topic}-${index}`} onClick={() => { setDraft(suggestion.text); setDraftState("idle"); }}>
                {suggestion.text}
              </button>
            ))}
          </div>
        </details>}
      </div>

      <div className="memory-grid">
        {options.map((option) => {
          const current = taughtByTopic.get(option.topic);
          const isOpen = teaching === option.topic;
          const busy = busyTopic === option.topic;
          return <article className={`memory-card${current ? " is-taught" : ""}`} key={option.topic}>
            <div className="memory-card-head">
              <div>
                <strong>{t(PREFERENCE_TOPIC_LABEL_KEY[option.topic] ?? option.topic)}</strong>
                <small>{current ? current.label : t("SetupView.nothingTaughtYet")}</small>
              </div>
              {current
                ? <span className={`status-pill ${current.source === "ask_aval" ? "" : "optional"}`}>{current.source === "ask_aval" ? t("SetupView.learnedFromChat") : t("SetupView.setHere")}</span>
                : null}
            </div>
            <div className="memory-card-actions">
              <button type="button" className="text-button" disabled={busy || !loaded} onClick={() => setTeaching(isOpen ? null : option.topic)}>
                {current ? t("SetupView.change") : t("SetupView.teachAval")}
                <NavArrowDown width={14} height={14}/>
              </button>
              {current && <button type="button" className="text-button quiet" disabled={busy} onClick={() => forget(option.topic)}>{t("SetupView.forget")}</button>}
            </div>
            {isOpen && <div className="memory-options">
              {option.statements.map((choice) => <button
                type="button"
                key={choice.statement}
                className={`memory-option${current?.statement === choice.statement ? " is-selected" : ""}`}
                disabled={busy}
                onClick={() => teach(option.topic, choice.statement)}
              >
                {current?.statement === choice.statement && <Check width={13} height={13}/>}
                <span>{choice.label}</span>
              </button>)}
            </div>}
          </article>;
        })}
      </div>

      <details className="memory-explainer"><summary>{t("AgentLibrary.aboutMemory")}</summary><p>{t("SetupView.memoryExplainer")}</p></details>
    </section>)}


  </div>;
}

function SettingsView({ openConnections, displayName, email }: { openConnections: () => void; displayName: string; email: string }) {
  const t = useTranslations();
  return <SettingsModule header={<AppHeader title={t("SettingsView.settings")} subtitle={t("SettingsModule.subtitle")}/>} openConnections={openConnections} displayName={displayName} email={email}/>;
}


const UTILITY_TYPE_OPTIONS: UtilityType[] = ["electricity", "water", "gas"];
const DEFAULT_UNIT_BY_UTILITY: Record<UtilityType, string> = { electricity: "kWh", water: "gal", gas: "therm" };


function AddMeterDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const { notify } = useExperience();
  const [propertyLabel, setPropertyLabel] = useState("");
  const [utilityType, setUtilityType] = useState<UtilityType>("electricity");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const label = propertyLabel.trim();
    if (!label || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/infrastructure/meters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ utilityType, propertyLabel: label, unitOfMeasure: DEFAULT_UNIT_BY_UTILITY[utilityType] }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        notify(t("InfrastructureView.addMeter"), label);
        onClose();
      } else {
        setError(data.error || t("InfrastructureView.addMeterError"));
      }
    } catch {
      setError(t("InfrastructureView.addMeterError"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="small-dialog">
          <div className="dialog-top">
            <Dialog.Title>{t("InfrastructureView.addMeter")}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t("Overview.close")}><Xmark width={20} height={20} /></Dialog.Close>
          </div>
          <form className="aval-draft-panel" onSubmit={submit}>
            <input value={propertyLabel} onChange={(event) => setPropertyLabel(event.target.value)} placeholder={t("InfrastructureView.propertyLabelPlaceholder")} autoFocus />
            <div className="aval-draft-panel-row">
              <select value={utilityType} onChange={(event) => setUtilityType(event.target.value as UtilityType)}>
                {UTILITY_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{t(UTILITY_LABEL_KEY[option])}</option>)}
              </select>
              <button type="submit" className="primary-button" disabled={!propertyLabel.trim() || submitting}>
                <NavArrowRight width={16} height={16} />{t("InfrastructureView.addMeter")}
              </button>
            </div>
            {error && <p className="aval-agent-create-error">{error}</p>}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DesktopApp({ authMode, displayName, email, initialView }: { authMode: AuthMode; displayName: string; email: string; initialView: View }) {
  // Everyone signed out shares one workspace, so anything saved here is
  // visible to the next visitor. Surfaces that store content say so.
  const isGuest = authMode === "guest";
  const { market, setMarket, theme, setTheme, sounds, setSounds, celebrate } = useExperience();
  const preferences = useOnboarding();
  const region = preferences?.state.preferences.region[0];
  useEffect(() => {
    if (region === "mx" || region === "latam") setMarket("latam");
    else if (region === "us") setMarket("us");
  }, [region, setMarket]);
  const t = useTranslations();
  const currentLocale = useLocale();
  const { jobs: draftJobs, createJob: createDraftJob, pauseJob: pauseDraftJob, resumeJob: resumeDraftJob, retryJob: retryDraftJob, sendJob: sendDraftJob, removeJobs: removeDraftJobs, loading: draftsLoading } = useDraftJobs(currentLocale);
  const router = useRouter();
  const pathname = usePathname();
  const switchLocale = (nextLocale: "en" | "es-mx") => router.replace(pathname, { locale: nextLocale }); const [view, setView] = useState<View>(initialView); const [providers, setProviders] = useState<Provider[]>(fallbackProviders); const [loading, setLoading] = useState(true); const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null); const [addMeterOpen, setAddMeterOpen] = useState(false); const [collapsed, setCollapsed] = useState(false); const [profile, setProfile] = useState(false); const [notifications, setNotifications] = useState(false); const [notificationItems, setNotificationItems] = useState<NotificationItem[]>([]); const unreadCount = notificationItems.filter((item) => !item.read).length; const accountingProviderId = market === "latam" ? "contpaqi" : "quickbooks";
  const [connectionFocus, setConnectionFocus] = useState<string>();
  const pendingReviewCount = 0;
  const loadProviders = async () => { try { const response = await fetch("/api/integrations"); const data = await response.json() as { providers?: Provider[] }; if (data.providers?.length) setProviders(data.providers); } catch { /* local preview stays usable */ } setLoading(false); };
  useEffect(() => { queueMicrotask(() => void loadProviders()); const show = () => setNotifications(true); window.addEventListener("aval:notifications", show); const connected = new URLSearchParams(window.location.search).get("connected"); if (connected) { window.setTimeout(() => celebrate(t("DesktopApp.connectionAuthorized"), connected), 250); const url = new URL(window.location.href); url.searchParams.delete("connected"); window.history.replaceState({}, "", url); } return () => window.removeEventListener("aval:notifications", show); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setActiveView = (requested: View) => { const next = requested === "tasks" || requested === "reviewCenter" ? "setup" : requested; setView(next); setProfile(false); const url = new URL(window.location.href); url.searchParams.set("view", next); window.history.replaceState({}, "", url); window.scrollTo({ top: 0, behavior: "smooth" }); }; const openConnections = (domain?: DashboardDomain) => { setConnectionFocus(domain ? ({ property: "Leasing & PMS", occupancy: "Leasing & PMS", leasing: "Leasing & PMS", maintenance: "Leasing & PMS", rent: "Leasing & PMS", collections: "Accounting", accounting: "Accounting", communications: "Communication" })[domain] : undefined); setActiveView("connections"); }; const openProvider = (id: string) => setSelectedProvider(providers.find((provider) => provider.id === id) ?? null); const titleKey = useMemo<string>(() => navGroups.flatMap((group) => group.items).find((item) => item.id === view)?.labelKey ?? "DesktopApp.avalFallback", [view]);
  const resolveNotificationProvider = (item: NotificationItem) => item.provider === "quickbooks" && market === "latam" ? accountingProviderId : item.provider;
  const openNotification = (item: NotificationItem) => {
    setNotificationItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry));
    setNotifications(false);
    const target = item.target;
    if (target.kind === "connectionProvider") {
      setActiveView("connections");
      openProvider(target.providerId === "quickbooks" ? accountingProviderId : target.providerId);
      return;
    }
    setActiveView(target.kind === "inboxThread" ? "inbox" : "overview");
  };
  const navCounts: Partial<Record<View, number>> = { reviewCenter: pendingReviewCount };
  const signOutOfPasswordAccount = () => { fetch("/api/auth/logout", { method: "POST" }).finally(() => { window.location.href = "/"; }); };
  return <main data-workspace-mode="live" className={`app-shell ${collapsed ? "sidebar-is-collapsed" : ""}`}><aside className="sidebar"><div className="brand-lockup"><span className="brand-symbol">a</span><div><strong>aval</strong><small>{t("DesktopApp.propertyOperations")}</small></div><button className="icon-button sidebar-collapse" onClick={() => setCollapsed(!collapsed)} aria-label={t(collapsed ? "DesktopApp.expandSidebar" : "DesktopApp.collapseSidebar")} aria-expanded={!collapsed}>{collapsed ? <PanelLeftOpen size={20}/> : <PanelLeftClose size={20}/>}</button></div><nav>{navGroups.map((group) => <div className="nav-group" key={group.labelKey}><p>{t(group.labelKey)}</p>{group.items.map((item) => { const Icon = item.icon; const count = navCounts[item.id] ?? item.count; return <button className={view === item.id ? "active" : ""} data-tour-target={item.id} onClick={() => setActiveView(item.id)} key={item.id} title={t(item.labelKey)}><Icon width={20} height={20}/><span>{t(item.labelKey)}</span>{Boolean(count) && <b>{count}</b>}{view === item.id && <NavArrowRight className="nav-chevron" width={16} height={16}/>}</button>; })}</div>)}</nav><button className="workspace-card" aria-expanded={profile} onClick={() => { setCollapsed(false); setProfile(!profile); }}><ProfileAvatar name={displayName} size={36}/><span><strong>{displayName}</strong><small>{email}</small></span><span className="icon-button"><NavArrowDown width={16} height={16}/></span></button>{profile && <div className="profile-menu"><div><ProfileAvatar name={displayName} size={36}/><span><strong>{displayName}</strong><small>{email}</small></span></div><button onClick={() => setActiveView("settings")}><Settings width={17} height={17}/>{t("DesktopApp.profileSettings")}</button><button onClick={() => switchLocale(currentLocale === "en" ? "es-mx" : "en")}><Language width={17} height={17}/>{currentLocale === "en" ? "Español (México)" : "English"}</button><button onClick={() => setMarket(market === "us" ? "latam" : "us")}><Globe width={17} height={17}/>{market === "us" ? t("DesktopApp.marketUnitedStates") : t("DesktopApp.marketLatam")}</button><button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? <HalfMoon width={17} height={17}/> : <SunLight width={17} height={17}/>} {theme === "light" ? t("DesktopApp.darkMode") : t("DesktopApp.lightMode")}</button><button onClick={() => setSounds(!sounds)}>{sounds ? <SoundHigh width={17} height={17}/> : <SoundOff width={17} height={17}/>} {sounds ? t("DesktopApp.soundsOn") : t("DesktopApp.soundsOff")}</button>{isGuest && <a href="?signin=1" className="profile-menu-signin"><Key width={17} height={17}/>{t("DesktopApp.signIn")}</a>}
      {authMode === "password"
        ? <button type="button" onClick={signOutOfPasswordAccount}><LogOut width={17} height={17}/>{t("DesktopApp.signOut")}</button>
        // eslint-disable-next-line @next/next/no-html-link-for-pages -- external platform sign-out route, not part of this app router
        : <a href="/signout-with-chatgpt?return_to=/"><LogOut width={17} height={17}/>{t("DesktopApp.signOut")}</a>}
      </div>}</aside><section className="content-shell" aria-label={t(titleKey)}><UsageRecorder enabled={!isGuest}/><DesktopServiceBar/>{(view === "calendar" || view === "projects" || view === "teams") && <PlanningWorkspace key={view} view={view} isGuest={isGuest}/>} {view === "overview" && <OperationsWorkspace view="overview" openConnections={openConnections} hero={<OverviewHero displayName={displayName} t={t}/>}/>} {view === "inbox" && <ConnectedInbox/>} {view === "connections" && <ConnectionsView providers={providers} loading={loading} onOpen={openProvider} focus={connectionFocus}/>} {view === "settings" && <SettingsView openConnections={openConnections} displayName={displayName} email={email}/>} {view === "infrastructure" && <InfrastructureView onAddMeter={() => setAddMeterOpen(true)}/>} {view === "setup" && <SetupView openConnections={openConnections} work={{ jobs: draftJobs, onCreate: createDraftJob, onPause: pauseDraftJob, onResume: resumeDraftJob, onRetry: retryDraftJob, onSend: sendDraftJob, onRemove: removeDraftJobs, loading: draftsLoading }}/>} {view === "documents" && <DocumentsView isGuest={isGuest}/>} {(["properties", "leasing", "maintenance", "accounting"] as View[]).includes(view) && <OperationsView view={view} openConnections={openConnections} providers={providers}/>}</section>{selectedProvider && <ConnectionDialog provider={selectedProvider} onClose={() => setSelectedProvider(null)} onRefresh={loadProviders}/>}{addMeterOpen && <AddMeterDialog onClose={() => setAddMeterOpen(false)}/>}<Dialog.Root open={notifications} onOpenChange={setNotifications}><Dialog.Portal><Dialog.Overlay className="dialog-overlay subtle"/><Dialog.Content className="notification-drawer"><div className="drawer-heading"><div><p className="eyebrow">{t("DesktopApp.liveWorkspace")}</p><Dialog.Title>{t("DesktopApp.notifications")}</Dialog.Title></div><Dialog.Close className="icon-button" aria-label={t("Overview.close")}><Xmark width={20} height={20}/></Dialog.Close></div><div className="notification-list">{notificationItems.map((item) => <button key={item.id} className={item.read ? "" : "unread"} onClick={() => openNotification(item)}><BrandMark provider={resolveNotificationProvider(item)} small/><span><strong>{t(item.titleKey)}</strong><small>{t(item.detailKey, item.detailParams)}</small></span><span className="notif-trailing">{!item.read && <i className="unread-dot"/>}<time>{formatMinutesAgo(item.minutesAgo, currentLocale)}</time></span></button>)}</div><button className="wide-button" onClick={() => setNotificationItems((current) => current.map((item) => ({ ...item, read: true })))}><Check width={17} height={17}/>{unreadCount ? t("DesktopApp.markAllAsRead") : t("DesktopApp.allCaughtUp")}</button></Dialog.Content></Dialog.Portal></Dialog.Root><AvalAssistant view={view} onCreateDraft={createDraftJob}/><ModuleTour currentView={view} onNavigate={setActiveView}/></main>;
}

export function AvalDashboard({ authMode, displayName, email, requestedView }: { authMode: AuthMode; displayName: string; email: string; requestedView?: string }) {
  const resolvedView = requestedView === "tasks" || requestedView === "reviewCenter" ? "setup" : requestedView;
  const initialView = navGroups.some(g => g.items.some(item => item.id === resolvedView)) ? resolvedView as View : "overview";
  return <ExperienceProvider><AppearanceProvider key={`${authMode}:${email}`} isGuest={authMode === "guest"}>{authMode === "guest" ? <DesktopApp authMode={authMode} displayName={displayName} email={email} initialView={initialView}/> : <OnboardingBoundary key={`${authMode}:${email}`}><DesktopApp authMode={authMode} displayName={displayName} email={email} initialView={initialView}/></OnboardingBoundary>}</AppearanceProvider></ExperienceProvider>;
}
