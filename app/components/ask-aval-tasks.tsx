"use client";
/* eslint-disable jsx-a11y/no-autofocus */

/**
 * "Ask Aval Tasks" — drafts (proposals, memos, reports) that Claude is
 * writing, live. Each job is a real call to /api/assistant/draft (the same
 * tool-loop + faithfulness gate as Ask Aval's chat answers); several can run
 * at once since each is just an independent fetch. The progressive reveal
 * you see in the preview plays out client-side once the verified document
 * arrives — pausing/resuming controls that playback, not the model call
 * itself (which has already finished by the time the first words appear).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useTranslations } from "next-intl";
import {
  Trash,
  Check,
  Clock,
  Download,
  NavArrowRight,
  Page,
  Pause,
  Play,
  RefreshDouble,
  SendDiagonal,
  WarningTriangle,
  Xmark,
} from "iconoir-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useExperience } from "@/app/components/experience";
import {
  exportDocx,
  exportPdf,
  exportPptx,
  exportXlsx,
} from "@/lib/ask-aval/export";
import { MarkdownPreview } from "@/app/components/markdown-preview";

export type DraftFormat = "docx" | "xlsx" | "pptx";
export type DraftStatus = "queued" | "streaming" | "paused" | "done" | "error";

export interface CreateDraftInput {
  title: string;
  instructions: string;
  format: DraftFormat;
  moduleLabel?: string;
  moduleSnapshot?: string;
  // Eyebrow label for the exported document's house style (e.g. "Weekly report").
  // Purely a display label chosen by the caller, never invented downstream.
  documentType?: string;
  // Which named agent persona (lib/ask-aval/personas.ts) drafted this — omit for the general assistant.
  personaId?: string;
}

interface DraftMetric {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number;
}
export interface DraftChart {
  metric: string;
  title: string;
  points: { x: string; y: number }[];
}

export interface DraftJob {
  id: string;
  input: CreateDraftInput;
  status: DraftStatus;
  content: string;
  fullText: string;
  headline?: string;
  narrative?: string;
  metrics?: DraftMetric[];
  chart?: DraftChart;
  confidence?: "high" | "medium" | "low";
  error?: string;
  progress: number;
  createdAt: number;
  sentTo?: string;
}

const REVEAL_TICK_MS = 55;
const REVEAL_TICKS = 140;

function wordChunks(text: string): string[] {
  return text.split(/(\s+)/).filter(Boolean);
}

export function useDraftJobs(locale: string) {
  const [jobs, setJobs] = useState<DraftJob[]>([]);
  const deleted = useRef(new Set<string>());
  const [loading, setLoading] = useState(true);
  const controllers = useRef(new Map<string, AbortController>());
  const timers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const wordCache = useRef(new Map<string, string[]>());

  const patchJob = useCallback(
    (
      id: string,
      patch: Partial<DraftJob> | ((job: DraftJob) => Partial<DraftJob>),
    ) => {
      setJobs((current) =>
        current.map((job) =>
          job.id === id
            ? { ...job, ...(typeof patch === "function" ? patch(job) : patch) }
            : job,
        ),
      );
    },
    [],
  );

  const stopReveal = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      timers.current.delete(id);
    }
  }, []);

  const startReveal = useCallback(
    (id: string, fullText: string, fromChars: number) => {
      stopReveal(id);
      let words = wordCache.current.get(id);
      if (!words) {
        words = wordChunks(fullText);
        wordCache.current.set(id, words);
      }
      const chunkSize = Math.max(1, Math.ceil(words.length / REVEAL_TICKS));
      let revealedChars = fromChars;
      let wordIndex = 0;
      let seen = 0;
      for (const word of words) {
        seen += word.length;
        wordIndex++;
        if (seen >= revealedChars) break;
      }
      const timer = setInterval(() => {
        wordIndex = Math.min(words!.length, wordIndex + chunkSize);
        const text = words!.slice(0, wordIndex).join("");
        revealedChars = text.length;
        const progress = Math.min(
          100,
          Math.round((revealedChars / Math.max(1, fullText.length)) * 100),
        );
        patchJob(id, { content: text, progress });
        if (wordIndex >= words!.length) {
          stopReveal(id);
          patchJob(id, { status: "done", content: fullText, progress: 100 });
        }
      }, REVEAL_TICK_MS);
      timers.current.set(id, timer);
    },
    [patchJob, stopReveal],
  );

  const runFetch = useCallback(
    (id: string, input: CreateDraftInput) => {
      controllers.current.get(id)?.abort();
      const controller = new AbortController();
      controllers.current.set(id, controller);
      patchJob(id, { status: "queued", progress: 0 });

      (async () => {
        try {
          const response = await fetch("/api/assistant/draft", {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              id,
              title: input.title,
              instructions: input.instructions,
              format: input.format,
              locale,
              moduleLabel: input.moduleLabel,
              moduleSnapshot: input.moduleSnapshot,
              documentType: input.documentType,
              personaId: input.personaId,
            }),
          });
          const data = (await response.json().catch(() => ({}))) as Record<
            string,
            unknown
          > & { error?: string };
          if (
            !response.ok ||
            typeof data.headline !== "string" ||
            typeof data.document !== "string"
          ) {
            throw new Error(
              typeof data.error === "string"
                ? data.error
                : "The draft could not be generated.",
            );
          }
          if (
            controller.signal.aborted ||
            deleted.current.has(id) ||
            controllers.current.get(id) !== controller
          )
            return;
          controllers.current.delete(id);
          patchJob(id, {
            status: "streaming",
            fullText: data.document as string,
            headline: data.headline as string,
            narrative:
              typeof data.narrative === "string" ? data.narrative : undefined,
            metrics: Array.isArray(data.metrics)
              ? (data.metrics as DraftMetric[])
              : [],
            chart: (data.chart as DraftChart | undefined) ?? undefined,
            confidence:
              (data.confidence as DraftJob["confidence"]) ?? undefined,
          });
          startReveal(id, data.document as string, 0);
        } catch (err) {
          if (controllers.current.get(id) !== controller) return;
          controllers.current.delete(id);
          if (err instanceof Error && err.name === "AbortError") return; // paused before it arrived — pauseJob already set status
          patchJob(id, {
            status: "error",
            error:
              err instanceof Error
                ? err.message
                : "The draft could not be generated.",
          });
        }
      })();
    },
    [locale, patchJob, startReveal],
  );

  useEffect(() => {
    const abort = new AbortController();
    (async () => {
      try {
        const response = await fetch("/api/assistant/documents", {
          signal: abort.signal,
          cache: "no-store",
        });
        const data = (await response.json()) as {
          documents?: Array<{
            id: string;
            title: string;
            instructions: string;
            format: DraftFormat;
            status: string;
            headline?: string;
            narrative?: string;
            documentType?: string;
            personaId?: string | null;
            document?: string;
            metrics?: DraftMetric[];
            chart?: DraftChart;
            confidence?: DraftJob["confidence"];
            error?: string;
            sentTo?: string;
            createdAt: number;
          }>;
        };
        const persisted = (data.documents ?? []).map((row): DraftJob => ({
          id: row.id,
          input: {
            title: row.title,
            instructions: row.instructions,
            format: row.format,
            documentType: row.documentType,
            personaId: row.personaId ?? undefined,
          },
          status:
            row.status === "done"
              ? "done"
              : row.status.startsWith("queued:")
                ? "paused"
                : "error",
          content: row.document ?? "",
          fullText: row.document ?? "",
          headline: row.headline,
          narrative: row.narrative,
          metrics: row.metrics,
          chart: row.chart,
          confidence: row.confidence,
          error: row.error,
          progress: row.status === "done" ? 100 : 0,
          createdAt: row.createdAt,
          sentTo: row.sentTo,
        }));
        if (!abort.signal.aborted)
          setJobs((current) => [
            ...current,
            ...persisted.filter(
              (job) =>
                !deleted.current.has(job.id) &&
                !current.some((j) => j.id === job.id),
            ),
          ]);
      } catch {
        /* existing in-memory jobs remain available */
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, []);

  const createJob = useCallback(
    (input: CreateDraftInput): string => {
      const id = crypto.randomUUID();
      const job: DraftJob = {
        id,
        input,
        status: "queued",
        content: "",
        fullText: "",
        progress: 0,
        createdAt: Date.now(),
      };
      setJobs((current) => [job, ...current]);
      runFetch(id, input);
      return id;
    },
    [runFetch],
  );

  const pauseJob = useCallback(
    (id: string) => {
      const job = jobs.find((j) => j.id === id);
      if (!job || (job.status !== "queued" && job.status !== "streaming"))
        return;
      controllers.current.get(id)?.abort();
      stopReveal(id);
      patchJob(id, { status: "paused" });
    },
    [jobs, patchJob, stopReveal],
  );

  const resumeJob = useCallback(
    (id: string) => {
      const job = jobs.find((j) => j.id === id);
      if (!job || job.status !== "paused") return;
      if (job.fullText) {
        startReveal(id, job.fullText, job.content.length);
        patchJob(id, { status: "streaming" });
      } else runFetch(id, job.input);
    },
    [jobs, patchJob, runFetch, startReveal],
  );

  const retryJob = useCallback(
    (id: string) => {
      const job = jobs.find((j) => j.id === id);
      if (!job || job.status !== "error") return;
      wordCache.current.delete(id);
      patchJob(id, {
        content: "",
        fullText: "",
        error: undefined,
        progress: 0,
      });
      runFetch(id, job.input);
    },
    [jobs, patchJob, runFetch],
  );

  const sendJob = useCallback(
    (id: string, recipient: string) => {
      patchJob(id, { sentTo: recipient });
      fetch("/api/assistant/documents", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, sentTo: recipient }),
      }).catch(() => {});
    },
    [patchJob],
  );

  useEffect(
    () => () => {
      timers.current.forEach((timer) => clearInterval(timer));
      controllers.current.forEach((controller) => controller.abort());
    },
    [],
  );

  const removeJobs = useCallback(
    async (ids: string[]) => {
      // Clear removes the snapshot the user reviewed, without affecting drafts
      // created in another window after this action started.
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50);
        const response = await fetch("/api/assistant/documents", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: batch }),
        });
        if (!response.ok) throw new Error("Could not remove drafts");
        for (const id of batch) {
          deleted.current.add(id);
          controllers.current.get(id)?.abort();
          controllers.current.delete(id);
          stopReveal(id);
          wordCache.current.delete(id);
        }
        setJobs((current) =>
          current.filter((job) => !deleted.current.has(job.id)),
        );
      }
    },
    [stopReveal],
  );

  return {
    jobs,
    loading,
    createJob,
    pauseJob,
    resumeJob,
    retryJob,
    sendJob,
    removeJobs,
  };
}

