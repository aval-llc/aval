"use client";
import { Component, useEffect, useState, type ReactNode } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { BorderBeam } from 'border-beam';
import { VoiceBeam } from 'voice-glow';
import { Liquid } from 'liquid-gooey';
import { Plus } from 'lucide-react';
import { getThinkingOrbState, type VisualActivity } from '@/lib/ask-aval/visual-activity';

export function useCalmMotion() {
  const [paused, setPaused] = useState(true);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPaused(media.matches || document.hidden);
    update(); media.addEventListener('change', update); document.addEventListener('visibilitychange', update);
    return () => { media.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  return paused;
}
export class EffectFallback extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
export function AvalThinkingOrb({ activity = 'idle', size = 20, paused = false }: { activity?: VisualActivity; size?: 20 | 64; paused?: boolean }) {
  const calm = useCalmMotion();
  return <span className="aval-thinking-orb" data-orb-state={getThinkingOrbState(activity)} aria-hidden="true"><EffectFallback fallback={<span className="aval-orb-fallback">✦</span>}><ThinkingOrb size={size} state={getThinkingOrbState(activity)} theme="auto" paused={calm || paused} /></EffectFallback></span>;
}
export function AvalGreeting({ text }: { text: string }) {
  const [length, setLength] = useState(0);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval>;
    const start = () => {
      clearInterval(timer);
      let count = 0;
      timer = setInterval(() => {
        count = media.matches ? text.length : Math.min(text.length, count + 3);
        setLength(count);
        if (count === text.length) clearInterval(timer);
      }, 12);
    };
    start(); media.addEventListener('change', start);
    return () => { clearInterval(timer); media.removeEventListener('change', start); };
  }, [text]);
  return <p className="aval-greeting"><span className="sr-only">{text}</span><span className="aval-greeting-typed" aria-hidden="true">{text.slice(0, length)}</span><span className="aval-greeting-static" aria-hidden="true">{text}</span></p>;
}
export function AvalComposerEffects({ children, active, stream, processing, dark }: { children: ReactNode; active: boolean; stream: MediaStream | null; processing: boolean; dark: boolean }) {
  const paused = useCalmMotion();
  const voice = !!stream || processing;
  return <div className="aval-composer-effects">{children}<div className="aval-composer-decoration" aria-hidden="true"><EffectFallback fallback={null}><BorderBeam className="aval-composer-beam" size="line" colorVariant="colorful" borderRadius={26} strength={voice ? 0 : active ? 1 : .85} brightness={1.6} active={!voice && !paused} duration={4} theme={dark ? 'dark' : 'light'}>
    <VoiceBeam className="aval-voice-beam" stream={stream} processing={processing} active={voice} paused={paused} colorVariant="ice" theme={dark ? 'dark' : 'light'} strength={.45}><div className="aval-composer-effect-fill"/></VoiceBeam>
  </BorderBeam></EffectFallback></div></div>;
}
export function AvalLiquidActions({ label, actions }: { label: string; actions: { label: string; icon: ReactNode; run: () => void; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const paused = useCalmMotion();
  const itemStyle = { position: 'absolute' as const, top: 0, left: 0, width: 30, height: 30 };
  const buttons = <>{actions.map((action, i) => <Liquid.Item style={itemStyle} key={action.label} x={open ? i * 50 : 0} y={open ? -118 : 0} transition={paused ? { duration: 0 } : 'bouncy'} delay={paused ? 0 : i * 35}>
    <button type="button" className="aval-liquid-action" disabled={action.disabled} tabIndex={open ? 0 : -1} aria-hidden={!open} style={{ visibility: open ? 'visible' : 'hidden' }} title={action.label} aria-label={action.label} onClick={() => { setOpen(false); action.run(); }}>{action.icon}</button>
  </Liquid.Item>)}<Liquid.Item style={itemStyle}><button type="button" className="aval-liquid-action" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}><Plus size={18}/></button></Liquid.Item></>;
  return <div className="aval-liquid-actions" role="toolbar" aria-label={label} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }} onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); e.currentTarget.querySelector<HTMLButtonElement>('button[aria-expanded]')?.focus(); } }}>
    <EffectFallback fallback={<details><summary>{label}</summary>{actions.map(a => <button type="button" key={a.label} disabled={a.disabled} onClick={a.run}>{a.label}</button>)}</details>}><Liquid blur={6} contrast={18} fill="var(--surface-raised)" shadow="0 3px 12px rgba(0,0,0,.08)" filterPadding={90}>{buttons}</Liquid></EffectFallback>
  </div>;
}
