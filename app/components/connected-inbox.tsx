"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Search, SendDiagonal } from "iconoir-react";
import { BrandMark } from "./brand-mark";
import { InboundPending } from "./inbound-pending";

interface Conversation {
  id: string;
  channel: string;
  contactDisplayName: string;
  draftReply: string | null;
  messages: {
    id: string;
    direction: string;
    body: string;
    createdAt: number;
  }[];
}
export function ConnectedInbox() {
  const t = useTranslations("InboxView"),
    d = useTranslations("Workspace"),
    locale = useLocale();
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState(""),
    [reply, setReply] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/conversations", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) throw Error();
        const body = (await response.json()) as {
          conversations: Conversation[];
        };
        if (!abort.signal.aborted) {
          setConversations(body.conversations);
          setError("");
        }
      } catch {
        if (!abort.signal.aborted) setError(d("inboxLoadError"));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, [d, revision]);
  const current = conversations.find((c) => c.id === selected);
  const send = async () => {
    if (!current || !reply.trim() || sending) return;
    const body = reply.trim(),
      id = current.id;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: id, body }),
      });
      if (!response.ok) throw Error();
      setConversations((rows) =>
        rows.map((c) =>
          c.id === id
            ? {
                ...c,
                draftReply: null,
                messages: [
                  ...c.messages,
                  {
                    id: crypto.randomUUID(),
                    direction: "outbound",
                    body,
                    createdAt: Date.now(),
                  },
                ],
              }
            : c,
        ),
      );
      setReply("");
    } catch {
      setError(d("inboxSendError"));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="view-wrap">
      <header className="app-header">
        <div>
          <h1>{t("sharedInbox")}</h1>
          <p className="header-subtitle">
            {t("oneResidentTimelineAcrossEveryConnected")}
          </p>
        </div>
      </header>
      <InboundPending />
      {error && (
        <div className="enterprise-error" role="alert">
          {error}
          <button
            className="soft-button"
            onClick={() => setRevision((v) => v + 1)}
          >
            {d("retry")}
          </button>
        </div>
      )}
      <div className="inbox-window">
        <aside className="conversation-list">
          <label className="search-field">
            <Search width={18} height={18} />
            <input
              placeholder={t("searchConversations")}
              aria-label={t("searchConversations")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {conversations
            .filter((c) =>
              `${c.contactDisplayName} ${c.messages.map((m) => m.body).join(" ")}`
                .toLocaleLowerCase(locale)
                .includes(query.toLocaleLowerCase(locale)),
            )
            .map((c) => (
              <button
                disabled={sending}
                className={`conversation-row ${selected === c.id ? "active" : ""}`}
                key={c.id}
                onClick={() => {
                  setSelected(c.id);
                  setReply(c.draftReply ?? "");
                }}
              >
                <BrandMark provider={c.channel} small />
                <span>
                  <strong>{c.contactDisplayName}</strong>
                  <small>{t("liveBadge")}</small>
                  <em>{c.messages.at(-1)?.body}</em>
                </span>
              </button>
            ))}
        </aside>
        {current ? (
          <section className="message-thread">
            <header>
              <strong>{current.contactDisplayName}</strong>
            </header>
            <div className="message-canvas">
              {current.messages.map((m) => (
                <div
                  className={`message ${m.direction === "inbound" ? "received" : "sent"}`}
                  key={m.id}
                >
                  <p>{m.body}</p>
                  <span>
                    {new Date(m.createdAt).toLocaleTimeString(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              ))}
              {current.draftReply && (
                <div className="message sent draft-pending">
                  <p>{current.draftReply}</p>
                  <span>{t("draftReadyToSend")}</span>
                </div>
              )}
            </div>
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input
                disabled={sending}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                aria-label={t("writeAReplyOrAskAval")}
                placeholder={t("writeAReplyOrAskAval")}
              />
              <button
                className="primary-button"
                disabled={sending || !reply.trim()}
              >
                <SendDiagonal width={17} height={17} />
                {t("send")}
              </button>
            </form>
          </section>
        ) : (
          <section className="enterprise-empty">
            <h2>
              {d(
                loading
                  ? "loading"
                  : conversations.length
                    ? "selectConversation"
                    : "emptyInbox",
              )}
            </h2>
            <p>{d("realDataOnly")}</p>
          </section>
        )}
      </div>
    </div>
  );
}
