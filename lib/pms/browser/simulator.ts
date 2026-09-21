/**
 * A property management system that exists only as a web app in memory.
 *
 * NOT A PROVIDER INTEGRATION. Nothing here says anything about AppFolio, Yardi
 * or any real system, and a run against it may only ever be described as
 * `SIMULATOR_E2E_TESTED`. What it proves is that Aval's own browser path works:
 * that a recorded flow replays against labelled fields and named buttons, that
 * a submit whose outcome was lost does not create a second record, that an
 * unverified write does not settle an objective, and that a page which has
 * changed stops the replay instead of clicking the nearest thing.
 *
 * It keeps its own state deliberately, for the same reason `adapters/simulator.ts`
 * does: a fake that returns success cannot answer whether the record is still
 * there on the next read, whether a provider that has not caught up is
 * distinguishable from one that says the record is absent, or whether a retried
 * action writes twice. Those need something that remembers.
 *
 * Faults are injected rather than mocked, because the interesting cases are the
 * ones where the provider behaves badly *while the path works*: the session
 * that expires between preflight and submit, the label that was renamed in last
 * night's release, two residents with the same name.
 */

import type { PmsAction } from "../types.ts";
import type { FlowStep } from "./steps.ts";
import {
  asUntrusted,
  type ProviderDriver,
  type ConnectionHealth,
  type ExecutionResult,
  type ExistingRecord,
  type PreflightResult,
  type ProviderSessionState,
  type RecoveryResult,
  type UntrustedPageText,
  type VerificationResult,
} from "./adapter.ts";

export interface SimulatedRecord {
  externalId: string;
  action: PmsAction;
  fields: Record<string, string>;
  createdAt: number;
  /** Reads before this many further attempts report the record as pending. */
  visibleAfterReads: number;
}

export interface SimulatorFaults {
  /** Sign-in refuses the customer's credentials. */
  wrongPassword?: boolean;
  /** The provider asks for a code the desktop runner cannot supply alone. */
  mfaRequired?: boolean;
  /** An authenticator code that does not match, e.g. a rotated seed or clock skew. */
  invalidTotp?: boolean;
  /** The session dies between preflight and the submit. */
  expireMidFlow?: boolean;
  /** The signed-in role cannot perform this action. */
  permissionDenied?: boolean;
  /** The provider stops answering. */
  timeout?: boolean;
  /** Rate limited: reachable, refusing. */
  rateLimited?: boolean;
  /** Last night's release renamed the fields the flow knows. */
  renameLabels?: Record<string, string>;
  /** The record is created but not readable for this many verification attempts. */
  consistencyLagReads?: number;
  /** Two candidates match the payload, so no single target is identifiable. */
  ambiguousTarget?: boolean;
  /** Text a stranger typed into the provider's database, rendered on the page. */
  pageText?: string;
  /** The submit lands but the runner never learns the outcome. */
  loseOutcomeAfterSubmit?: boolean;
}

interface Page {
  fields: string[];
  buttons: string[];
  /** Which page each button navigates to, by the button's own name. */
  opens?: Record<string, string>;
  /** The button that creates a record. Pressing it is the external effect. */
  creates?: string;
  /** Label the created record's identifier is read from. */
  captures?: Record<string, string>;
}

/**
 * A provider's UI, as far as a flow can see it.
 *
 * Kept as data so a fault can rename a label without any code knowing that a
 * rename is a thing that happens — and so a second provider can be a different
 * shape rather than the same shape with different strings.
 */
export type ProviderShape = Record<string, Page>;

/**
 * One provider's web app: a list, a form, a confirmation.
 *
 * The shape most maintenance systems have, and the one the first flow was
 * recorded against.
 */
export const LIST_FORM_CONFIRM: ProviderShape = {
  "Maintenance": {
    fields: [],
    buttons: ["New Work Order"],
    opens: { "New Work Order": "New Work Order" },
  },
  "New Work Order": {
    fields: ["Unit", "Description", "Priority"],
    buttons: ["Create Work Order"],
    creates: "Create Work Order",
    opens: { "Create Work Order": "Work Order Created" },
  },
  "Work Order Created": { fields: [], buttons: [], captures: { "Work Order #": "externalId" } },
};

