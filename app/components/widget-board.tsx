"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  CalendarDays, Check, ChevronDown, Clock3, CloudSun, ExternalLink,
  Grip, Image as ImageIcon, ListTodo, LocateFixed, Music2, Plus, RotateCcw,
} from "lucide-react";

type WidgetId = "time" | "weather" | "calendar" | "reminders" | "music";
type Layout = Record<WidgetId, { x: number; y: number; w: number; h: number }>;
interface Wallpaper {
  id: string;
  imageUrl: string;
  thumbnailUrl: string;
  alt: string;
  color: string;
  photographer: string;
  photographerUrl: string;
  photoUrl: string;
  downloadLocation: string | null;
}
interface Reminder { id: string; text: string; done: boolean }

const STORAGE_KEY = "aval-widget-board-v1";
const DEFAULT_LAYOUT: Layout = {
  time: { x: 2.5, y: 13, w: 34, h: 31 },
  weather: { x: 38, y: 13, w: 27, h: 31 },
  music: { x: 66.5, y: 13, w: 31, h: 31 },
  calendar: { x: 2.5, y: 47, w: 47, h: 50 },
  reminders: { x: 51, y: 47, w: 46.5, h: 50 },
};
const FALLBACK: Wallpaper = {
  id: "aval-fallback-lake",
  imageUrl: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1800&q=86",
  thumbnailUrl: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=360&q=72",
  alt: "Mountain lake beneath a cloudy sky",
  color: "#526d67",
  photographer: "Luca Bravo",
  photographerUrl: "https://unsplash.com/@lucabravo?utm_source=aval&utm_medium=referral",
  photoUrl: "https://unsplash.com/photos/landscape-photography-of-mountains-near-body-of-water-during-daytime-lake-and-mountain-O453M2Liufs?utm_source=aval&utm_medium=referral",
  downloadLocation: null,
};

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

function isSavedLayout(value: unknown): value is Layout {
  if (!value || typeof value !== "object") return false;
  return (Object.keys(DEFAULT_LAYOUT) as WidgetId[]).every((id) => {
    const item = (value as Partial<Layout>)[id];
    return !!item && [item.x, item.y, item.w, item.h].every((part) => typeof part === "number" && Number.isFinite(part));
  });
}

function snapLayout(candidate: Layout[WidgetId], id: WidgetId, layout: Layout): Layout[WidgetId] {
  const threshold = 1.35;
  const snapped = { ...candidate, x: Math.round(candidate.x * 2) / 2, y: Math.round(candidate.y * 2) / 2 };
  for (const [otherId, other] of Object.entries(layout) as [WidgetId, Layout[WidgetId]][]) {
    if (otherId === id) continue;
    if (Math.abs(snapped.x - (other.x + other.w)) < threshold) snapped.x = other.x + other.w;
    if (Math.abs((snapped.x + snapped.w) - other.x) < threshold) snapped.x = other.x - snapped.w;
    if (Math.abs(snapped.y - (other.y + other.h)) < threshold) snapped.y = other.y + other.h;
    if (Math.abs((snapped.y + snapped.h) - other.y) < threshold) snapped.y = other.y - snapped.h;
  }
  snapped.x = clamp(snapped.x, 0, 100 - snapped.w);
  snapped.y = clamp(snapped.y, 10, 100 - snapped.h);
  return snapped;
}

function WidgetShell({ id, title, icon, layout, active, onPointerDown, children }: {
  id: WidgetId; title: string; icon: React.ReactNode; layout: Layout[WidgetId]; active: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, id: WidgetId) => void; children: React.ReactNode;
}) {
  return <article
    className={`aval-widget aval-widget-${id}${active ? " is-dragging" : ""}`}
    style={{ left: `${layout.x}%`, top: `${layout.y}%`, width: `${layout.w}%`, height: `${layout.h}%` }}
  >
    <div className="aval-widget-handle" onPointerDown={(event) => onPointerDown(event, id)}>
      <span>{icon}{title}</span><Grip size={15} aria-hidden="true"/>
    </div>
    <div className="aval-widget-content">{children}</div>
  </article>;
}

