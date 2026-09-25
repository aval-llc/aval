"use client";

/** Aval One, the Leads and paginated employees share a folder UI; identities
 * and ownership remain distinct so work is never attributed by a matching role.
 * Four tabs (directive §28): All agents, Your employees, Aval One & Leads, and
 * the Expertise library. Customer-created employees are kept apart from the
 * built-in Leads, and the 266 Specialists live only in the library. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import { belongsToAgent } from "./agent-library-model";
import { EmployeeWorkspace, type EmployeeWorkProps } from "./employee-workspace";
import { AvalAgentAvatar } from "./agent-avatar/AgentAvatar";
import { PERSONA_PRESETS } from "./agent-avatar/personas";
import { ExpertiseLibrary, LeadCards, presetFor, type Organization } from "./organization-library";
import { AVAL_ONE, LEADS, leadRuntimeId } from "@/lib/agents/organization/domains";
import { Check, Pause, Play, Archive, Plus, Search, Xmark, NavArrowRight, Circle, Folder, Link } from "iconoir-react";

interface Employee {
  id: string;
  name: string;
  role: string;
  objective: string | null;
  status: "draft" | "active" | "paused" | "archived";
  autonomyMode: "supervised" | "assisted" | "autonomous";
}

interface Template {
  slug: string;
  name: string;
  role: string;
  objective: string;
}

interface Directory {
  employees: Employee[];
  total: number;
  /** Null means this workspace has no configured ceiling. */
  limit: number | null;
  templates: Template[];
}

interface Work { id: string; agentId: string; employeeId?: string | null; goal: string; status: string }
interface ConnectionProvider { id: string; name: string; connection: { id: string; status: string } | null }
interface EmployeeDetail { scopes: Partial<Record<string, string[]>>; openWork: number }
interface LibraryAgent { id: string; name: string; role: string; objective: string | null; employee?: Employee; preset: typeof PERSONA_PRESETS.general }
const PAGE_SIZE = 24;
/**
 * Aval One and the Leads as they are known before the catalogue arrives, so
 * the built-in organization is on screen at first paint rather than after a
 * round trip. Only the Specialist counts wait for the server.
 */
const INITIAL_ORGANIZATION: Organization = {
  avalOne: { id: AVAL_ONE.legacyPersonaId, alias: AVAL_ONE.id, name: AVAL_ONE.name, subtitle: AVAL_ONE.subtitle, summary: AVAL_ONE.summary },
  leads: LEADS.map(lead => ({ id: leadRuntimeId(lead), alias: lead.id, domain: lead.domain, name: lead.name, summary: lead.summary, historical: Boolean(lead.legacyPersonaId), specialistCount: 0, relatedLeads: [] })),
  counts: { leads: LEADS.length, specialists: 0, domains: LEADS.length },
};
const TABS = ["all", "employees", "leads", "expertise"] as const;
type Tab = (typeof TABS)[number];
/** The tab a link asked for. `builtIn` is the tab's name before it was split. */
function tabFromUrl(): Tab {
  if (typeof window === "undefined") return "all";
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab === "builtIn" ? "leads" : (TABS as readonly string[]).includes(tab ?? "") ? tab as Tab : "all";
}

/** Which lifecycle actions make sense from where the employee currently is. */
function actionsFor(status: Employee["status"]): ("activate" | "pause" | "resume" | "archive")[] {
  switch (status) {
    case "draft": return ["activate", "archive"];
    case "active": return ["pause", "archive"];
    case "paused": return ["resume", "archive"];
    default: return [];
  }
}

