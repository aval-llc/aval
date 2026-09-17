/**
 * The typed tool registry (§9 / §10 of the production-readiness guide).
 *
 * Every tool the agent runtime can execute is declared here exactly once,
 * with the facts the backend needs to decide whether to run it: what
 * permission it costs, what it would break if it went wrong, whether it
 * changes anything, how long it may take, whether a retry is safe, and
 * whether a person has to say yes first.
 *
 * Two rules keep this honest:
 *
 * 1. **A tool that is not in this registry does not execute.** `policy.ts`
 *    denies unknown names outright rather than falling through to the legacy
 *    switch in lib/ask-aval/tools.ts. Registering a tool is a deliberate act.
 * 2. **Risk level and `mutates` are declared, not derived.** A reader should
 *    be able to answer "what is the worst this agent can do" from this file
 *    alone, without tracing executors.
 *
 * The PMS write tools are the first mutating capabilities with real executors.
 * They are not gated by `unimplemented` — they are gated by
 * `lib/pms/capability.ts`, which assembles them into a request's tool list only
 * when the provider supports and permits the action, the customer's connection
 * grants it, the workspace enabled it, and Aval has actually built the path.
 * That is a stronger gate than `unimplemented`, because it is evaluated per org
 * and per provider rather than once at build time.
 *
 * The remaining gated entries at the bottom still have no executor: they define
 * the envelope a future capability will land inside, and `policy.ts` denies them
 * until one is wired, so declaring one grants nothing.
 */

import type { Permission } from "./permissions.ts";

/**
 * §10's classification. The level is about consequence, not difficulty:
 * - `low`      — reads permitted data. Runs automatically.
 * - `medium`   — creates a draft or internal record. Automatic if policy passes.
 * - `high`     — externally visible or hard to walk back. Stronger validation.
 * - `critical` — money, contracts, deletion, permissions. Approval required.
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolDescriptor {
  name: string;
  /** One line, for approval cards and audit summaries. Never shown to the model — the model reads the schema in lib/ask-aval/tools.ts. */
  summary: string;
  riskLevel: RiskLevel;
  /** True if executing it changes stored state. Drives idempotency and approval defaults. */
  mutates: boolean;
  requiredPermission: Permission;
  /** Wall-clock budget for one execution. Exceeded → the step fails with a timeout, never a hang. */
  timeoutMs: number;
  /**
   * Retries on a *transient* failure. Non-zero is only ever correct for a tool
   * that is safe to run twice — asserted against `mutates` by a test, so a
   * future mutating tool cannot quietly inherit a retry budget.
   */
  maxRetries: number;
  /** True when running it twice with the same arguments has the same effect as running it once. */
  idempotent: boolean;
  /** True when a person must approve before execution. Enforced in policy.ts; `critical` always requires it regardless of this field. */
  requiresApproval: boolean;
  /** Declared-but-unwired: policy denies these until an executor exists. */
  unimplemented?: true;
  /** Routine external actions can follow the selected execution mode. */
  routine?: boolean;
  /** Extra deterministic checks for money-moving tools (financial.ts). */
  financial?: {
    /** Argument holding the amount, in minor units (cents). */
    amountField: string;
    /** Argument holding the ISO-4217 code. */
    currencyField: string;
    /** Provider-owned destination/account identifier. It is validated against
     * an org allowlist and only a one-way fingerprint is persisted. */
    accountField: string;
    /** Currencies this tool accepts. Anything else is denied before any policy threshold is consulted. */
    allowedCurrencies: readonly string[];
  };
}

const READ_DEFAULTS = {
  mutates: false,
  timeoutMs: 10_000,
  // A read is safe to repeat by definition, so a transient D1 hiccup costs a
  // retry rather than a whole round of the agent's step budget.
  maxRetries: 2,
  idempotent: true,
  requiresApproval: false,
  riskLevel: "low",
} as const;