const STATUS_META: Record<
  DraftStatus,
  { icon: typeof Clock; labelKey: string }
> = {
  queued: { icon: Clock, labelKey: "AskAvalTasks.statusQueued" },
  streaming: { icon: RefreshDouble, labelKey: "AskAvalTasks.statusStreaming" },
  paused: { icon: Pause, labelKey: "AskAvalTasks.statusPaused" },
  done: { icon: Check, labelKey: "AskAvalTasks.statusDone" },
  error: { icon: WarningTriangle, labelKey: "AskAvalTasks.statusError" },
};

function DraftJobCard({
  job,
  onPause,
  onResume,
  onRetry,
  onSend,
  onDelete,
  deleting,
}: {
  job: DraftJob;
  onDelete: (id: string) => void;
  deleting: boolean;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onSend: (id: string, recipient: string) => void;
}) {
  const t = useTranslations();
  const { notify } = useExperience();
  const [recipient, setRecipient] = useState("");
  const [exporting, setExporting] = useState<string | null>(null);
  const meta = STATUS_META[job.status];
  const StatusIcon = meta.icon;
  const canControl =
    job.status === "queued" ||
    job.status === "streaming" ||
    job.status === "paused";
  const done = job.status === "done";

  const runExport = async (kind: "native" | "pdf") => {
    if (!done) return;
    setExporting(kind);
    try {
      const draft = {
        title: job.headline ?? job.input.title,
        document: job.fullText,
        standfirst: job.narrative,
        documentType: job.input.documentType,
        metrics: job.metrics,
        chart: job.chart,
        status: job.sentTo ? ("sent" as const) : ("draft" as const),
        sentTo: job.sentTo,
      };
      if (kind === "pdf") await exportPdf(draft);
      else if (job.input.format === "xlsx") await exportXlsx(draft);
      else if (job.input.format === "pptx") await exportPptx(draft);
      else await exportDocx(draft);
      notify(t("AskAvalTasks.downloadReady"), job.input.title);
    } catch {
      notify(t("AskAvalTasks.exportFailed"));
    } finally {
      setExporting(null);
    }
  };

  const submitSend = () => {
    if (!recipient.trim()) return;
    onSend(job.id, recipient.trim());
    notify(
      t("AskAvalTasks.sentToInbox", { recipient: recipient.trim() }),
      job.input.title,
    );
    setRecipient("");
  };

  return (
    <article className={`draft-task-card status-${job.status}`}>
      <div className="draft-task-top">
        <span className={`draft-status-badge ${job.status}`}>
          <StatusIcon width={14} height={14} />
          {t(meta.labelKey)}
        </span>
        <span className="draft-task-format">
          {job.input.format.toUpperCase()}
        </span>
        <button
          type="button"
          className="icon-button draft-delete"
          disabled={deleting}
          onClick={() => onDelete(job.id)}
          aria-label={t("AskAvalTasks.deleteDraft", { title: job.input.title })}
          title={t("AskAvalTasks.delete")}
        >
          <Trash width={17} height={17} />
        </button>
      </div>
      <h3>{job.headline ?? job.input.title}</h3>
      <div className="draft-task-progress">
        <div
          className={`draft-task-progress-bar ${job.status === "queued" ? "indeterminate" : ""}`}
          style={
            job.status === "queued" ? undefined : { width: `${job.progress}%` }
          }
        />
      </div>
      {job.status === "error" ? (
        <p className="draft-task-error">{job.error}</p>
      ) : (
        <div className="draft-task-preview" aria-live="polite">
          {job.content ? (
            <MarkdownPreview text={job.content} />
          ) : (
            t("AskAvalTasks.waitingOnAval")
          )}
        </div>
      )}
      <div className="draft-task-actions">
        {canControl && job.status !== "queued" && (
          <button
            type="button"
            className="soft-button"
            onClick={() =>
              job.status === "paused" ? onResume(job.id) : onPause(job.id)
            }
          >
            {job.status === "paused" ? (
              <Play width={16} height={16} />
            ) : (
              <Pause width={16} height={16} />
            )}
            {job.status === "paused"
              ? t("AskAvalTasks.resume")
              : t("AskAvalTasks.pause")}
          </button>
        )}
        {job.status === "queued" && (
          <button
            type="button"
            className="soft-button"
            onClick={() => onPause(job.id)}
          >
            <Pause width={16} height={16} />
            {t("AskAvalTasks.pause")}
          </button>
        )}
        {job.status === "error" && (
          <button
            type="button"
            className="soft-button"
            onClick={() => onRetry(job.id)}
          >
            <RefreshDouble width={16} height={16} />
            {t("AskAvalTasks.retry")}
          </button>
        )}
        {done && (
          <>
            <button
              type="button"
              className="soft-button"
              disabled={exporting !== null}
              onClick={() => runExport("native")}
            >
              <Download width={16} height={16} />
              {exporting === "native"
                ? t("AskAvalTasks.exporting")
                : t("AskAvalTasks.downloadFormat", {
                    format: job.input.format.toUpperCase(),
                  })}
            </button>
            <button
              type="button"
              className="soft-button"
              disabled={exporting !== null}
              onClick={() => runExport("pdf")}
            >
              <Page width={16} height={16} />
              {exporting === "pdf"
                ? t("AskAvalTasks.exporting")
                : t("AskAvalTasks.downloadPdf")}
            </button>
          </>
        )}
      </div>
      {done && !job.sentTo && (
        <div className="draft-task-send">
          <input
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder={t("AskAvalTasks.sendToPlaceholder")}
            onKeyDown={(event) => event.key === "Enter" && submitSend()}
          />
          <button
            type="button"
            onClick={submitSend}
            disabled={!recipient.trim()}
            aria-label={t("AskAvalTasks.sendToInboxAction")}
          >
            <SendDiagonal width={16} height={16} />
          </button>
        </div>
      )}
      {job.sentTo && (
        <p className="draft-task-sent">
          <Check width={14} height={14} />
          {t("AskAvalTasks.sentTo", { recipient: job.sentTo })}
        </p>
      )}
    </article>
  );
}