/**
 * A materially different app: a database to pick before anything else, a
 * search-then-select step, and a two-stage save.
 *
 * Not a re-skin. It has more pages, a different number of steps, a selection
 * the first shape has no equivalent of, and it reads its identifier from a
 * differently named field. If the boundary were quietly shaped around the first
 * provider, replaying a flow here would not work.
 */
export const DATABASE_SEARCH_SAVE: ProviderShape = {
  "Voyager": {
    fields: [],
    buttons: ["Select Database"],
    opens: { "Select Database": "Database" },
  },
  "Database": {
    fields: ["Database"],
    buttons: ["Continue"],
    opens: { "Continue": "Service Requests" },
  },
  "Service Requests": {
    fields: ["Search Unit"],
    buttons: ["Add Service Request"],
    opens: { "Add Service Request": "Service Request" },
  },
  "Service Request": {
    fields: ["Unit Code", "Problem Description", "Category"],
    buttons: ["Save"],
    opens: { "Save": "Review" },
  },
  "Review": {
    fields: [],
    buttons: ["Confirm"],
    creates: "Confirm",
    opens: { "Confirm": "Saved" },
  },
  "Saved": { fields: [], buttons: [], captures: { "Service Request ID": "externalId" } },
};

export class BrowserSimulator implements ProviderDriver {
  readonly provider: string;
  /** A simulated web app is only ever reached inside a customer's own session. */
  readonly accessModes = ["customer_desktop_session"] as const;
  /** Says so itself, so nothing downstream has to infer it from the name. */
  readonly simulated = true;
  readonly faults: SimulatorFaults = {};
  private session: ProviderSessionState = "NEW";
  private readonly records = new Map<string, SimulatedRecord>();
  private readonly supported: Set<PmsAction>;
  private readonly pages: ProviderShape;
  /** Prefix for the identifiers this provider hands back. */
  private readonly idPrefix: string;
  private sequence = 0;
  /** Counted so a test can assert a retry did not submit twice. */
  submits = 0;

  constructor(
    provider: string,
    supported: readonly PmsAction[],
    pages: ProviderShape = LIST_FORM_CONFIRM,
    idPrefix = "WO",
  ) {
    this.provider = provider;
    this.supported = new Set(supported);
    this.pages = pages;
    this.idPrefix = idPrefix;
  }

  /** Everything the provider holds, for assertions. Never read by product code. */
  get external(): SimulatedRecord[] {
    return [...this.records.values()];
  }

  /**
   * The customer signs in, out of band.
   *
   * Modelled as its own event because that is what it is: Aval never performs
   * this. Somebody goes to the provider's own page, types their own password,
   * completes their own second factor, and a session exists afterwards that
   * Aval can operate inside. Nothing in the runtime can cause it.
   */
  signIn(): void {
    this.session = "ACTIVE";
  }

  reset(): void {
    this.records.clear();
    this.session = "NEW";
    this.sequence = 0;
    this.submits = 0;
    for (const key of Object.keys(this.faults)) delete (this.faults as Record<string, unknown>)[key];
  }

  get capabilities(): readonly PmsAction[] {
    return [...this.supported];
  }

  /**
   * What the signed-in session can reach.
   *
   * The simulator answers from its own state rather than from its manifest: a
   * permission-denied fault means this login cannot do the things this provider
   * implements, which is exactly the difference the contract exists to keep.
   */
  async discoverCapabilities(): Promise<{ available: PmsAction[]; error?: string }> {
    if (this.faults.timeout || this.faults.rateLimited) {
      return { available: [], error: "The provider did not answer a capability probe." };
    }
    // Evidence about the role, not about the network: an empty list with no
    // error is a fact, and an error with an empty list is an absence of one.
    if (this.faults.permissionDenied) return { available: [] };
    return { available: [...this.supported] };
  }

