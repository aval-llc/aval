"use client";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, NavArrowDown, Refresh } from "iconoir-react";
import { useExperience } from "@/app/components/experience";
interface TaughtPreference { topic: string; statement: string; label: string; source: string }
interface PreferenceOption { topic: string; statements: { statement: string; label: string }[] }

/** Label keys for the fixed preference taxonomy, so the picker reads as English/Spanish, not as tags. */
const PREFERENCE_TOPIC_LABEL_KEY: Record<string, string> = {
  vendor_selection: "SetupView.topicVendorSelection",
  communication_channel: "SetupView.topicCommunicationChannel",
  reporting_style: "SetupView.topicReportingStyle",
  approval_threshold: "SetupView.topicApprovalThreshold",
};

export function SetupMemory() {
  const t = useTranslations();
  const { notify } = useExperience();
  const [loaded, setLoaded] = useState(false);
  const [taught, setTaught] = useState<TaughtPreference[]>([]);
  const [options, setOptions] = useState<PreferenceOption[]>([]);
  const [teaching, setTeaching] = useState<string | null>(null);
  const [busyTopic, setBusyTopic] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftState, setDraftState] = useState<"idle" | "saving" | "noMatch">("idle");
  const [suggestions, setSuggestions] = useState<{ topic: string; text: string }[]>([]);
  const [suggestionSeed, setSuggestionSeed] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agents/memory").then(r => r.ok ? r.json() as Promise<{taught:TaughtPreference[];options:PreferenceOption[];suggestions:{topic:string;text:string}[]}> : null).catch(() => null).then(memory => {
      if (cancelled) return;
      if (memory) { setTaught(memory.taught); setOptions(memory.options); setSuggestions(memory.suggestions ?? []); }
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  const taughtByTopic = useMemo(() => new Map(taught.map((row) => [row.topic, row])), [taught]);


  async function teach(topic: string, statement: string) {
    setBusyTopic(topic);
    try {
      const response = await fetch("/api/agents/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, statement }) });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { taught: TaughtPreference[]; suggestions: { topic: string; text: string }[] };
      setTaught(body.taught);
      setSuggestions(body.suggestions ?? []);
      setTeaching(null);
      notify(t("SetupView.taughtTitle"), t("SetupView.taughtDetail"));
    } catch {
      notify(t("SetupView.teachFailedTitle"), t("SetupView.teachFailedDetail"));
    } finally { setBusyTopic(null); }
  }

  /**
   * Teaches from a typed sentence. The server classifies it into the fixed
   * taxonomy and stores only the resulting tag — the sentence itself is never
   * persisted. A 422 means it couldn't be placed confidently, which is shown
   * as "pick from the list" rather than guessed at.
   */
  async function teachFromText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setDraftState("saving");
    try {
      const response = await fetch("/api/agents/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: trimmed }) });
      if (response.status === 422) { setDraftState("noMatch"); return; }
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { taught: TaughtPreference[]; suggestions: { topic: string; text: string }[]; matched?: { topic: string; statement: string } };
      setTaught(body.taught);
      setSuggestions(body.suggestions ?? []);
      setDraft("");
      setDraftState("idle");
      const label = body.taught.find((row) => row.topic === body.matched?.topic)?.label ?? "";
      notify(t("SetupView.taughtTitle"), label || t("SetupView.taughtDetail"));
    } catch {
      setDraftState("idle");
      notify(t("SetupView.teachFailedTitle"), t("SetupView.teachFailedDetail"));
    }
  }

  async function forget(topic: string) {
    setBusyTopic(topic);
    try {
      const response = await fetch(`/api/agents/memory?topic=${encodeURIComponent(topic)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { taught: TaughtPreference[]; suggestions: { topic: string; text: string }[] };
      setTaught(body.taught);
      setSuggestions(body.suggestions ?? []);
    } catch {
      notify(t("SetupView.teachFailedTitle"), t("SetupView.teachFailedDetail"));
    } finally { setBusyTopic(null); }
  }

  return <div className="setup-memory-detail">
    {(<section className="panel memory-panel" data-reveal>
      <div className="panel-heading">
        <div><p className="eyebrow">{t("SetupView.memory")}</p><h2>{t("SetupView.whatAvalRemembers")}</h2></div>
        <span className="quiet-label">{t("SetupView.appliesEverywhere")}</span>
      </div>

      <div className="teach-box">
        <div className="teach-input-row">
          <input
            type="text"
            className="teach-input"
            placeholder={t("SetupView.teachPlaceholder")}
            value={draft}
            onChange={(event) => { setDraft(event.target.value); if (draftState === "noMatch") setDraftState("idle"); }}
            onKeyDown={(event) => { if (event.key === "Enter") teachFromText(draft); }}
            disabled={draftState === "saving" || !loaded}
            aria-label={t("SetupView.teachPlaceholder")}
          />
          <button type="button" className="primary-button" onClick={() => teachFromText(draft)} disabled={!draft.trim() || draftState === "saving" || !loaded}>
            {draftState === "saving" ? t("SetupView.saving") : t("SetupView.teachAval")}
          </button>
        </div>
        {draftState === "noMatch"
          ? <p className="teach-hint is-warning">{t("SetupView.noMatchHint")}</p>
          : <p className="teach-hint">{t("SetupView.teachHint")}</p>}

        {suggestions.length > 0 && <details className="teach-suggestions"><summary>{t("SetupView.notSureWhatToTeach")}</summary>
          <div className="teach-suggestions-head">
            <span>{t("SetupView.notSureWhatToTeach")}</span>
            <button type="button" className="text-button" onClick={() => setSuggestionSeed((seed) => seed + 1)}>
              <Refresh width={13} height={13}/>{t("SetupView.refresh")}
            </button>
          </div>
          <div className="teach-suggestion-chips">
            {/* One rotating window over the pool, so Refresh always changes
                what's on screen instead of reshuffling into the same three. */}
            {Array.from({ length: Math.min(3, suggestions.length) }, (_, offset) => suggestions[(suggestionSeed * 3 + offset) % suggestions.length]).map((suggestion, index) => (
              <button type="button" className="teach-chip" key={`${suggestion.topic}-${index}`} onClick={() => { setDraft(suggestion.text); setDraftState("idle"); }}>
                {suggestion.text}
              </button>
            ))}
          </div>
        </details>}
      </div>

      <div className="memory-grid">
        {options.map((option) => {
          const current = taughtByTopic.get(option.topic);
          const isOpen = teaching === option.topic;
          const busy = busyTopic === option.topic;
          return <article className={`memory-card${current ? " is-taught" : ""}`} key={option.topic}>
            <div className="memory-card-head">
              <div>
                <strong>{t(PREFERENCE_TOPIC_LABEL_KEY[option.topic] ?? option.topic)}</strong>
                <small>{current ? current.label : t("SetupView.nothingTaughtYet")}</small>
              </div>
              {current
                ? <span className={`status-pill ${current.source === "ask_aval" ? "" : "optional"}`}>{current.source === "ask_aval" ? t("SetupView.learnedFromChat") : t("SetupView.setHere")}</span>
                : null}
            </div>
            <div className="memory-card-actions">
              <button type="button" className="text-button" disabled={busy || !loaded} onClick={() => setTeaching(isOpen ? null : option.topic)}>
                {current ? t("SetupView.change") : t("SetupView.teachAval")}
                <NavArrowDown width={14} height={14}/>
              </button>
              {current && <button type="button" className="text-button quiet" disabled={busy} onClick={() => forget(option.topic)}>{t("SetupView.forget")}</button>}
            </div>
            {isOpen && <div className="memory-options">
              {option.statements.map((choice) => <button
                type="button"
                key={choice.statement}
                className={`memory-option${current?.statement === choice.statement ? " is-selected" : ""}`}
                disabled={busy}
                onClick={() => teach(option.topic, choice.statement)}
              >
                {current?.statement === choice.statement && <Check width={13} height={13}/>}
                <span>{choice.label}</span>
              </button>)}
            </div>}
          </article>;
        })}
      </div>

      <details className="memory-explainer"><summary>{t("AgentLibrary.aboutMemory")}</summary><p>{t("SetupView.memoryExplainer")}</p></details>
    </section>)}


  </div>;
}
