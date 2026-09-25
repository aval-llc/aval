"use client";

import { useId } from "react";
import { SHAPES, type ShapeId } from "./shapes";
import { THEMES, type ThemeId } from "./themes";
import { renderShapeLayer } from "./render-shape";
import { useOptionalAppearance } from "../appearance-provider";
import { CharacterAvatar } from "../character-avatar";
import { defaultAgentAvatar, currentAvatar } from "@/lib/appearance";

export interface AvalAgentAvatarProps {
  personaId?: string;
  shape: ShapeId;
  theme: ThemeId;
  /** Pixel size of the square container. The brief's tested range is 24-64. */
  size?: number;
  /** Raises luminosity/bloom/rim rather than adding a ring — see the design brief's interaction section. */
  selected?: boolean;
  /** Adds a hover state (subtle bloom/luminosity increase). Purely visual — wrap in a real <button> for behavior. */
  interactive?: boolean;
  label?: string;
  className?: string;
  /**
   * A finished icon image (the six built-in personas' own commissioned
   * artwork — a self-contained rounded-square glyph with its own baked-in
   * background) — when set, this renders in place of the procedural
   * shape+theme silhouette below, which stays reserved for personas with no
   * fixed artwork of their own: custom, user-created personas, and the
   * shape/theme swatch pickers used to build one.
   */
  icon?: string;
}

/**
 * An abstract, illuminated agent avatar: a dark dimensional silhouette
 * (`shape`) lit by an asymmetric two-source gradient (`theme`), with a
 * blurred bloom halo, a thin inner rim highlight, and a small specular
 * hotspot. Shape and theme are fully independent — any of the 6 shapes
 * can carry any of the 6 themes (see shapes.tsx / themes.ts) — so new
 * agent personas are a config entry, not a new graphic.
 *
 * Three-layer SVG structure per avatar:
 *  1. an unmasked, blurred, primary-colored copy of the shape sitting
 *     behind everything — the only layer allowed to bleed past the
 *     silhouette edge (the bloom).
 *  2. the shape's own silhouette used as an SVG <mask>, constraining a
 *     dark base gradient plus two asymmetric radial lights (primary top
 *     right, secondary bottom left) to an otherwise perfectly crisp edge.
 *  3. inside that same mask: a thin rim-light outline and a small
 *     specular ellipse, both slightly blurred.
 * Every id is instance-scoped via useId() so multiple avatars in one
 * page never collide on <mask>/<gradient> references.
 */
