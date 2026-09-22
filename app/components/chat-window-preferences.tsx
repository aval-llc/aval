"use client";
import { useTranslations } from 'next-intl';
import { useAppearance } from './appearance-provider';
import { DEFAULT_CHAT_TRANSPARENCY, MAX_CHAT_TRANSPARENCY, type ChatWindowBackground } from '@/lib/appearance';

export function ChatWindowPreferences() {
  const t = useTranslations('ChatPanel');
  const a = useTranslations('Appearance');
  const { appearance, saved, setAppearance, save, loading, saving, error, reload } = useAppearance();
  const selected = appearance.chatWindowBackground ?? 'white';
  const transparency = appearance.chatWindowTransparency ?? DEFAULT_CHAT_TRANSPARENCY;
  const disabled = loading || saving || error === 'load';
  const dirty = selected !== (saved.chatWindowBackground ?? 'white') || transparency !== (saved.chatWindowTransparency ?? DEFAULT_CHAT_TRANSPARENCY);
  return <section className="settings-section chat-window-preferences">
    <div className="settings-section-label"><h3>{t('windowBackground')}</h3><p>{t('windowBackgroundHelp')}</p></div>
    <div className="settings-choice-group" role="group" aria-label={t('windowBackground')}>
      {(['white', 'glass'] as ChatWindowBackground[]).map(value => <button key={value} type="button" aria-pressed={selected === value} disabled={disabled} onClick={() => setAppearance({ ...appearance, chatWindowBackground: value })}>{t(value === 'white' ? 'whiteBackground' : 'glassBackground')}</button>)}
    </div>
    <div className="chat-transparency-control">
      <div className="chat-transparency-label"><label htmlFor="chat-window-transparency">{t('transparency')}</label><output htmlFor="chat-window-transparency">{transparency}%</output></div>
      <input id="chat-window-transparency" type="range" min={0} max={MAX_CHAT_TRANSPARENCY} step={1} value={transparency} disabled={disabled} aria-valuetext={t('transparencyValue', { value: transparency })} onChange={event => setAppearance({ ...appearance, chatWindowTransparency: Number(event.target.value) })}/>
      <div className="chat-transparency-scale"><span>{t('opaque')}</span><span>{t('moreTransparent')}</span></div>
    </div>
    <div className="chat-window-preference-save">
      <p role="status">{error ? a(error === 'load' ? 'loadError' : 'saveError') : saving ? a('saving') : dirty ? a('unsaved') : a('saved')}</p>
      {error === 'load' ? <button type="button" className="soft-button" onClick={reload}>{a('retry')}</button> : <button type="button" className="soft-button" disabled={!dirty || saving || loading} onClick={() => void save()}>{saving ? a('saving') : a('save')}</button>}
    </div>
  </section>;
}