export function WidgetBoard() {
  const t = useTranslations("WidgetBoard");
  const locale = useLocale();
  const boardRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [wallpapers, setWallpapers] = useState<Wallpaper[]>([FALLBACK]);
  const [wallpaperId, setWallpaperId] = useState(FALLBACK.id);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState<WidgetId | null>(null);
  const [music, setMusic] = useState<"spotify" | "apple">("spotify");
  const [weather, setWeather] = useState<{ temp: number; label: string } | null>(null);
  const [weatherBusy, setWeatherBusy] = useState(false);
  const [reminders, setReminders] = useState<Reminder[]>([
    { id: "lease", text: t("reminderLease"), done: false },
    { id: "owners", text: t("reminderOwners"), done: true },
  ]);
  const [newReminder, setNewReminder] = useState("");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const dragRef = useRef<{ id: WidgetId; startX: number; startY: number; origin: Layout[WidgetId] } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as { layout?: Layout; wallpaperId?: string; music?: "spotify" | "apple"; reminders?: Reminder[] } | null;
        if (isSavedLayout(saved?.layout)) setLayout(saved.layout);
        if (saved?.wallpaperId) setWallpaperId(saved.wallpaperId);
        if (saved?.music) setMusic(saved.music);
        if (saved?.reminders) setReminders(saved.reminders);
      } catch { /* A malformed local preference should never break the dashboard. */ }
      setPreferencesReady(true);
    });
    fetch("/api/unsplash/wallpapers", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ wallpapers: Wallpaper[] }> : null)
      .then((body) => { if (body?.wallpapers.length) setWallpapers(body.wallpapers); })
    .catch(() => {});
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout, wallpaperId, music, reminders })); }
    catch { /* Preferences can stay in memory when storage is unavailable. */ }
  }, [layout, wallpaperId, music, reminders, preferencesReady]);

  const selected = wallpapers.find((wallpaper) => wallpaper.id === wallpaperId) ?? wallpapers[0] ?? FALLBACK;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(now);
  const date = new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(now);
  const month = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(now);
  const calendarYear = now.getFullYear(), calendarMonth = now.getMonth();
  const calendarDays = useMemo(() => {
    const first = new Date(calendarYear, calendarMonth, 1);
    const start = new Date(first); start.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 35 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); return day; });
  }, [calendarYear, calendarMonth]);

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>, id: WidgetId) {
    if (window.matchMedia("(max-width: 760px)").matches) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id, startX: event.clientX, startY: event.clientY, origin: layout[id] };
    setDragging(id);
  }
  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current, board = boardRef.current;
    if (!drag || !board) return;
    const bounds = board.getBoundingClientRect();
    const candidate = { ...drag.origin, x: drag.origin.x + ((event.clientX - drag.startX) / bounds.width) * 100, y: drag.origin.y + ((event.clientY - drag.startY) / bounds.height) * 100 };
    setLayout((current) => ({ ...current, [drag.id]: snapLayout(candidate, drag.id, current) }));
  }
  function endDrag() { dragRef.current = null; setDragging(null); }
  function chooseWallpaper(wallpaper: Wallpaper) {
    setWallpaperId(wallpaper.id); setPickerOpen(false);
    if (wallpaper.downloadLocation) void fetch("/api/unsplash/wallpapers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ downloadLocation: wallpaper.downloadLocation }) });
  }
  function locateWeather() {
    if (!navigator.geolocation) return;
    setWeatherBusy(true);
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude.toFixed(3)}&longitude=${coords.longitude.toFixed(3)}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`);
        const body = await response.json() as { current?: { temperature_2m?: number; weather_code?: number } };
        const code = body.current?.weather_code ?? 0;
        setWeather({ temp: Math.round(body.current?.temperature_2m ?? 0), label: code <= 1 ? t("clear") : code <= 3 ? t("cloudy") : code >= 51 && code <= 67 ? t("rain") : t("mixed") });
      } catch { setWeather(null); } finally { setWeatherBusy(false); }
    }, () => setWeatherBusy(false), { timeout: 10000 });
  }
  function addReminder() {
    const text = newReminder.trim(); if (!text) return;
    setReminders((current) => [...current, { id: `${Date.now()}`, text, done: false }]); setNewReminder("");
  }

  return <section className="widget-board-wrap" aria-label={t("title")}>
    <div
      ref={boardRef}
      className="widget-board"
      style={{ backgroundColor: selected.color, backgroundImage: `linear-gradient(135deg, rgba(8,18,25,.12), rgba(5,15,25,.28)), url("${selected.imageUrl}")` }}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
    >
      <div className="widget-board-toolbar">
        <div className="wallpaper-picker">
          <button className="widget-toolbar-button" onClick={() => setPickerOpen((open) => !open)} aria-expanded={pickerOpen}>
            <ImageIcon size={16}/><span>{t("wallpaper")}</span><ChevronDown size={15}/>
          </button>
          {pickerOpen && <div className="wallpaper-menu">
            <div><strong>{t("latestWallpapers")}</strong><span>{t("poweredBy")}</span></div>
            <div className="wallpaper-grid">{wallpapers.map((wallpaper) => <button key={wallpaper.id} onClick={() => chooseWallpaper(wallpaper)} className={wallpaper.id === selected.id ? "is-selected" : ""} title={wallpaper.alt}>
              {/* Remote Unsplash thumbnails must preserve the API-provided URL and ixid. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={wallpaper.thumbnailUrl} alt=""/><span>{wallpaper.photographer}</span>
            </button>)}</div>
          </div>}
        </div>
        <span className="widget-board-hint"><Grip size={14}/>{t("dragHint")}</span>
        <button className="widget-toolbar-icon" onClick={() => setLayout(DEFAULT_LAYOUT)} aria-label={t("resetLayout")} title={t("resetLayout")}><RotateCcw size={16}/></button>
      </div>

      <WidgetShell id="time" title={t("time")} icon={<Clock3 size={15}/>} layout={layout.time} active={dragging === "time"} onPointerDown={beginDrag}>
        <div className="widget-time-value">{time}</div><p>{date}</p><span>{Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll("_", " ")}</span>
      </WidgetShell>
      <WidgetShell id="weather" title={t("weather")} icon={<CloudSun size={15}/>} layout={layout.weather} active={dragging === "weather"} onPointerDown={beginDrag}>
        {weather ? <><div className="widget-weather-value"><CloudSun/><strong>{weather.temp}°</strong></div><p>{weather.label}</p><span>{t("yourLocation")}</span></> : <button className="widget-locate" onClick={locateWeather} disabled={weatherBusy}><LocateFixed size={20}/><strong>{weatherBusy ? t("locating") : t("showWeather")}</strong><span>{t("locationPrivate")}</span></button>}
      </WidgetShell>
      <WidgetShell id="music" title={t("music")} icon={<Music2 size={15}/>} layout={layout.music} active={dragging === "music"} onPointerDown={beginDrag}>
        <div className="music-provider-toggle"><button className={music === "spotify" ? "active" : ""} onClick={() => setMusic("spotify")}>Spotify</button><button className={music === "apple" ? "active" : ""} onClick={() => setMusic("apple")}>Apple Music</button></div>
        <div className={`music-art ${music}`}><Music2/></div>
        <div className="music-meta"><strong>{t("soundtrack")}</strong><span>{music === "spotify" ? "Spotify" : "Apple Music"}</span></div>
        <a className="music-open" href={music === "spotify" ? "https://open.spotify.com/" : "https://music.apple.com/"} target="_blank" rel="noreferrer"><ExternalLink size={14}/>{t("open")}</a>
      </WidgetShell>
      <WidgetShell id="calendar" title={t("calendar")} icon={<CalendarDays size={15}/>} layout={layout.calendar} active={dragging === "calendar"} onPointerDown={beginDrag}>
        <div className="widget-calendar-title"><strong>{month}</strong><span>{now.getDate()}</span></div>
        <div className="widget-calendar-grid">{["S","M","T","W","T","F","S"].map((day, index) => <b key={`${day}-${index}`}>{day}</b>)}{calendarDays.map((day) => <span key={day.toISOString()} className={`${day.getMonth() !== now.getMonth() ? "is-outside" : ""}${day.toDateString() === now.toDateString() ? " is-today" : ""}`}>{day.getDate()}</span>)}</div>
      </WidgetShell>
      <WidgetShell id="reminders" title={t("reminders")} icon={<ListTodo size={15}/>} layout={layout.reminders} active={dragging === "reminders"} onPointerDown={beginDrag}>
        <div className="widget-reminder-list">{reminders.map((reminder) => <button key={reminder.id} className={reminder.done ? "is-done" : ""} onClick={() => setReminders((current) => current.map((item) => item.id === reminder.id ? { ...item, done: !item.done } : item))}><i>{reminder.done && <Check size={12}/>}</i><span>{reminder.text}</span></button>)}</div>
        <form className="widget-reminder-add" onSubmit={(event) => { event.preventDefault(); addReminder(); }}><input value={newReminder} onChange={(event) => setNewReminder(event.target.value)} placeholder={t("addReminder")}/><button aria-label={t("addReminder")}><Plus size={15}/></button></form>
      </WidgetShell>

      <div className="widget-attribution">{t("photoBy")} <a href={selected.photographerUrl} target="_blank" rel="noreferrer">{selected.photographer}</a> {t("on")} <a href={selected.photoUrl} target="_blank" rel="noreferrer">Unsplash</a></div>
    </div>
  </section>;
}
