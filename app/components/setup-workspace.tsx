"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Folder, NavArrowRight, NetworkLeft, Plus, Refresh, Xmark } from "iconoir-react";
import type { WorkspaceGraph } from "@/lib/setup/workspace-graph";
import type { AutonomyMode } from "@/lib/agents/autonomy";
import { PORTRAIT_IDS, type AvatarSelection } from "@/lib/appearance";
import { PERSONA_PRESETS, PERSONA_TOOL_ACCESS, type PersonaId } from "./agent-avatar/personas";
import { AvalAgentAvatar } from "./agent-avatar/AgentAvatar";
import { CharacterAvatar } from "./character-avatar";
import { SetupMemory } from "./setup-memory";
import { SetupCanvas } from "./setup-canvas";
import { IndependenceControls } from "./independence-controls";
import { WorkspaceMembers } from "./workspace-members";
import { ConnectionDialog, type Provider } from "./connection-dialog";
import { IntegrationsCatalog } from "./integrations-catalog";
import { PmsDesktopSession } from "./pms-desktop-session";
import { SetupProviderPicker, type SetupProviderKind } from "./setup-provider-picker";
import { DocumentUploader } from "./document-uploader";
import { useAppearance } from "./appearance-provider";
import { usePrefersReducedMotion } from "./experience";

type Graph = WorkspaceGraph & { canManage: boolean };
type Employee = WorkspaceGraph["employees"][number];
type CustomPersona = { id: string; label: string; focusDescription: string };
type Selection =
  | { kind: "workspace" | "connections" | "team" | "create" }
  | { kind: "employee" | "connection" | "persona"; id: string };
type LibraryAgent = { id: string; name: string; role: string; objective: string | null; preset?: (typeof PERSONA_PRESETS)[PersonaId]; employee?: Employee };
const topTabs = ["overview", "agentsLibrary"] as const;
const workspaceTabs = ["knowledge", "memory", "permissions", "connections", "team"] as const;

