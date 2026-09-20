"use client";

/**
 * The execution trace: what an agent actually did, step by step.
 *
 * This is the surface the agent runtime was built to have (§24 of the
 * production-readiness guide). Before it, the product showed a persona picker
 * — "choose which AI to talk to" — which reads as eight chat wrappers however
 * real the execution underneath. A visible trace is what distinguishes the
 * two, and it costs nothing to show because lib/agents/tasks.ts already
 * persists every step.
 *
 * Three things drive the design:
 *
 * 1. **A denial is the most important row on the page.** The audit's central
 *    finding was that authorization was enforced by the model rather than the
 *    backend (docs/AGENT_ARCHITECTURE_AUDIT.md). Now that a deterministic
 *    policy engine refuses calls, those refusals have to be legible — an
 *    operator should be able to see that an agent asked for something and was
 *    told no. Hiding it would waste the guarantee.
 *
 * 2. **Structure follows the runtime, not the row order.** A reasoning step is
 *    one model call plus every tool call it proposed, so steps group and the
 *    sequence orders within them. Rendering a flat list would lose the thing
 *    that makes a trace readable: which investigation each action belonged to.
 *
 * 3. **Approvals come before tasks.** A parked action is the only thing here
 *    that needs a person, so it sits at the top regardless of how many tasks
 *    are running below it.
 *
 * Polling is observation only. Request-background execution and the Cloudflare
 * cron advance tasks; opening or refreshing this view can never execute a tool
 * or spend a model step.
 */

import { belongsToAgent } from "./agent-library-model";
import { MarkdownPreview } from "./markdown-preview";
import { AgentApprovalPrompt } from "./agent-approval-prompt";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Check,
  WarningTriangle,
  Lock,
  Clock,
  Sparks,
  Database,
  Cpu,
  Play,
  Prohibition,
  NavArrowDown,
  NavArrowRight,
} from "iconoir-react";
import { AvalAgentAvatar } from "@/app/components/agent-avatar/AgentAvatar";
import { PERSONA_PRESETS, DATA_SOURCE_NODES, type PersonaId } from "@/app/components/agent-avatar/personas";
import { formatDuration, groupBySteps, toneFor, type RowTone } from "@/lib/agents/trace-view";

/* ── shapes returned by app/api/agents/* ──────────────────────────────────── */

interface TaskSummary {
  employeeId?: string | null;
  id: string;
  agentId: string;
  goal: string;
  status: string;
  steps: { used: number; max: number };
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
}

interface TraceEntry {
  sequence: number;
  step: number;
  kind: string;
  modelProvider: string | null;
  modelName: string | null;
  tool: string | null;
  policy: string | null;
  denyCode: string | null;
  risk: string | null;
  attempt: number;
  durationMs: number | null;
  error: string | null;
  at: number;
}

interface TaskDetail extends TaskSummary {
  tokens: { used: number; max: number };
  delegationDepth: number;
  parentTaskId: string | null;
  result: { headline?: string; narrative?: string; document?: string } | null;
  trace: TraceEntry[];
  plan?: { revision: number; nodes: { id: string; key: string; goal: string; status: string; dependencies: string; error: string | null }[] } | null;
  checks?: { step: number; exitCode: number; output: { problems?: string[]; scope?: string } | null }[];
}

interface PendingApproval {
  id: string;
  taskId: string;
  tool: string;
  risk: string;
  tier: string;
  amountCents: number | null;
  currency: string | null;
  evidence: { goal?: string; agent?: string; reason?: string; arguments?: Record<string, unknown>; review?: Record<string, unknown> };
  requestedAt: number;
  expiresAt: number;
  requiredApprovals: number;
  approvalsReceived: number;
}

/** Terminal states, mirroring TERMINAL_STATES in lib/agents/task-state.ts. A task in one of these never changes again, so it is never polled. */
const SETTLED = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** Tool name → the same readable label the Setup diagram uses, so a tool is named identically wherever it appears. */
const TOOL_LABEL_KEYS = new Map(DATA_SOURCE_NODES.map((node) => [node.tool, node.labelKey]));

/**
 * Translates a server enum (a status, risk class, or event kind) through a
 * namespaced key, falling back to the raw value when a translation has not
 * landed yet.
 *
 * The sets are closed and enumerated in messages/en.json, so the fallback is
 * not the normal path — it exists so that adding a state to
 * lib/agents/task-state.ts or an event kind to lib/audit/chain.ts degrades to
 * a readable token instead of throwing inside a render.
 */