  async sessionStatus(): Promise<PreflightResult> {
    if (this.faults.timeout) return { ready: false, session: "EXPIRED", reason: "The provider did not respond." };
    if (this.faults.permissionDenied) {
      return { ready: false, session: "PERMISSION_DENIED", reason: "This PMS user cannot perform this action." };
    }
    if (this.session !== "ACTIVE") {
      return { ready: false, session: this.session === "NEW" ? "EXPIRED" : this.session, reason: "Not signed in." };
    }
    return { ready: true, session: "ACTIVE" };
  }

  /**
   * Sign in as the customer's own user.
   *
   * The desktop runner drives the session the person is already authenticated
   * for; where the provider re-prompts, an authenticator code is a thing only
   * they can supply. `MFA_REQUIRED` is therefore a handoff, not a retry, and
   * never something to work around.
   */
  async recoverSession(): Promise<RecoveryResult> {
    if (this.faults.wrongPassword) {
      this.session = "BLOCKED";
      return { session: "BLOCKED", recovered: false, reason: "The provider rejected the sign-in." };
    }
    if (this.faults.mfaRequired || this.faults.invalidTotp) {
      this.session = "MFA_REQUIRED";
      return {
        session: "MFA_REQUIRED",
        recovered: false,
        reason: "The provider asked for an authenticator code. A person has to supply it.",
      };
    }
    this.session = "ACTIVE";
    return { session: "ACTIVE", recovered: true };
  }

  async healthCheck(): Promise<ConnectionHealth> {
    if (this.faults.rateLimited) {
      return { session: this.session, usable: false, detail: "Rate limited by the provider.", checkedAt: new Date() };
    }
    if (this.faults.timeout) {
      return { session: "EXPIRED", usable: false, detail: "No response.", checkedAt: new Date() };
    }
    return { session: this.session, usable: this.session === "ACTIVE", checkedAt: new Date() };
  }

  /**
   * Is this record already here?
   *
   * Matches on the fields that identify one, not on everything — a description
   * edited by a retry must still be recognised as the same work order, or the
   * duplicate guard protects nothing.
   */
  async reconcile(action: PmsAction, payload: unknown): Promise<ExistingRecord | null> {
    if (this.faults.timeout) throw new Error("The provider did not respond to the duplicate check.");
    const fields = asFields(payload);
    const identity = ["unit", "reference"];

    const matches = this.external.filter((record) =>
      record.action === action
      && identity.every((key) => !fields[key] || record.fields[key] === fields[key])
      && identity.some((key) => Boolean(fields[key])),
    );
    if (matches.length === 0) return null;
    return { externalId: matches[0].externalId, matchedOn: identity.filter((key) => Boolean(fields[key])) };
  }