export function SetupWorkspace({ onNavigateAgents }: { onNavigateAgents: () => void }) {
  const t = useTranslations("SetupGraph");
  const all = useTranslations();
  const locale = useLocale();
  const reduced = usePrefersReducedMotion();
  const appearance = useAppearance();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [customPersonas, setCustomPersonas] = useState<CustomPersona[]>([]);
  const [tab, setTab] = useState<(typeof topTabs)[number]>("overview");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [connection, setConnection] = useState<Provider | null>(null);
  const [providerPicker, setProviderPicker] = useState<SetupProviderKind | null>(null);
  const [pmsSession, setPmsSession] = useState<Provider | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailTab, setDetailTab] = useState("overview");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams(focus ? { employeeId: focus } : {});
      const [graphResponse, providersResponse, personasResponse] = await Promise.all([
        fetch(`/api/setup/workspace-graph?${params}`, { signal, cache: "no-store" }),
        fetch("/api/integrations", { signal, cache: "no-store" }),
        fetch("/api/agents", { signal, cache: "no-store" }),
      ]);
      if (!graphResponse.ok) throw Error(t("loadError"));
      const data = await graphResponse.json() as Graph;
      const catalog = await providersResponse.json() as { providers?: Provider[] };
      const personas = await personasResponse.json().catch(() => ({})) as { personas?: CustomPersona[] };
      if (signal?.aborted) return;
      setGraph(data);
      setProviders(catalog.providers ?? []);
      setCustomPersonas(personas.personas ?? []);
      setError("");
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : t("loadError"));
    }
  }, [focus, t]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    const timer = window.setInterval(() => void load(controller.signal), 15000);
    const refresh = () => void load(controller.signal);
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  const open = (value: Selection, initialTab = "overview") => { setSelection(value); setDetailTab(initialTab); if (value.kind === "employee") setFocus(value.id); };
  const changed = async () => { await load(); window.dispatchEvent(new Event("aval:configuration-changed")); };
  const mutate = async (url: string, method: string, body: unknown) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string; employee?: { id: string } };
      if (!response.ok) throw Error(data.error ?? t("saveError"));
      await changed(); return data;
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("saveError")); return null; }
    finally { setBusy(false); }
  };

  const employee = graph?.employees.find((item) => item.id === (selection?.kind === "employee" ? selection.id : focus)) ?? graph?.selected;
  const chosenConnection = graph?.connections.find((item) => item.id === (selection?.kind === "connection" ? selection.id : ""));
  const assignments = (item: Employee) => graph?.connections.filter((candidate) => item.scopes.connection?.includes(candidate.id)) ?? [];
  const grant = (item: Employee, kind: string, value: string, enabled: boolean) => mutate(`/api/agents/employees/${item.id}`, "POST", { action: enabled ? "grant" : "revoke", scope: { kind, value } });
  const patchEmployee = (item: Employee, body: unknown) => mutate(`/api/agents/employees/${item.id}`, "PATCH", body);
  const focused = focus ? graph?.employees.find((item) => item.id === focus) ?? graph?.selected ?? null : null;
  const running = graph?.work.some((item) => item.state === "RUNNING") ?? false;
  const connectionNodes = (focused ? assignments(focused) : graph?.connections ?? []).filter((item) => !graph?.channels.some((channel) => channel.id === item.id));
  const channelNodes = (focused ? assignments(focused) : graph?.channels ?? []).filter((item) => graph?.channels.some((channel) => channel.id === item.id));
  const libraryAgents = useMemo<LibraryAgent[]>(() => [
    ...Object.values(PERSONA_PRESETS).map((preset) => ({ id: preset.id, name: all(preset.labelKey), role: all("AgentLibrary.builtIn"), objective: null, preset })),
    ...customPersonas.map((persona) => ({ id: persona.id, name: persona.label, role: all("AgentLibrary.customAgent"), objective: persona.focusDescription })),
    ...(graph?.employees ?? []).map((item) => ({ id: item.id, name: item.name, role: item.role, objective: item.objective, employee: item })),
  ], [all, customPersonas, graph?.employees]);
  const selectedPersona = selection?.kind === "persona" ? libraryAgents.find((item) => item.id === selection.id) : undefined;
  const saveAvatar = async (targetId: string, avatar: AvatarSelection) => {
    const next = { ...appearance.appearance, agents: { ...appearance.appearance.agents, [targetId]: avatar } };
    appearance.setAppearance(next); await appearance.save(next);
  };

  return <div className="view-wrap living-setup">
    <header className="living-header"><div><p className="eyebrow">AVAL WORKSPACE</p><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><span className="living-live"><i/>{t("setupLive")}</span></header>
    <nav className="living-tabs living-top-tabs" aria-label={t("title")}>{topTabs.map((value) => <button key={value} type="button" aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{t(value)}</button>)}</nav>
    {error && <div className="living-error" role="alert">{error}<button type="button" className="text-button" onClick={() => void load()}>{t("retry")}</button></div>}
    {!graph && !error && <p role="status">{t("loading")}</p>}
    {graph && tab === "overview" && <Overview graph={graph} focused={focused} running={running} reduced={reduced} channelNodes={channelNodes} connectionNodes={connectionNodes} open={open} setFocus={setFocus} setTab={setTab} load={load} onNavigateAgents={onNavigateAgents} openProviderPicker={setProviderPicker}/>}
    {graph && tab === "agentsLibrary" && <AgentLibrary agents={libraryAgents} graph={graph} onOpen={(item) => item.employee ? open({ kind: "employee", id: item.id }) : open({ kind: "persona", id: item.id })} onCreate={() => open({ kind: "create" })}/>}
    <Dialog.Root open={!!selection} onOpenChange={(value) => { if (!value) { setSelection(null); void changed(); } }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay living-overlay"/><Dialog.Content className="living-inspector"><DrawerHeader selection={selection} employee={employee} connection={chosenConnection} persona={selectedPersona}/><Dialog.Description className="sr-only">{t("detailDescription")}</Dialog.Description>{error && <p role="alert" className="living-error">{error}</p>}
      {selection?.kind === "workspace" && <><nav className="living-tabs living-drawer-tabs">{workspaceTabs.map((value) => <button key={value} aria-current={detailTab === value ? "page" : undefined} onClick={() => setDetailTab(value)}>{t(value)}</button>)}</nav>{detailTab === "knowledge" ? <Knowledge graph={graph} onChanged={changed}/> : detailTab === "memory" ? <SetupMemory/> : detailTab === "permissions" ? <Permissions graph={graph}/> : detailTab === "connections" ? <IntegrationsCatalog providers={providers} loading={!providers.length} onOpen={(id) => setConnection(providers.find((provider) => provider.id === id) ?? null)}/> : <WorkspaceMembers/>}</>}
      {selection?.kind === "connections" && <IntegrationsCatalog providers={providers} loading={!providers.length} onOpen={(id) => setConnection(providers.find((provider) => provider.id === id) ?? null)}/>}
      {selection?.kind === "team" && <WorkspaceMembers/>}
      {selection?.kind === "persona" && selectedPersona && graph && <PersonaDetail agent={selectedPersona} graph={graph} onSaveAvatar={saveAvatar}/>}
      {selection?.kind === "employee" && employee && graph && <EmployeeDetail employee={employee} graph={graph} detailTab={detailTab} setDetailTab={setDetailTab} busy={busy} locale={locale} mutate={mutate} patch={patchEmployee} grant={grant} saveAvatar={saveAvatar}/>}
      {selection?.kind === "connection" && chosenConnection && graph && <ConnectionDetail connection={chosenConnection} graph={graph} providers={providers} busy={busy} setConnection={setConnection} grant={grant}/>}
      {selection?.kind === "create" && <NewEmployee templates={graph?.templates ?? []} connections={graph?.connections ?? []} disabled={busy || !graph?.canManage} onCreate={async (body, avatar, activate) => { const data = await mutate("/api/agents/employees", "POST", body); if (!data?.employee) return; await saveAvatar(data.employee.id, avatar); if (activate) await mutate(`/api/agents/employees/${data.employee.id}`, "POST", { action: "activate" }); setFocus(data.employee.id); open({ kind: "employee", id: data.employee.id }); }}/>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    {connection && <ConnectionDialog provider={connection} onClose={() => setConnection(null)} onRefresh={() => void changed()}/>}
    {providerPicker && <SetupProviderPicker kind={providerPicker} providers={providers} onClose={() => setProviderPicker(null)} onChoose={(provider) => { setProviderPicker(null); if (providerPicker === "pms") setPmsSession(provider); else setConnection(provider); }}/>}
    {pmsSession && <Dialog.Root open onOpenChange={(value) => { if (!value) { setPmsSession(null); void changed(); } }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay setup-picker-overlay"/><Dialog.Content className="setup-pms-dialog"><div className="setup-pms-heading"><div><p className="eyebrow">PROPERTY SYSTEM</p><Dialog.Title>{pmsSession.title}</Dialog.Title></div><Dialog.Close className="icon-button" aria-label={t("close")}><Xmark width={20}/></Dialog.Close></div><Dialog.Description>{t("providerSignInDescription", { provider: pmsSession.title })}</Dialog.Description><PmsDesktopSession provider={pmsSession.id}/></Dialog.Content></Dialog.Portal></Dialog.Root>}
  </div>;
}

function Overview({ graph, focused, running, reduced, channelNodes, connectionNodes, open, setFocus, setTab, load, onNavigateAgents, openProviderPicker }: { graph: Graph; focused: Employee | null; running: boolean; reduced: boolean; channelNodes: Graph["connections"]; connectionNodes: Graph["connections"]; open: (value: Selection, tab?: string) => void; setFocus: (id: string | null) => void; setTab: (tab: "overview" | "agentsLibrary") => void; load: () => Promise<void>; onNavigateAgents: () => void; openProviderPicker: (kind: SetupProviderKind) => void }) {
  const t = useTranslations("SetupGraph");
  return <><div className="living-canvas-heading"><span>{focused ? t("accessFor", { name: focused.name }) : t("workspaceMap")}</span>{focused ? <button className="text-button" onClick={() => setFocus(null)}>{t("showWorkspace")}</button> : <button className="text-button" onClick={() => void load()}><Refresh width={13}/>{t("refresh")}</button>}</div><SetupCanvas graph={graph} focused={focused} running={running} reduced={reduced} channelNodes={channelNodes} connectionNodes={connectionNodes} onOpenCore={() => open(focused ? { kind: "employee", id: focused.id } : { kind: "workspace" }, focused ? "overview" : "knowledge")} onOpenConnection={(id) => open({ kind: "connection", id })} onOpenEmployee={(id) => { setFocus(id); open({ kind: "employee", id }); }} onCreateEmployee={() => open({ kind: "create" })} onOpenTeam={() => open({ kind: "team" })} onOpenLibrary={() => setTab("agentsLibrary")} onViewAllConnections={() => open({ kind: "workspace" }, "connections")} openProviderPicker={openProviderPicker}/>{focused && <section className="living-edge-panel"><h2>{t("accessFor", { name: focused.name })}</h2>{graph.edges.filter((edge) => edge.from === focused.id).map((edge) => <button className="living-edge" key={edge.id} onClick={() => open({ kind: "connection", id: edge.to })}><span>{focused.name} → {graph.connections.find((item) => item.id === edge.to)?.label ?? t("unavailable")}</span><small>{edge.active ? t("assigned") : t("inactive")} · {t(edge.autonomy)} · {t("capabilityCount", { count: edge.capabilities.length })}</small><NavArrowRight width={16}/></button>)}<button className="text-button" onClick={() => open({ kind: "employee", id: focused.id }, "access")}>{t("editAccess")}</button></section>}{!!graph.attention.length && <section className="living-attention"><h2>{t("attention")} <small>{graph.attention.length}</small></h2>{graph.attention.slice(0, 4).map((item) => <button key={`${item.kind}:${item.id}`} onClick={() => item.kind === "work" ? onNavigateAgents() : open({ kind: item.kind as "employee" | "connection", id: item.id })}><span className="living-attention-dot"/><span>{item.label}<small>{t.has(`status_${item.state}`) ? t(`status_${item.state}`) : item.state.replaceAll("_", " ")}</small></span><NavArrowRight width={15}/></button>)}</section>}</>;
}

function DrawerHeader({ selection, employee, connection, persona }: { selection: Selection | null; employee?: Employee | null; connection?: Graph["connections"][number]; persona?: LibraryAgent }) { const t = useTranslations("SetupGraph"); return <div className="living-inspector-heading"><div><p className="eyebrow">{t("setupDrawer")}</p><Dialog.Title>{selection?.kind === "employee" ? employee?.name : selection?.kind === "connection" ? connection?.label : selection?.kind === "persona" ? persona?.name : selection?.kind === "create" ? t("newEmployee") : selection?.kind === "connections" ? t("connections") : selection?.kind === "team" ? t("team") : "Aval"}</Dialog.Title></div><Dialog.Close className="icon-button" aria-label={t("close")}><Xmark width={21}/></Dialog.Close></div>; }
function Permissions({ graph }: { graph: Graph | null }) { const t = useTranslations("SetupGraph"); return <><IndependenceControls/><section className="living-edge-panel"><h2>{t("approvalAuthority")}</h2><p>{t("approvalExplanation")}</p>{graph?.humans.filter((human) => human.role !== "member").map((human) => <div className="living-edge" key={human.userId}><span>{human.displayName || human.email}</span><small>{human.role}</small></div>)}</section></>; }

function AgentLibrary({ agents, graph, onOpen, onCreate }: { agents: LibraryAgent[]; graph: Graph; onOpen: (agent: LibraryAgent) => void; onCreate: () => void }) { const t = useTranslations("SetupGraph"); const a = useTranslations("AgentLibrary"); return <section className="living-agent-library"><div className="living-library-heading"><div><p className="eyebrow">{a("yourTeam")}</p><h2>{a("title")}</h2><p>{a("subtitle")}</p></div><span>{t("agentCount", { count: agents.length })}</span></div><div className="living-agent-grid">{agents.map((agent) => { const connected = agent.employee ? graph.connections.filter((item) => agent.employee?.scopes.connection?.includes(item.id)) : []; const color = Array.from(agent.id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 6; return <button className={`living-agent-folder folder-color-${color}`} key={agent.id} onClick={() => onOpen(agent)}><span className="living-folder-cover"><span>{agent.employee ? t(`status_${agent.employee.status}`) : a("ready")}</span></span><span className="living-folder-front"><span className="living-folder-identity"><AvalAgentAvatar {...(agent.preset ?? PERSONA_PRESETS.general)} personaId={agent.id} size={48} label={agent.name}/><span><strong>{agent.name}</strong><small>{agent.role}</small></span></span><span className="living-folder-location"><NetworkLeft width={14}/>{connected.length ? connected.map((item) => item.label).join(", ") : agent.employee ? a("unassigned") : a("workspace")}</span><span className="living-folder-check"><Check width={15}/>{agent.objective || (agent.employee ? a("workCount", { count: agent.employee.openWork }) : a("workspaceNote"))}</span><span className="living-folder-check"><Check width={15}/>{agent.employee ? t("capabilityCount", { count: agent.employee.tools.length }) : t("backgroundReady")}</span></span></button>; })}<button className="living-agent-folder living-create-folder" onClick={onCreate}><span className="living-create-plus"><Plus width={34}/></span><strong>{a("newAgent")}</strong><small>{a("createDescription")}</small></button></div></section>; }

function PersonaDetail({ agent, graph, onSaveAvatar }: { agent: LibraryAgent; graph: Graph; onSaveAvatar: (id: string, avatar: AvatarSelection) => Promise<void> }) { const t = useTranslations("SetupGraph"); const a = useTranslations("AgentLibrary"); const appearance = useAppearance(); const access = PERSONA_TOOL_ACCESS[agent.id as PersonaId]; return <section className="living-summary"><div className="living-agent-hero"><AvalAgentAvatar {...(agent.preset ?? PERSONA_PRESETS.general)} personaId={agent.id} size={80} label={agent.name}/><div><h3>{agent.role}</h3><p>{agent.objective || a("workspaceNote")}</p></div></div><div className="living-edge"><span>{a("workspace")}</span><small>{t("documentCount", { count: graph.knowledgeSources.length })}</small></div><div className="living-edge"><span>{t("capabilities")}</span><small>{access === null ? t("allCapabilities") : t("capabilityCount", { count: access?.length ?? 0 })}</small></div>{agent.id !== "general" && <AvatarPicker selected={appearance.appearance.agents[agent.id]} onSelect={(avatar) => void onSaveAvatar(agent.id, avatar)}/>}</section>; }

function EmployeeDetail({ employee, graph, detailTab, setDetailTab, busy, locale, mutate, patch, grant, saveAvatar }: { employee: Employee; graph: Graph; detailTab: string; setDetailTab: (tab: string) => void; busy: boolean; locale: string; mutate: (url: string, method: string, body: unknown) => Promise<{ employee?: { id: string } } | null>; patch: (employee: Employee, body: unknown) => Promise<unknown>; grant: (employee: Employee, kind: string, value: string, enabled: boolean) => Promise<unknown>; saveAvatar: (id: string, avatar: AvatarSelection) => Promise<void> }) { const t = useTranslations("SetupGraph"); const appearance = useAppearance(); return <><nav className="living-tabs living-drawer-tabs">{["overview", "access", "expertise", "memory"].map((value) => <button key={value} aria-current={detailTab === value ? "page" : undefined} onClick={() => setDetailTab(value)}>{t(value)}</button>)}</nav>{detailTab === "overview" && <><div className="living-agent-hero"><AvalAgentAvatar personaId={employee.id} shape={PERSONA_PRESETS.general.shape} theme={PERSONA_PRESETS.general.theme} size={72}/><div><h3>{employee.role}</h3><p>{employee.objective}</p></div></div><div className="living-actions">{employee.status !== "archived" && <button className="soft-button" disabled={busy || !graph.canManage} onClick={() => void mutate(`/api/agents/employees/${employee.id}`, "POST", { action: employee.status === "active" ? "pause" : employee.status === "draft" ? "activate" : "resume" })}>{t(employee.status === "active" ? "pause" : "activate")}</button>}<span className="living-status">{t(`status_${employee.status}`)}</span></div><label className="living-field">{t("independence")}<select value={employee.autonomyMode} disabled={busy || !graph.canManage} onChange={(event) => void patch(employee, { autonomyMode: event.target.value })}>{["supervised", "assisted", "autonomous"].map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></label><p className="living-hint">{t("autonomyHint")}</p><AvatarPicker selected={appearance.appearance.agents[employee.id]} onSelect={(avatar) => void saveAvatar(employee.id, avatar)}/><button className="primary-button" onClick={() => window.location.assign(`/${locale}?view=agents&agent=${employee.id}`)}>{t("openWork")}<NavArrowRight width={15}/></button></>}{detailTab === "access" && <><h3>{t("connections")}</h3>{graph.connections.map((item) => <label className="living-toggle" key={item.id}><input type="checkbox" disabled={busy || !graph.canManage} checked={employee.scopes.connection?.includes(item.id) ?? false} onChange={(event) => void grant(employee, "connection", item.id, event.target.checked)}/><span>{item.label}<small>{item.account ?? item.status}</small></span></label>)}<label className="living-toggle"><input type="checkbox" checked={employee.mayCommunicateExternally} disabled={busy || !graph.canManage} onChange={(event) => void patch(employee, { mayCommunicateExternally: event.target.checked })}/>{t("externalCommunication")}</label><h3>{t("capabilities")}</h3><p className="living-hint">{t("capabilityHint")}</p>{graph.capabilities.map((capability) => <label className="living-toggle" key={capability.name}><input type="checkbox" disabled={busy || !graph.canManage} checked={employee.scopes.capability?.includes(capability.name) ?? false} onChange={(event) => void grant(employee, "capability", capability.name, event.target.checked)}/><span>{capability.summary}<small>{employee.tools.includes(capability.name) ? t("available") : employee.scopes.capability?.includes(capability.name) ? t("unavailable") : t("notGranted")} · {capability.risk}</small></span>{employee.tools.includes(capability.name) && <Check width={14}/>}</label>)}</>}{detailTab === "memory" && <EmployeeInstructions employee={employee} disabled={busy || !graph.canManage} onSave={(instructions) => patch(employee, { instructions })}/>} {detailTab === "expertise" && graph.expertise.map((item) => <label className="living-toggle" key={item.id}><input type="checkbox" checked={employee.expertise.some((candidate) => candidate.id === item.id)} disabled={busy || !graph.canManage} onChange={(event) => void mutate(`/api/agents/employees/${employee.id}`, "POST", { action: event.target.checked ? "grant_expertise" : "revoke_expertise", expertiseId: item.id })}/><span>{item.name}<small>{item.description}</small></span></label>)}</>; }

function ConnectionDetail({ connection, graph, providers, busy, setConnection, grant }: { connection: Graph["connections"][number]; graph: Graph; providers: Provider[]; busy: boolean; setConnection: (provider: Provider | null) => void; grant: (employee: Employee, kind: string, value: string, enabled: boolean) => Promise<unknown> }) { const t = useTranslations("SetupGraph"); return <><p>{connection.account ?? connection.label} · {connection.status}</p><p className="living-hint">{connection.authMode}</p><button className="primary-button" onClick={() => setConnection(providers.find((provider) => provider.id === connection.provider) ?? null)}>{t("manageConnection")}</button><h3>{t("reportingAccess")}</h3><div className="living-chips">{connection.reportingCapabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>{connection.matrix && <><h3>{t("providerCapabilities")}</h3>{Object.entries(connection.matrix).map(([name, value]) => <div className="living-edge" key={name}><span>{name}</span><small>{value.state}</small></div>)}</>}<h3>{t("usedBy")}</h3>{graph.employees.map((item) => <label className="living-toggle" key={item.id}><input type="checkbox" disabled={busy || !graph.canManage} checked={item.scopes.connection?.includes(connection.id) ?? false} onChange={(event) => void grant(item, "connection", connection.id, event.target.checked)}/><span>{item.name}<small>{item.role}</small></span></label>)}<p className="living-hint">{t("assignmentHint")}</p></>; }

function AvatarPicker({ selected, onSelect }: { selected?: AvatarSelection; onSelect: (avatar: AvatarSelection) => void }) { const t = useTranslations(); return <section className="living-avatar-picker"><h3>{t("Appearance.chooseAvatar")}</h3><div className="living-avatar-strip">{PORTRAIT_IDS.map((id) => { const avatar: AvatarSelection = { kind: "portrait", id, background: selected?.background ?? "paper" }; return <button type="button" key={id} aria-pressed={selected?.kind === "portrait" && selected.id === id} aria-label={t(`Appearance.portraitsList.${id}`)} onClick={() => onSelect(avatar)}><CharacterAvatar avatar={avatar} size={52} label=""/></button>; })}</div><small>{t("Appearance.accountStorage")}</small></section>; }
function EmployeeInstructions({ employee, disabled, onSave }: { employee: Employee; disabled: boolean; onSave: (value: string) => Promise<unknown> }) { const t = useTranslations("SetupGraph"); const [value, setValue] = useState(employee.instructions ?? ""); return <form onSubmit={(event) => { event.preventDefault(); void onSave(value); }}><label className="living-field">{t("instructions")}<textarea rows={8} maxLength={4000} value={value} onChange={(event) => setValue(event.target.value)} disabled={disabled}/></label><p className="living-hint">{t("instructionsHint")}</p><button className="primary-button" disabled={disabled}>{t("save")}</button></form>; }

function NewEmployee({ templates, connections, disabled, onCreate }: { templates: WorkspaceGraph["templates"]; connections: Graph["connections"]; disabled: boolean; onCreate: (body: unknown, avatar: AvatarSelection, activate: boolean) => Promise<void> }) { const t = useTranslations("SetupGraph"); const [role, setRole] = useState(""); const [objective, setObjective] = useState(""); const [avatar, setAvatar] = useState<AvatarSelection>({ kind: "portrait", id: PORTRAIT_IDS[0], background: "paper" }); const [selectedConnections, setSelectedConnections] = useState<string[]>([]); const [mode, setMode] = useState<AutonomyMode>("supervised"); const [external, setExternal] = useState(false); const [activate, setActivate] = useState(false); return <form className="living-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void onCreate({ name: data.get("name"), role, objective, autonomyMode: mode, mayCommunicateExternally: external, scopes: selectedConnections.map((value) => ({ kind: "connection", value })) }, avatar, activate); }}><AvatarPicker selected={avatar} onSelect={setAvatar}/><label className="living-field">{t("startFrom")}<select defaultValue="" onChange={(event) => { const template = templates.find((item) => item.slug === event.target.value); setRole(template?.role ?? ""); setObjective(template?.objective ?? ""); }}><option value="">{t("scratch")}</option>{templates.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></label><div className="living-form-pair"><label className="living-field">{t("name")}<input name="name" required maxLength={120}/></label><label className="living-field">{t("role")}<input value={role} onChange={(event) => setRole(event.target.value)} required maxLength={120}/></label></div><label className="living-field">{t("objective")}<textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} maxLength={4000}/></label><label className="living-field">{t("independence")}<select value={mode} onChange={(event) => setMode(event.target.value as AutonomyMode)}>{["supervised", "assisted", "autonomous"].map((value) => <option key={value} value={value}>{t(value)}</option>)}</select></label>{connections.length > 0 && <fieldset className="living-create-access"><legend>{t("initialAccess")}</legend>{connections.map((item) => <label className="living-toggle" key={item.id}><input type="checkbox" checked={selectedConnections.includes(item.id)} onChange={(event) => setSelectedConnections((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))}/><span>{item.label}<small>{item.account ?? item.status}</small></span></label>)}</fieldset>}<label className="living-toggle"><input type="checkbox" checked={external} onChange={(event) => setExternal(event.target.checked)}/><span>{t("externalCommunication")}</span></label><label className="living-toggle"><input type="checkbox" checked={activate} onChange={(event) => setActivate(event.target.checked)}/><span>{t("activateNow")}<small>{t("activateNowHint")}</small></span></label><p className="living-hint">{t("creationHint")}</p><button className="primary-button" disabled={disabled}>{activate ? t("createAndActivate") : t("create")}</button></form>; }

function Knowledge({ graph, onChanged }: { graph: Graph | null; onChanged: () => Promise<void> }) { const t = useTranslations("SetupGraph"); return <section className="living-summary"><p>{t("knowledgeHint")}</p>{graph?.canManage && <DocumentUploader disabled={false} onUploaded={() => void onChanged()}/>}<div className="living-source-list">{graph?.knowledgeSources.map((document) => <div className="living-edge" key={document.id}><Folder width={17}/><span>{document.title}<small>{document.kind}</small></span><Check width={15}/></div>)}</div>{!graph?.knowledgeSources.length && <p className="living-empty">{t("noKnowledge")}</p>}</section>; }
