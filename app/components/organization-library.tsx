"use client";

/**
 * Aval One, the Leads and the Specialist library, drawn in the agent library's
 * own folder language.
 *
 * Leads are platform actors, not customer headcount, so they have no
 * lifecycle, access or memory tabs: a Lead's card shows what it coordinates and
 * the work it has done here. The 266 Specialists are never rendered as 266
 * cards; they are grouped by domain and opened on demand (directive §28).
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Circle, Folder, Link, NavArrowDown, NavArrowRight, Xmark } from "iconoir-react";
import { AvalAgentAvatar } from "./agent-avatar/AgentAvatar";
import { PERSONA_PRESETS } from "./agent-avatar/personas";

export interface OrganizationLead {
  id: string;
  alias: string;
  domain: string;
  name: string;
  summary: string;
  historical: boolean;
  specialistCount: number;
  relatedLeads: string[];
}

export interface OrganizationSpecialist {
  id: string;
  name: string;
  domain: string;
  boundary: string;
  notThis: { id: string; name: string; because: string };
  triggers: string[];
  inputs: string[];
  outputs: string[];
  capabilities: string[];
  approvals: string[];
  forbidden: string[];
  completion: { doneWhen: string; notDoneWhen: string };
  collaborators: { id: string; name: string }[];
}

export interface Organization {
  avalOne: { id: string; alias: string; name: string; subtitle: string; summary: string };
  leads: OrganizationLead[];
  counts: { leads: number; specialists: number; domains: number };
  specialists?: OrganizationSpecialist[];
}

interface Work { id: string; agentId: string; employeeId?: string | null; goal: string; status: string }

/** The historical agents keep their own avatars; a new Lead takes Aval's. */
export function presetFor(id: string) {
  return (PERSONA_PRESETS as Record<string, typeof PERSONA_PRESETS.general>)[id] ?? { ...PERSONA_PRESETS.general, icon: undefined };
}

