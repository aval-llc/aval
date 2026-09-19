/**
 * The task state machine, with no storage dependency.
 *
 * Split from tasks.ts (which imports `@/db`, unresolvable outside the
 * Workers/Vite build) so the transition rules can be unit-tested directly with
 * `node --test` — the same convention lib/ask-aval/persona-validation.ts
 * follows for persona validation. The rules are the part worth testing; the
 * SQL around them is verified separately against a real SQLite instance.
 */

export const TASK_STATES = [
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_TOOL",
  "WAITING_FOR_APPROVAL",
  // An external effect was accepted but is not yet proven. AVAL_AGENT.md §7.5:
  // "If an action is accepted but not confirmed, the correct state is
  // PENDING_VERIFICATION or WAITING_FOR_EXTERNAL, never COMPLETED." Without
  // this state such work had to be recorded as COMPLETED, which §17.2 lists as
  // a release blocker, or as FAILED, which is untrue because the write landed.
  "PENDING_VERIFICATION",
  // A person owns the next move. Where verification cannot be obtained inside
  // its budget the work is handed over rather than being forced to a terminal
  // state that misdescribes what happened.
  "WAITING_FOR_HUMAN",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States from which no further execution happens. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * States the task endpoint may hand to the runtime. A pending approval returns
 * immediately; an expired or decided one resumes. RUNNING is included so an
 * expired worker lease has a real recovery path.
 */
export const ADVANCEABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["QUEUED", "RUNNING", "WAITING_FOR_TOOL", "WAITING_FOR_APPROVAL", "PENDING_VERIFICATION"]);

/**
 * States a worker resumes on a timer rather than on an event. The claim query
 * already gates on `nextAttemptAt`, so a verification re-check waits for its
 * own wake-up instead of spinning.
 */
export const TIMER_RESUMED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["PENDING_VERIFICATION"]);

/** How many times verification is attempted before the work is handed to a person. */
export const MAX_VERIFICATION_ATTEMPTS = 3;

/** How long to wait between verification attempts. */
export const VERIFICATION_BACKOFF_MS = 5 * 60_000;

/**
 * Legal transitions. Written out rather than inferred so an illegal one is a
 * rejected write, not a state nobody noticed the system could reach — the case
 * this exists for is a late worker completing a task a user already cancelled.
 *
 * RUNNING → QUEUED is not a mistake: it is how a run yields at an invocation
 * boundary without ending, leaving the task claimable with its transcript
 * intact.
 */
export const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  QUEUED: ["RUNNING", "CANCELLED", "FAILED"],
  RUNNING: ["WAITING_FOR_TOOL", "WAITING_FOR_APPROVAL", "PENDING_VERIFICATION", "WAITING_FOR_HUMAN", "COMPLETED", "FAILED", "CANCELLED", "QUEUED"],
  WAITING_FOR_TOOL: ["RUNNING", "FAILED", "CANCELLED"],
  WAITING_FOR_APPROVAL: ["RUNNING", "CANCELLED", "FAILED"],
  // Verification either proves the effect, exhausts its budget and becomes a
  // person's problem, or is cancelled. It never returns to COMPLETED directly
  // from here without going through a run that evaluated the evidence.
  PENDING_VERIFICATION: ["RUNNING", "WAITING_FOR_HUMAN", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_FOR_HUMAN: ["RUNNING", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** How long a worker holds a task before another may claim it. Longer than the slowest single step (a 30s tool plus a 25s model call), short enough that a crashed run resumes promptly. */
export const LEASE_MS = 90_000;

/** Defaults chosen so one task cannot spend a workspace's whole day of model budget: 12 steps is roughly three times the chat loop's four rounds. */
export const DEFAULT_MAX_STEPS = 12;
export const DEFAULT_MAX_TOKENS = 60_000;
