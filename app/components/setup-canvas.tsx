"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { useTranslations } from "next-intl";
import { BorderBeam } from "border-beam";
import { ThinkingOrb } from "thinking-orbs";
import { Building, Community, Mail, NavArrowRight, Plus, Settings } from "iconoir-react";
import type { WorkspaceGraph } from "@/lib/setup/workspace-graph";
import { autonomyMode } from "@/lib/agents/autonomy";
import { BrandMark } from "./brand-mark";
import { AvalAgentAvatar } from "./agent-avatar/AgentAvatar";
import { PERSONA_PRESETS } from "./agent-avatar/personas";
import { ProfileAvatar } from "./character-avatar";
import { AvatarAddBox, AvatarBox, AvatarInitials } from "./avatar-box";
import { ModeSlider } from "./mode-slider";
import { EffectFallback } from "./agent-ui/effects";
import { useExperience } from "./experience";
import { useOnboarding } from "./preference-context";
import type { SetupProviderKind } from "./setup-provider-picker";

type Graph = WorkspaceGraph & { canManage: boolean; viewerId?: string };
type Connection = Graph["connections"][number];
type Employee = Graph["employees"][number];

/**
 * One colour per line, handed out in the order the modules appear, so a line
 * and the orb at its end always agree. A live line carries its colour at full
 * strength with a pulse travelling along it; one not yet live keeps its colour
 * faintly, so the map still says what would connect to what.
 */
const LINE_COLORS = ["#4c7dff", "#14b8a6", "#9b6bff", "#f59e0b", "#ec4899", "#0ea5e9", "#22c55e"] as const;

type Side = "left" | "right" | "down";
type Anchor = { id: string; side: Side; color: string; live: boolean };
type Point = { x: number; y: number };
type Line = Anchor & { d: string; from: Point; to: Point };

/** Half-pixel snapping keeps a 1.5px stroke crisp instead of smeared. */
const snap = (value: number) => Math.round(value * 2) / 2;

/**
 * An S-curve with flat tangents at both ends: it leaves Aval level and arrives
 * at the module level, so each line reads as one clean stroke. Every line on a
 * side starts from the same point on Aval's edge, which is what makes several
 * of them read as one line branching rather than as a tangle.
 */
function curve(side: Side, from: Point, to: Point): string {
  if (side === "down") {
    const mid = (from.y + to.y) / 2;
    return `M${from.x} ${from.y} C${from.x} ${mid} ${to.x} ${mid} ${to.x} ${to.y}`;
  }
  const mid = (from.x + to.x) / 2;
  return `M${from.x} ${from.y} C${mid} ${from.y} ${mid} ${to.y} ${to.x} ${to.y}`;
}

const sameLines = (a: readonly Line[], b: readonly Line[]) =>
  a.length === b.length && a.every((line, i) => line.d === b[i].d && line.live === b[i].live && line.color === b[i].color);

/**
 * Lines drawn from where the modules actually are.
 *
 * The previous map drew its lines in a fixed 1200×610 viewBox and hoped the
 * cards landed underneath them, which is how a Knowledge line ended up looping
 * around its own card. These are measured: every module and Aval's card are
 * observed, and a size change anywhere re-measures everything, because a size
 * change is also what moves the neighbours.
 */
