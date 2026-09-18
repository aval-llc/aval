/**
 * The capability matrix's vocabulary (docs/PMS_INTEGRATION.md, P0).
 *
 * Every property management system differs along four independent axes, and
 * the whole point of this file is that they are never collapsed into one
 * boolean:
 *
 *   supported  — does a path physically exist?   (an engineering fact)
 *   permitted  — do the provider's terms allow it? (a legal fact)
 *   granted    — what did this customer's PMS role actually give us?
 *   enabled    — what has this workspace turned on?
 *
 * `lib/integrations/catalog.ts` used to carry a single `readOnly: boolean` for
 * this job. It was unenforced on all seven PMS providers, which is the exact
 * failure the brief warns about: code that treats capability and permission as
 * one thing will eventually enable a write because an API existed. The
 * descriptors here are authoritative; the catalog derives from them.
 */

/** How data comes *in*. `notification` needs no API — the PMS mails the seat. */
export type ReadMechanism = "api" | "notification" | "manual_export";

/** How data goes *out*. `ui` means driving the provider's web app as a signed-in staff user. */
export type WriteMechanism = "api" | "ui";

/**
 * Where the hands are.
 *
 * `cloud` runs in the Worker. `desktop` drains through the Electron runner on
 * the customer's own machine, against the session they are already signed into,
 * so PMS credentials never reach Aval's infrastructure.
 *
 * A `ui` mechanism is always `desktop`. The combination `ui` + `cloud` would
 * mean Aval storing a customer's PMS password and driving their PMS from a
 * datacenter IP — the specific arrangement this design exists to avoid. An
 * invariant test in tests/pms-descriptors.test.ts asserts it can never appear.
 */
export type Runner = "cloud" | "desktop";

/**
 * The five states an operator can see, and the reason they are five.
 *
 * Two of these mean "no, and you cannot fix it by clicking" — but they are not
 * the same kind of no, and showing them identically would be a lie about who
 * owes the work:
 *
 *   `unavailable` — no path exists. Nobody is at fault; the provider has no API
 *                   and no reachable UI surface for this action.
 *   `blocked`     — a path exists and something forbids using it. Carries the
 *                   clause or the missing grant that forbids it.
 *   `unlearned`   — everything says yes, but Aval has not recorded a flow for
 *                   this action on this provider yet. This is *our* backlog,
 *                   not the customer's problem, and it must never read like a
 *                   policy refusal.
 *   `off`         — permitted and granted; the workspace simply has not enabled
 *                   it. One click away.
 *   `allow`       — active.
 */
export type CapabilityState = "allow" | "off" | "blocked" | "unlearned" | "unavailable";

/** Who has to act for a non-`allow` state to change. Drives the settings copy. */
export type RemediationOwner = "aval" | "customer" | "provider";

export interface CapabilityResolution {
  state: CapabilityState;
  /** Why it is not `allow`. For `blocked` on terms, names the specific clause. */
  reason?: string;
  /** What would change it, in the operator's own terms. */
  remediation?: string;
  owner?: RemediationOwner;
  /**
   * Every execution needs a named human approval, whatever the autonomy mode or
   * settings row says. Availability and approval are separate questions: a Fair
   * Housing-exposed action can be fully `allow` and still never run unreviewed.
   */
  mandatoryApproval?: boolean;
  /** Which mechanism resolution selected, so the caller knows where to execute. */
  mechanism?: "api" | "ui" | "notification" | "manual_export";
  /** Where the hands are for this action. Only meaningful for writes. */
  runner?: Runner;
}

export interface ReadCapability {
  mechanisms: ReadMechanism[];
  supported: boolean;
  permitted: boolean;
  /** Required whenever `permitted` is false. Unknown defaults to false, so silence here is a bug. */
  reason?: string;
  note?: string;
}

export interface WriteCapability {
  mechanisms: WriteMechanism[];
  runner: Runner;
  supported: boolean;
  permitted: boolean;
  reason?: string;
  /**
   * The only way a `permitted: false` write ever runs: a per-org record of who
   * signed for it and when (`pms_write_authorizations`). Never a default, and
   * never a workspace toggle on its own.
   */
  override?: "signed_authorization";
  /**
   * ISO date on which a human last read the provider's live terms and confirmed
   * the language in `reason`. The brief requires this because every clause
   * citation in these descriptors came from secondary research, not counsel.
   * A stale date is a reason to re-read, not a reason to proceed.
   */
  termsVerifiedAt?: string;
  note?: string;
}

/**
 * One action the matrix resolves independently. Named `<workflow>.<object>.<verb>`
 * so a settings row, a permission, and an audit entry can all be keyed the same.
 *
 * These are deliberately finer-grained than the workflows: "maintenance writes
 * are on" is not a thing a customer should have to accept wholesale, because
 * creating a work order and authorizing a vendor's spend are not the same risk.
 */
export type PmsAction =
  // maintenance — the first write-enabled workflow
  | "maintenance.work_orders.read"
  | "maintenance.work_order.create"
  | "maintenance.work_order.update_status"
  | "maintenance.work_order.close"
  | "maintenance.vendor.dispatch"
  // arrears — built complete, flagged off
  | "arrears.ledger.read"
  | "arrears.payment_plan.create"
  | "arrears.payment.post"
  // leasing — built complete, flagged off, human checkpoint non-negotiable
  | "leasing.applications.read"
  | "leasing.inquiry.reply"
  | "leasing.viewing.book"
  | "leasing.application.send"
  | "leasing.lease.update_status"
  // reporting — reads only, by design
  | "reporting.financials.read";

export type PmsWorkflow = "maintenance" | "arrears" | "leasing" | "reporting";

