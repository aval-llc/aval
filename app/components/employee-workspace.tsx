"use client";

import type { ComponentProps } from "react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { AskAvalTasksSection } from "./ask-aval-tasks";
import { AgentTrace } from "./agent-trace";
import { AutomationTimeline } from "./automation-timeline";

export type EmployeeWorkProps = ComponentProps<typeof AskAvalTasksSection>;

/** Reuses the existing task/draft/review controls inside the owning folder. */
export function EmployeeWorkspace({ id, name, employee, work, reviewCount: initialReviewCount = 0 }: { id: string; name: string; employee: boolean; work?: EmployeeWorkProps; reviewCount?: number }) {
  const t = useTranslations();
  const [reviewCount, setReviewCount] = useState<number | null>(initialReviewCount);
  const [tab, setTab] = useState("work");
  const documents = work?.jobs.filter(job => !employee && job.input.personaId === id) ?? [];
  const legacy = work?.jobs.filter(job => !job.input.personaId) ?? [];
  const workspace = id === "general" && !employee;
  const tabs = ["work", "documents", "review", ...(workspace ? ["workspace"] : [])];
  return <div className="employee-workspace">
    <div className="library-filters employee-work-tabs" role="group" aria-label={name}>
      {tabs.map(value => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{t(`AgentLibrary.${value}Tab`)}{value === "review" && reviewCount !== null && reviewCount > 0 && <span className="employee-review-count">{reviewCount}</span>}</button>)}
    </div>
    {tab === "work" && <AgentTrace agentFilter={id} employeeFilter={employee} agentLabel={name} mode="work"/>}
    {tab === "review" && <AgentTrace agentFilter={id} employeeFilter={employee} agentLabel={name} mode="review" onReviewCount={setReviewCount}/>}
    {tab === "documents" && (employee ? <><p className="library-objective">{t("AgentLibrary.employeeDocuments")}</p><AgentTrace agentFilter={id} employeeFilter agentLabel={name} mode="documents"/></> : work && <AskAvalTasksSection {...work} jobs={documents} onCreate={input => work.onCreate({ ...input, personaId: id })}/>)}
    {tab === "workspace" && <><p className="library-objective">{t("AgentLibrary.workspaceNote")}</p><AutomationTimeline/>{work && legacy.length > 0 && <details className="execution-disclosure"><summary>{t("AgentLibrary.legacyDrafts")} · {legacy.length}</summary><p className="library-objective">{t("AgentLibrary.legacyNote")}</p><AskAvalTasksSection {...work} jobs={legacy} canCreate={false}/></details>}</>}
  </div>;
}