/** `work_order.create` reads as "Work order · create". */
export function capabilityLabel(capability: string) {
  const [object, ...verb] = capability.split(".");
  const noun = object.replace(/_/g, " ");
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} · ${verb.join(" ").replace(/_/g, " ")}`;
}

const colorOf = (id: string) => Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;

/** One folder card for Aval One or a Lead. */
export function OrganizationCard({ id, name, subtitle, detail, work, onOpen }: {
  id: string; name: string; subtitle: string; detail: string; work: Work[]; onOpen: () => void;
}) {
  const t = useTranslations();
  const tasks = work.filter((task) => !task.employeeId && task.agentId === id);
  return <button type="button" className={`agent-folder folder-color-${colorOf(id)}`} onClick={onOpen}>
    <span className="folder-cover"><span className="folder-badge">{t("AgentLibrary.available")}</span></span>
    <span className="folder-front">
      <span className="folder-identity"><AvalAgentAvatar {...presetFor(id)} personaId={id} size={40} label={name}/><span><strong>{name}</strong><small>{subtitle}</small></span></span>
      <span className="folder-location"><Link width={13} height={13}/><span>{t("AgentLibrary.workspace")}</span></span>
      <span className="folder-work">
        <span className="folder-check"><Circle width={14} height={14}/><span>{detail}</span></span>
        {tasks.slice(0, 1).map((task) => <span className={`folder-check ${task.status === "COMPLETED" ? "is-done" : ""}`} key={task.id}>{task.status === "COMPLETED" ? <Check width={14} height={14}/> : <Circle width={14} height={14}/>}<span>{task.goal}</span></span>)}
      </span>
      <span className="folder-footer"><span><Folder width={14} height={14}/>{t("AgentLibrary.workCount", { count: tasks.length })}</span><NavArrowRight width={16} height={16}/></span>
    </span>
  </button>;
}

/** Aval One and the 22 Leads, Aval One first. */
export function LeadCards({ organization, work, search, onOpen }: {
  organization: Organization; work: Work[]; search: string; onOpen: (id: string) => void;
}) {
  const t = useTranslations();
  const query = search.trim().toLowerCase();
  const matches = (text: string) => !query || text.toLowerCase().includes(query);
  const { avalOne } = organization;
  return <>
    {matches(`${avalOne.name} ${avalOne.subtitle}`) && <OrganizationCard id={avalOne.id} name={avalOne.name} subtitle={t("AgentLibrary.avalOneSubtitle")} detail={t("AgentLibrary.avalOneCoordinates")} work={work} onOpen={() => onOpen(avalOne.id)}/>}
    {organization.leads.filter((lead) => matches(`${lead.name} ${lead.summary}`)).map((lead) => <OrganizationCard key={lead.id} id={lead.id} name={lead.name} subtitle={t("AgentLibrary.leadSubtitle")}
      detail={lead.specialistCount ? t("AgentLibrary.coordinates", { count: lead.specialistCount }) : lead.summary} work={work} onOpen={() => onOpen(lead.id)}/>)}
  </>;
}

/** The expertise library: domains collapsed, each opening to its Lead and its Specialists. */
export function ExpertiseLibrary({ organization, loading, failed, search, work, onOpenLead }: {
  organization: Organization | null; loading: boolean; failed: boolean; search: string; work: Work[]; onOpenLead: (id: string) => void;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrganizationSpecialist | null>(null);
  const query = search.trim().toLowerCase();
  const specialists = useMemo(() => organization?.specialists ?? [], [organization]);
  const byDomain = useMemo(() => {
    const groups = new Map<string, OrganizationSpecialist[]>();
    for (const specialist of specialists) {
      if (query && !`${specialist.name} ${specialist.boundary} ${specialist.triggers.join(" ")}`.toLowerCase().includes(query)) continue;
      groups.set(specialist.domain, [...(groups.get(specialist.domain) ?? []), specialist]);
    }
    return groups;
  }, [specialists, query]);

  if (failed) return <p className="employee-error" role="status">{t("AgentLibrary.expertiseUnavailable")}</p>;
  if (loading || !organization?.specialists) return <p className="library-empty">{t("AgentLibrary.loadingExpertise")}</p>;

  const recent = detail ? work.filter((task) => !task.employeeId && task.agentId === detail.id).slice(0, 3) : [];
  return <div className="expertise-library">
    <p className="expertise-intro">{t("AgentLibrary.expertiseIntro", { specialists: organization.counts.specialists, domains: organization.counts.domains })}</p>
    <div className="expertise-domains">
      {organization.leads.filter((lead) => byDomain.has(lead.domain)).map((lead) => {
        const team = byDomain.get(lead.domain) ?? [];
        const expanded = open === lead.domain || Boolean(query);
        return <section className="expertise-domain" key={lead.domain} data-open={expanded}>
          <button type="button" className="expertise-domain-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded && !query ? null : lead.domain)}>
            <span><strong>{lead.name.replace(/ Lead$/, "")}</strong><small>{t("AgentLibrary.domainRow", { count: team.length, lead: lead.name })}</small></span>
            <NavArrowDown width={16} height={16} aria-hidden/>
          </button>
          {expanded && <div className="expertise-domain-body">
            <div className="agent-folder-grid expertise-lead"><OrganizationCard id={lead.id} name={lead.name} subtitle={t("AgentLibrary.leadSubtitle")} detail={lead.summary} work={work} onOpen={() => onOpenLead(lead.id)}/></div>
            <div className="specialist-grid">
              {team.map((specialist) => <button type="button" className="specialist-card" key={specialist.id} onClick={() => setDetail(specialist)}>
                <strong>{specialist.name}</strong>
                <span>{specialist.boundary}</span>
                <small>{specialist.capabilities.slice(0, 3).map(capabilityLabel).join(" · ")}</small>
              </button>)}
            </div>
          </div>}
        </section>;
      })}
    </div>
    {!byDomain.size && <p className="library-empty">{t("AgentLibrary.noResults")}</p>}

    <Dialog.Root open={!!detail} onOpenChange={(next) => { if (!next) setDetail(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="agent-library-dialog specialist-dialog">
      {detail && <>
        <div className="library-dialog-heading"><div><p className="eyebrow">{organization.leads.find((lead) => lead.domain === detail.domain)?.name}</p><Dialog.Title>{detail.name}</Dialog.Title></div><Dialog.Close className="icon-button" aria-label={t("Overview.close")}><Xmark width={20} height={20}/></Dialog.Close></div>
        <Dialog.Description className="library-objective">{detail.boundary}</Dialog.Description>
        <dl className="specialist-facts">
          <dt>{t("AgentLibrary.whenUsed")}</dt><dd>{detail.triggers.join(", ")}</dd>
          <dt>{t("AgentLibrary.needs")}</dt><dd><ul>{detail.inputs.map((item) => <li key={item}>{item}</li>)}</ul></dd>
          <dt>{t("AgentLibrary.canDo")}</dt><dd><ul>{detail.outputs.map((item) => <li key={item}>{item}</li>)}</ul></dd>
          <dt>{t("AgentLibrary.systems")}</dt><dd>{detail.capabilities.map(capabilityLabel).join(" · ")}</dd>
          <dt>{t("AgentLibrary.doneWhen")}</dt><dd>{detail.completion.doneWhen} <span className="specialist-not">{detail.completion.notDoneWhen}</span></dd>
          <dt>{t("AgentLibrary.requiresApproval")}</dt><dd>{detail.approvals.length ? <ul>{detail.approvals.map((item) => <li key={item}>{item}</li>)}</ul> : t("AgentLibrary.nothingNeedsApproval")}</dd>
          <dt>{t("AgentLibrary.cannotDo")}</dt><dd><ul>{detail.forbidden.map((item) => <li key={item}>{item}</li>)}</ul></dd>
          <dt>{t("AgentLibrary.notTheSame", { name: detail.notThis.name })}</dt><dd>{detail.notThis.because}</dd>
          {!!detail.collaborators.length && <><dt>{t("AgentLibrary.worksWith")}</dt><dd>{detail.collaborators.map((row) => row.name).join(", ")}</dd></>}
          <dt>{t("AgentLibrary.recentWork")}</dt><dd>{recent.length ? <ul>{recent.map((task) => <li key={task.id}>{task.goal}</li>)}</ul> : t("AgentLibrary.noRecentWork")}</dd>
        </dl>
      </>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
