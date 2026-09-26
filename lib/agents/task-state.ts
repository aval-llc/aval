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
  // Waiting on something outside Aval. An objective in any of these is neither
  // finished nor failed, and saying otherwise is the misreport the whole state
  // machine exists to prevent: a provider that has not caught up, a resident
  // who has not replied, a vendor who has not scheduled, a document that has
  // not arrived.
  "WAITING_FOR_PROVIDER",
  "WAITING_FOR_RESIDENT",
  "WAITING_FOR_VENDOR",
  "WAITING_FOR_DOCUMENT",
  // Waiting on the other two parties a property-management objective commonly
  // stalls on: an owner's decision and an applicant's reply.
  "WAITING_FOR_OWNER",
  "WAITING_FOR_APPLICANT",
  // Waiting on another Aval actor — a peer this task asked for help. Woken when
  // that peer finishes, and on a recheck timer in case the wake-up is lost.
  "WAITING_FOR_AGENT",
  // Deliberately deferred to a time, rather than waiting on a party.
  "SCHEDULED",
  // Cannot proceed and has no timer that would change that. Something outside
  // the runtime — a person, a permission, a connection — has to move first.
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  // Replaced by a revised plan. Terminal, and distinct from CANCELLED: nobody
  // asked for this work to stop, a better plan made it unnecessary.
  "SUPERSEDED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States from which no further execution happens. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["COMPLETED", "FAILED", "CANCELLED", "SUPERSEDED"]);

/**
 * States the task endpoint may hand to the runtime. A pending approval returns
 * immediately; an expired or decided one resumes. RUNNING is included so an
 * expired worker lease has a real recovery path.
 */
export const ADVANCEABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["QUEUED", "RUNNING", "WAITING_FOR_TOOL", "WAITING_FOR_APPROVAL", "PENDING_VERIFICATION", "WAITING_FOR_PROVIDER", "WAITING_FOR_RESIDENT", "WAITING_FOR_VENDOR", "WAITING_FOR_DOCUMENT", "WAITING_FOR_OWNER", "WAITING_FOR_APPLICANT", "WAITING_FOR_AGENT", "SCHEDULED"]);

/**
 * States a worker resumes on a timer rather than on an event. The claim query
 * already gates on `nextAttemptAt`, so a verification re-check waits for its
 * own wake-up instead of spinning.
 */
export const TIMER_RESUMED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["PENDING_VERIFICATION", "WAITING_FOR_PROVIDER", "WAITING_FOR_RESIDENT", "WAITING_FOR_VENDOR", "WAITING_FOR_DOCUMENT", "WAITING_FOR_OWNER", "WAITING_FOR_APPLICANT", "WAITING_FOR_AGENT", "SCHEDULED"]);

/** Waiting on a party outside Aval, as opposed to on a clock or on Aval itself. */
export const EXTERNAL_WAIT_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["WAITING_FOR_RESIDENT", "WAITING_FOR_VENDOR", "WAITING_FOR_DOCUMENT", "WAITING_FOR_OWNER", "WAITING_FOR_APPLICANT"]);

/**
 * States that are claimable only once a wake-up time has been set.
 *
 * The claim query treats a null `nextAttemptAt` as "runnable now". For work
 * that is waiting on a resident or a vendor that would mean being re-selected
 * on every tick and spending a claim a minute forever while nothing changes —
 * the same silent spin that made a parked verification unreachable. These
 * states must name the moment they expect to be worth looking at again.
 */
export const SCHEDULED_WAKE_ONLY_STATES: ReadonlySet<TaskState> = new Set<TaskState>([...EXTERNAL_WAIT_STATES, "WAITING_FOR_AGENT", "SCHEDULED", "BLOCKED", "WAITING_FOR_HUMAN"]);

/**
 * States a worker takes the lease from as themselves rather than as `QUEUED`.
 *
 * `claimTask` is an exact-status compare-and-set, so the state named here has
 * to be the row's real state or the update matches nothing. `WAITING_FOR_APPROVAL`
 * is absent on purpose: an approval-parked task takes its lease through the
 * approval path, which has already stamped one by the time the claim would run.
 */
export const CLAIM_FROM_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["RUNNING", "WAITING_FOR_TOOL", "PENDING_VERIFICATION", "WAITING_FOR_PROVIDER", "WAITING_FOR_RESIDENT", "WAITING_FOR_VENDOR", "WAITING_FOR_DOCUMENT", "WAITING_FOR_OWNER", "WAITING_FOR_APPLICANT", "WAITING_FOR_AGENT", "SCHEDULED", "BLOCKED", "WAITING_FOR_HUMAN"]);