export function AskAvalTasksSection({
  jobs,
  onCreate,
  onPause,
  onResume,
  onRetry,
  onSend,
  onRemove,
  loading = false,
  canCreate = true,
}: {
  jobs: DraftJob[];
  onRemove: (ids: string[]) => Promise<void>;
  loading?: boolean;
  canCreate?: boolean;
  onCreate: (input: CreateDraftInput) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onSend: (id: string, recipient: string) => void;
}) {
  const t = useTranslations();
  const [removing, setRemoving] = useState(false);
  const [clearIds, setClearIds] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const remove = async (ids: string[]) => {
    setRemoving(true);
    setDeleteError("");
    try {
      await onRemove(ids);
      setClearIds([]);
    } catch {
      setDeleteError(t("AskAvalTasks.deleteError"));
    } finally {
      setRemoving(false);
    }
  };
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [format, setFormat] = useState<DraftFormat>("docx");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !instructions.trim()) return;
    onCreate({
      title: title.trim(),
      instructions: instructions.trim(),
      format,
    });
    setTitle("");
    setInstructions("");
    setFormat("docx");
    setCreating(false);
  };

  return (
    <section className="ask-aval-tasks" data-reveal>
      <div className="ask-aval-tasks-heading">
        <div>
          <h2>{t("AgentLibrary.documentsTitle")}</h2>
          <p>{t("AgentLibrary.documentsSubtitle")}</p>
        </div>
        <div className="draft-heading-actions">
          <button
            type="button"
            className="soft-button"
            disabled={loading || removing || jobs.length === 0}
            onClick={() => setClearIds(jobs.map((job) => job.id))}
          >
            <Trash width={16} height={16} />
            {t("AskAvalTasks.clearAll")}
          </button>
          {canCreate && <button
            type="button"
            className="primary-button"
            disabled={removing}
            onClick={() => setCreating(true)}
          >
            <Page width={17} height={17} />
            {t("AskAvalTasks.newDraft")}
          </button>}
        </div>
      </div>
      {deleteError && (
        <p className="enterprise-error" role="alert">
          {deleteError}
        </p>
      )}
      {jobs.length === 0 ? (
        <div className="empty-column">{t("AskAvalTasks.noDraftsYet")}</div>
      ) : (
        <div className="draft-task-grid">
          {jobs.map((job) => (
            <DraftJobCard
              key={job.id}
              job={job}
              onPause={onPause}
              onResume={onResume}
              onRetry={onRetry}
              onSend={onSend}
              onDelete={(id) => void remove([id])}
              deleting={removing}
            />
          ))}
        </div>
      )}

      <Dialog.Root
        open={clearIds.length > 0}
        onOpenChange={(open) => {
          if (!open && !removing) setClearIds([]);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay employee-draft-overlay" />
          <Dialog.Content className="small-dialog employee-draft-dialog">
            <Dialog.Title>{t("AskAvalTasks.clearTitle")}</Dialog.Title>
            <Dialog.Description>
              {t("AskAvalTasks.clearDescription", { count: clearIds.length })}
            </Dialog.Description>
            {deleteError && (
              <p role="alert" className="enterprise-error">
                {deleteError}
              </p>
            )}
            <div className="dialog-actions">
              <Dialog.Close className="soft-button" disabled={removing}>
                {t("AskAvalTasks.cancel")}
              </Dialog.Close>
              <button
                type="button"
                className="primary-button"
                disabled={removing}
                onClick={() => void remove(clearIds)}
              >
                {t(
                  removing ? "AskAvalTasks.clearing" : "AskAvalTasks.clearAll",
                )}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={creating} onOpenChange={setCreating}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay employee-draft-overlay" />
          <Dialog.Content className="small-dialog employee-draft-dialog">
            <div className="dialog-top">
              <Dialog.Title>{t("AskAvalTasks.newDraft")}</Dialog.Title>
              <Dialog.Close className="icon-button">
                <Xmark width={20} height={20} />
              </Dialog.Close>
            </div>
            <form onSubmit={submit}>
              <label>
                {t("AskAvalTasks.draftTitleLabel")}
                <input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t("AskAvalTasks.draftTitlePlaceholder")}
                />
              </label>
              <label>
                {t("AskAvalTasks.instructionsLabel")}
                <textarea
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={t("AskAvalTasks.instructionsPlaceholder")}
                />
              </label>
              <label>
                {t("AskAvalTasks.formatLabel")}
                <select
                  value={format}
                  onChange={(event) =>
                    setFormat(event.target.value as DraftFormat)
                  }
                >
                  <option value="docx">{t("AskAvalTasks.formatDocx")}</option>
                  <option value="xlsx">{t("AskAvalTasks.formatXlsx")}</option>
                  <option value="pptx">{t("AskAvalTasks.formatPptx")}</option>
                </select>
              </label>
              <div className="dialog-actions">
                <Dialog.Close className="soft-button">
                  {t("AskAvalTasks.cancel")}
                </Dialog.Close>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={!title.trim() || !instructions.trim()}
                >
                  <NavArrowRight width={17} height={17} />
                  {t("AskAvalTasks.startDrafting")}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
