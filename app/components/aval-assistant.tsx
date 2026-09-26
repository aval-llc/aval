"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ChevronDown, ExternalLink, Maximize2, Minimize2, Mic, Square, X, FileText, View, MessageCircle, Briefcase } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useExperience } from './experience';
import { useAppearance } from './appearance-provider';
import { useChatPanel } from './use-chat-panel';
import { DEFAULT_CHAT_TRANSPARENCY } from '@/lib/appearance';
import { useOnboarding } from './preference-context';
import { useDesktopCodex } from './desktop-codex';
import { AgentTaskConversation } from './agent-task-conversation';
import { MarkdownPreview } from './markdown-preview';
import type { CreateDraftInput, DraftFormat } from './ask-aval-tasks';
import { readAskStream, type AskProgress } from '@/lib/ask-aval/progress';
import { joinEarlierTurns, replyTurnId } from '@/lib/ask-aval/chat-turn';
import { autonomyMode, type AutonomyMode } from '@/lib/agents/autonomy';
import { visualActivity, settledRun, type VisualActivity, type SafeStep } from '@/lib/ask-aval/visual-activity';
import { AvalThinkingOrb, AvalComposerEffects, AvalLiquidActions, AvalGreeting } from './agent-ui/effects';
import { AvalActivityTrace } from './agent-ui/activity';
import { useAvalVoice } from './agent-ui/use-voice';

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
  id: string;
  startedAt?: number;
  finishedAt?: number;
  activity?: SafeStep[];
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