const DESCRIPTORS: ToolDescriptor[] = [
  ...['get_goal_plan','read_memory','read_task_history'].map(name=>({...READ_DEFAULTS,name,summary:'Durable task coordination and history.',requiredPermission:'tasks.manage' as const})),
  {...READ_DEFAULTS,name:'plan_goal',summary:'Persist a bounded goal plan.',requiredPermission:'tasks.manage',mutates:true,maxRetries:0,routine:true},
  {...READ_DEFAULTS,name:'write_memory',summary:'Append a task scratchpad observation.',requiredPermission:'tasks.manage',mutates:true,maxRetries:0,routine:true},
  {...READ_DEFAULTS,name:"read_conversation",summary:"Read the originating conversation.",requiredPermission:"portfolio.read"},
  /* ── reads: portfolio and accounting ─────────────────────────────────── */
  { ...READ_DEFAULTS, name: "get_portfolio_metrics", summary: "Portfolio-level NOI, rent, occupancy and work-order counts.", requiredPermission: "portfolio.read" },
  { ...READ_DEFAULTS, name: "get_metric_series", summary: "A time series for one metric with genuine multi-point data.", requiredPermission: "market.read" },
  { ...READ_DEFAULTS, name: "get_accounting_breakdown", summary: "Revenue, expense and NOI margin totals.", requiredPermission: "accounting.read" },
  { ...READ_DEFAULTS, name: "get_operating_statement", summary: "Period profit and loss from the general ledger.", requiredPermission: "accounting.read", timeoutMs: 15_000 },
  { ...READ_DEFAULTS, name: "get_delinquent_accounts", summary: "Past-due resident accounts with aging and contact channel.", requiredPermission: "accounting.read", timeoutMs: 15_000 },

  /* ── reads: property, leasing, maintenance ───────────────────────────── */
  { ...READ_DEFAULTS, name: "get_property_breakdown", summary: "Per-property and per-unit-type occupancy and rent position.", requiredPermission: "portfolio.read", timeoutMs: 15_000 },
  { ...READ_DEFAULTS, name: "get_leasing_funnel", summary: "Lead-to-lease funnel counts and stage conversion.", requiredPermission: "leasing.read" },
  { ...READ_DEFAULTS, name: "get_leasing_velocity", summary: "Funnel timing, channel performance and the expiration schedule.", requiredPermission: "leasing.read", timeoutMs: 15_000 },
  { ...READ_DEFAULTS, name: "get_maintenance_performance", summary: "Work-order SLA compliance, timings and vendor scorecards.", requiredPermission: "maintenance.read", timeoutMs: 15_000 },

  /* ── reads: analysis and provenance ──────────────────────────────────── */
  { ...READ_DEFAULTS, name: "get_operations_insights", summary: "Findings the current data supports, each with its source rows.", requiredPermission: "provenance.read", timeoutMs: 20_000 },
  { ...READ_DEFAULTS, name: "get_data_conflicts", summary: "Fields where two connected systems disagree.", requiredPermission: "provenance.read" },

  /* ── reads: documents ────────────────────────────────────────────────── */
  { ...READ_DEFAULTS, name: "list_documents", summary: "Titles and ids of stored documents.", requiredPermission: "documents.read" },
  {
    ...READ_DEFAULTS,
    name: "read_document",
    summary: "Full text of one stored document.",
    requiredPermission: "documents.read",
    // Elevated over the other reads because the returned text is written by a
    // counterparty and enters the model's context verbatim. Nothing about the
    // execution is riskier; the *result* is the app's largest untrusted-input
    // surface, and the audit trail should say so plainly.
    riskLevel: "medium",
  },

  /* ── the one mutating tool that exists ───────────────────────────────── */
  {
    name: "record_preference",
    summary: "Record a standing behavioral preference from a fixed taxonomy.",
    riskLevel: "medium",
    mutates: true,
    requiredPermission: "preferences.write",
    timeoutMs: 10_000,
    // Mutating: never retried. A transient failure here loses a preference,
    // which is recoverable; a double write is not what the caller asked for.
    maxRetries: 0,
    // The write is an upsert keyed by (org, topic) over a closed enum, so a
    // repeat is genuinely a no-op — see lib/ask-aval/preferences.ts.
    idempotent: true,
    requiresApproval: false,
  },

  /* ── declared, not yet wired ─────────────────────────────────────────── */
  // These exist so the envelope is defined before the capability is. Policy
  // denies every one of them (`unimplemented`), so declaring them here grants
  // nothing today and forces the next mutating feature to arrive with a risk
  // level, a permission and an approval posture already decided.
  { name: "send_external_message", summary: "Send a message to a resident or vendor over a real channel.", riskLevel: "high", mutates: true, requiredPermission: "messaging.send.external", timeoutMs: 20_000, maxRetries: 0, idempotent: false, requiresApproval: true, routine: true },
  { name: "place_call", summary: "Place a call and optionally connect a configured team.", riskLevel: "high", mutates: true, requiredPermission: "messaging.send.external", timeoutMs: 20000, maxRetries: 0, idempotent: false, requiresApproval: true, routine: true },
  { ...READ_DEFAULTS, name: "get_communication_channels", summary: "Connected channels and team routes.", requiredPermission: "portfolio.read" },
  { ...READ_DEFAULTS, name: "list_conversations", summary: "Real workspace conversations.", requiredPermission: "portfolio.read" },
  { ...READ_DEFAULTS, name: "request_execution_plan", summary: "Approve exact actions in a task plan.", requiredPermission: "preferences.write", requiresApproval: true },
  { ...READ_DEFAULTS, name: "get_marketing_channels", summary: "Marketing channel readiness.", requiredPermission: "leasing.read" },
  { name: "publish_listing", summary: "Publish a unit listing to an external marketplace.", riskLevel: "high", mutates: true, requiredPermission: "listing.publish", timeoutMs: 20_000, maxRetries: 0, idempotent: false, requiresApproval: true },

  /* ── PMS writes ──────────────────────────────────────────────────────────
   * Ten tools, one machinery. Whether any of them is offered to the model is
   * decided per request by `lib/pms/capability.ts`, not here: this file only
   * says what each one costs if it runs.
   *
   * All ten are `idempotent: true` despite mutating, which is unusual enough to
   * justify: every one is enqueued with a caller-supplied idempotency key that
   * is unique per org (`pms_write_queue.idempotencyKey`), so a repeat collides
   * on the index rather than writing twice. `maxRetries` stays 0 regardless —
   * the queue owns retries, and a tool-level retry would race the drainer.
   *
   * `requiresApproval` is true on all of them. The autonomy mode can relax a
   * `routine` mutation elsewhere in this registry; a write into someone else's
   * system of record is never routine, because the customer — not Aval — is the
   * party who answers for what appears in their PMS.
   */
  { name: "create_work_order", summary: "Create a work order in the connected PMS.", riskLevel: "high", mutates: true, requiredPermission: "pms.maintenance.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  { name: "update_work_order_status", summary: "Change a work order's status in the connected PMS.", riskLevel: "medium", mutates: true, requiredPermission: "pms.maintenance.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  { name: "close_work_order", summary: "Close a work order in the connected PMS.", riskLevel: "medium", mutates: true, requiredPermission: "pms.maintenance.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  { name: "dispatch_vendor", summary: "Dispatch a vendor to a work order.", riskLevel: "high", mutates: true, requiredPermission: "vendor.dispatch", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  // Arrears: a payment plan is a commitment about someone's housing, and a
  // posting lands in a trust ledger. `critical` puts both behind the elevated
  // approval tier (two distinct approvers) rather than a single sign-off.
  { name: "create_payment_plan", summary: "Record a payment plan against a delinquent account.", riskLevel: "critical", mutates: true, requiredPermission: "pms.arrears.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  { name: "post_payment", summary: "Post a payment to a resident ledger in the connected PMS.", riskLevel: "critical", mutates: true, requiredPermission: "pms.arrears.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  // Leasing: the two applicant-facing tools are also in
  // MANDATORY_HUMAN_CHECKPOINT, which is enforced independently of this flag so
  // that no future edit here can make them autonomous.
  { name: "reply_to_inquiry", summary: "Reply to a leasing inquiry through the connected PMS.", riskLevel: "high", mutates: true, requiredPermission: "pms.leasing.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  { name: "book_viewing", summary: "Book a viewing in the connected PMS calendar.", riskLevel: "medium", mutates: true, requiredPermission: "pms.leasing.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  { name: "send_application", summary: "Send a rental application to a prospect.", riskLevel: "high", mutates: true, requiredPermission: "pms.leasing.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },
  { name: "update_lease_status", summary: "Update a lease's status in the connected PMS.", riskLevel: "high", mutates: true, requiredPermission: "pms.leasing.write", timeoutMs: 30_000, maxRetries: 0, idempotent: true, requiresApproval: true },

  {
    name: "authorize_vendor_spend",
    summary: "Authorize spend against a vendor estimate.",
    riskLevel: "critical", mutates: true, requiredPermission: "vendor.spend.authorize",
    timeoutMs: 30_000, maxRetries: 0, idempotent: false, requiresApproval: true, unimplemented: true,
    financial: { amountField: "amount_cents", currencyField: "currency", accountField: "vendor_id", allowedCurrencies: ["USD", "MXN"] },
  },
  {
    name: "issue_payment",
    summary: "Move money to an external account.",
    riskLevel: "critical", mutates: true, requiredPermission: "payments.execute",
    timeoutMs: 30_000, maxRetries: 0, idempotent: false, requiresApproval: true, unimplemented: true,
    financial: { amountField: "amount_cents", currencyField: "currency", accountField: "destination_account_id", allowedCurrencies: ["USD", "MXN"] },
  },
  { name: "execute_lease", summary: "Countersign and execute a lease.", riskLevel: "critical", mutates: true, requiredPermission: "lease.execute", timeoutMs: 30_000, maxRetries: 0, idempotent: false, requiresApproval: true, unimplemented: true },
];

export const TOOL_REGISTRY: ReadonlyMap<string, ToolDescriptor> = new Map(DESCRIPTORS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDescriptor | undefined {
  return TOOL_REGISTRY.get(name);
}

/** Every tool that is actually executable today — the declared-but-unwired entries are excluded. */
export function implementedTools(): ToolDescriptor[] {
  return DESCRIPTORS.filter((tool) => !tool.unimplemented);
}

/** Final-answer tools are model output shapes, not capabilities: they touch nothing and are handled by the loop itself, never by the executor. */
export const NON_CAPABILITY_TOOLS: ReadonlySet<string> = new Set(["render_answer", "compose_document"]);