export function EmployeeDirectory({ work: draftWork }: { work?: EmployeeWorkProps } = {}) {
  const t = useTranslations();
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openedLink = useRef(false);
  const [selected, setSelected] = useState<LibraryAgent | null>(null);
  const [reviews, setReviews] = useState<{ agentId: string; employeeId?: string | null }[]>([]);
  const [work, setWork] = useState<Work[]>([]);
  const [workError, setWorkError] = useState(false);
  const [employeeDetails, setEmployeeDetails] = useState<Record<string, EmployeeDetail>>({});
  const [providers, setProviders] = useState<ConnectionProvider[]>([]);
  const [organization, setOrganization] = useState<Organization | null>(INITIAL_ORGANIZATION);
  const [expertiseState, setExpertiseState] = useState<"idle" | "loading" | "failed">("idle");
  const [filter, setFilterState] = useState<Tab>(tabFromUrl);
  const setFilter = useCallback((tab: Tab) => {
    setFilterState(tab);
    // The tab is part of the link, so a shared or reloaded library opens where
    // it was. `agent` deep links are left untouched.
    const url = new URL(window.location.href);
    if (tab === "all") url.searchParams.delete("tab"); else url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<{ name: string; role: string; objective: string; templateSlug?: string }>({ name: "", role: "", objective: "" });

  const fetchDirectory = useCallback(async (): Promise<Directory | null> => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (search.trim()) params.set("search", search.trim());
    const response = await fetch(`/api/agents/employees?${params}`);
    return response.ok ? await response.json() as Directory : null;
  }, [offset, search]);

  // The liveness flag is not only about unmounting: typing in the search box
  // fires overlapping requests, and without it a slower earlier response lands
  // last and shows results for a query the person has already moved past.
  useEffect(() => {
    let live = true;
    void fetchDirectory().then((next) => {
      if (!live) return;
      if (next) { setDirectory(next); setError(null); } else setError(t("Employees.loadFailed"));
    }).catch(() => { if (live) setError(t("Employees.loadFailed")); });
    return () => { live = false; };
  }, [fetchDirectory, t]);

  /** Re-reads after a mutation, where there is no race to lose. */
  const load = useCallback(async () => {
    const next = await fetchDirectory();
    if (next) { setDirectory(next); setError(null); } else setError(t("Employees.loadFailed"));
  }, [fetchDirectory, t]);

  const act = async (id: string, action: string) => {
    setBusy(id);
    try {
      const response = await fetch(`/api/agents/employees/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; openWork?: number };
        // Archiving is refused while the employee still owns unfinished work.
        // Saying how much is outstanding is the difference between a refusal
        // and an explanation.
        setError(body.openWork
          ? t("Employees.hasOpenWork", { count: body.openWork })
          : body.error ?? t("Employees.actionFailed"));
        return;
      }
      setError(null);
      await load();
      return true;
    } catch { setError(t("Employees.actionFailed")); } finally { setBusy(null); }
  };

  const create = async () => {
    setBusy("new");
    try {
      const response = await fetch("/api/agents/employees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? t("Employees.createFailed"));
        return;
      }
      setDraft({ name: "", role: "", objective: "" });
      setCreating(false);
      setSearch("");
      setOffset(0);
      setFilter("employees");
      setError(null);
      // Changed search/page triggers its own fetch; never let the old query overwrite it.
      if (offset === 0 && search === "") await load();
    } catch { setError(t("Employees.createFailed")); } finally { setBusy(null); }
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/agents/approvals", { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const data = await response.json() as { approvals: { agentId: string; employeeId?: string | null }[] };
      if (!controller.signal.aborted) setReviews(data.approvals);
    }).catch(() => {});
    void fetch("/api/agents/tasks", { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error();
      const data = await r.json() as { tasks: Work[] };
      if (!controller.signal.aborted) { setWork(data.tasks); setWorkError(false); }
    }).catch(() => { if (!controller.signal.aborted) setWorkError(true); });
    void fetch("/api/integrations", { signal: controller.signal }).then(async r => {
      if (!r.ok) return;
      const data = await r.json() as { providers?: ConnectionProvider[] };
      if (!controller.signal.aborted) setProviders(data.providers ?? []);
    }).catch(() => {});
    // Former custom personas are employees now, listed with the rest of the
    // directory; there is no second list to fetch.
    void fetch("/api/agents/organization", { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error();
      const data = await r.json() as Organization;
      if (!controller.signal.aborted) setOrganization(current => current?.specialists ? { ...data, specialists: current.specialists } : data);
    }).catch(() => { if (!controller.signal.aborted) setError(t("Employees.loadFailed")); });
    return () => controller.abort();
  }, [t, selected]);

  // The specialist catalogue is only fetched once somebody opens the library.
  useEffect(() => {
    if (filter !== "expertise" || organization?.specialists || expertiseState !== "idle") return;
    queueMicrotask(() => setExpertiseState("loading"));
    void fetch("/api/agents/organization?include=specialists").then(async r => {
      if (!r.ok) throw new Error();
      const data = await r.json() as Organization;
      setOrganization(data);
      setExpertiseState("idle");
    }).catch(() => setExpertiseState("failed"));
  }, [filter, organization?.specialists, expertiseState]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all((directory?.employees ?? []).map(async employee => {
      try {
        const r = await fetch(`/api/agents/employees/${encodeURIComponent(employee.id)}`, { signal: controller.signal });
        if (!r.ok) return;
        const detail = await r.json() as EmployeeDetail;
        if (!controller.signal.aborted) setEmployeeDetails(current => ({ ...current, [employee.id]: detail }));
      } catch { /* The card keeps its explicit unavailable state. */ }
    }));
    return () => controller.abort();
  }, [directory]);

  // Aval One and the Leads, as the folder dialog opens them.
  const builtIns: LibraryAgent[] = useMemo(() => organization ? [
    { id: organization.avalOne.id, name: organization.avalOne.name, role: t("AgentLibrary.avalOneSubtitle"), objective: organization.avalOne.summary, preset: presetFor(organization.avalOne.id) },
    ...organization.leads.map(lead => ({ id: lead.id, name: lead.name, role: t("AgentLibrary.leadSubtitle"), objective: lead.summary, preset: presetFor(lead.id) })),
  ] : [], [organization, t]);
  const employees = directory?.employees ?? [];
  const showsLeads = filter === "all" || filter === "leads";
  const agents: LibraryAgent[] = filter === "leads" || filter === "expertise" ? [] : employees.map(employee => ({ id: employee.id, name: employee.name, role: employee.role, objective: employee.objective, employee, preset: { ...PERSONA_PRESETS.general, icon: undefined } }));
  const openBuiltIn = (id: string) => { const agent = builtIns.find(row => row.id === id); if (agent) setSelected(agent); };
  useEffect(() => {
    if (openedLink.current) return;
    const id = new URLSearchParams(window.location.search).get("agent");
    if (!id) { openedLink.current = true; return; }
    if (!organization || !directory) return;
    // Every historical link still opens: the eight legacy agent ids are the
    // Leads' own ids, `aval-one` and `lead.<domain>` are aliases, and a former
    // custom persona's id is now its employee's id.
    const lead = organization.leads.find(row => row.id === id || row.alias === id);
    const builtIn = builtIns.find(row => row.id === (id === organization.avalOne.alias ? organization.avalOne.id : lead?.id ?? id));
    const employee = directory.employees.find(employee => employee.id === id);
    const match: LibraryAgent | undefined = builtIn ?? (employee ? { id, name: employee.name, role: employee.role, objective: employee.objective, employee, preset: { ...PERSONA_PRESETS.general, icon: undefined } } : undefined);
    openedLink.current = true;
    if (match) queueMicrotask(() => setSelected(match));
    else if (/^[a-z-]+\.[a-z0-9-]+$/.test(id)) queueMicrotask(() => setFilter("expertise"));
  }, [directory, organization, builtIns, setFilter]);
  const pages = useMemo(() => Math.max(1, Math.ceil((directory?.total ?? 0) / PAGE_SIZE)), [directory?.total]);
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const agentWork = (agent: LibraryAgent) => work.filter(task => belongsToAgent(task, agent.id, !!agent.employee));
  const location = (agent: LibraryAgent) => {
    if (!agent.employee) return t("AgentLibrary.workspace");
    const detail = employeeDetails[agent.id];
    if (!detail) return t("AgentLibrary.connectionsUnavailable");
    const connections = detail.scopes.connection ?? [];
    return connections.length ? connections.map(id => providers.find(provider => provider.connection?.id === id || provider.id === id)?.name ?? t("AgentLibrary.assignedConnection")).join(", ") : t("AgentLibrary.unassigned");
  };

  return <section className="panel agent-library" data-reveal>
    <div className="panel-heading">
      <div><p className="eyebrow">{t("Employees.eyebrow")}</p><h2>{t("AgentLibrary.title")}</h2><p className="library-subtitle">{t("AgentLibrary.subtitle")}</p></div>
      <button type="button" className="primary-button library-create" onClick={() => setCreating(true)}><Plus width={16} height={16}/>{t("AgentLibrary.newAgent")}</button>
    </div>
    <div className="library-toolbar">
      <div className="library-filters" aria-label={t("AgentLibrary.filter")}>
        {TABS.map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setOffset(0); }}>{t(`AgentLibrary.tab_${value}`)}</button>)}
      </div>
      <label className="employee-search"><Search width={16} height={16}/><input placeholder={t("Employees.searchPlaceholder")} value={search} aria-label={t("Employees.searchPlaceholder")} onChange={event => { setOffset(0); setSearch(event.target.value); }}/></label>
    </div>
    {error && <p className="employee-error" role="alert">{error}</p>}
    {workError && <p className="employee-error" role="status">{t("AgentLibrary.workUnavailable")}</p>}
    {filter === "expertise" ? <ExpertiseLibrary organization={organization} loading={expertiseState === "loading"} failed={expertiseState === "failed"} search={search} work={work} onOpenLead={openBuiltIn}/> : <>
    <div className="agent-folder-grid">
      {showsLeads && organization && <LeadCards organization={organization} work={work} search={search} onOpen={openBuiltIn}/>}
      {agents.map((agent) => {
        const tasks = agentWork(agent);
        const pending = reviews.filter(review => belongsToAgent(review, agent.id, !!agent.employee)).length;
        const documents = draftWork?.jobs.filter(job => !agent.employee && job.input.personaId === agent.id).length ?? 0;
        const color = Array.from(agent.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
        return <button type="button" className={`agent-folder folder-color-${color}`} key={agent.id} onClick={() => setSelected(agent)}>
          <span className="folder-cover"><span className="folder-badge">{agent.employee ? t(`Employees.status_${agent.employee.status}`) : t("AgentLibrary.ready")}</span></span>
          <span className="folder-front">
            <span className="folder-identity"><AvalAgentAvatar {...agent.preset} personaId={agent.id} size={40} label={agent.name}/><span><strong>{agent.name}</strong><small>{agent.role}</small></span></span>
            <span className="folder-location"><Link width={13} height={13}/><span>{location(agent)}</span></span>
            <span className="folder-work">
              {tasks.length ? tasks.slice(0, 2).map(task => <span className={`folder-check ${task.status === "COMPLETED" ? "is-done" : ""}`} key={task.id}>{task.status === "COMPLETED" ? <Check width={14} height={14}/> : <Circle width={14} height={14}/>}<span>{task.goal}</span></span>) : <span className="folder-check"><Circle width={14} height={14}/><span>{workError ? t("AgentLibrary.workUnavailable") : agent.objective || t("AgentLibrary.noWork")}</span></span>}
            </span>
            <span className="folder-footer"><span><Folder width={14} height={14}/>{pending ? t("AgentLibrary.needsReview", { count: pending }) : documents ? t("AgentLibrary.documentCount", { count: documents }) : t("AgentLibrary.workCount", { count: tasks.length })}</span><NavArrowRight width={16} height={16}/></span>
          </span>
        </button>;
      })}
    </div>
    {!agents.length && !showsLeads && <p className="library-empty">{!directory ? t("AgentTrace.loadingTasks") : filter === "employees" && !search ? t("AgentLibrary.noEmployeesYet") : t("AgentLibrary.noResults")}</p>}
    {pages > 1 && filter !== "leads" && <div className="employee-pager"><button className="soft-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t("Employees.previous")}</button><span>{t("Employees.pageOf", { page, pages })}</span><button className="soft-button" disabled={page >= pages} onClick={() => setOffset(offset + PAGE_SIZE)}>{t("Employees.next")}</button></div>}
    </>}

    <Dialog.Root open={creating} onOpenChange={setCreating}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="agent-library-dialog agent-create-dialog">
      <div className="library-dialog-heading"><div><p className="eyebrow">{t("AgentLibrary.yourTeam")}</p><Dialog.Title>{t("AgentLibrary.newAgent")}</Dialog.Title></div><Dialog.Close className="icon-button" aria-label={t("Overview.close")}><Xmark width={20} height={20}/></Dialog.Close></div>
      <Dialog.Description>{t("AgentLibrary.createDescription")}</Dialog.Description>
      <form className="employee-form" onSubmit={event => { event.preventDefault(); void create(); }}>
        <label>{t("AgentLibrary.responsibilities")}<textarea required rows={4} value={draft.objective} placeholder={t("Employees.objectivePlaceholder")} onChange={e => setDraft({ ...draft, objective: e.target.value, templateSlug: undefined })}/></label>
        <div className="employee-form-row"><label>{t("AgentLibrary.name")}<input required value={draft.name} placeholder={t("Employees.namePlaceholder")} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label>{t("AgentLibrary.role")}<input required value={draft.role} placeholder={t("Employees.rolePlaceholder")} onChange={e => setDraft({ ...draft, role: e.target.value, templateSlug: undefined })}/></label></div>
        {!!directory?.templates.length && <details className="library-templates"><summary>{t("Employees.templateHint")}</summary><div className="employee-templates">{directory.templates.map(template => <button key={template.slug} type="button" className="employee-template-chip" aria-pressed={draft.templateSlug === template.slug} onClick={() => setDraft({ name: template.name, role: template.role, objective: template.objective, templateSlug: template.slug })}>{template.role}</button>)}</div></details>}
        <p className="employee-form-note">{t("AgentLibrary.createNote")}</p>
        {error && <p role="alert" className="employee-error">{error}</p>}
        <div className="employee-form-actions"><Dialog.Close type="button" className="soft-button" disabled={busy !== null}>{t("AgentLibrary.cancel")}</Dialog.Close><button className="primary-button" disabled={busy !== null || !draft.name.trim() || !draft.role.trim() || !draft.objective.trim()}>{busy === "new" ? t("SetupView.saving") : t("Employees.createConfirm")}</button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>

    <Dialog.Root open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="agent-library-dialog agent-work-dialog">
      {selected && <><div className="library-dialog-heading"><div className="folder-identity"><AvalAgentAvatar {...selected.preset} personaId={selected.id} size={48} label={selected.name}/><div><Dialog.Title>{selected.name}</Dialog.Title><p>{selected.role}</p></div></div><Dialog.Close className="icon-button" aria-label={t("Overview.close")}><Xmark width={20} height={20}/></Dialog.Close></div>
      <Dialog.Description className="folder-location"><Link width={14} height={14}/>{location(selected)}</Dialog.Description>
      {selected.objective && <p className="library-objective">{selected.objective}</p>}
      {selected.employee && <div className="library-lifecycle"><span className="employee-status">{t(`Employees.status_${selected.employee.status}`)}</span>{actionsFor(selected.employee.status).map(action => <button type="button" className="soft-button" key={action} disabled={busy !== null} onClick={async () => { if (await act(selected.id, action)) setSelected(null); }}>{action === "pause" ? <Pause width={14} height={14}/> : action === "archive" ? <Archive width={14} height={14}/> : <Play width={14} height={14}/>} {t(`Employees.action_${action}`)}</button>)}</div>}
      {error && <p className="employee-error" role="alert">{error}</p>}
      <EmployeeWorkspace key={selected.id} id={selected.id} employee={!!selected.employee} name={selected.name} work={draftWork} reviewCount={reviews.filter(review => belongsToAgent(review, selected.id, !!selected.employee)).length}/></>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