type Employee = { id: string; name: string; role: string; autonomyMode: AutonomyMode };
export function AvalAssistant({ view, onCreateDraft }: { view: string; onCreateDraft: (input: CreateDraftInput) => void }) {
  const t = useTranslations(); const m = useTranslations('MinimalChat'); const locale = useLocale();
  const { notify, theme } = useExperience(); const { appearance } = useAppearance();
  const desktop = useDesktopCodex(); const preferences = useOnboarding();
  const panel = useChatPanel(() => notify(t('ChatPanel.popupBlocked'), t('ChatPanel.popupHelp')), appearance.chatWindowBackground ?? 'white', theme, appearance.chatWindowTransparency);
  const { popupRoot, expanded, panelRef } = panel;
  const [open, setOpen] = useState(true);
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [restored, setRestored] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const retryTurn = useRef<{ id: string; text: string } | null>(null);
  const [intent, setIntent] = useState<'task' | 'chat'>('task');
  const [progress, setProgress] = useState<AskProgress>({ phase: 'thinking' });
  const [activeSteps, setActiveSteps] = useState<SafeStep[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [taskStates, setTaskStates] = useState<Record<string, { activity: VisualActivity; status: string }>>({});
  const [unread, setUnread] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [picker, setPicker] = useState(false);
  const [employeeError, setEmployeeError] = useState('');
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState('');
  const [draft, setDraft] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftFormat, setDraftFormat] = useState<DraftFormat>('docx');
  const [module, setModule] = useState<SelectedModule | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const followScroll = useRef(true);
  const openRef = useRef(open); useEffect(() => { openRef.current = open; }, [open]);
  // Whatever was already typed when dictation began, captured once at the
  // start. The recognizer sends the whole utterance so far on every update, so
  // each one replaces the last rather than appending — otherwise speaking a
  // sentence would leave every half-heard draft of it in the box. Keeping the
  // base separate is what preserves words the person typed themselves.
  const dictationBase = useRef('');
  const voice = useAvalVoice(text => {
    setInput([dictationBase.current, text].filter(Boolean).join(' '));
    inputRef.current?.focus();
  });
  const voiceRef = useRef(voice); useEffect(() => { voiceRef.current = voice; }, [voice]);
  const activeEmployee = employees.find(e => e.id === employeeId);
  const actorName = activeEmployee?.name ?? t('AvalAssistant.askAval');
  const mode = activeEmployee?.autonomyMode ?? autonomyMode(preferences?.state.preferences.autonomy[0]);
  const currentContext = useMemo(() => t(viewNameKeys[view] ?? viewNameKeys.overview), [t, view]);
  const activeTask = Object.values(taskStates).find(s => !settledRun(s.status));
  const activity = voice.state === 'idle' && !busy && activeTask ? activeTask.activity : visualActivity({ voice: voice.state, busy, progress });
  const working = busy || !!activeTask && activeTask.activity !== 'idle';
  const hasVoice = voice.state === 'live' || voice.state === 'requesting' || voice.processing;
  const onTaskActivity = useCallback((id: string, activity: VisualActivity, status: string) => {
    setTaskStates(current => {
      if (current[id]?.status === status && current[id]?.activity === activity) return current;
      if (!openRef.current && current[id] && !settledRun(current[id].status) && settledRun(status)) setUnread(true);
      return { ...current, [id]: { activity, status } };
    });
  }, []);
  /**
   * Bring an earlier conversation back, when it is asked for.
   *
   * The panel no longer replays one on open. What was dispatched from here is
   * filed with the agent that ran it and is read there; what stayed in the
   * panel was a copy of it, and a copy of a turn that has already settled —
   * an answer given days ago, a question that could not be answered at all —
   * was occupying a window that is now deliberately small. Nothing is
   * discarded: the record is append only and still whole, one press away.
   * What changed is that the chat opens on the next question rather than on
   * the last one.
   */
  const loadHistory = useCallback(async (cursor?: string) => {
    try {
      const response = await fetch('/api/assistant/history' + (cursor ? '?before=' + encodeURIComponent(cursor) : ''), { cache: 'no-store' });
      if (!response.ok) throw Error(m('historyError'));
      const data = await response.json() as { messages: ChatMessage[]; before: string | null };
      setMessages(current => joinEarlierTurns(data.messages, current));
      setBefore(data.before); setHistoryError(''); setRestored(true);
    } catch { setHistoryError(m('historyError')); }
  }, [m]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/agents/employees?status=active&limit=100&search=' + encodeURIComponent(employeeSearch), { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw Error();
        const data = await response.json() as { employees: Employee[] };
        setEmployees(current => [...new Map([...current.filter(e => e.id === employeeId), ...data.employees].map(e => [e.id, e])).values()]); setEmployeeError('');
      } catch { if (!controller.signal.aborted) setEmployeeError(m('employeeError')); }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [employeeSearch, employeeId, picker, m]);
  useEffect(() => {
    if (open) { inputRef.current?.focus(); const timer = setTimeout(() => setUnread(false), 0); return () => clearTimeout(timer); }
  }, [open, popupRoot]);
  useEffect(() => {
    const element = inputRef.current; if (element) { element.style.height = 'auto'; element.style.height = Math.min(element.scrollHeight, 160) + 'px'; }
  }, [input, open]);
  useEffect(() => {
    if (followScroll.current && open) streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'auto' });
  }, [messages, activeSteps, taskStates, open]);
  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent<boolean>).detail) setOpen(true); };
    window.addEventListener('aval:tour:chat', show); return () => window.removeEventListener('aval:tour:chat', show);
  }, []);
  const close = () => { voiceRef.current.cancel(); setPicker(false); panel.reattach(); setOpen(false); setTimeout(() => launcherRef.current?.focus(), 0); };
  const closeRef = useRef(close); useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    const target = popupRoot?.ownerDocument.defaultView ?? window;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (picker) { setPicker(false); inputRef.current?.focus(); }
      else if (draft) setDraft(false);
      else if (open) closeRef.current();
    };
    target.addEventListener('keydown', escape); return () => target.removeEventListener('keydown', escape);
  }, [open, picker, draft, popupRoot]);
  /**
   * Show a message, and file it unless it is a failure.
   *
   * History is append only — a stored entry is never rewritten, which is what
   * stops a client revising the record of what happened. That makes writing a
   * failed attempt a mistake rather than a detail: the row could never be
   * replaced by the answer a retry produced, so every attempt would survive
   * and a reload would bring back a column of "couldn't finish" orbs. A
   * failure is shown while it is true and forgotten when the turn succeeds.
   */
  const append = async (message: ChatMessage, persist = true) => {
    setMessages(current => [...current.filter(row => row.id !== message.id), message]);
    if (!persist) return;
    const response = await fetch('/api/assistant/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
    if (!response.ok) { setHistoryError(m('saveError')); throw Error(m('saveError')); }
  };
  const setMode = async (next: AutonomyMode) => {
    if (modeBusy) return;
    if (!employeeId) { await preferences?.setMode(next); return; }
    setModeBusy(true); setModeError('');
    try {
      const response = await fetch('/api/agents/employees/' + encodeURIComponent(employeeId), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autonomyMode: next }) });
      if (!response.ok) throw Error(m('modeError'));
      const data = await response.json() as { employee: Employee };
      setEmployees(current => current.map(e => e.id === employeeId ? data.employee : e));
    } catch { setModeError(m('modeError')); } finally { setModeBusy(false); }
  };
  const submit = async (question = input) => {
    const text = question.trim();
    if (!text || submitting.current || hasVoice || modeBusy || preferences?.busy) return;
    submitting.current = true; setBusy(true); followScroll.current = true;
    const start = Date.now(); setStartedAt(start); setProgress({ phase: 'thinking' }); setActiveSteps([]);
    const steps: SafeStep[] = [];
    const user: ChatMessage = { id: retryTurn.current?.text === text ? retryTurn.current.id : crypto.randomUUID(), role: 'user', text };
    retryTurn.current = { id: user.id, text };
    // One turn, one reply — whatever it took to get there. See `chat-turn.ts`
    // for why the id is derived from the question and why its exact shape is
    // not this file's to choose.
    const replyId = replyTurnId(user.id);
    try {
      await append(user); setInput('');
      if (intent === 'task' || employeeId) {
        const response = await fetch('/api/agents/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: text, agentId: 'general', ...(employeeId ? { employeeId } : {}), chatMessageId: user.id, context: { view, moduleLabel: module?.label, moduleSnapshot: module?.snapshot } }) });
        const result = await response.json() as { taskId?: string };
        if (!response.ok || !result.taskId) throw Error(m('requestFailed'));
        // The server commits this link with the task so refresh cannot orphan it.
        const answer: ChatMessage = { id: user.id + '-run', role: 'assistant', taskId: result.taskId, taskAgentId: employeeId || 'general' };
        setMessages(current => [...current.filter(row => row.id !== answer.id), answer]);
      } else {
        let answer: Answer;
        if (desktop.bridge && desktop.state?.active && desktop.state.account?.type === 'chatgpt') {
          const response = await fetch('/api/assistant/context?view=' + encodeURIComponent(view), { cache: 'no-store' });
          if (!response.ok) throw Error(m('requestFailed'));
          answer = await desktop.bridge.ask<Answer>({ conversationId: 'ask-aval', question: text, locale, context: { ...await response.json(), focusedModule: module, selectedAgent: t('AvalAssistant.askAval') } });
        } else {
          const response = await fetch('/api/assistant/ask', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ question: text, view, locale, personaId: 'general', chatMessageId: user.id, moduleLabel: module?.label, moduleSnapshot: module?.snapshot }) });
          // Aval One decided this needs specialists: the turn became durable
          // Work, and the chat follows its run exactly as it follows agent work.
          if (response.headers.get('x-aval-work')) {
            const opened = await response.json() as { work?: { taskId: string; taskAgentId: string } };
            if (!opened.work?.taskId) throw Error(m('requestFailed'));
            const run: ChatMessage = { id: user.id + '-run', role: 'assistant', taskId: opened.work.taskId, taskAgentId: opened.work.taskAgentId };
            setMessages(current => [...current.filter(row => row.id !== run.id), run]);
            retryTurn.current = null;
            return;
          }
          const data = await readAskStream(response, event => {
            setProgress(event);
            // Only documented public progress fields enter the activity history.
            steps.push({ id: String(steps.length), kind: event.phase === 'tool' ? 'lookup_started' : event.phase === 'checking' ? 'verification' : 'model_call', tool: event.tool });
            setActiveSteps([...steps]);
          });
          if (!response.ok || !isAnswerShaped(data)) throw Error(m('requestFailed'));
          answer = { ...data, metrics: data.metrics ?? [] } as Answer;
        }
        if (!isAnswerShaped(answer)) throw Error(m('requestFailed'));
        await append({ id: replyId, role: 'assistant', answer: { ...answer, metrics: answer.metrics ?? [] }, activity: steps, startedAt: start, finishedAt: Date.now() });
        if (!openRef.current) setUnread(true);
      }
      retryTurn.current = null;
    } catch {
      setInput(current => current || text);
      await append({ id: replyId, role: 'assistant', error: m('requestFailed'), activity: steps, startedAt: start, finishedAt: Date.now() }, false).catch(() => {});
    } finally { submitting.current = false; setBusy(false); }
  };
  const startDraft = (event: FormEvent) => {
    event.preventDefault(); if (!draftTitle.trim() || !input.trim()) return;
    onCreateDraft({ title: draftTitle.trim(), instructions: input.trim(), format: draftFormat, personaId: 'general', moduleLabel: module?.label, moduleSnapshot: module?.snapshot });
    setDraft(false); setInput(''); setDraftTitle(''); notify(t('AvalAssistant.draftStartedInTasks'));
  };
  // Style and opacity, applied to the module itself rather than only to the
  // detached window. They were already stored and already offered in settings;
  // the inline chat simply never read them, which is why moving the slider
  // appeared to do nothing.
  const chatStyle = appearance.chatWindowBackground ?? 'white';
  const chatOpacity = 100 - (appearance.chatWindowTransparency ?? DEFAULT_CHAT_TRANSPARENCY);
  const content = <section ref={panelRef} className="aval-inline-chat" role="dialog" aria-label={t('AvalAssistant.askAval')} data-expanded={expanded} data-detached={!!popupRoot} data-chat-style={chatStyle} style={{ '--chat-surface': `${chatOpacity}%`, '--chat-blur': chatStyle === 'glass' ? '24px' : '0px' } as CSSProperties} hidden={!open}>
    <div className="aval-inline-controls">
      <span>{currentContext}</span>
      <button type="button" aria-label={t(expanded ? 'ChatPolish.compact' : 'ChatPolish.expand')} onClick={panel.toggleExpanded}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
      <button type="button" aria-label={t(popupRoot ? 'ChatPanel.reattach' : 'ChatPanel.detach')} onClick={() => { voice.cancel(); if (popupRoot) panel.reattach(); else panel.detach(); }}><ExternalLink size={16}/></button>
      <button type="button" aria-label={t('AvalAssistant.closeAssistant')} onClick={close}><X size={18}/></button>
    </div>
    <div className="aval-inline-stream" data-empty={messages.length === 0} ref={streamRef} onScroll={event => { const e = event.currentTarget; followScroll.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80; }}>
      {restored
        ? before && <button type="button" className="text-button" onClick={() => void loadHistory(before)}>{m('older')}</button>
        : <button type="button" className="text-button" onClick={() => void loadHistory()}>{m('previous')}</button>}
      {open && messages.length === 0 && <div className="aval-inline-welcome"><AvalThinkingOrb size={64} activity={activity}/><AvalGreeting key={locale} text={m('welcome')}/></div>}
      {messages.map(message => <div className={'aval-inline-message ' + message.role} key={message.id}>
        {message.text && <p>{message.text}</p>}
        {message.taskId && <><AgentTaskConversation taskId={message.taskId} onActivity={onTaskActivity}/><a className="aval-work-link" href={`/${locale}?view=agents&agent=${encodeURIComponent(message.taskAgentId ?? 'general')}`}>{t('Independence.viewTask')}</a></>}
        {message.activity && <AvalActivityTrace status={message.error ? 'FAILED' : 'COMPLETED'} steps={message.activity} startedAt={message.startedAt} finishedAt={message.finishedAt}/>}
        {message.error && <p className="aval-inline-error" role="alert">{message.error}</p>}
        {message.answer && <div className="aval-inline-answer">
          <strong>{message.answer.headline}</strong><MarkdownPreview text={message.answer.narrative}/>
          {!!message.answer.metrics?.length && <div className="aval-chat-stats">{message.answer.metrics.map(metric => <span key={metric.label}><small>{metric.label}</small><strong>{formatMetricValue(metric)}</strong></span>)}</div>}
          {!!message.answer.chart?.points.length && <AvalChatChart chart={message.answer.chart}/>}
          {message.answer.document && <MarkdownPreview text={message.answer.document}/>}
          {(message.answer.evidence?.length || message.answer.evidence_ids?.length) ? <details><summary>{t('AvalAssistant.viewEvidence')}</summary>{message.answer.evidence?.map(row => <p key={row.label}>{row.label}: {row.value}</p>)}{message.answer.evidence_ids?.map(id => <p key={id}>{id}</p>)}</details> : null}
          {message.answer.action && <button type="button" className="text-button" onClick={() => { setDraftTitle(message.answer!.action!); setInput(message.answer!.actionDetail ?? message.answer!.narrative); setDraft(true); }}>{message.answer.action}</button>}
        </div>}
      </div>)}
      {busy && <AvalActivityTrace status="RUNNING" steps={activeSteps} startedAt={startedAt}/>}
    </div>
    <div className="aval-inline-bottom">
      {historyError && <p className="aval-inline-error" role="alert">{historyError} <button type="button" onClick={() => void loadHistory()}>{m('retry')}</button></p>}
      {(modeError || preferences?.error) && <p className="aval-inline-error" role="alert">{modeError || preferences?.error}</p>}
      {picker && <div className="aval-employee-popover">
        <input aria-label={m('searchEmployees')} placeholder={m('searchEmployees')} value={employeeSearch} onChange={event => setEmployeeSearch(event.target.value)}/>
        <button type="button" aria-pressed={!employeeId} onClick={() => { setEmployeeId(''); setPicker(false); inputRef.current?.focus(); }}>{t('AvalAssistant.askAval')}<small>{m('orchestrator')}</small></button>
        {employees.filter(e => !employeeSearch || (e.name + ' ' + e.role).toLowerCase().includes(employeeSearch.toLowerCase())).map(e => <button key={e.id} type="button" aria-pressed={employeeId === e.id} onClick={() => { setEmployeeId(e.id); setIntent('task'); setPicker(false); inputRef.current?.focus(); }}>{e.name}<small>{e.role}</small></button>)}
        {employeeError && <p role="alert">{employeeError}</p>}<a href={`/${locale}?view=setup`}>{t('Nav.setup')}</a>
      </div>}
      {draft && <form className="aval-inline-draft" onSubmit={startDraft}><input aria-label={t('AvalAssistant.draftTitlePlaceholder')} placeholder={t('AvalAssistant.draftTitlePlaceholder')} value={draftTitle} onChange={e => setDraftTitle(e.target.value)}/><select aria-label={m('format')} value={draftFormat} onChange={e => setDraftFormat(e.target.value as DraftFormat)}><option value="docx">Word</option><option value="xlsx">Excel</option><option value="pptx">PowerPoint</option></select><button type="submit" disabled={!draftTitle.trim() || !input.trim()}>{t('AvalAssistant.startDrafting')}</button><button type="button" aria-label={m('closeDraft')} onClick={() => setDraft(false)}><X size={16}/></button></form>}
      {module && <div className="aval-inline-context">{module.label}<button type="button" aria-label={t('AvalAssistant.clearSelectedModule')} onClick={() => setModule(null)}><X size={14}/></button></div>}
      {intent === 'chat' && <div className="aval-inline-context">{m('quickAnswer')}<button type="button" onClick={() => setIntent('task')}>{m('agentWork')}</button></div>}
      <AvalComposerEffects active={focused || working} stream={voice.stream} processing={voice.processing} dark={theme === 'dark'}>
        <form className="aval-minimal-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <textarea ref={inputRef} rows={2} maxLength={1200} value={input} aria-label={t('AvalAssistant.askAval')} placeholder={voice.state === 'live' ? m('listening') : m('placeholder')} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}/>
          <div className="aval-minimal-toolbar">
            <AvalLiquidActions label={t('ChatPolish.tools')} actions={[
              { label: t('AvalAssistant.draftDocument'), icon: <FileText size={18}/>, run: () => setDraft(true) },
              { label: m('pageContext'), icon: <View size={18}/>, run: () => setModule({ label: currentContext, snapshot: document.querySelector('main')?.textContent?.replace(/\s+/g, ' ').slice(0, 260) ?? currentContext }) },
              { label: intent === 'task' ? m('quickAnswer') : m('agentWork'), icon: intent === 'task' ? <MessageCircle size={18}/> : <Briefcase size={18}/>, disabled: !!employeeId || busy, run: () => setIntent(intent === 'task' ? 'chat' : 'task') },
            ]}/>
            <button className="aval-minimal-agent" type="button" disabled={busy || hasVoice} aria-expanded={picker} aria-label={t('ChatPanel.agentLabel', { agent: actorName })} onClick={() => setPicker(!picker)}><span>{actorName}</span><ChevronDown size={13}/></button>
            <label className="aval-minimal-mode"><span className="sr-only">{m('autonomy')}</span><select value={mode} disabled={busy || hasVoice || modeBusy || preferences?.busy || !preferences} onChange={e => void setMode(e.target.value as AutonomyMode)}>{(['supervised', 'assisted', 'autonomous'] as const).map(value => <option value={value} key={value}>{t('Onboarding.options.' + value)}</option>)}</select><ChevronDown size={13}/></label>
            <button className="aval-minimal-mic" type="button" aria-label={voice.state === 'live' ? m('stopVoice') : m('startVoice')} aria-pressed={voice.state === 'live'} disabled={busy || voice.processing || voice.state === 'requesting'} onClick={() => { if (voice.state === 'live') { voice.stop(); return; } dictationBase.current = input.trim(); void voice.start(); }}>{voice.state === 'live' ? <Square size={16}/> : <Mic size={18}/>}</button>
            <button className="aval-minimal-send" type="submit" disabled={!input.trim() || busy || hasVoice || modeBusy || preferences?.busy} aria-label={t('AvalAssistant.sendMessage')}><ArrowUp size={18}/></button>
          </div>
        </form>
      </AvalComposerEffects>
      <div className="aval-inline-hint" role="status">{voice.error || (voice.state === 'live' ? m('listening') : voice.processing ? m('transcribing') : m('mode.' + mode))}</div>
    </div>
  </section>;
  return <div className="aval-assistant aval-minimal" data-open={open} data-detached={!!popupRoot}>
    {popupRoot ? createPortal(content, popupRoot) : content}
    <button ref={launcherRef} className="aval-orb-launcher" type="button" data-tour-target="chat" aria-label={open ? t('AvalAssistant.closeAssistant') : t('AvalAssistant.askAval')} aria-expanded={open} onClick={() => open ? close() : setOpen(true)}><AvalThinkingOrb size={64} activity={activity}/>{unread && <span className="aval-unread" aria-label={m('unread')}/>}</button>
  </div>;
}
