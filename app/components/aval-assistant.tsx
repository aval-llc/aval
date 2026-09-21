"use client";
/* eslint-disable jsx-a11y/no-autofocus */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppearance } from "./appearance-provider";
import { createPortal } from "react-dom";
import { ChevronDown, ExternalLink, PanelRightClose, PanelRightOpen, ArrowDownLeft, ArrowUp } from "lucide-react";
import { useChatPanel } from "./use-chat-panel";
import { Foldout } from "./foldout";
import { readAskStream, type AskProgress } from "@/lib/ask-aval/progress";
import { autonomyMode } from "@/lib/agents/autonomy";
import type { ResizeEdge } from "@/lib/ask-aval/panel-geometry";
import type { FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChatLines, CheckCircle, Database, NavArrowRight, Page, Search, SendDiagonal, StatsUpSquare, ViewGrid, WarningTriangle, Xmark, Minus, ScaleFrameEnlarge, ScaleFrameReduce, ControlSlider } from "iconoir-react";
import { AgentTaskConversation } from "./agent-task-conversation";
import { useOnboarding } from "./preference-context";
import { IndependenceControls } from "./independence-controls";
import { useExperience } from "@/app/components/experience";
import type { CreateDraftInput, DraftFormat } from "@/app/components/ask-aval-tasks";
import { MarkdownPreview } from "@/app/components/markdown-preview";
import { AvalAgentAvatar, PERSONA_IDS, PERSONA_PRESETS, SHAPE_IDS, THEME_IDS, type PersonaId, type ShapeId, type ThemeId } from "@/app/components/agent-avatar";
import { useDesktopCodex } from "@/app/components/desktop-codex";

interface CustomPersonaSummary {
  id: string;
  label: string;
  shape: ShapeId;
  theme: ThemeId;
}

type EvidenceRow = { label: string; value: string };
// value can be a pre-formatted string (the local sample-mode fallback
// already bakes in currency/percent formatting) or a raw number with a unit
// (what the live model returns, via its render_answer tool) — rendered
// differently below depending on which one arrives.
type Metric = { label: string; value: number | string; unit?: "currency" | "percent" | "count" | "days"; delta?: number };
type ChartPoint = { x: string; y: number };
type AnswerChart = { metric?: string; title?: string; points: ChartPoint[] };
type Answer = {
  headline: string;
  narrative: string;
  metrics: Metric[];
  evidence?: EvidenceRow[];
  evidence_ids?: string[];
  chart?: AnswerChart;
  document?: string;
  action?: string;
  actionDetail?: string;
  confidence?: "high" | "medium" | "low";
  /**
   * The tools the model actually called, from the response's own
   * `tools_used`. Rendered as the reasoning trace — real work, not a
   * simulation of it.
   */
  tools_used?: string[];
};
type ChatMessage = {
  taskId?: string;
  taskAgentId?: string;
  id: number;
  role: "user" | "assistant";
  text?: string;
  answer?: Answer;
  // Whether this answer came from a real Claude call or the local sample-mode
  // fallback (no API key configured, or the request failed) — always shown,
  // never presented as "real analysis" when it was actually pattern-matched.
  /** Set when the request failed; rendered as an error, never as an answer. */
  error?: string;
};
function isAnswerShaped(value: unknown): value is Answer {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Answer>;
  // metrics is optional in the server's render_answer schema — a real answer
  // that had no figures worth tiling is still a real answer, not a failure.
  return typeof candidate.headline === "string" && typeof candidate.narrative === "string" && (candidate.metrics === undefined || Array.isArray(candidate.metrics));
}
type SelectedModule = { label: string; snapshot: string };

function formatMetricValue(metric: Metric): string {
  if (typeof metric.value === "string") return metric.value;
  if (metric.unit === "currency") return `$${metric.value.toLocaleString()}`;
  if (metric.unit === "percent") return `${metric.value}%`;
  if (metric.unit === "days") return `${metric.value}d`;
  return metric.value.toLocaleString();
}