/**
 * The state a worker should claim `status` from.
 *
 * Anything not claimable as itself is waiting in `QUEUED`. Getting this wrong
 * does not raise: the claim simply matches no row, the worker returns, and the
 * task is re-selected and re-dropped on every tick without ever advancing.
 */
export function claimFromState(status: TaskState): TaskState {
  return CLAIM_FROM_STATES.has(status) ? status : "QUEUED";
}

/**
 * How often and how long verification is attempted is resolved per provider,
 * tool, work type and risk class — see lib/agents/attempt-policy.ts. The
 * constants that used to live here governed every provider and every workflow
 * at once, which is exactly what they should not have done. The shipped
 * defaults are unchanged and now live in DEFAULT_ATTEMPT_POLICIES.
 */

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
  QUEUED: ["RUNNING", "CANCELLED", "FAILED", "SUPERSEDED"],
  RUNNING: ["WAITING_FOR_TOOL", "WAITING_FOR_APPROVAL", "PENDING_VERIFICATION", "WAITING_FOR_HUMAN", "WAITING_FOR_PROVIDER", "WAITING_FOR_RESIDENT", "WAITING_FOR_VENDOR", "WAITING_FOR_DOCUMENT", "WAITING_FOR_OWNER", "WAITING_FOR_APPLICANT", "WAITING_FOR_AGENT", "SCHEDULED", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED", "QUEUED"],
  WAITING_FOR_TOOL: ["RUNNING", "FAILED", "CANCELLED", "SUPERSEDED"],
  WAITING_FOR_APPROVAL: ["RUNNING", "CANCELLED", "FAILED"],
  // Verification either proves the effect, exhausts its budget and becomes a
  // person's problem, or is cancelled. It never returns to COMPLETED directly
  // from here without going through a run that evaluated the evidence.
  PENDING_VERIFICATION: ["RUNNING", "WAITING_FOR_HUMAN", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_FOR_HUMAN: ["RUNNING", "CANCELLED", "FAILED"],
  // Each outside-party wait resumes into a run that re-evaluates the objective,
  // escalates to a person, or is cancelled. None of them reaches COMPLETED
  // directly: completion is always a decision a run makes against the evidence.
  WAITING_FOR_PROVIDER: ["RUNNING", "WAITING_FOR_HUMAN", "BLOCKED", "FAILED", "CANCELLED"],
  WAITING_FOR_RESIDENT: ["RUNNING", "WAITING_FOR_HUMAN", "BLOCKED", "FAILED", "CANCELLED"],
  WAITING_FOR_VENDOR: ["RUNNING", "WAITING_FOR_HUMAN", "BLOCKED", "FAILED", "CANCELLED"],
  WAITING_FOR_DOCUMENT: ["RUNNING", "WAITING_FOR_HUMAN", "BLOCKED", "FAILED", "CANCELLED"],
  WAITING_FOR_OWNER: ["RUNNING", "WAITING_FOR_HUMAN", "BLOCKED", "FAILED", "CANCELLED"],
  WAITING_FOR_APPLICANT: ["RUNNING", "WAITING_FOR_HUMAN", "BLOCKED", "FAILED", "CANCELLED"],
  // A peer finished, failed, or never answered inside the parent's deadline.
  WAITING_FOR_AGENT: ["RUNNING", "WAITING_FOR_HUMAN", "FAILED", "CANCELLED"],
  SCHEDULED: ["RUNNING", "WAITING_FOR_HUMAN", "BLOCKED", "FAILED", "CANCELLED"],
  // Blocked work waits on a person or a change of configuration, so it leaves
  // only when something outside the runtime moves it.
  // …or when a connection is verified and the work is woken to re-check
  // (lib/agents/waits.ts), which is a run, not a completion.
  BLOCKED: ["RUNNING", "WAITING_FOR_HUMAN", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  SUPERSEDED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** How long a worker holds a task before another may claim it. Longer than the slowest single step (a 30s tool plus a 25s model call), short enough that a crashed run resumes promptly. */
export const LEASE_MS = 90_000;

/** Defaults chosen so one task cannot spend a workspace's whole day of model budget: 12 steps is roughly three times the chat loop's four rounds. */
export const DEFAULT_MAX_STEPS = 12;
export const DEFAULT_MAX_TOKENS = 60_000;