export function AvalAgentAvatar({ shape, theme: themeId, size = 40, selected = false, interactive = false, label, className, icon, personaId }: AvalAgentAvatarProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const preferences = useOptionalAppearance();
  const customAvatar = personaId ? preferences?.appearance.agents[personaId] : undefined;
  const geometry = SHAPES[shape];
  const theme = THEMES[themeId];
  const iconContainerClassName = ["aval-agent-avatar", "aval-agent-avatar-icon", interactive && "aval-agent-avatar-interactive", selected && "aval-agent-avatar-selected", className].filter(Boolean).join(" ");

  if (customAvatar) return <CharacterAvatar avatar={currentAvatar(customAvatar)} size={size} label={label} className={iconContainerClassName}/>;
  const originalId = icon?.match(/^\/personas\/([a-z-]+)\.webp$/)?.[1];
  if (personaId || originalId) {
    return <CharacterAvatar avatar={defaultAgentAvatar(personaId ?? originalId!)} size={size} label={label} className={iconContainerClassName}/>;
  }

  if (icon) {
    return (
      <div className={iconContainerClassName} style={{ width: size, height: size }} role={label ? "img" : undefined} aria-label={label}>
        <img src={icon} alt="" width={size} height={size} />
      </div>
    );
  }

  const maskId = `avatar-mask-${uid}`;
  const primaryGradId = `avatar-primary-${uid}`;
  const secondaryGradId = `avatar-secondary-${uid}`;
  const baseGradId = `avatar-base-${uid}`;
  const bloomFilterId = `avatar-bloom-${uid}`;
  const softFilterId = `avatar-soft-${uid}`;

  const bloomOpacity = selected ? 0.7 : 0.42;
  const primaryOpacity = selected ? 1 : 0.88;
  const secondaryOpacity = selected ? 0.62 : 0.42;
  const specularOpacity = selected ? 1 : 0.85;
  const rimOpacity = selected ? 0.85 : 0.5;

  // Light sources are positioned from *this shape's own* bounding box, not
  // a fixed canvas position — a fixed position tuned for one silhouette
  // falls outside a narrower shape's bounds and reads as flat/unlit.
  const { x0, y0, x1, y1 } = geometry.bbox;
  const boxWidth = x1 - x0;
  const boxHeight = y1 - y0;
  const boxDiagonal = Math.sqrt(boxWidth ** 2 + boxHeight ** 2);
  const primaryCx = x1 - boxWidth * 0.16;
  const primaryCy = y0 + boxHeight * 0.16;
  const secondaryCx = x0 + boxWidth * 0.16;
  const secondaryCy = y1 - boxHeight * 0.16;
  const lightRadius = boxDiagonal * 0.62;
  const specularCx = x1 - boxWidth * 0.2;
  const specularCy = y0 + boxHeight * 0.14;

  const containerClassName = ["aval-agent-avatar", interactive && "aval-agent-avatar-interactive", selected && "aval-agent-avatar-selected", className].filter(Boolean).join(" ");

  // Breathing room as a pixel value derived from `size`, not CSS `%` — see
  // globals.css's comment on why percentage padding doesn't work here.
  const padding = Math.round(size * 0.17);

  return (
    <div className={containerClassName} style={{ width: size, height: size, padding }} role={label ? "img" : undefined} aria-label={label}>
      <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden={label ? undefined : true}>
        <defs>
          <mask id={maskId}>{renderShapeLayer(geometry, "silhouette")}</mask>
          <radialGradient id={primaryGradId} gradientUnits="userSpaceOnUse" cx={primaryCx} cy={primaryCy} r={lightRadius}>
            <stop offset="0%" stopColor={theme.primary} stopOpacity={primaryOpacity} />
            <stop offset="55%" stopColor={theme.primary} stopOpacity={primaryOpacity * 0.38} />
            <stop offset="100%" stopColor={theme.primary} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={secondaryGradId} gradientUnits="userSpaceOnUse" cx={secondaryCx} cy={secondaryCy} r={lightRadius * 0.95}>
            <stop offset="0%" stopColor={theme.secondary} stopOpacity={secondaryOpacity} />
            <stop offset="60%" stopColor={theme.secondary} stopOpacity={secondaryOpacity * 0.32} />
            <stop offset="100%" stopColor={theme.secondary} stopOpacity="0" />
          </radialGradient>
          <linearGradient id={baseGradId} x1="10%" y1="0%" x2="90%" y2="100%">
            <stop offset="0%" stopColor={theme.base} />
            <stop offset="100%" stopColor="#000000" />
          </linearGradient>
          <filter id={bloomFilterId} x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation={selected ? 5 : 3.4} />
          </filter>
          <filter id={softFilterId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="0.7" />
          </filter>
        </defs>

        <g className="aval-agent-avatar-bloom" style={{ color: theme.primary }} filter={`url(#${bloomFilterId})`} opacity={bloomOpacity}>
          {renderShapeLayer(geometry, "bloom", "bloom")}
        </g>

        <g mask={`url(#${maskId})`}>
          <rect x={0} y={0} width={100} height={100} fill={`url(#${baseGradId})`} />
          <rect className="aval-agent-avatar-primary-light" x={0} y={0} width={100} height={100} fill={`url(#${primaryGradId})`} />
          <rect x={0} y={0} width={100} height={100} fill={`url(#${secondaryGradId})`} />
          <g className="aval-agent-avatar-rim" style={{ color: theme.rim }} filter={`url(#${softFilterId})`} opacity={rimOpacity}>
            {renderShapeLayer(geometry, "rim", "rim")}
          </g>
          <ellipse className="aval-agent-avatar-specular" cx={specularCx} cy={specularCy} rx={boxDiagonal * 0.07} ry={boxDiagonal * 0.045} fill="#ffffff" opacity={specularOpacity} filter={`url(#${softFilterId})`} />
        </g>
      </svg>
    </div>
  );
}
