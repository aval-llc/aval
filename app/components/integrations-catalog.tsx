"use client";
import { ConnectionOperations } from "./connection-operations";
import { CommunicationSettings } from "./communication-settings";
import { PmsMatrix } from "./pms-matrix";
import { PmsSeat } from "./pms-seat";
import { PmsDesktopSession } from "./pms-desktop-session";
import { PmsWorkflows } from "./pms-workflows";
import { connectionBlocker } from "@/lib/integrations/readiness";
import { internalPreview } from "@/lib/integrations/internal-preview";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle, Search, ShieldCheck } from "iconoir-react";
import type { Provider } from "./connection-dialog";
import { BrandMark } from "./brand-mark";

/** Not a category — the tab that answers "what have we already connected?". */
const CONNECTED = "#connected";
/** Call routing is configuration for these providers, so it lives under them. */
const COMMUNICATION = "Communication";

type RowState = "connected" | "attention" | "blocked" | "available";

/**
 * One row, one state, one thing to press.
 *
 * The page used to say a provider's state in muted grey under its description,
 * which left "and what do I do about it" unanswered. The state now decides the
 * button, so every row ends in the next action rather than in a status.
 */
function rowState(provider: Provider): RowState {
  // A blocker is Aval's side of the connection being unfinished; a provider
  // that is not configured is the same problem seen from the other end.
  // Neither is something pressing "connect" can solve, so both say so.
  if (connectionBlocker(provider.id) || !provider.configured) return "blocked";
  if (provider.connection?.status === "connected") return "connected";
  if (provider.connection) return "attention";
  return "available";
}

export function IntegrationsCatalog({
  providers,
  loading,
  onOpen,
  initialCategory,
}: {
  providers: Provider[];
  loading: boolean;
  onOpen: (id: string) => void;
  initialCategory?: string;
}) {
  const t = useTranslations("Catalog");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState(initialCategory ?? "");
  // Read on the client only, and false on the server: the markup a customer
  // is served must not depend on a parameter, or the two would disagree at
  // hydration. Nothing subscribes, because the URL does not change underneath
  // this page without a navigation.
  const preview = useSyncExternalStore(
    () => () => {},
    () => internalPreview(window.location.search, "pms"),
    () => false,
  );

  const categories = [...new Set(providers.map((p) => p.category))];
  const connected = providers.filter((p) => rowState(p) === "connected").length;
  const filtered = useMemo(
    () =>
      providers.filter(
        (p) =>
          (tab === "" || (tab === CONNECTED ? rowState(p) === "connected" : p.category === tab)) &&
          (!query ||
            `${p.title} ${p.description} ${p.category}`.toLowerCase().includes(query.toLowerCase())),
      ),
    [providers, tab, query],
  );

  const label: Record<RowState, string> = {
    connected: t("connected"),
    attention: t("reconnect"),
    blocked: t("setupRequired"),
    available: t("connect"),
  };

  return (
    <div className="view-wrap integrations-catalog">
      <header className="app-header">
        <div>
          <p className="eyebrow">{t("workspace")}</p>
          <h1>{t("title")}</h1>
          <p className="header-subtitle">{t("description")}</p>
        </div>
        <span className="enterprise-status">
          <CheckCircle width={14} height={14} />
          {t("connectedCount", { count: connected })}
        </span>
      </header>

      {/* Built and testable, but not something a customer should meet here
          yet. See `internal-preview.ts`. */}
      {preview && (
        <>
          <PmsSeat />
          {/* Connecting the PMS comes before choosing what Aval may do in it. */}
          <PmsDesktopSession provider="appfolio" />
          <PmsMatrix />
          {/* What Aval can drive, and how far each one is actually proven. */}
          <PmsWorkflows />
        </>
      )}

      <div className="catalog-toolbar">
        <div className="catalog-tabs" role="tablist" aria-label={t("categories")}>
          <button role="tab" aria-selected={tab === ""} onClick={() => setTab("")}>
            {t("all")}
          </button>
          {categories.map((c) => (
            <button key={c} role="tab" aria-selected={tab === c} onClick={() => setTab(c)}>
              {t.has(`categoryLabels.${c}`) ? t(`categoryLabels.${c}`) : c}
            </button>
          ))}
          <button role="tab" aria-selected={tab === CONNECTED} onClick={() => setTab(CONNECTED)}>
            {t("connected")}
            {connected > 0 && <b>{connected}</b>}
          </button>
        </div>
        <label className="enterprise-search">
          <Search width={17} height={17} />
          <input
            placeholder={t("search")}
            aria-label={t("search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="catalog-results" aria-busy={loading}>
        {loading && (
          <p className="settings-muted" role="status">
            {t("loading")}
          </p>
        )}
        {filtered.length === 0 && !loading && (
          <div className="enterprise-empty">
            <Search width={24} height={24} />
            <h3>{t("noResults")}</h3>
            <p>{t("trySearch")}</p>
            <button
              className="soft-button"
              onClick={() => {
                setQuery("");
                setTab("");
              }}
            >
              {t("clear")}
            </button>
          </div>
        )}
        <ul className="catalog-list">
          {filtered.map((p) => {
            const state = rowState(p);
            return (
              <li className="catalog-row" key={p.id}>
                <BrandMark provider={p.id} />
                <div className="catalog-row-copy">
                  <strong>{p.title}</strong>
                  <small>{p.description}</small>
                </div>
                <button
                  className="catalog-row-action"
                  data-state={state}
                  onClick={() => onOpen(p.id)}
                >
                  {label[state]}
                  {/* Reads as "Connect Slack" to a screen reader, so a column
                      of these is not a column of identical controls. */}
                  <span className="sr-only"> {p.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="catalog-footnote">
          <ShieldCheck width={15} height={15} />
          {t("permissions")}
        </p>
      </div>

      {/* Call routing is settings for the providers above it rather than a
          destination of its own, so it sits with them instead of at the top of
          a page most people open to connect something else. */}
      {tab === COMMUNICATION && <CommunicationSettings />}
      <ConnectionOperations />
    </div>
  );
}
