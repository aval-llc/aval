"use client";
import { useEffect, useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { chartDomain } from "@/lib/charts/domain";
import type { DataState } from "@/lib/operations/dashboard-state";
import {
  chartKinds,
  finiteValue,
  segments,
  totals,
  type ChartKind,
  type Datum,
} from "@/lib/charts/geometry";
export type ChartRow = Datum;
export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}
export function DataChart({
  title,
  subtitle,
  rows,
  series,
  format,
  axisFormat,
  compact = false,
  chartId,
  temporal = false,
  additive = false,
  initialKind = "bars",
  loading = false,
  dataState = "live",
  onConnect,
  connectLabel,
}: {
  title: string;
  subtitle?: string;
  rows: ChartRow[];
  series: ChartSeries[];
  format?: (value: number) => string;
  axisFormat?: (value: number) => string;
  compact?: boolean;
  chartId?: string;
  temporal?: boolean;
  additive?: boolean;
  initialKind?: ChartKind;
  loading?: boolean;
  dataState?: DataState;
  onConnect?: () => void;
  connectLabel?: string;
}) {
  const t = useTranslations("Enterprise"),
    c = useTranslations("Charts"),
    s = useTranslations("DashboardState"),
    locale = useLocale();
  const id = useId().replace(/:/g, "");
  const [hidden, setHidden] = useState<string[]>([]),
    [table, setTable] = useState(false),
    [active, setActive] = useState<number | null>(null);
  const [selectedKind, setKind] = useState<ChartKind>(initialKind),
    [finish, setFinish] = useState("gradient");
  const [preferenceKey, setPreferenceKey] = useState("");
  const preview = dataState === "preview";
  const syncing = loading || dataState === "syncing";
  const storageKey = `aval.chart.v2.${chartId ?? title}`;
  useEffect(() => {
    let saved: { kind?: ChartKind; finish?: string } = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      /* Preferences are optional when browser storage is unavailable. */
    }
    queueMicrotask(() => {
      setKind(saved?.kind ?? initialKind);
      setFinish(saved?.finish === "hatched" ? "hatched" : "gradient");
      setPreferenceKey(storageKey);
    });
  }, [storageKey, initialKind]);
  useEffect(() => {
    if (preferenceKey !== storageKey) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ kind: selectedKind, finish }),
      );
    } catch {
      /* Preferences are optional when browser storage is unavailable. */
    }
  }, [selectedKind, finish, storageKey, preferenceKey]);
  const visible = series.filter((s) => !hidden.includes(s.key));
  const kinds = chartKinds(
    rows,
    series.map((s) => s.key),
    temporal,
    additive,
  );
  const kind = kinds.includes(selectedKind)
    ? selectedKind
    : kinds.includes(initialKind)
      ? initialKind
      : "bars";
  const stacked = kind === "stacked" || kind === "stackedArea",
    horizontal = kind === "horizontal";
  const numbers = stacked
    ? totals(
        rows,
        visible.map((s) => s.key),
      )
    : rows
        .flatMap((r) => visible.map((s) => r.values[s.key]))
        .filter(finiteValue);
  const { top, bottom, ticks } = chartDomain(numbers);
  const width = horizontal ? 740 : Math.max(620, rows.length * 65 + 85),
    height = horizontal
      ? Math.max(240, rows.length * (visible.length * 22 + 26) + 50)
      : compact
        ? 260
        : 320;
  const left = horizontal ? 145 : 65,
    right = 24,
    plotHeight = height - 70,
    plotWidth = width - left - right;
  const y = (n: number) => 20 + ((top - n) / (top - bottom)) * plotHeight;
  const hx = (n: number) => left + ((n - bottom) / (top - bottom)) * plotWidth;
  const band = plotWidth / Math.max(rows.length, 1),
    x = (i: number) => left + (i + 0.5) * band;
  const value = (n: unknown) =>
    finiteValue(n)
      ? (format?.(n) ??
        new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n))
      : "—";
  const tickValue = (n: number) =>
    axisFormat?.(n) ??
    new Intl.NumberFormat(locale, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  const fill = (j: number) =>
    `url(#${id}-${kind === "dots" ? "dots" : finish === "hatched" ? "hatch" : "gradient"}-${j})`;
  const describe = (i: number) =>
    `${rows[i].label}: ${visible.map((s) => `${s.label} ${value(rows[i].values[s.key])}`).join(", ")}`;
  const short = (s: string, n: number) =>
    s.length > n ? s.slice(0, n - 1) + "…" : s;
  return (
    <section
      className="data-chart"
      aria-labelledby={`${id}-title`}
      aria-busy={syncing}
      data-chart-kind={kind}
      data-state={dataState}
    >
      <div className="data-chart-heading">
        <div>
          <h3 id={`${id}-title`}>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
          {preview && <p className="dashboard-state-label">{s("preview")}</p>}
          {dataState === "syncing" && <p className="dashboard-state-label">{s("syncing")}</p>}
          {dataState === "empty" && <p className="dashboard-state-label">{s("empty")}</p>}
          {preview && onConnect && <button type="button" className="soft-button dashboard-connect" onClick={onConnect}>{connectLabel ?? s("connect")}</button>}
        </div>
        <div className="chart-controls">
          <label>
            <span className="sr-only">{c("representation")}</span>
            <select
              className="enterprise-select"
              aria-label={`${title}: ${c("representation")}`}
              value={kind}
              disabled={preview || syncing}
              onChange={(e) => setKind(e.target.value as ChartKind)}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {c(`kinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">{c("finish")}</span>
            <select
              className="enterprise-select"
              aria-label={`${title}: ${c("finish")}`}
              value={finish}
              disabled={preview || syncing}
              onChange={(e) => setFinish(e.target.value)}
            >
              <option value="gradient">{c("gradient")}</option>
              <option value="hatched">{c("hatched")}</option>
            </select>
          </label>
          <button
            type="button"
            className="soft-button"
            aria-pressed={table}
            disabled={preview || syncing}
            onClick={() => setTable(!table)}
          >
            {t(table ? "showChart" : "showData")}
          </button>
        </div>
      </div>
      <div className="data-chart-legend" aria-label={t("series")}>
        {series.map((s) => (
          <button
            type="button"
            aria-pressed={!hidden.includes(s.key)}
            key={s.key}
            disabled={preview || syncing}
            onClick={() =>
              setHidden((old) =>
                old.includes(s.key)
                  ? old.filter((k) => k !== s.key)
                  : old.length < series.length - 1
                    ? [...old, s.key]
                    : old,
              )
            }
          >
            <i style={{ background: s.color }} />
            {s.label}
          </button>
        ))}
      </div>
      {syncing ? (
        <div className="chart-loading" role="status">
          <span />
          {dataState === "syncing" ? s("syncing") : c("loading")}
        </div>
      ) : preview ? (
        <div className="data-chart-plot data-chart-preview" aria-hidden="true">
          <svg viewBox="0 0 620 260" width="100%" focusable="false">
            <defs><linearGradient id={`${id}-preview`} x1="0" y1="0" x2="0" y2="1"><stop stopColor={series[0]?.color ?? "var(--viz-blue)"} stopOpacity=".65"/><stop offset="1" stopColor={series[0]?.color ?? "var(--viz-blue)"} stopOpacity=".1"/></linearGradient></defs>
            {[68, 118, 168, 218].map((line) => <line key={line} x1="65" x2="596" y1={line} y2={line} stroke="var(--line)" strokeDasharray="3 6" />)}
            {initialKind === "horizontal" || initialKind === "bars" || initialKind === "stacked" || initialKind === "dots" ?
              [0, 1, 2, 3, 4].map((index) => <rect key={index} x={initialKind === "horizontal" ? 145 : 95 + index * 95} y={initialKind === "horizontal" ? 32 + index * 42 : 190 - [45, 92, 62, 116, 78][index]} width={initialKind === "horizontal" ? [295, 210, 345, 260, 185][index] : 38} height={initialKind === "horizontal" ? 16 : [45, 92, 62, 116, 78][index]} rx="4" fill={`url(#${id}-preview)`}/>) :
              <><path d="M65 183 L155 150 L245 163 L335 91 L425 120 L515 72 L596 104 L596 218 L65 218 Z" fill={`url(#${id}-preview)`}/><path d="M65 183 L155 150 L245 163 L335 91 L425 120 L515 72 L596 104" fill="none" stroke={series[0]?.color ?? "var(--viz-blue)"} strokeWidth="2.5"/></>}
          </svg>
        </div>
      ) : !rows.length || !numbers.length ? (
        <div className="enterprise-empty">
          <p>{t("noChartData")}</p>
        </div>
      ) : table ? (
        <div className="enterprise-table-wrap">
          <table className="enterprise-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{t("category")}</th>
                {visible.map((s) => (
                  <th scope="col" className="numeric" key={s.key}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{r.label}</th>
                  {visible.map((s) => (
                    <td className="numeric" key={s.key}>
                      {value(r.values[s.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="data-chart-plot" onMouseLeave={() => setActive(null)}>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              style={{
                minWidth: !horizontal && rows.length > 8 ? width : undefined,
              }}
              role="group"
              aria-labelledby={`${id}-title`}
            >
              <defs>
                {visible.map((s, j) => (
                  <g key={s.key}>
                    <linearGradient
                      id={`${id}-gradient-${j}`}
                      x1="0"
                      y1="0"
                      x2={horizontal ? "1" : "0"}
                      y2={horizontal ? "0" : "1"}
                    >
                      <stop offset="0%" stopColor={s.color} stopOpacity=".95" />
                      <stop
                        offset="100%"
                        stopColor={s.color}
                        stopOpacity=".18"
                      />
                    </linearGradient>
                    <pattern
                      id={`${id}-hatch-${j}`}
                      width="7"
                      height="7"
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(35)"
                    >
                      <rect width="7" height="7" fill={s.color} opacity=".18" />
                      <line
                        x1="0"
                        x2="0"
                        y1="0"
                        y2="7"
                        stroke={s.color}
                        strokeWidth="2.5"
                        opacity=".8"
                      />
                    </pattern>
                    <pattern
                      id={`${id}-dots-${j}`}
                      width="8"
                      height="8"
                      patternUnits="userSpaceOnUse"
                    >
                      <circle cx="4" cy="4" r="2.5" fill={s.color} />
                    </pattern>
                  </g>
                ))}
              </defs>
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={horizontal ? hx(tick) : left}
                    x2={horizontal ? hx(tick) : width - right}
                    y1={horizontal ? 18 : y(tick)}
                    y2={horizontal ? height - 36 : y(tick)}
                    stroke="var(--line)"
                    strokeDasharray={tick === 0 ? undefined : "3 6"}
                  />
                  <text
                    x={horizontal ? hx(tick) : left - 10}
                    y={horizontal ? height - 12 : y(tick) + 4}
                    textAnchor={horizontal ? "middle" : "end"}
                    className="data-axis"
                  >
                    {tickValue(tick)}
                  </text>
                </g>
              ))}
              <g
                key={`${kind}-${finish}-${rows.map((r) => visible.map((s) => r.values[s.key]).join()).join()}`}
                className="chart-reveal"
              >
                {(
                  ["line", "area", "steps", "stackedArea"] as string[]
                ).includes(kind) &&
                  visible.map((s, j) => {
                    const lower = rows.map((r) =>
                      stacked
                        ? visible
                            .slice(0, j)
                            .reduce(
                              (a, prev) => a + (r.values[prev.key] ?? 0),
                              0,
                            )
                        : 0,
                    );
                    return segments(rows.map((r) => r.values[s.key])).map(
                      (points, n) => {
                        const path = points
                          .map(
                            (p, k) =>
                              `${k === 0 ? "M" : kind === "steps" ? "H" : "L"}${x(p.index)}${k > 0 && kind === "steps" ? "V" : ","}${y(p.value + lower[p.index])}`,
                          )
                          .join(" ");
                        const area = `${path} ${[...points]
                          .reverse()
                          .map((p) => `L${x(p.index)},${y(lower[p.index])}`)
                          .join(" ")} Z`;
                        return (
                          <g key={`${s.key}-${n}`}>
                            {kind !== "line" && (
                              <path
                                d={area}
                                fill={fill(j)}
                                opacity={stacked ? 0.9 : 0.4}
                              />
                            )}
                            <path
                              d={path}
                              fill="none"
                              stroke={s.color}
                              strokeWidth="2.5"
                              strokeLinejoin="round"
                            />
                            {points.map((p) => (
                              <circle
                                key={p.index}
                                cx={x(p.index)}
                                cy={y(p.value + lower[p.index])}
                                r={active === p.index ? 5 : 3}
                                fill={s.color}
                                stroke="var(--surface)"
                                strokeWidth="1.5"
                              />
                            ))}
                          </g>
                        );
                      },
                    );
                  })}
                {(
                  ["bars", "dots", "stacked", "horizontal"] as string[]
                ).includes(kind) &&
                  rows.map((row, i) => {
                    let offset = 0;
                    return (
                      <g key={i}>
                        {visible.map((s, j) => {
                          const n = row.values[s.key];
                          if (!finiteValue(n)) return null;
                          const base = stacked ? offset : 0;
                          offset += n;
                          const barWidth = Math.min(
                            kind === "dots" ? 46 : 38,
                            (band - 16) / (stacked ? 1 : visible.length),
                          );
                          const cx = stacked
                            ? x(i) - barWidth / 2
                            : x(i) -
                              (visible.length * barWidth) / 2 +
                              j * barWidth;
                          const rowBand = (height - 60) / rows.length;
                          return (
                            <rect
                              key={s.key}
                              x={horizontal ? Math.min(hx(n), hx(0)) : cx}
                              y={
                                horizontal
                                  ? 24 + i * rowBand + j * 22
                                  : Math.min(y(base + n), y(base))
                              }
                              width={
                                horizontal
                                  ? Math.abs(hx(n) - hx(0))
                                  : Math.max(1, barWidth - 3)
                              }
                              height={
                                horizontal
                                  ? 16
                                  : Math.abs(y(base + n) - y(base))
                              }
                              rx={kind === "dots" ? 0 : stacked ? 2 : 4}
                              fill={fill(j)}
                              stroke={kind === "dots" ? s.color : "none"}
                              strokeOpacity=".18"
                            >
                              <title>{`${row.label} · ${s.label}: ${value(n)}`}</title>
                            </rect>
                          );
                        })}
                      </g>
                    );
                  })}
              </g>
              {rows.map((row, i) => (
                <g
                  key={i}
                  tabIndex={0}
                  role="button"
                  aria-label={describe(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => setActive(i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActive(i);
                    }
                    if (e.key === "Escape") setActive(null);
                  }}
                >
                  <rect
                    x={horizontal ? left : left + i * band}
                    y={horizontal ? 20 + (i * (height - 60)) / rows.length : 16}
                    width={horizontal ? plotWidth : band}
                    height={
                      horizontal ? (height - 60) / rows.length : plotHeight + 8
                    }
                    fill={active === i ? "var(--ink)" : "transparent"}
                    fillOpacity=".035"
                    rx="5"
                  />
                  {active === i && !horizontal && (
                    <line
                      x1={x(i)}
                      x2={x(i)}
                      y1="18"
                      y2={height - 46}
                      stroke="var(--muted)"
                      strokeDasharray="3 4"
                      opacity=".5"
                    />
                  )}
                  <text
                    x={horizontal ? left - 12 : x(i)}
                    y={
                      horizontal
                        ? 36 + (i * (height - 60)) / rows.length
                        : height - 16
                    }
                    textAnchor={horizontal ? "end" : "middle"}
                    className="data-axis"
                  >
                    {short(row.label, horizontal ? 21 : 17)}
                    <title>{row.label}</title>
                  </text>
                </g>
              ))}
            </svg>
            {active !== null && rows[active] && (
              <div
                className="chart-tooltip"
                role="status"
                style={{
                  left: horizontal
                    ? "50%"
                    : `${Math.max(20, Math.min(80, (x(active) / width) * 100))}%`,
                }}
              >
                <strong>{rows[active].label}</strong>
                {visible.map((s) => (
                  <span key={s.key}>
                    <i style={{ background: s.color }} />
                    {s.label}
                    <b>{value(rows[active].values[s.key])}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="data-chart-inspect" aria-live="polite">
            {active !== null && rows[active] ? (
              <>
                <strong>{rows[active].label}</strong>
                {visible.map((s) => (
                  <span key={s.key}>
                    <i style={{ background: s.color }} />
                    {s.label}
                    <b>{value(rows[active].values[s.key])}</b>
                  </span>
                ))}
              </>
            ) : (
              <span>{c(kind === "dots" ? "dotNote" : "inspect")}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