  async execute(
    action: PmsAction,
    steps: readonly FlowStep[],
    payload: unknown,
  ): Promise<ExecutionResult> {
    const observations: UntrustedPageText[] = [];
    if (this.faults.pageText) observations.push(asUntrusted(this.faults.pageText));

    if (this.faults.timeout) {
      return { ok: false, error: "The provider did not respond.", retryable: true, session: "EXPIRED", observations };
    }
    if (this.faults.expireMidFlow) {
      this.session = "EXPIRED";
      return { ok: false, error: "The session expired part-way through.", retryable: true, session: "EXPIRED", observations };
    }
    if (this.faults.permissionDenied) {
      return {
        ok: false,
        error: "This PMS user cannot perform this action.",
        // A permission denial does not become true by being retried.
        retryable: false,
        session: "PERMISSION_DENIED",
        observations,
      };
    }
    if (this.session !== "ACTIVE") {
      return { ok: false, error: "Not signed in.", retryable: true, session: this.session, observations };
    }
    if (this.faults.ambiguousTarget) {
      return {
        ok: false,
        error: "More than one record matched. Aval will not guess which one on a write.",
        retryable: false,
        session: "ACTIVE",
        observations,
      };
    }

    const fields = asFields(payload);
    const captured: Record<string, string> = {};
    let page: Page | null = null;

    for (const step of steps) {
      switch (step.kind) {
        case "open": {
          page = this.pages[step.page] ?? null;
          if (!page) return this.changed(`There is no page called "${step.page}" any more.`, observations);
          break;
        }
        case "click": {
          if (!page) return this.changed("A flow clicked before opening anything.", observations);
          if (!this.has(page.buttons, step.button)) {
            return this.changed(`No button named "${step.button}" on this page.`, observations);
          }
          // The submit. Everything before it is navigation.
          const creating = page.creates !== undefined && this.has([page.creates], step.button);
          const opened: string | undefined = this.pageOpenedBy(page, step.button);
          if (creating) {
            this.submits += 1;
            const record = this.create(action, fields);
            captured.externalId = record.externalId;
          }
          page = opened ? this.pages[opened] ?? page : page;
          if (creating) {
            if (this.faults.loseOutcomeAfterSubmit) {
              // The provider has the record; the runner never finds out. This is
              // the case the duplicate guard exists for.
              return {
                ok: false,
                error: "The connection dropped after the form was submitted.",
                retryable: true,
                session: "ACTIVE",
                observations,
              };
            }
          }
          break;
        }
        case "fill":
        case "choose": {
          if (!page) return this.changed("A flow filled a field before opening anything.", observations);
          if (!this.has(page.fields, step.label)) {
            return this.changed(`No field labelled "${step.label}" on this page.`, observations);
          }
          break;
        }
        case "expect": {
          break;
        }
        case "capture": {
          // Through `has`, like every other label. A provider that renamed the
          // field the identifier is read from has changed the page as surely as
          // one that renamed a button, and reading nothing while reporting
          // success is the worse of the two failures.
          if (!page?.captures || !this.has(Object.keys(page.captures), step.label)) {
            return this.changed(`Nothing labelled "${step.label}" to read.`, observations);
          }
          break;
        }
      }
    }

    return { ok: true, externalId: captured.externalId, captured, observations, session: "ACTIVE" };
  }

  /**
   * Read the provider back.
   *
   * The only thing that turns a submitted form into a fact. A provider that has
   * not caught up answers `pending`, which is deliberately not `confirmed:
   * false` — one waits and the other means the write did not land.
   */
  async verify(
    action: PmsAction,
    execution: ExecutionResult,
    payload: unknown,
  ): Promise<VerificationResult> {
    if (this.faults.timeout) return { confirmed: false, pending: true, detail: "The provider did not respond." };

    const found = execution.externalId
      ? this.records.get(execution.externalId) ?? null
      : await this.reconcile(action, payload).then((hit) => (hit ? this.records.get(hit.externalId) ?? null : null));

    if (!found) return { confirmed: false, detail: "No such record at the provider." };
    if (found.visibleAfterReads > 0) {
      found.visibleAfterReads -= 1;
      return { confirmed: false, pending: true, detail: "The provider has not caught up yet." };
    }
    return { confirmed: true, externalId: found.externalId };
  }

  /** Which page a pressed button opens, accounting for renamed labels. */
  private pageOpenedBy(page: Page, pressed: string): string | undefined {
    for (const [button, destination] of Object.entries(page.opens ?? {})) {
      if (this.has([button], pressed)) return destination;
    }
    return undefined;
  }

  private has(labels: readonly string[], wanted: string): boolean {
    const renamed = this.faults.renameLabels ?? {};
    // A renamed label is simply absent under its old name. Nothing here tries
    // to be clever about near-matches: guessing is how automation clicks the
    // wrong button.
    return labels.some((label) => (renamed[label] ?? label) === wanted);
  }

  private changed(reason: string, observations: UntrustedPageText[]): ExecutionResult {
    return { ok: false, error: reason, retryable: false, session: "PROVIDER_CHANGED", observations };
  }

  private create(action: PmsAction, fields: Record<string, string>): SimulatedRecord {
    this.sequence += 1;
    const externalId = `${this.idPrefix}-${String(this.sequence).padStart(5, "0")}`;
    const record: SimulatedRecord = {
      externalId,
      action,
      fields,
      createdAt: Date.now(),
      visibleAfterReads: this.faults.consistencyLagReads ?? 0,
    };
    this.records.set(externalId, record);
    return record;
  }
}

function asFields(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") out[key] = String(value);
  }
  return out;
}