export const PMS_ACTIONS: Readonly<Record<PmsWorkflow, readonly PmsAction[]>> = {
  maintenance: [
    "maintenance.work_orders.read",
    "maintenance.work_order.create",
    "maintenance.work_order.update_status",
    "maintenance.work_order.close",
    "maintenance.vendor.dispatch",
  ],
  arrears: ["arrears.ledger.read", "arrears.payment_plan.create", "arrears.payment.post"],
  leasing: [
    "leasing.applications.read",
    "leasing.inquiry.reply",
    "leasing.viewing.book",
    "leasing.application.send",
    "leasing.lease.update_status",
  ],
  reporting: ["reporting.financials.read"],
};

/** Reads are resolved against `descriptor.read`, writes against `descriptor.write`. */
export function isReadAction(action: PmsAction): boolean {
  return action.endsWith(".read");
}

export function workflowFor(action: PmsAction): PmsWorkflow {
  return action.split(".")[0] as PmsWorkflow;
}

/**
 * Per-workflow default for whether a *write* may be enabled at all.
 *
 * `off` here is not a UI preference — it means an org cannot turn these on
 * without a signed authorization on file, however permissive the provider is.
 * Maintenance is the exception because a wrong work order costs an apology and
 * a delete; arrears touches trust accounting and leasing touches Fair Housing.
 */
export const WORKFLOW_WRITE_DEFAULT: Readonly<Record<PmsWorkflow, "on" | "off" | "none">> = {
  maintenance: "on",
  arrears: "off",
  leasing: "off",
  reporting: "none",
};

/**
 * Actions whose every outbound message requires a named human approval, with no
 * configuration path around it.
 *
 * HUD's 2024 guidance applies Fair Housing to AI-driven screening and applicant
 * communication, and the liability lands on the property manager — our design
 * partner — not on Aval. So this is hard-coded rather than an org setting:
 * `resolveCapability` stamps `mandatoryApproval` on these regardless of autonomy
 * mode or any settings row, and the tool registration carries it through to
 * `requiresApproval`. Availability and approval are different questions — these
 * actions can be perfectly available and still never execute unreviewed.
 */
export const MANDATORY_HUMAN_CHECKPOINT: ReadonlySet<PmsAction> = new Set([
  "leasing.inquiry.reply",
  "leasing.application.send",
]);

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  read: ReadCapability;
  write: WriteCapability;
  /**
   * Actions this provider has no surface for at all, even though the workflow
   * exists. Resolves to `unavailable` rather than `blocked` — there is nothing
   * to permit.
   */
  unsupportedActions?: readonly PmsAction[];
  /**
   * Domains this provider is *expected* to send seat mail from, offered to an
   * operator as a starting point during setup.
   *
   * **These are suggestions and never authority.** Nothing in the verification
   * path reads this field: `verifySender` consults `pms_seat_senders`, and a row
   * only gets there when an operator confirmed it. The distinction matters
   * because the entries below are the same class of claim as `termsVerifiedAt` —
   * researched, not observed — and an unconfirmed suggestion that silently
   * became an allowlist entry would be Aval deciding whose mail may enter a
   * customer's agent context.
   *
   * Apex domains only, because `domainMatches` already accepts subdomains.
   * Enumerating `mail.`/`notifications.` here would be guessing at
   * infrastructure that changes without notice, and guessing wider than we know
   * is the failure mode this field is shaped to avoid.
   */
  senderDomains?: readonly string[];
}


/**
 * What a customer's connection actually grants, as established by a probe.
 *
 * Declared here rather than in grants.ts so the pure resolver in
 * capability-rules.ts can name it without importing the module that touches D1.
 */
export interface GrantSet {
  /** Actions the connection demonstrably permits. Absence is not denial — see `probed`. */
  available: readonly PmsAction[];
  /** When this was last established. A stale grant is re-probed, never trusted indefinitely. */
  probedAt: string | null;
  /**
   * False when no probe has succeeded yet. The resolver treats un-probed as
   * "unknown", which resolves away from `allow` — unknown defaults to no.
   */
  probed: boolean;
  /** Present when the last probe failed, for the settings row to show. */
  error?: string;
}

/** What this workspace has turned on for one (provider, action). */
export interface Enablement {
  enabled: boolean;
  /** True only when a human countersigned a terms override, with their id on the row. */
  signedAuthorization: boolean;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  status: "draft" | "approved" | "suspended" | "absent";
  authorizationReference: string | null;
}

/**
 * Everything the resolver needs for one provider, gathered once.
 *
 * Deliberately all data and no function handles: `executablePaths` and
 * `grantProbeImplemented` are resolved by the caller rather than looked up
 * inside the decision, which is what keeps the decision pure and every state
 * directly testable.
 */
export interface ResolutionContext {
  grants: GrantSet;
  enablements: Map<string, Enablement>;
  /** Actions with an executable path: a learned flow for `ui`, a registered adapter for `api`. */
  executablePaths: ReadonlySet<PmsAction>;
  /** Whether Aval can verify what this provider's connections grant. */
  grantProbeImplemented: boolean;
}

export const ABSENT_ENABLEMENT: Enablement = {
  enabled: false,
  signedAuthorization: false,
  approvedByUserId: null,
  approvedAt: null,
  status: "absent",
  authorizationReference: null,
};

/** An empty context: nothing probed, nothing enabled, nothing learned. */
export function emptyContext(): ResolutionContext {
  return {
    grants: { available: [], probedAt: null, probed: false },
    enablements: new Map(),
    executablePaths: new Set(),
    grantProbeImplemented: false,
  };
}

export function enablementFor(
  byKey: Map<string, Enablement>,
  providerId: string,
  action: PmsAction,
): Enablement {
  return byKey.get(`${providerId}:${action}`) ?? ABSENT_ENABLEMENT;
}
