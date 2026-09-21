"use client";
import { ConnectionOperations } from "./connection-operations";
import { CommunicationSettings } from "./communication-settings";
import { PmsMatrix } from "./pms-matrix";
import { PmsSeat } from "./pms-seat";
import { connectionBlocker } from "@/lib/integrations/readiness";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle, NavArrowRight, Search, ShieldCheck } from "iconoir-react";
import type { Provider } from "./connection-dialog";
import { BrandMark } from "./brand-mark";
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
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(initialCategory ?? ""),
    [installed, setInstalled] = useState(false);
  const categories = [...new Set(providers.map((p) => p.category))];
  const connected = providers.filter(
    (p) => p.connection?.status === "connected" && !connectionBlocker(p.id),
  ).length;
  const filtered = useMemo(
    () =>
      providers.filter(
        (p) =>
          (!category || p.category === category) &&
          (!installed || p.connection?.status === "connected") &&
          (!query ||
            `${p.title} ${p.description} ${p.category}`
              .toLowerCase()
              .includes(query.toLowerCase())),
      ),
    [providers, category, installed, query],
  );
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
      <CommunicationSettings/>
      <PmsSeat/>
      <PmsMatrix/>
      <ConnectionOperations/>
      <div className="enterprise-toolbar">
        <div className="segmented" role="group" aria-label={t("browse")}>
          <button
            className={!installed ? "active" : ""}
            aria-pressed={!installed}
            onClick={() => setInstalled(false)}
          >
            {t("browse")}
          </button>
          <button
            className={installed ? "active" : ""}
            aria-pressed={installed}
            onClick={() => setInstalled(true)}
          >
            {t("connected")}
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
      {!installed && !query && !category && (
        <section className="catalog-intro">
          <div className="catalog-brand-strip" aria-hidden="true">
            {[
              "quickbooks",
              "appfolio",
              "slack",
              "notion",
              "outlook",
              "gmail",
            ].map((id) => (
              <BrandMark key={id} provider={id} />
            ))}
          </div>
          <div>
            <h2>{t("introTitle")}</h2>
            <p>{t("introDescription")}</p>
          </div>
          <ShieldCheck width={22} height={22} />
        </section>
      )}
      <div className="catalog-layout">
        <nav className="catalog-categories" aria-label={t("categories")}>
          <button aria-pressed={!category} onClick={() => setCategory("")}>
            {t("all")}
            <span>{providers.length}</span>
          </button>
          {categories.map((c) => (
            <button
              key={c}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {t.has(`categoryLabels.${c}`) ? t(`categoryLabels.${c}`) : c}
              <span>{providers.filter((p) => p.category === c).length}</span>
            </button>
          ))}
        </nav>
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
                  setCategory("");
                  setInstalled(false);
                }}
              >
                {t("clear")}
              </button>
            </div>
          )}
          <div className="catalog-apps">
            {filtered.map((p) => (
              <button
                className="catalog-app"
                key={p.id}
                onClick={() => onOpen(p.id)}
              >
                <BrandMark provider={p.id} />
                <span className="catalog-app-copy">
                  <strong>{p.title}</strong>
                  <small>{p.description}</small>
                  <span
                    className={`catalog-state ${p.connection?.status === "connected" && !connectionBlocker(p.id) ? "connected" : ""}`}
                  >
                    {connectionBlocker(p.id)
                      ? t("setupRequired")
                      : p.connection?.status === "connected"
                      ? t("connected")
                      : p.connection
                        ? t("needsAttention")
                        : t(p.configured ? "available" : "setupRequired")}
                  </span>
                </span>
                <NavArrowRight width={17} height={17} />
              </button>
            ))}
          </div>
          <p className="catalog-footnote">
            <ShieldCheck width={15} height={15} />
            {t("permissions")}
          </p>
        </div>
      </div>
    </div>
  );
}
