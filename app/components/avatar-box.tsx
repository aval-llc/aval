"use client";
import type { CSSProperties, ReactNode } from "react";
import { Plus } from "iconoir-react";

/**
 * A teammate in a rectangular box — the same shape the agent library gives its
 * "New agent" card, so people and AI employees read as one family.
 *
 * The tile floats slightly, each box offset by `index` so a row never bobs in
 * step. Blinking is deliberately not synthesized here: it belongs to the
 * artwork. Avatars render through `CharacterAvatar`, which serves an animated
 * WebP (the blink lives in its frames) and a still PNG under reduced motion, so
 * a new avatar pack animates by joining that set rather than by changing this.
 */
export function AvatarBox({
  avatar,
  name,
  detail,
  badge,
  live,
  index = 0,
  onClick,
}: {
  avatar: ReactNode;
  name: string;
  detail?: string;
  badge?: string;
  live?: boolean;
  index?: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="avatar-box"
      onClick={onClick}
      style={{ "--float-delay": `${-index * 0.9}s` } as CSSProperties}
    >
      <span className="avatar-box-tile">{avatar}</span>
      <span className="avatar-box-copy">
        <strong>{name}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {badge && (
        <span className="avatar-box-badge" data-live={live || undefined}>
          {badge}
        </span>
      )}
    </button>
  );
}

/** The same box holding a large plus: the way in for the next teammate. */
export function AvatarAddBox({
  label,
  detail,
  onClick,
  disabled,
}: {
  label: string;
  detail?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="avatar-box avatar-box-add" onClick={onClick} disabled={disabled}>
      <span className="avatar-box-tile">
        <Plus width={28} height={28} />
      </span>
      <span className="avatar-box-copy">
        <strong>{label}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </button>
  );
}

/** Two letters for someone who has not chosen an avatar yet. */
export function AvatarInitials({ name }: { name: string }) {
  const letters = name.trim().split(/[\s@._-]+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  return <span className="avatar-initials" aria-hidden="true">{letters}</span>;
}
