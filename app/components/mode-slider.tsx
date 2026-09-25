"use client";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import type { AutonomyMode } from "@/lib/agents/autonomy";

const MODES: readonly AutonomyMode[] = ["supervised", "assisted", "autonomous"];
/** Movement below this is a press, not a drag — so a click still just picks. */
const DRAG_THRESHOLD = 4;

/**
 * How much Aval does on its own, as a switch you can take hold of.
 *
 * The thumb follows the pointer while it is held and snaps to the nearest mode
 * when it is let go. That snap is the commit: nothing changes while the thumb is
 * in flight, so dragging across "Autonomous" on the way to somewhere else never
 * briefly hands Aval more authority than was meant. Once it settles, the lock
 * says the mode is set rather than merely hovered.
 *
 * Keyboard and assistive tech get the same control as a radio group: arrows
 * move, and each mode can be activated directly.
 */
export function ModeSlider({
  mode,
  onChange,
  disabled,
}: {
  mode: AutonomyMode;
  onChange: (mode: AutonomyMode) => void;
  disabled?: boolean;
}) {
  const o = useTranslations("Onboarding");
  const t = useTranslations("SetupGraph");
  const track = useRef<HTMLDivElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const press = useRef<{ x: number; dragging: boolean } | null>(null);
  // A drag ends in a pointerup and then a click on whatever is underneath. The
  // drag already committed, so that click must not commit a second time.
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<number | null>(null);

  const index = MODES.indexOf(mode);
  const shown = drag === null ? index : Math.round(drag);

  /** Where the thumb sits for a pointer at `clientX`, in segment units. */
  const positionAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return index;
    const segment = rect.width / MODES.length;
    return Math.min(MODES.length - 1, Math.max(0, (clientX - rect.left - segment / 2) / segment));
  };

  const choose = (next: AutonomyMode) => {
    if (!disabled && next !== mode) onChange(next);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    press.current = { x: event.clientX, dragging: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = press.current;
    if (!held) return;
    if (!held.dragging && Math.abs(event.clientX - held.x) < DRAG_THRESHOLD) return;
    // Capture only once this is a drag. A captured pointer's click is delivered
    // to the track instead of the button under it, so capturing on every press
    // made a plain click on a mode do nothing at all.
    if (!held.dragging) event.currentTarget.setPointerCapture(event.pointerId);
    held.dragging = true;
    setDrag(positionAt(event.clientX));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const held = press.current;
    press.current = null;
    if (!held?.dragging) return;
    // Swallow only this gesture's click. With the pointer captured, that click
    // often lands on the track rather than a button and never reaches the
    // handler that would reset the flag — which left the *next* ordinary click
    // eaten. Clearing on the next task catches exactly this gesture's click.
    swallowClick.current = true;
    setTimeout(() => { swallowClick.current = false; }, 0);
    setDrag(null);
    choose(MODES[Math.round(positionAt(event.clientX))]);
  };
  const onPointerCancel = () => {
    press.current = null;
    setDrag(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = Math.min(MODES.length - 1, Math.max(0, at + step));
    options.current[next]?.focus();
    choose(MODES[next]);
  };

  return (
    <div className="mode-slider" data-disabled={disabled || undefined}>
      <div
        ref={track}
        className="mode-slider-track"
        role="radiogroup"
        aria-label={t("independence")}
        aria-disabled={disabled || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <span
          className="mode-slider-thumb"
          aria-hidden="true"
          data-dragging={drag !== null || undefined}
          // Percentages of the thumb's own width, and the thumb is one segment
          // wide, so 100% is exactly one mode along.
          style={{ transform: `translateX(${(drag ?? index) * 100}%)` }}
        />
        {MODES.map((id, at) => (
          <button
            key={id}
            ref={(element) => { options.current[at] = element; }}
            type="button"
            role="radio"
            aria-checked={mode === id}
            tabIndex={mode === id ? 0 : -1}
            disabled={disabled}
            className="mode-slider-option"
            data-current={shown === at || undefined}
            onClick={() => {
              if (swallowClick.current) { swallowClick.current = false; return; }
              choose(id);
            }}
            onKeyDown={(event) => onKeyDown(event, at)}
          >
            {o(`options.${id}`)}
            {mode === id && drag === null && <Lock className="mode-slider-lock" size={10} aria-hidden="true" />}
          </button>
        ))}
      </div>
      <p className="mode-slider-hint">{t("modeHint")}</p>
    </div>
  );
}