function useEnumLabel() {
  const t = useTranslations();
  return (prefix: string, value: string) => {
    const key = `AgentTrace.${prefix}_${value}`;
    return t.has(key) ? t(key) : value.replaceAll("_", " ").toLowerCase();
  };
}

function personaFor(agentId: string) {
  return PERSONA_PRESETS[agentId as PersonaId] ?? PERSONA_PRESETS.general;
}

function formatMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);
}

/* ── one trace row ────────────────────────────────────────────────────────── */

/** Icon per tone. The classification itself is in lib/agents/trace-view.ts, where it is tested. */
const TONE_ICONS: Record<RowTone, typeof Check> = {
  denied: Prohibition,
  held: Lock,
  decided: Check,
  failed: WarningTriangle,
  retried: Clock,
  thought: Cpu,
  reserved: Lock,
  read: Database,
};

function TraceRow({ entry }: { entry: TraceEntry }) {
  const t = useTranslations();
  const label = useEnumLabel();
  const tone = toneFor(entry);
  const Icon = TONE_ICONS[tone];
  const duration = formatDuration(entry.durationMs);
  const labelKey = entry.tool ? TOOL_LABEL_KEYS.get(entry.tool) : undefined;

  const title = entry.kind === "model_call"
    ? t("AgentTrace.kindModelCall")
    : labelKey
      ? t(labelKey)
      : entry.tool ?? label("kind", entry.kind);

  return (
    <li className="agent-trace-row" data-tone={tone}>
      <span className="agent-trace-icon"><Icon width={13} height={13}/></span>
      <span className="agent-trace-body">
        <span className="agent-trace-title">
          {title}
          {/* Shown only above `low` — a risk marker on every row would flatten
              the one distinction it exists to draw. */}
          {entry.risk && entry.risk !== "low" && <b className={`agent-risk-tag risk-${entry.risk}`}>{label("risk", entry.risk)}</b>}
          {entry.attempt > 1 && <b className="agent-attempt-tag">{t("AgentTrace.attemptN", { n: entry.attempt })}</b>}
        </span>
        {/* The deny code is the machine-readable reason the policy engine
            refused. Surfaced verbatim: an operator debugging why an agent
            couldn't answer needs the actual cause, not a euphemism. */}
        {entry.denyCode && <code className="agent-trace-code">{entry.denyCode}</code>}
        {entry.error && <span className="agent-trace-error">{entry.error}</span>}
      </span>
      {duration && <span className="agent-trace-duration">{duration}</span>}
    </li>
  );
}

