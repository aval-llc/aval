"use client";

/**
 * The AI employee directory.
 *
 * Every card here comes from a row. There is no list of roles in this file, no
 * slot count, and nothing that knows about eight of anything — which is the
 * whole point: a workspace that invents "Turnover Coordinator" sees it rendered
 * by the same code that renders the ones Aval ships, because to this component
 * they are the same thing.
 *
 * Paged from the start rather than when it becomes a problem. A hundred
 * employees is an ordinary number for a directory, not an edge case.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Pause, Play, Archive, Plus, Search } from "iconoir-react";

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

const PAGE_SIZE = 24;

/** Which lifecycle actions make sense from where the employee currently is. */
function actionsFor(status: Employee["status"]): ("activate" | "pause" | "resume" | "archive")[] {
  switch (status) {
    case "draft": return ["activate", "archive"];
    case "active": return ["pause", "archive"];
    case "paused": return ["resume", "archive"];
    default: return [];
  }
}

export function EmployeeDirectory() {
  const t = useTranslations();
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", role: "", objective: "" });

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
    } finally { setBusy(null); }
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
      setError(null);
      await load();
    } finally { setBusy(null); }
  };

  const employees = directory?.employees ?? [];
  const pages = useMemo(() => Math.max(1, Math.ceil((directory?.total ?? 0) / PAGE_SIZE)), [directory?.total]);
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return <section className="panel" data-reveal>
    <div className="panel-heading">
      <div>
        <p className="eyebrow">{t("Employees.eyebrow")}</p>
        <h2>{t("Employees.title")}</h2>
      </div>
      <button className="pill-button" onClick={() => setCreating((open) => !open)} disabled={busy !== null}>
        <Plus width={15} height={15}/>{t("Employees.create")}
      </button>
    </div>

    <div className="employee-toolbar">
      <label className="employee-search">
        <Search width={14} height={14}/>
        <input placeholder={t("Employees.searchPlaceholder")} value={search} aria-label={t("Employees.searchPlaceholder")}
          onChange={(event) => { setOffset(0); setSearch(event.target.value); }}/>
      </label>
      {/* A ceiling is shown only where one is configured, rather than invented. */}
      <span className="employee-count">
        {directory?.limit == null
          ? t("Employees.countUnlimited", { count: directory?.total ?? 0 })
          : t("Employees.countOfLimit", { count: directory?.total ?? 0, limit: directory.limit })}
      </span>
    </div>

    {creating && <div className="employee-form">
      <div className="employee-form-row">
        <input placeholder={t("Employees.namePlaceholder")} value={draft.name} aria-label={t("Employees.namePlaceholder")}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}/>
        <input placeholder={t("Employees.rolePlaceholder")} value={draft.role} aria-label={t("Employees.rolePlaceholder")}
          onChange={(event) => setDraft({ ...draft, role: event.target.value })}/>
      </div>
      <input placeholder={t("Employees.objectivePlaceholder")} value={draft.objective} aria-label={t("Employees.objectivePlaceholder")}
        onChange={(event) => setDraft({ ...draft, objective: event.target.value })}/>

      {/* Templates fill the form. They are a head start, never the roster. */}
      {(directory?.templates ?? []).length > 0 && <div className="employee-templates">
        <span>{t("Employees.templateHint")}</span>
        {(directory?.templates ?? []).slice(0, 6).map((template) => <button key={template.slug} type="button" className="employee-template-chip"
          onClick={() => setDraft({ name: template.name, role: template.role, objective: template.objective })}>
          {template.role}
        </button>)}
      </div>}

      <div className="employee-form-actions">
        <p className="employee-form-note">{t("Employees.grantsNothing")}</p>
        <button className="primary-button" onClick={() => void create()}
          disabled={busy !== null || !draft.name.trim() || !draft.role.trim()}>
          {t("Employees.createConfirm")}
        </button>
      </div>
    </div>}

    {error && <p className="employee-error" role="alert">{error}</p>}

    {employees.length === 0
      ? <p className="empty-copy">{t("Employees.none")}</p>
      : <div className="employee-grid">
          {employees.map((employee) => <article key={employee.id} className="employee-card">
            <div className="employee-card-head">
              <span className="employee-identity">
                <strong>{employee.name}</strong>
                <small>{employee.role}</small>
              </span>
              <span className={`employee-status is-${employee.status}`}>{t(`Employees.status_${employee.status}`)}</span>
            </div>
            {employee.objective && <p className="employee-objective">{employee.objective}</p>}
            <div className="employee-card-foot">
              <small className="employee-count">{t(`Employees.autonomy_${employee.autonomyMode}`)}</small>
              <span className="employee-actions">
                {actionsFor(employee.status).map((action) => <button key={action} type="button" className="icon-button"
                  aria-label={t(`Employees.action_${action}`)} title={t(`Employees.action_${action}`)}
                  disabled={busy !== null} onClick={() => void act(employee.id, action)}>
                  {action === "pause" ? <Pause width={15} height={15}/>
                    : action === "archive" ? <Archive width={15} height={15}/>
                    : action === "activate" ? <Check width={15} height={15}/>
                    : <Play width={15} height={15}/>}
                </button>)}
              </span>
            </div>
          </article>)}
        </div>}

    {pages > 1 && <div className="employee-pager">
      <button className="pill-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
        {t("Employees.previous")}
      </button>
      <span className="employee-count">{t("Employees.pageOf", { page, pages })}</span>
      <button className="pill-button" disabled={page >= pages} onClick={() => setOffset(offset + PAGE_SIZE)}>
        {t("Employees.next")}
      </button>
    </div>}
  </section>;
}