function useMeasuredLines(anchors: readonly Anchor[]) {
  const canvas = useRef<HTMLDivElement>(null);
  const core = useRef<HTMLElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [lines, setLines] = useState<Line[]>([]);

  const register = (id: string) => (element: HTMLElement | null) => {
    if (element) nodes.current.set(id, element);
    else nodes.current.delete(id);
  };

  useEffect(() => {
    const frame = canvas.current;
    const center = core.current;
    if (!frame || !center) return;
    const measure = () => {
      const box = frame.getBoundingClientRect();
      const c = center.getBoundingClientRect();
      const at = (x: number, y: number): Point => ({ x: snap(x - box.left), y: snap(y - box.top) });
      const next: Line[] = [];
      for (const anchor of anchors) {
        const element = nodes.current.get(anchor.id);
        if (!element) continue;
        const r = element.getBoundingClientRect();
        const from = anchor.side === "left" ? at(c.left, c.top + c.height / 2)
          : anchor.side === "right" ? at(c.right, c.top + c.height / 2)
          : at(c.left + c.width / 2, c.bottom);
        const to = anchor.side === "left" ? at(r.right, r.top + r.height / 2)
          : anchor.side === "right" ? at(r.left, r.top + r.height / 2)
          : at(r.left + r.width / 2, r.top);
        next.push({ ...anchor, from, to, d: curve(anchor.side, from, to) });
      }
      setLines((current) => (sameLines(current, next) ? current : next));
    };
    // The observer fires once on `observe`, which is the first measure.
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(center);
    nodes.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [anchors]);

  return { canvas, core, register, lines };
}

/**
 * The chrome ball at the start of each module's row.
 *
 * Drawn in CSS. This is the single place MetalFx's liquid-metal shader would
 * render if that package is added, which is why it is a component rather than
 * a class on a span.
 */
function MetalOrb({ live, color }: { live?: boolean; color: string }) {
  return <span className="sc-orb" data-live={live || undefined} style={{ "--line": color } as CSSProperties} aria-hidden="true" />;
}

/** A module inside a pulse that breathes within its own border. */
function Module({
  live,
  reduced,
  dark,
  className = "",
  innerRef,
  children,
}: {
  live?: boolean;
  reduced: boolean;
  dark: boolean;
  className?: string;
  innerRef?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  const card = (
    <section ref={innerRef} className={`sc-module ${className}`} data-live={live || undefined}>
      {children}
    </section>
  );
  // A decorative effect that fails must not take the module with it.
  return (
    <EffectFallback fallback={card}>
      <BorderBeam
        className="sc-beam"
        size="pulse-inner"
        colorVariant="mono"
        theme={dark ? "dark" : "light"}
        active={!reduced}
        strength={live ? 0.85 : 0.4}
        borderRadius={18}
      >
        {card}
      </BorderBeam>
    </EffectFallback>
  );
}

export function SetupCanvas({
  graph,
  focused,
  running,
  reduced,
  channelNodes,
  connectionNodes,
  onOpenCore,
  onOpenConnection,
  onOpenEmployee,
  onCreateEmployee,
  onOpenTeam,
  onOpenLibrary,
  onViewAllConnections,
  openProviderPicker,
}: {
  graph: Graph;
  focused: Employee | null;
  running: boolean;
  reduced: boolean;
  channelNodes: Connection[];
  connectionNodes: Connection[];
  onOpenCore: () => void;
  onOpenConnection: (id: string) => void;
  onOpenEmployee: (id: string) => void;
  onCreateEmployee: () => void;
  onOpenTeam: () => void;
  onOpenLibrary: () => void;
  onViewAllConnections: () => void;
  openProviderPicker: (kind: SetupProviderKind) => void;
}) {
  const t = useTranslations("SetupGraph");
  const roles = useTranslations("WorkspaceMembers");
  const { theme } = useExperience();
  const dark = theme === "dark";

  const live = (item: Connection) => item.status === "connected";
  const channels = channelNodes.slice(0, 3);
  // A PMS is recognised by its capability matrix, which only PMS providers
  // carry; the stored `category` is not consistent enough to key on.
  const pms = connectionNodes.filter((item) => item.matrix !== null);
  const others = connectionNodes.filter((item) => item.matrix === null);
  const systems = others.slice(0, 3);

  // Keyed on what the lines depend on — which modules exist and whether each
  // is live — so a 15-second refresh that changes nothing draws nothing.
  const lineKey = [
    channels.map((item) => `${item.id}:${item.status}`).join(),
    pms.map((item) => item.status).join(),
    systems.map((item) => `${item.id}:${item.status}`).join(),
  ].join("|");
  const anchors = useMemo<Anchor[]>(() => {
    const [channelPart, pmsPart, systemPart] = lineKey.split("|");
    const pairs = (part: string) => part ? part.split(",").map((entry) => entry.split(":")) : [];
    const list: Omit<Anchor, "color">[] = [
      ...(channelPart
        ? pairs(channelPart).map(([id, status]) => ({ id: `channel:${id}`, side: "left" as const, live: status === "connected" }))
        : [{ id: "channel:none", side: "left" as const, live: false }]),
      { id: "pms", side: "right", live: pmsPart.split(",").includes("connected") },
      ...pairs(systemPart).map(([id, status]) => ({ id: `system:${id}`, side: "right" as const, live: status === "connected" })),
      // You are always a member, so the team line is always live.
      { id: "team", side: "down", live: true },
    ];
    return list.map((anchor, i) => ({ ...anchor, color: LINE_COLORS[i % LINE_COLORS.length] }));
  }, [lineKey]);
  const colorOf = (id: string) => anchors.find((anchor) => anchor.id === id)?.color ?? LINE_COLORS[0];

  const { canvas, core, register, lines } = useMeasuredLines(anchors);
  const origins = [...new Map(lines.map((line) => [line.side, line.from])).values()];

  const viewer = graph.humans.find((human) => human.userId === graph.viewerId);
  const people = viewer ? [viewer, ...graph.humans.filter((human) => human !== viewer)] : graph.humans;
  const roleOf = (role: string) => (roles.has(`role_${role}`) ? roles(`role_${role}`) : role);

  return (
    <div className="sc-scroll">
      <div className="sc-canvas" ref={canvas}>
        <svg className="sc-lines" aria-hidden="true">
          {lines.map((line) => (
            <g key={line.id} className="sc-line-group" data-live={line.live || undefined} style={{ "--line": line.color } as CSSProperties}>
              <path className="sc-line" d={line.d} />
              {line.live && !reduced && <path className="sc-line-pulse" d={line.d} pathLength={100} />}
              <circle className="sc-line-end" cx={line.to.x} cy={line.to.y} r={3.5} />
            </g>
          ))}
          {origins.map((point) => (
            <circle key={`${point.x}:${point.y}`} className="sc-line-origin" cx={point.x} cy={point.y} r={3} />
          ))}
        </svg>

        <div className="sc-column sc-left">
          <p className="sc-caption">{t("communication")}</p>
          {channels.map((item) => (
            <Module key={item.id} live={live(item)} reduced={reduced} dark={dark} innerRef={register(`channel:${item.id}`)}>
              <header className="sc-module-head">
                <BrandMark provider={item.provider} small />
                <strong>{item.label}</strong>
                <span className="sc-chip" data-live={live(item) || undefined}>{t(live(item) ? "online" : "offline")}</span>
              </header>
              <div className="sc-well">
                <MetalOrb live={live(item)} color={colorOf(`channel:${item.id}`)} />
                <span className={`sc-well-text${live(item) ? "" : " is-quiet"}`}>{live(item) ? item.account ?? t("workspaceConnection") : t("notConnected")}</span>
                <button type="button" className="sc-dark" onClick={() => onOpenConnection(item.id)}>{t(live(item) ? "manage" : "connect")}</button>
              </div>
            </Module>
          ))}
          {channels.length === 0 && (
            <Module reduced={reduced} dark={dark} innerRef={register("channel:none")}>
              <header className="sc-module-head">
                <span className="sc-icon"><Mail width={16} height={16} /></span>
                <strong>{t("emailMessaging")}</strong>
                <span className="sc-chip">{t("offline")}</span>
              </header>
              <div className="sc-well">
                <MetalOrb color={colorOf("channel:none")} />
                <span className="sc-well-text is-quiet">{t("notConnected")}</span>
                <button type="button" className="sc-dark" onClick={() => openProviderPicker("communication")}>{t("connect")}</button>
              </div>
            </Module>
          )}
          {channels.length > 0 && (
            <button type="button" className="sc-add" onClick={() => openProviderPicker("communication")}>
              <Plus width={14} height={14} />{t("addChannel")}
            </button>
          )}
        </div>

        <div className="sc-center">
          <Module live={running} reduced={reduced} dark={dark} className="sc-core" innerRef={core}>
            {/* The orb alone. The animated cursor that used to circle it read
                as someone else's pointer on your screen. */}
            <button type="button" className="sc-core-tile" onClick={onOpenCore} aria-label={t(running ? "working" : "ready")}>
              <span className="sc-core-orb"><ThinkingOrb state="solving" size={64} speed={running ? 1 : 0.55} paused={reduced} /></span>
            </button>
            <strong className="sc-core-name">{focused?.name ?? "Aval"}</strong>
            <span className="sc-core-summary">
              {focused?.role ?? t("teamSummary", { employees: graph.total, connections: graph.connections.filter(live).length })}
            </span>
            {!focused && <CoreMode />}
            <button type="button" className="sc-core-action" onClick={onOpenCore}>
              <Settings width={15} height={15} />{t("configure")}
            </button>
          </Module>
        </div>

        <div className="sc-column sc-right">
          <p className="sc-caption">{t("systems")}</p>
          <Module live={pms.some(live)} reduced={reduced} dark={dark} innerRef={register("pms")}>
            <header className="sc-module-head">
              <span className="sc-icon"><Building width={16} height={16} /></span>
              <strong>{t("propertySystem")}</strong>
              {pms.length > 0 && <span className="sc-chip" data-live={pms.some(live) || undefined}>{t(pms.some(live) ? "online" : "offline")}</span>}
            </header>
            {pms.map((item) => (
              <div className="sc-well" key={item.id}>
                <MetalOrb live={live(item)} color={colorOf("pms")} />
                <span className="sc-well-text">{item.label}</span>
                <button type="button" className="sc-dark" onClick={() => onOpenConnection(item.id)}>{t("manage")}</button>
              </div>
            ))}
            {pms.length === 0 && (
              <button type="button" className="sc-dashed" onClick={() => openProviderPicker("pms")}>
                <Plus width={14} height={14} />{t("connectPms")}
              </button>
            )}
          </Module>
          {systems.map((item) => (
            <Module key={item.id} live={live(item)} reduced={reduced} dark={dark} className="sc-compact" innerRef={register(`system:${item.id}`)}>
              <header className="sc-module-head">
                <BrandMark provider={item.provider} small />
                <strong>{item.label}</strong>
                <button type="button" className="sc-dark" onClick={() => onOpenConnection(item.id)}>{t(live(item) ? "manage" : "connect")}</button>
              </header>
            </Module>
          ))}
          {others.length > systems.length && (
            <button type="button" className="text-button" onClick={onViewAllConnections}>{t("viewAll", { count: others.length })}</button>
          )}
          <button type="button" className="sc-add" onClick={() => openProviderPicker("pms")}>
            <Plus width={14} height={14} />{t("addConnection")}
          </button>
        </div>

        <div className="sc-bottom">
          <Module live reduced={reduced} dark={dark} className="sc-team" innerRef={register("team")}>
            <header className="sc-team-head">
              <span className="sc-icon"><Community width={16} height={16} /></span>
              <strong>{t("teamMembers")}</strong>
              <span className="sc-chip" data-live>{t("memberCount", { count: people.length + graph.employees.length })}</span>
              <button type="button" className="sc-link" onClick={onOpenLibrary}>{t("openLibrary")}<NavArrowRight width={13} height={13} /></button>
            </header>

            <p className="sc-row-caption">{t("people")}</p>
            <div className="sc-team-grid">
              {people.slice(0, 6).map((human, i) => {
                const name = human.displayName || human.email;
                const you = human === viewer;
                return (
                  <AvatarBox
                    key={human.userId}
                    index={i}
                    avatar={you ? <ProfileAvatar name={name} size={62} /> : <AvatarInitials name={name} />}
                    name={name}
                    detail={you ? `${t("you")} · ${roleOf(human.role)}` : roleOf(human.role)}
                    badge={t("status_active")}
                    live
                    onClick={onOpenTeam}
                  />
                );
              })}
              <AvatarAddBox label={t("invite")} onClick={onOpenTeam} />
            </div>

            <p className="sc-row-caption">{t("employees")}</p>
            <div className="sc-team-grid">
              {graph.employees.slice(0, 6).map((item, i) => (
                <AvatarBox
                  key={item.id}
                  index={i + people.length}
                  avatar={<AvalAgentAvatar personaId={item.id} shape={PERSONA_PRESETS.general.shape} theme={PERSONA_PRESETS.general.theme} size={52} />}
                  name={item.name}
                  detail={item.role}
                  badge={t(`status_${item.status}`)}
                  live={item.status === "active"}
                  onClick={() => onOpenEmployee(item.id)}
                />
              ))}
              <AvatarAddBox label={t("newEmployee")} onClick={onCreateEmployee} disabled={!graph.canManage} />
            </div>
          </Module>
        </div>
      </div>
    </div>
  );
}

/** The workspace's supervision mode, set from Aval's own card. */
function CoreMode() {
  const preferences = useOnboarding();
  if (!preferences) return null;
  const mode = autonomyMode(preferences.state.preferences.autonomy[0]);
  return <ModeSlider mode={mode} disabled={preferences.busy} onChange={(next) => void preferences.setMode(next)} />;
}