/** Trace rows grouped by the reasoning step that produced them. */
function TraceSteps({ trace }: { trace: TraceEntry[] }) {
  const t = useTranslations();
  const groups = useMemo(() => groupBySteps(trace), [trace]);

  if (groups.length === 0) return <p className="agent-trace-empty">{t("AgentTrace.noStepsYet")}</p>;

  return (
    <div className="agent-trace-steps">
      {groups.map(([step, entries]) => (
        <div className="agent-trace-step" key={step}>
          <span className="agent-trace-step-label">{t("AgentTrace.stepN", { n: step + 1 })}</span>
          <ul className="agent-trace-list">
            {entries.map((entry) => <TraceRow entry={entry} key={entry.sequence}/>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ── approvals ────────────────────────────────────────────────────────────── */

function ApprovalCard({ approval, busy, onDecide, locale }: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (id: string, decision: "approved" | "rejected") => void;
  locale: string;
}) {
  const t = useTranslations();
  const label = useEnumLabel();
  const persona = personaFor(approval.evidence.agent ?? "general");

  return (
    <article className="agent-approval-card" data-risk={approval.risk}>
      <div className="agent-approval-top">
        <AvalAgentAvatar personaId={approval.evidence.agent ?? "general"} shape={persona.shape} theme={persona.theme} icon={persona.icon} size={28}/>
        <div className="agent-approval-head">
          <strong>{approval.tool}</strong>
          <span>{t("AgentTrace.proposedBy", { agent: t(persona.labelKey) })}</span>
        </div>
        <span className={`agent-risk-tag risk-${approval.risk}`}>{label("risk", approval.risk)}</span>
      </div>

      {approval.amountCents !== null && approval.currency && (
        <p className="agent-approval-amount">{formatMoney(approval.amountCents, approval.currency, locale)}</p>
      )}
      {approval.evidence.reason && <p className="agent-approval-reason">{approval.evidence.reason}</p>}
      {approval.evidence.goal && (
        <p className="agent-approval-goal"><span>{t("AgentTrace.forGoal")}</span>{approval.evidence.goal}</p>
      )}

      <AgentApprovalPrompt tool={approval.tool} review={approval.evidence.review ?? approval.evidence.arguments ?? {}} disabled={busy} onDecision={decision => onDecide(approval.id,decision)}/>
      {approval.requiredApprovals > 1 && (
        <p className="agent-approval-note">{t("AgentTrace.approvalProgress", { received: approval.approvalsReceived, required: approval.requiredApprovals })}</p>
      )}
      <p className="agent-approval-note">{t("AgentTrace.approvalNote")}</p>
    </article>
  );
}

/* ── one task ─────────────────────────────────────────────────────────────── */

function TaskCard({ task, detail, expanded, busy, onToggle, onCancel }: {
  task: TaskSummary;
  detail: TaskDetail | null;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const label = useEnumLabel();
  const persona = personaFor(task.agentId);
  const live = !SETTLED.has(task.status);
  const progress = task.steps.max > 0 ? Math.min(100, (task.steps.used / task.steps.max) * 100) : 0;
  const Chevron = expanded ? NavArrowDown : NavArrowRight;

  return (
    <article className="agent-task-card" data-status={task.status.toLowerCase()}>
      <button type="button" className="agent-task-summary" onClick={onToggle} aria-expanded={expanded}>
        <Chevron className="agent-task-chevron" width={15} height={15}/>
        <AvalAgentAvatar personaId={task.agentId} shape={persona.shape} theme={persona.theme} icon={persona.icon} size={30}/>
        <span className="agent-task-headline">
          <strong>{task.goal}</strong>
          <span>{t(persona.labelKey)}</span>
        </span>
        <span className="agent-task-steps">{t("AgentTrace.stepsOf", { used: task.steps.used, max: task.steps.max })}</span>
        <span className={`agent-status-pill status-${task.status.toLowerCase()}`}>
          {/* A running task gets a moving dot as well as a word: state should
              read at a glance without parsing text. */}
          {live && task.status === "RUNNING" && <i className="agent-status-dot"/>}
          {label("status", task.status)}
        </span>
      </button>

      <div className="agent-task-progress" role="presentation">
        <span className="agent-task-progress-bar" style={{ width: `${progress}%` }}/>
      </div>

      {expanded && (
        <div className="agent-task-detail">
          {detail ? (
            <>
              <details className="execution-disclosure"><summary>{t("AgentLibrary.executionDetails")}</summary>
              {detail.plan?.nodes.length ? <section className="agent-task-result">
                <p className="eyebrow">{t("AgentTrace.goalPlan", { revision: detail.plan.revision })}</p>
                <ol className="agent-plan-nodes">{detail.plan.nodes.map(node => <li key={node.id}>
                  <strong>{node.goal}</strong><span>{label("status", node.status)}</span>
                  {node.dependencies !== "[]" && <small>{t("AgentTrace.dependsOn", { keys: (JSON.parse(node.dependencies) as string[]).join(", ") })}</small>}
                  {node.error && <p className="agent-task-failure">{node.error}</p>}
                </li>)}</ol>
              </section> : null}
              <TraceSteps trace={detail.trace}/>
              {!!detail.checks?.length && <section className="agent-task-result">
                <p className="eyebrow">{t("AgentTrace.completionChecks")}</p>
                {detail.checks.map((check, index) => <div key={index} className={check.exitCode ? "agent-task-failure" : "agent-check-passed"}>
                  <strong>{t(check.exitCode ? "AgentTrace.checkFailed" : "AgentTrace.checkPassed", { step: check.step + 1 })}</strong>
                  {check.output?.problems?.map(problem => <p key={problem}>{problem}</p>)}
                </div>)}
                <small>{t("AgentTrace.checkScope")}</small>
              </section>}

              </details>
              {(detail.result?.headline || detail.result?.narrative || detail.result?.document) && (
                <div className="agent-task-result">
                  <p className="eyebrow">{t("AgentTrace.conclusion")}</p>
                  <strong>{detail.result.headline}</strong>
                  {detail.result.narrative && <p>{detail.result.narrative}</p>}
                  {detail.result.document && <div className="library-document-output"><MarkdownPreview text={detail.result.document}/><a className="soft-button" download={`aval-${task.id}.md`} href={`data:text/markdown;charset=utf-8,${encodeURIComponent(detail.result.document)}`}>{t("AgentLibrary.downloadDocument")}</a></div>}
                </div>
              )}
              {/* A withheld or failed run is reported, not hidden. The
                  faithfulness gate refusing to state an unverified figure is
                  the system working correctly, and an operator should see it. */}
              {detail.error && (
                <p className="agent-task-failure"><WarningTriangle width={14} height={14}/>{detail.error}</p>
              )}

              <div className="agent-task-meta">
                <span>{t("AgentTrace.tokensUsed", { used: detail.tokens.used.toLocaleString(), max: detail.tokens.max.toLocaleString() })}</span>
                {detail.delegationDepth > 0 && <span>{t("AgentTrace.delegatedDepth", { depth: detail.delegationDepth })}</span>}
                {live && (
                  <button type="button" className="agent-task-cancel" disabled={busy} onClick={onCancel}>
                    {t("AgentTrace.cancelTask")}
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="agent-trace-empty">{t("AgentTrace.loadingTrace")}</p>
          )}
        </div>
      )}
    </article>
  );
}

/* ── the section ──────────────────────────────────────────────────────────── */

export function AgentTrace({ agentFilter, employeeFilter = false, agentLabel }: { agentFilter?: string; employeeFilter?: boolean; agentLabel?: string } = {}) {
  const t = useTranslations();
  // Read here rather than threaded through TasksView, which has no other use
  // for it — only the approval card's currency formatting needs a locale.
  const locale = useLocale();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [details, setDetails] = useState<Record<string, TaskDetail>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [agentId, setAgentId] = useState<string>(agentFilter ?? "general");
  const [recommendation, setRecommendation] = useState<{agentId:string;mode:string;goal:string}|null>(null);
  const suggestion = goal.trim() && recommendation?.goal === goal ? recommendation : null;
  useEffect(() => {
    if (!goal.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { fetch(`/api/agents/recommendations?goal=${encodeURIComponent(goal)}`, {signal:controller.signal}).then(r=>r.ok?r.json() as Promise<{agentId:string;mode:string}>:null).then(data=>{if(data && !controller.signal.aborted)setRecommendation({...data,goal});}).catch(()=>{}); },250);
    return () => {clearTimeout(timer);controller.abort();};
  },[goal]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Mirrored into a ref so the polling effect can read whichever task is open
  // without tearing down and restarting its interval every time the user
  // expands a different row. Synced in an effect rather than during render,
  // since a render must stay free of side effects.
  const expandedRef = useRef<string | null>(null);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  // False once the component unmounts, so a response that lands afterwards is
  // dropped instead of writing to state that no longer exists.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const loadTasks = useCallback(async (signal?: AbortSignal) => {
    const [taskResponse, approvalResponse] = await Promise.all([
      fetch("/api/agents/tasks", { signal }).then((response) => response.ok ? response.json() : null).catch(() => null),
      fetch("/api/agents/approvals", { signal }).then((response) => response.ok ? response.json() : null).catch(() => null),
    ]);
    if (!mounted.current || signal?.aborted) return;
    if (!taskResponse || !approvalResponse) { setNotice(t("AgentLibrary.workUnavailable")); return; }
    const allTasks = (taskResponse as { tasks?: TaskSummary[] }).tasks ?? [];
    const visibleTasks = agentFilter ? allTasks.filter(task => belongsToAgent(task, agentFilter, employeeFilter)) : allTasks;
    setTasks(visibleTasks);
    setApprovals(((approvalResponse as { approvals?: PendingApproval[] }).approvals ?? []).filter(approval => !agentFilter || visibleTasks.some(task => task.id === approval.taskId)));
    setLoaded(true);
  }, [agentFilter, employeeFilter, t]);

  /** Reads one task's detail. The endpoint is side-effect free. */
  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/agents/tasks/${id}`, { signal }).catch(() => null);
    if (!response?.ok) { if (!signal?.aborted) setNotice(t("AgentLibrary.workUnavailable")); return null; }
    const detail = (await response.json().catch(() => null)) as TaskDetail | null;
    if (!mounted.current || signal?.aborted) return null;
    if (detail?.id) setDetails((current) => ({ ...current, [id]: detail }));
    return detail;
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void loadTasks(controller.signal); });
    return () => controller.abort();
  }, [loadTasks]);

  // Polling observes worker-owned execution. It runs only while something is
  // live, so an idle workspace makes no requests at all.
  const hasLive = tasks.some((task) => !SETTLED.has(task.status));
  useEffect(() => {
    if (!hasLive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    // Schedule after completion rather than with setInterval so slow reads do
    // not accumulate overlapping requests.
    const poll = async () => {
      await loadTasks(controller.signal);
      const open = expandedRef.current;
      if (open) await loadDetail(open, controller.signal);
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [hasLive, loadDetail, loadTasks]);

  const toggle = async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!details[id]) await loadDetail(id);
  };

  const start = async () => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/agents/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: trimmed, agentId }),
      });
      const data = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || data.error) { setNotice(data.error ?? t("AgentTrace.startFailed")); return; }
      setGoal("");
      if (data.id) { setExpanded(data.id); await loadDetail(data.id); }
      await loadTasks();
    } catch { setNotice(t("AgentTrace.startFailed")); } finally {
      setBusy(false);
    }
  };

  const decide = async (approvalId: string, decision: "approved" | "rejected") => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/agents/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId, decision }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok || data.error) { setNotice(data.error ?? t("AgentTrace.decisionFailed")); return; }
      const open = expandedRef.current;
      if (open) await loadDetail(open);
      await loadTasks();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/agents/tasks/${id}`, { method: "DELETE" });
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      if (data.message) setNotice(data.message);
      await Promise.all([loadDetail(id), loadTasks()]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ask-aval-tasks agent-trace-card" data-reveal>
      <div className="ask-aval-tasks-heading">
        <div>
          <h2>{t(agentFilter ? "AgentLibrary.outputs" : "AgentTrace.title")}</h2>
          <p>{t(agentFilter ? "AgentLibrary.outputsSubtitle" : "AgentTrace.subtitle")}</p>
        </div>
      </div>

      {/* Approvals first: a parked action is the only thing here that needs a
          person, so it outranks however many tasks are running below it. */}
      {approvals.length > 0 && (
        <div className="agent-approvals">
          <p className="eyebrow"><Lock width={12} height={12}/>{t("AgentTrace.awaitingApproval", { count: approvals.length })}</p>
          <div className="agent-approval-grid">
            {approvals.map((approval) => (
              <ApprovalCard approval={approval} busy={busy} onDecide={decide} locale={locale} key={approval.id}/>
            ))}
          </div>
        </div>
      )}

      {!employeeFilter && <div className="agent-goal-form">
        <label className="agent-goal-field">
          <Sparks width={16} height={16}/>
          <input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void start(); }}
            placeholder={t("AgentTrace.goalPlaceholder")}
            maxLength={1200}
          />
        </label>
        {!agentFilter && <select value={agentId} onChange={(event) => setAgentId(event.target.value)} aria-label={t("AgentTrace.agentLabel")}>
          {Object.values(PERSONA_PRESETS).map((preset) => (
            <option value={preset.id} key={preset.id}>{t(preset.labelKey)}</option>
          ))}
        </select>}
        {agentFilter && <span className="library-agent-label">{agentLabel}</span>}
        <button type="button" className="primary-button" onClick={start} disabled={busy || !goal.trim()}>
          <Play width={15} height={15}/>{t("AgentTrace.runGoal")}
        </button>
      </div>}

      {!agentFilter && suggestion && <div className="agent-suggestion"><span>{t("AgentTrace.suggestedAgent", { agent: t(personaFor(suggestion.agentId).labelKey) })}</span><button type="button" className="soft-button" onClick={()=>setAgentId(suggestion.agentId)}>{t("AgentTrace.chooseSuggested")}</button></div>}
      {notice && <div className="agent-trace-notice" role="alert">{notice} <button type="button" className="text-button" onClick={() => { setNotice(null); void loadTasks(); if (expanded) void loadDetail(expanded); }}>{t("SetupView.refresh")}</button></div>}

      {tasks.length === 0 ? (
        <div className="empty-column">{notice ? t("AgentLibrary.workUnavailable") : loaded ? t(agentFilter ? "AgentLibrary.emptyOutputs" : "AgentTrace.empty") : t("AgentTrace.loadingTasks")}</div>
      ) : (
        <div className="agent-task-list">
          {tasks.map((task) => (
            <TaskCard
              task={task}
              detail={details[task.id] ?? null}
              expanded={expanded === task.id}
              busy={busy}
              onToggle={() => toggle(task.id)}
              onCancel={() => cancel(task.id)}
              key={task.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}