/** A small inline line chart for a live answer's get_metric_series result — real tool output only, never hand-drawn from prose. */
function AvalChatChart({ chart }: { chart: AnswerChart }) {
  const width = 300;
  const height = 96;
  const padding = { top: 8, right: 8, bottom: 8, left: 8 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const values = chart.points.map((point) => point.y);
  const maxY = Math.max(...values, 1);
  const minY = Math.min(...values, 0);
  const range = maxY - minY || 1;
  const stepX = chart.points.length > 1 ? plotW / (chart.points.length - 1) : 0;
  const x = (index: number) => padding.left + index * stepX;
  const y = (value: number) => padding.top + plotH - ((value - minY) / range) * plotH;
  const linePath = chart.points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point.y)}`).join(" ");
  return (
    <div className="aval-chat-chart">
      {chart.title && <p>{chart.title}</p>}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={chart.title ?? chart.metric ?? "Chart"}>
        <path d={linePath} className="aval-chat-chart-line" />
        {chart.points.map((point, index) => <circle key={`${point.x}-${index}`} cx={x(index)} cy={y(point.y)} r={2.5} className="aval-chat-chart-dot" />)}
      </svg>
      <div className="aval-chat-chart-labels">{chart.points.map((point, index) => <span key={`${point.x}-${index}`}>{point.x}</span>)}</div>
    </div>
  );
}

const viewNameKeys: Record<string, string> = {
  calendar: "Nav.calendar",
  projects: "Nav.projects",
  teams: "Nav.teams",
  overview: "Nav.portfolioOverview",
  tasks: "Nav.avalTasks",
  inbox: "Nav.sharedInbox",
  properties: "Nav.properties",
  leasing: "Nav.leasing",
  maintenance: "Nav.maintenance",
  accounting: "Nav.accounting",
  connections: "Nav.connections",
  documents: "Nav.documents",
  settings: "Nav.settings",
};

/**
 * A tool name as a person would read it: `get_delinquent_accounts` becomes
 * "delinquent accounts".
 *
 * Derived rather than translated into a table of hand-written labels. A table
 * would need an entry per tool in every locale, and the entry that goes stale
 * is the one nobody notices — a trace that names the wrong source is worse
 * than one that names the source plainly.
 */
function readableToolName(tool: string): string {
  return tool.replace(/^(get|list|read|record|fetch)_/, "").replace(/_/g, " ");
}

const suggestionKeys = ["AvalAssistant.suggestion1", "AvalAssistant.suggestion2", "AvalAssistant.suggestion3"];
const focusedSuggestionKeys = ["AvalAssistant.focusedSuggestion1", "AvalAssistant.focusedSuggestion2", "AvalAssistant.focusedSuggestion3"];

// Mirrors persona-validation.ts's VALID_TOOL_NAMES — duplicated rather than
// imported since that file sits in lib/ask-aval (server-only in spirit,
// even though this particular module has no actual server-only import) and
// this is just six display labels, not logic worth sharing a module for.
const TOOL_OPTIONS: { id: string; labelKey: string }[] = [
  { id: "get_portfolio_metrics", labelKey: "AvalAssistant.toolPortfolioMetrics" },
  { id: "get_property_breakdown", labelKey: "AvalAssistant.toolPropertyBreakdown" },
  { id: "get_delinquent_accounts", labelKey: "AvalAssistant.toolDelinquentAccounts" },
  { id: "get_leasing_funnel", labelKey: "AvalAssistant.toolLeasingFunnel" },
  { id: "get_metric_series", labelKey: "AvalAssistant.toolMetricSeries" },
  { id: "get_accounting_breakdown", labelKey: "AvalAssistant.toolAccountingBreakdown" },
];
const ALL_TOOL_IDS = TOOL_OPTIONS.map((tool) => tool.id);

const moduleSelector = [
  "[data-ai-module]",
  ".metric-card",
  ".panel",
  ".task-column",
  ".task-card",
  ".conversation-row",
  ".message-thread",
  ".contact-panel",
  ".required-source",
  ".connection-card",
  ".locked-panel",
  ".settings-card",
].join(",");

function describeModule(element: HTMLElement): SelectedModule {
  const labelNode = element.querySelector<HTMLElement>(
    ".metric-top span, .panel-heading h2, .column-heading h2, .task-card-top strong, .conversation-row strong, h2, h3, strong",
  );
  const label = element.dataset.aiLabel ?? labelNode?.innerText.trim() ?? "Dashboard module";
  const snapshot = element.innerText.replace(/\s+/g, " ").trim().slice(0, 260);
  return { label, snapshot };
}


export function AvalAssistant({ view, onCreateDraft }: { view: string; onCreateDraft: (input: CreateDraftInput) => void }) {
  const { notify, theme } = useExperience();
  const desktop = useDesktopCodex();
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent<boolean>).detail) setOpen(true); };
    window.addEventListener("aval:tour:chat",show);
    return () => window.removeEventListener("aval:tour:chat",show);
  }, []);
  const { appearance } = useAppearance();
  const panel = useChatPanel(() => notify(t("ChatPanel.popupBlocked"), t("ChatPanel.popupHelp")), appearance.chatWindowBackground ?? "white", theme, appearance.chatWindowTransparency);
  const { minimized, expanded, popupRoot } = panel;
  const [intent, setIntent] = useState<'chat' | 'task'>('chat');
  const toolsRef = useRef<HTMLDetailsElement>(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [workingQuestion, setWorkingQuestion] = useState("");
  const [progress, setProgress] = useState<AskProgress>({ phase: 'thinking' });
  const [pickingModule, setPickingModule] = useState(false);
  const [selectedModule, setSelectedModule] = useState<SelectedModule | null>(null);
  const [pickingPersona, setPickingPersona] = useState(false);
  const [personaId, setPersonaId] = useState<string>("general");
  const [customPersonas, setCustomPersonas] = useState<CustomPersonaSummary[]>([]);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [creatingAgentBusy, setCreatingAgentBusy] = useState(false);
  const [newAgentLabel, setNewAgentLabel] = useState("");
  const [newAgentFocus, setNewAgentFocus] = useState("");
  const [newAgentShape, setNewAgentShape] = useState<ShapeId>("arch");
  const [newAgentTheme, setNewAgentTheme] = useState<ThemeId>("violet");
  const [newAgentTools, setNewAgentTools] = useState<Set<string>>(new Set(ALL_TOOL_IDS));
  const [newAgentError, setNewAgentError] = useState<string | null>(null);

  const toggleNewAgentTool = (toolId: string) => {
    setNewAgentTools((current) => {
      const next = new Set(current);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  };

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/agents");
        const data = (await response.json()) as { personas?: CustomPersonaSummary[] };
        if (Array.isArray(data.personas)) setCustomPersonas(data.personas);
      } catch { /* not fatal — the picker just shows the built-in roster */ }
    })();
  }, []);

  // Built-in presets carry an i18n labelKey; a workspace-created persona
  // carries its own literal label (typed by the user, not translatable) —
  // this is the one place both are normalized to the same shape/theme/text.
  const personaDisplay = (id: string): { shape: ShapeId; theme: ThemeId; label: string; icon?: string } => {
    const builtIn = PERSONA_PRESETS[id as PersonaId];
    if (builtIn) return { shape: builtIn.shape, theme: builtIn.theme, label: t(builtIn.labelKey), icon: builtIn.icon };
    const custom = customPersonas.find((persona) => persona.id === id);
    if (custom) return { shape: custom.shape, theme: custom.theme, label: custom.label };
    return { shape: PERSONA_PRESETS.general.shape, theme: PERSONA_PRESETS.general.theme, label: t(PERSONA_PRESETS.general.labelKey), icon: PERSONA_PRESETS.general.icon };
  };
  const activePersona = personaDisplay(personaId);
  const progressText = progress.phase === 'checking' ? t('ChatPanel.checking') : progress.tool
    ? t(progress.phase === 'tool' ? 'ChatPanel.usingTool' : 'ChatPanel.reviewingTool', { source: readableToolName(progress.tool) })
    : t('ChatPanel.thinkingAbout', { topic: Array.from(workingQuestion.replace(/\s+/g, ' ').trim()).slice(0, 90).join('') + (Array.from(workingQuestion).length > 90 ? '…' : '') });



  const createAgent = async (event: FormEvent) => {
    event.preventDefault();
    const label = newAgentLabel.trim();
    const focusDescription = newAgentFocus.trim();
    if (!label || !focusDescription || newAgentTools.size === 0 || creatingAgentBusy) return;
    setNewAgentError(null);
    setCreatingAgentBusy(true);
    try {
      // Sending `null` (every tool) rather than the full list when nothing's
      // been unchecked keeps a freshly-created agent's behavior identical
      // to before this picker existed, instead of quietly re-deriving "all
      // tools" as an explicit list that could drift from ALL_TOOL_IDS later.
      const toolNames = newAgentTools.size === ALL_TOOL_IDS.length ? null : [...newAgentTools];
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, focusDescription, shape: newAgentShape, theme: newAgentTheme, toolNames }),
      });
      const data = (await response.json().catch(() => ({}))) as { persona?: CustomPersonaSummary; error?: string };
      if (response.ok && data.persona) {
        setCustomPersonas((current) => [data.persona!, ...current]);
        setPersonaId(data.persona.id);
        setNewAgentLabel("");
        setNewAgentFocus("");
        setNewAgentTools(new Set(ALL_TOOL_IDS));
        setCreatingAgent(false);
        setPickingPersona(false);
      } else {
        setNewAgentError(data.error || t("AvalAssistant.createAgentError"));
      }
    } catch {
      setNewAgentError(t("AvalAssistant.createAgentError"));
    } finally {
      setCreatingAgentBusy(false);
    }
  };

  const deleteAgent = (id: string, event: ReactMouseEvent) => {
    event.stopPropagation();
    setCustomPersonas((current) => current.filter((persona) => persona.id !== id));
    if (personaId === id) setPersonaId("general");
    fetch(`/api/agents/${id}`, { method: "DELETE" }).catch(() => {});
  };
  const [prepared, setPrepared] = useState<Record<number, boolean>>({});
  const [draftPanelOpen, setDraftPanelOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [draftFormat, setDraftFormat] = useState<DraftFormat>("docx");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "assistant",
      text: t("AvalAssistant.welcomeMessage"),
    },
  ]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const selectedElementRef = useRef<HTMLElement | null>(null);
  const nextId = useRef(2);
  const currentContext = useMemo(() => t(viewNameKeys[view] ?? viewNameKeys.overview), [t, view]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 80);
  }, [open, popupRoot]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking, open]);

  useEffect(() => {
    selectedElementRef.current?.classList.remove("aval-ai-module-selected");
    selectedElementRef.current = null;
    queueMicrotask(() => {
      setSelectedModule(null);
      setPickingModule(false);
    });
  }, [view]);

  useEffect(() => {
    if (!open || !pickingModule) return;
    document.documentElement.classList.add("aval-module-picking");
    let hovered: HTMLElement | null = null;

    const findModule = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement) || target.closest(".aval-assistant")) return null;
      return target.closest<HTMLElement>(moduleSelector);
    };
    const hoverModule = (event: PointerEvent) => {
      const next = findModule(event.target);
      if (next === hovered) return;
      hovered?.classList.remove("aval-ai-module-hover");
      hovered = next;
      hovered?.classList.add("aval-ai-module-hover");
    };
    const selectModule = (event: MouseEvent) => {
      const target = findModule(event.target);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const moduleContext = describeModule(target);
      hovered?.classList.remove("aval-ai-module-hover");
      selectedElementRef.current?.classList.remove("aval-ai-module-selected");
      target.classList.add("aval-ai-module-selected");
      selectedElementRef.current = target;
      setSelectedModule(moduleContext);
      setPickingModule(false);
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        text: t("AvalAssistant.moduleSelectedMessage", { module: moduleContext.label }),
      }]);
    };

    document.addEventListener("pointerover", hoverModule, true);
    document.addEventListener("click", selectModule, true);
    return () => {
      document.documentElement.classList.remove("aval-module-picking");
      hovered?.classList.remove("aval-ai-module-hover");
      document.removeEventListener("pointerover", hoverModule, true);
      document.removeEventListener("click", selectModule, true);
    };
  }, [open, pickingModule, t]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (toolsRef.current?.open) { toolsRef.current.open = false; toolsRef.current.querySelector("summary")?.focus(); return; }
      if (pickingModule) {
        setPickingModule(false);
        return;
      }
      popupRoot?.ownerDocument.defaultView?.close();
      setOpen(false);
      selectedElementRef.current?.classList.remove("aval-ai-module-selected");
      selectedElementRef.current = null;
      setSelectedModule(null);
    };
    const chatWindow = popupRoot?.ownerDocument.defaultView ?? window;
    chatWindow.addEventListener("keydown", closeOnEscape);
    return () => chatWindow.removeEventListener("keydown", closeOnEscape);
  }, [pickingModule, popupRoot]);

  // Answers are grounded in authenticated workspace records. Failures are
  // shown explicitly and never replaced with canned analysis.
  const preferences = useOnboarding();
  const [startingTask, setStartingTask] = useState(false);
  const taskStarting = useRef(false);
  const startAgentTask = async () => {
    const goal = input.trim();
    if (!goal || thinking || taskStarting.current || !preferences || preferences.busy) return;
    taskStarting.current = true; setStartingTask(true);
    try {
      const response = await fetch("/api/agents/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal, agentId: personaId }) });
      const data = await response.json() as { taskId?: string; error?: string };
      if (!response.ok || !data.taskId) throw new Error(data.error || t("AvalAssistant.unavailable"));
      setMessages(current => [...current, { id: nextId.current++, role: "user", text: goal }, { id: nextId.current++, role: "assistant", taskId: data.taskId, taskAgentId: personaId, text: t("ChatPanel.taskStartedWith", { agent: activePersona.label }) }]);
      setInput(current => current.trim() === goal ? "" : current);
    } catch (error) {
      setMessages(current => [...current, { id: nextId.current++, role: "assistant", error: error instanceof Error ? error.message : t("AvalAssistant.unavailable") }]);
    } finally { taskStarting.current = false; setStartingTask(false); }
  };

  const submitQuestion = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || thinking || startingTask) return;
    const focusedModule = selectedModule;
    const userMessage: ChatMessage = { id: nextId.current++, role: "user", text: trimmed };
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setWorkingQuestion(trimmed);
    setProgress({ phase: "thinking" });
    setThinking(true);
    try {
      if (desktop.bridge && desktop.state?.active && desktop.state.account?.type === "chatgpt") {
        // The hosted service supplies authenticated, org-scoped facts only.
        // The actual model turn happens in the desktop main process, where
        // credentials and raw App Server RPC are unavailable to this page.
        const contextResponse = await fetch(`/api/assistant/context?view=${encodeURIComponent(view)}`, { cache: "no-store" });
        const dashboardContext = await contextResponse.json().catch(() => ({})) as Record<string, unknown> & { error?: string };
        if (!contextResponse.ok) throw new Error(dashboardContext.error ?? t("AvalAssistant.contextUnavailable"));
        const answer = await desktop.bridge.ask<Answer>({
          conversationId: "ask-aval",
          question: trimmed,
          locale,
          context: {
            ...dashboardContext,
            focusedModule: focusedModule ? { label: focusedModule.label, visibleText: focusedModule.snapshot } : null,
            selectedAgent: activePersona.label,
          },
        });
        if (!isAnswerShaped(answer)) throw new Error(t("AvalAssistant.unavailable"));
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", answer: { ...answer, metrics: answer.metrics ?? [] } }]);
        return;
      }
      const response = await fetch("/api/assistant/ask", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ question: trimmed, view, moduleLabel: focusedModule?.label, moduleSnapshot: focusedModule?.snapshot, locale, personaId }),
      });
      // The endpoint returns the render_answer payload flattened at the top
      // level (plus tools_used), not wrapped in an { answer: ... } envelope.
      const data = await readAskStream(response, setProgress);
      if (!response.ok || !isAnswerShaped(data)) throw new Error(typeof data.error === "string" ? data.error : "The assistant is unavailable right now.");
      const answer = {
        ...data,
        metrics: Array.isArray(data.metrics) ? data.metrics : [],
        tools_used: Array.isArray(data.tools_used) ? data.tools_used.filter((name): name is string => typeof name === "string") : [],
      } as Answer;
      setMessages((current) => [...current, { id: nextId.current++, role: "assistant", answer }]);
    } catch (error) {
      // Previously this substituted a locally generated answer with hardcoded
      // figures, which rendered identically to a real one — a user could not
      // tell an outage from analysis. Now the failure is shown as a failure.
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        error: error instanceof Error ? error.message : t("AvalAssistant.unavailable"),
      }]);
    } finally {
      setThinking(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (intent === "task") void startAgentTask(); else void submitQuestion(input);
  };

  const prepareAction = (message: ChatMessage) => {
    if (!message.answer?.action) return;
    setPrepared((current) => ({ ...current, [message.id]: true }));
    onCreateDraft({
      title: message.answer.action,
      instructions: `Draft the full write-up for this approved action so it is ready to send: "${message.answer.action}". ${message.answer.actionDetail ?? ""} It follows from this finding: ${message.answer.headline}`,
      format: "docx",
      personaId,
    });
    notify(t("AvalAssistant.actionPreparedForReview"), t("AvalAssistant.draftStartedInTasks"));
  };

  const startDraft = (event: FormEvent) => {
    event.preventDefault();
    if (!draftTitle.trim() || !draftInstructions.trim()) return;
    onCreateDraft({
      title: draftTitle.trim(),
      instructions: draftInstructions.trim(),
      format: draftFormat,
      moduleLabel: selectedModule?.label,
      moduleSnapshot: selectedModule?.snapshot,
      personaId,
    });
    setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: t("AvalAssistant.draftStartedMessage", { title: draftTitle.trim() }) }]);
    setDraftTitle(""); setDraftInstructions(""); setDraftFormat("docx"); setDraftPanelOpen(false);
  };

  const clearSelectedModule = () => {
    selectedElementRef.current?.classList.remove("aval-ai-module-selected");
    selectedElementRef.current = null;
    setSelectedModule(null);
    setPickingModule(false);
  };

  const closeAssistant = () => {
    clearSelectedModule();
    panel.reattach(); setOpen(false);
  };

  const toggleAssistant = () => {
    if (popupRoot) { panel.restore(); return; }
    if (open) closeAssistant();
    else { panel.restore(); setOpen(true); }
  };

  const promptSuggestions = selectedModule ? focusedSuggestionKeys : messages.length === 1 ? suggestionKeys : [];

  const panelContent = (
        <section ref={panel.panelRef} className="aval-assistant-panel aval-glass-chat" data-minimized={minimized} data-expanded={expanded} data-docked={panel.docked} data-detached={!!popupRoot} data-dragging={panel.dragging}
          style={!popupRoot && panel.rect ? { left: panel.rect.x, top: panel.rect.y, width: panel.rect.width, height: panel.rect.height, right: 'auto', bottom: 'auto' } : undefined}
          role="dialog" aria-label={t("AvalAssistant.avalAssistant")}>
          {popupRoot && <div className="aval-chat-native-titlebar" title={t('ChatPanel.moveWindow')}><span>{t('AvalAssistant.askAval')}</span></div>}
          {!popupRoot && !minimized && (['n','s','e','w','ne','nw','se','sw'] as ResizeEdge[]).map(edge => <div key={edge} className={`aval-resize-edge edge-${edge}`} aria-hidden="true" onPointerDown={event => panel.begin(event, edge)} {...panel.pointerHandlers}/>)}
          <header className="aval-assistant-header" onPointerDown={event => panel.begin(event)} {...panel.pointerHandlers} title={!popupRoot ? t('ChatPanel.dragHelp') : undefined}>
            <div className="aval-assistant-identity">
              {personaId === "general" ? (
                <span className="aval-assistant-mark" aria-hidden="true" />
              ) : (
                <AvalAgentAvatar personaId={personaId} shape={activePersona.shape} theme={activePersona.theme} icon={activePersona.icon} size={38} label={activePersona.label} />
              )}
              <span><strong>{t("AvalAssistant.askAval")}</strong><small><i />{t("ChatPanel.connected")}</small></span>
            </div>
            <div className="aval-window-controls">
              {!popupRoot && <><button type="button" className="icon-button" onClick={panel.toggleDock} aria-label={t(panel.docked ? 'ChatPanel.undock' : 'ChatPanel.dock')} title={t(panel.docked ? 'ChatPanel.undock' : 'ChatPanel.dock')}>{panel.docked ? <PanelRightOpen size={17}/> : <PanelRightClose size={17}/>}</button>
              <button type="button" className="icon-button" onClick={panel.toggleMinimized} aria-label={t(minimized ? 'ChatPolish.restore' : 'ChatPolish.minimize')}>{minimized ? <ScaleFrameEnlarge width={17} height={17}/> : <Minus width={17} height={17}/>}</button>
              <button type="button" className="icon-button" onClick={panel.toggleExpanded} aria-label={t(expanded ? 'ChatPolish.compact' : 'ChatPolish.expand')}>{expanded ? <ScaleFrameReduce width={17} height={17}/> : <ScaleFrameEnlarge width={17} height={17}/>}</button></>}
              <button type="button" className="icon-button" onClick={() => popupRoot ? panel.reattach() : panel.detach()} aria-label={t(popupRoot ? 'ChatPanel.reattach' : 'ChatPanel.detach')} title={t(popupRoot ? 'ChatPanel.reattach' : 'ChatPanel.detach')}>{popupRoot ? <ArrowDownLeft size={17}/> : <ExternalLink size={17}/>}</button>
              <button className="aval-assistant-close" type="button" onClick={closeAssistant} aria-label={t("AvalAssistant.closeAssistant")}><Xmark width={19} height={19}/></button>
            </div>
          </header>

          <div className="aval-assistant-context">
            <Foldout className="aval-chat-settings" summary={`${t(`Onboarding.options.${autonomyMode(preferences?.state.preferences.autonomy[0])}`)} · ${currentContext}`}>
              <IndependenceControls compact/>
              <span className="aval-chat-scope"><Database width={15} height={15}/>{currentContext} · {t("ChatPolish.workspace")}</span>
            </Foldout>
            {pickingModule && <p className="aval-module-picker-instruction"><span />{t("AvalAssistant.hoverOverADashboardModuleThen")}</p>}
            {pickingPersona && (
              <div className="aval-agent-picker">
                {PERSONA_IDS.map((id) => {
                  const preset = PERSONA_PRESETS[id];
                  return (
                    <button key={id} type="button" className="aval-agent-picker-item" aria-pressed={personaId === id} onClick={() => { setPersonaId(id); setPickingPersona(false); }}>
                      <AvalAgentAvatar personaId={id} shape={preset.shape} theme={preset.theme} icon={preset.icon} size={40} selected={personaId === id} interactive />
                      <span>{t(preset.labelKey)}</span>
                    </button>
                  );
                })}
                {customPersonas.map((persona) => (
                  <div key={persona.id} className="aval-agent-picker-item">
                    <button type="button" className="aval-agent-picker-item-select" aria-pressed={personaId === persona.id} onClick={() => { setPersonaId(persona.id); setPickingPersona(false); }}>
                      <AvalAgentAvatar personaId={persona.id} shape={persona.shape} theme={persona.theme} size={40} selected={personaId === persona.id} interactive />
                      <span>{persona.label}</span>
                    </button>
                    <button type="button" className="aval-agent-picker-item-delete" aria-label={t("AvalAssistant.deleteAgent")} onClick={(event) => deleteAgent(persona.id, event)}>
                      <Xmark width={9} height={9} />
                    </button>
                  </div>
                ))}
                <button type="button" className="aval-agent-picker-create" aria-label={t("AvalAssistant.newAgent")} onClick={() => setCreatingAgent((current) => !current)}>+</button>
              </div>
            )}
            {pickingPersona && creatingAgent && (
              <form className="aval-draft-panel" onSubmit={createAgent}>
                <input value={newAgentLabel} onChange={(event) => setNewAgentLabel(event.target.value)} placeholder={t("AvalAssistant.newAgentNamePlaceholder")} autoFocus />
                <textarea value={newAgentFocus} onChange={(event) => setNewAgentFocus(event.target.value)} placeholder={t("AvalAssistant.newAgentFocusPlaceholder")} />
                <div className="aval-agent-swatch-row">
                  {SHAPE_IDS.map((shape) => (
                    <button key={shape} type="button" className={shape === newAgentShape ? "selected" : ""} onClick={() => setNewAgentShape(shape)}>
                      <AvalAgentAvatar shape={shape} theme={newAgentTheme} size={28} />
                    </button>
                  ))}
                </div>
                <div className="aval-agent-swatch-row">
                  {THEME_IDS.map((theme) => (
                    <button key={theme} type="button" className={theme === newAgentTheme ? "selected" : ""} onClick={() => setNewAgentTheme(theme)}>
                      <AvalAgentAvatar shape={newAgentShape} theme={theme} size={28} />
                    </button>
                  ))}
                </div>
                <p className="aval-agent-tools-label">{t("AvalAssistant.agentTools")}</p>
                <div className="aval-agent-tools-list">
                  {TOOL_OPTIONS.map((tool) => (
                    <label key={tool.id}>
                      <input type="checkbox" checked={newAgentTools.has(tool.id)} onChange={() => toggleNewAgentTool(tool.id)} />
                      {t(tool.labelKey)}
                    </label>
                  ))}
                </div>
                {newAgentError && <p className="aval-agent-create-error">{newAgentError}</p>}
                <div className="aval-draft-panel-row">
                  <button type="submit" className="primary-button" disabled={!newAgentLabel.trim() || !newAgentFocus.trim() || newAgentTools.size === 0 || creatingAgentBusy}>
                    <NavArrowRight width={16} height={16} />{t("AvalAssistant.createAgent")}
                  </button>
                </div>
              </form>
            )}
            {selectedModule && (
              <div className="aval-selected-module-context">
                <ViewGrid width={16} height={16} />
                <span><small>{t("AvalAssistant.focusedModule")}</small><strong>{selectedModule.label}</strong></span>
                <button type="button" onClick={clearSelectedModule} aria-label={t("AvalAssistant.clearSelectedModule")}><Xmark width={15} height={15} /></button>
              </div>
            )}
            {draftPanelOpen && (
              <form className="aval-draft-panel" onSubmit={startDraft}>
                <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} placeholder={t("AvalAssistant.draftTitlePlaceholder")} autoFocus />
                <textarea value={draftInstructions} onChange={(event) => setDraftInstructions(event.target.value)} placeholder={t("AvalAssistant.draftInstructionsPlaceholder")} />
                <div className="aval-draft-panel-row">
                  <select value={draftFormat} onChange={(event) => setDraftFormat(event.target.value as DraftFormat)}>
                    <option value="docx">{t("AvalAssistant.formatDocx")}</option>
                    <option value="xlsx">{t("AvalAssistant.formatXlsx")}</option>
                    <option value="pptx">{t("AvalAssistant.formatPptx")}</option>
                  </select>
                  <button type="submit" className="primary-button" disabled={!draftTitle.trim() || !draftInstructions.trim()}>
                    <NavArrowRight width={16} height={16} />{t("AvalAssistant.startDrafting")}
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="aval-assistant-stream" ref={streamRef} aria-live="polite">
            {messages.map((message) => (
              <div className={`aval-chat-message ${message.role}`} key={message.id}>
                {message.text && <p>{message.text}</p>}
                {message.taskId && <><AgentTaskConversation taskId={message.taskId}/><a className="soft-button" href={`/${locale}?view=setup&agent=${encodeURIComponent(message.taskAgentId ?? "general")}`}>{t("Independence.viewTask")}</a></>}
                {message.error && (
                  <div className="aval-chat-error">
                    <WarningTriangle width={16} height={16}/>
                    <div>
                      <strong>{t("AvalAssistant.couldNotAnswer")}</strong>
                      <p>{message.error}</p>
                    </div>
                  </div>
                )}
                {message.answer && (
                  <div className="aval-chat-answer">
                    {message.answer.tools_used && message.answer.tools_used.length > 0 && (
                      <div className="aval-chat-trace">
                        {message.answer.tools_used.map((tool, index) => (
                          <div className="aval-chat-trace-step" key={`${tool}-${index}`}>
                            <span className="aval-chat-trace-rail" aria-hidden="true"><Search width={14} height={14} /></span>
                            <span className="aval-chat-trace-body">
                              <span>{t("AvalAssistant.traceRead", { source: readableToolName(tool) })}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="aval-chat-answer-heading">
                      <StatsUpSquare width={18} height={18} />
                      <strong>{message.answer.headline}</strong>
                      {message.answer.confidence && <span className={`aval-chat-confidence ${message.answer.confidence}`}>{t(`AvalAssistant.confidence${message.answer.confidence[0].toUpperCase()}${message.answer.confidence.slice(1)}`)}</span>}
                    </div>
                    <p>{message.answer.narrative}</p>
                    {message.answer.metrics.length > 0 && (
                      <div className="aval-chat-stats">
                        {message.answer.metrics.map((metric) => <span key={metric.label}><small>{metric.label}</small><strong>{formatMetricValue(metric)}</strong></span>)}
                      </div>
                    )}
                    {message.answer.chart && message.answer.chart.points.length > 0 && <AvalChatChart chart={message.answer.chart} />}
                    {message.answer.document && <div className="aval-chat-document"><MarkdownPreview text={message.answer.document} /></div>}
                    {(message.answer.evidence?.length || message.answer.evidence_ids?.length) ? (
                      <details className="aval-chat-evidence">
                        <summary>{t("AvalAssistant.viewEvidence")}<NavArrowRight width={15} height={15} /></summary>
                        <div>
                          {message.answer.evidence?.map((row) => <span key={row.label}><small>{row.label}</small><strong>{row.value}</strong></span>)}
                          {!message.answer.evidence && message.answer.evidence_ids?.map((id) => <span key={id}><small>{id}</small></span>)}
                        </div>
                        <p><CheckCircle width={14} height={14} />{t("AvalAssistant.calculatedFromTheDashboardSnapshotUpdated")}</p>
                      </details>
                    ) : null}
                    {message.answer.action && (
                      <button className="aval-chat-action" type="button" disabled={prepared[message.id]} onClick={() => prepareAction(message)}>
                        {prepared[message.id] ? <CheckCircle width={17} height={17} /> : <SendDiagonal width={17} height={17} />}
                        <span><strong>{prepared[message.id] ? t("AvalAssistant.preparedForReview") : message.answer.action}</strong><small>{message.answer.actionDetail ?? message.answer.action}</small></span>
                        {!prepared[message.id] && <NavArrowRight width={17} height={17} />}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

          </div>

          {promptSuggestions.length > 0 && (
            <div className="aval-chat-suggestions">
              {promptSuggestions.map((key) => <button type="button" key={key} onClick={() => submitQuestion(t(key))}>{t(key)}<NavArrowRight width={15} height={15} /></button>)}
            </div>
          )}

          {(thinking || startingTask) && <div className="aval-chat-progress" role="status"><i className="aval-chat-thinking-ring" aria-hidden="true"/><span>{startingTask ? t('ChatPanel.startingWith', { agent: activePersona.label }) : progressText}</span></div>}
          <form className="aval-chat-composer" onSubmit={onSubmit}>
            <textarea ref={inputRef} rows={2} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (intent === 'task') void startAgentTask(); else void submitQuestion(input); } }} placeholder={intent === 'task' ? t('ChatPanel.taskPlaceholder', { agent: activePersona.label }) : selectedModule ? t("AvalAssistant.askAboutModulePlaceholder", { module: selectedModule.label }) : t('ChatPanel.placeholder')} aria-label={t("AvalAssistant.askAval")}/>
            <div className="aval-composer-toolbar">
              <details ref={toolsRef} className="aval-tools-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }}>
                <summary aria-label={t('ChatPolish.tools')} title={t('ChatPolish.tools')}><ControlSlider width={17} height={17}/></summary>
                <div className="aval-tools-popover" role="group" aria-label={t('ChatPolish.tools')}>
                  <button type="button" disabled={!!popupRoot} onClick={() => { setPickingModule(true); if (toolsRef.current) toolsRef.current.open = false; }}><ViewGrid width={18} height={18}/><span>{t('AvalAssistant.selectModule')}<small>{t(popupRoot ? 'ChatPanel.moduleInDashboard' : 'ChatPolish.moduleHelp')}</small></span></button>
                  <button type="button" onClick={() => { setDraftPanelOpen(true); if (toolsRef.current) toolsRef.current.open = false; }}><Page width={18} height={18}/><span>{t('AvalAssistant.draftDocument')}<small>{t('ChatPolish.draftHelp')}</small></span></button>
                </div>
              </details>
              <button className="aval-composer-agent" type="button" disabled={thinking || startingTask} onClick={() => setPickingPersona(current => !current)} aria-expanded={pickingPersona} aria-label={t('ChatPanel.agentLabel', { agent: activePersona.label })} title={t('ChatPanel.agentHelp')}>
                <AvalAgentAvatar personaId={personaId} shape={activePersona.shape} theme={activePersona.theme} icon={activePersona.icon} size={20}/><span>{activePersona.label}</span><ChevronDown size={13}/>
              </button>
              {preferences && <label className="aval-composer-intent"><span className="sr-only">{t('ChatPanel.intent')}</span><select value={intent} onChange={event => setIntent(event.target.value as 'chat' | 'task')} disabled={thinking || startingTask}><option value="chat">{t('ChatPanel.chat')}</option><option value="task">{t('ChatPanel.runTask')}</option></select><ChevronDown size={13} aria-hidden="true"/></label>}
              {thinking && desktop.bridge && desktop.state?.active
                ? <button className="aval-composer-send" type="button" onClick={() => void desktop.bridge?.cancelTurn("ask-aval")} aria-label={t("AvalAssistant.cancelAnswer")}><Xmark width={18} height={18}/></button>
                : <button className="aval-composer-send" type="submit" disabled={!input.trim() || thinking || startingTask || (intent === 'task' && preferences?.busy)} aria-label={intent === 'task' ? t('ChatPanel.runWith', { agent: activePersona.label }) : t("AvalAssistant.sendMessage")} title={intent === 'task' ? t('ChatPanel.runWith', { agent: activePersona.label }) : t("AvalAssistant.sendMessage")}><ArrowUp size={18}/></button>}
            </div>
          </form>
          <div className="aval-composer-status"><span>{intent === 'task' ? t('ChatPanel.runWith', { agent: activePersona.label }) : t('ChatPolish.newLine')}</span></div>
        </section>
  );
  return (
    <div className={`aval-assistant ${open ? "is-open" : ""}`}>
      {open && (popupRoot ? createPortal(panelContent, popupRoot) : panelContent)}
      {panel.dragging && panel.dropTarget !== 'float' && <div className={`aval-chat-drop-target ${panel.dropTarget}`} aria-hidden="true">{t(panel.dropTarget === 'dock' ? 'ChatPanel.dropDock' : 'ChatPanel.dropWindow')}</div>}
      <button className="aval-assistant-launcher" data-tour-target="chat" type="button" onClick={toggleAssistant} aria-expanded={open} aria-label={open ? t("AvalAssistant.closeAvalAssistant") : t("AvalAssistant.askAval")}>
        {open ? <Xmark width={22} height={22} /> : <ChatLines width={23} height={23} />}
        {!open && <span aria-hidden="true" />}
      </button>
    </div>
  );
}
