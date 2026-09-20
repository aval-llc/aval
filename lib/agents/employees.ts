/**
 * AI employees: durable organizational actors.
 *
 * An employee is not a model session and not a persona. It outlives any run,
 * owns Work, and carries its own authority. Everything here is keyed on
 * `organization_id` and nothing counts, enumerates or special-cases a roster —
 * employee #1 and employee #101 take the identical path through this module,
 * which is the property the architecture actually has to guarantee.
 *
 * How many employees a workspace may have is read from
 * `organizations.ai_employee_limit`, where null means no limit. That is the
 * only place a number appears, and it is configuration rather than code.
 */

import { and, asc, count, eq, ilike, or } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { aiEmployees, aiEmployeeScopes, agentTasks, organizations } from "@/db/postgres/schema";
import { TERMINAL_STATES, type TaskState } from "./task-state.ts";

export const EMPLOYEE_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const AUTONOMY_MODES = ["supervised", "assisted", "autonomous"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const SCOPE_KINDS = ["property", "connection", "capability", "work_type", "data_domain", "delegate_to"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const MEMORY_SCOPES = ["organization", "property", "work"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const RISK_CEILINGS = ["low", "medium", "high", "critical"] as const;
export type RiskCeiling = (typeof RISK_CEILINGS)[number];

const MAX_NAME_CHARS = 120;
const MAX_ROLE_CHARS = 120;
const MAX_TEXT_CHARS = 4000;

/**
 * Lifecycle.
 *
 * A draft has never acted and can be discarded; an archived employee is the end
 * of the line, because its Work and audit trail have to keep referring to
 * something. Nothing here deletes: an employee that did things is part of the
 * record of what was done.
 */
export const EMPLOYEE_TRANSITIONS: Record<EmployeeStatus, readonly EmployeeStatus[]> = {
  draft: ["active", "archived"],
  active: ["paused", "archived"],
  paused: ["active", "archived"],
  archived: [],
};

export function canTransitionEmployee(from: EmployeeStatus, to: EmployeeStatus): boolean {
  return EMPLOYEE_TRANSITIONS[from].includes(to);
}

export interface EmployeeScope {
  kind: ScopeKind;
  value: string;
}

export interface EmployeeRecord {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  description: string | null;
  objective: string | null;
  instructions: string | null;
  status: EmployeeStatus;
  autonomyMode: AutonomyMode;
  approvalPolicy: string;
  spendLimitCents: number | null;
  riskCeiling: RiskCeiling;
  memoryScope: MemoryScope;
  mayCommunicateExternally: boolean;
  mayDelegate: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEmployeeInput {
  name: string;
  role: string;
  description?: string | null;
  objective?: string | null;
  instructions?: string | null;
  status?: EmployeeStatus;
  autonomyMode?: AutonomyMode;
  approvalPolicy?: string;
  spendLimitCents?: number | null;
  riskCeiling?: RiskCeiling;
  memoryScope?: MemoryScope;
  mayCommunicateExternally?: boolean;
  mayDelegate?: boolean;
  /** Granted explicitly. Creating an employee authorizes nothing by itself. */
  scopes?: readonly EmployeeScope[];
}

export class InvalidEmployeeInputError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidEmployeeInputError"; }
}

/** The workspace is at the limit its plan configured. Not an architectural limit. */
export class EmployeeQuotaError extends Error {
  constructor(readonly limit: number) {
    super(`This workspace is configured for ${limit} AI employees.`);
    this.name = "EmployeeQuotaError";
  }
}

/** Archiving an employee that still owns live Work would orphan it. */
export class EmployeeHasOpenWorkError extends Error {
  constructor(readonly openWork: number) {
    super(`This employee still owns ${openWork} piece(s) of unfinished work. Reassign it first.`);
    this.name = "EmployeeHasOpenWorkError";
  }
}

function text(value: string | null | undefined, field: string, max: number, required = false): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    if (required) throw new InvalidEmployeeInputError(`${field} is required.`);
    return null;
  }
  if (trimmed.length > max) throw new InvalidEmployeeInputError(`${field} is longer than ${max} characters.`);
  return trimmed;
}

function oneOf<T extends string>(value: T | undefined, allowed: readonly T[], fallback: T, field: string): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new InvalidEmployeeInputError(`${field} is not one of the permitted values.`);
  return value;
}

/** How many employees this workspace may have. Null means no limit. */
export async function employeeLimit(dbSession: DbSession, organizationId: string): Promise<number | null> {
  const [row] = await dbSession.db
    .select({ limit: organizations.aiEmployeeLimit })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.limit ?? null;
}

/** Employees that count against the limit. An archived one no longer does. */
export async function employeeCount(dbSession: DbSession, organizationId: string): Promise<number> {
  const [row] = await dbSession.db
    .select({ total: count() })
    .from(aiEmployees)
    .where(and(eq(aiEmployees.organizationId, organizationId), or(
      eq(aiEmployees.status, "draft"), eq(aiEmployees.status, "active"), eq(aiEmployees.status, "paused"),
    )));
  return Number(row?.total ?? 0);
}

/**
 * Creates an employee.
 *
 * Nothing about this path varies with how many already exist. The only check on
 * count is the workspace's own configured limit, and a workspace without one
 * creates its hundred-and-first employee exactly as it created its first.
 */
export async function createEmployee(
  dbSession: DbSession,
  organizationId: string,
  userId: string,
  input: CreateEmployeeInput,
): Promise<EmployeeRecord> {
  const name = text(input.name, "Name", MAX_NAME_CHARS, true)!;
  const role = text(input.role, "Role", MAX_ROLE_CHARS, true)!;

  const limit = await employeeLimit(dbSession, organizationId);
  if (limit !== null && (await employeeCount(dbSession, organizationId)) >= limit) {
    throw new EmployeeQuotaError(limit);
  }

  const now = new Date();
  const row = {
    id: crypto.randomUUID(),
    organizationId,
    name,
    role,
    description: text(input.description, "Description", MAX_TEXT_CHARS),
    objective: text(input.objective, "Objective", MAX_TEXT_CHARS),
    instructions: text(input.instructions, "Instructions", MAX_TEXT_CHARS),
    status: oneOf(input.status, EMPLOYEE_STATUSES, "draft", "Status"),
    autonomyMode: oneOf(input.autonomyMode, AUTONOMY_MODES, "supervised", "Autonomy"),
    approvalPolicy: text(input.approvalPolicy, "Approval policy", MAX_NAME_CHARS) ?? "standard",
    spendLimitCents: input.spendLimitCents ?? null,
    riskCeiling: oneOf(input.riskCeiling, RISK_CEILINGS, "low", "Risk ceiling"),
    memoryScope: oneOf(input.memoryScope, MEMORY_SCOPES, "work", "Memory scope"),
    mayCommunicateExternally: input.mayCommunicateExternally ?? false,
    mayDelegate: input.mayDelegate ?? false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  if (row.spendLimitCents !== null && (!Number.isInteger(row.spendLimitCents) || row.spendLimitCents < 0)) {
    throw new InvalidEmployeeInputError("A spend limit must be a whole number of cents, or absent.");
  }

  await dbSession.db.insert(aiEmployees).values(row);
  for (const scope of input.scopes ?? []) {
    await grantScope(dbSession, organizationId, row.id, userId, scope);
  }
  return row as EmployeeRecord;
}

export interface ListEmployeesOptions {
  status?: EmployeeStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * The workspace's employees.
 *
 * Paged from the start rather than when it becomes a problem: a directory is a
 * list of rows, and a hundred of them is an ordinary number, not an edge case.
 */
export async function listEmployees(
  dbSession: DbSession,
  organizationId: string,
  options: ListEmployeesOptions = {},
): Promise<EmployeeRecord[]> {
  const search = options.search?.trim();
  const rows = await dbSession.db
    .select()
    .from(aiEmployees)
    .where(and(
      eq(aiEmployees.organizationId, organizationId),
      ...(options.status ? [eq(aiEmployees.status, options.status)] : []),
      ...(search ? [or(ilike(aiEmployees.name, `%${search}%`), ilike(aiEmployees.role, `%${search}%`))!] : []),
    ))
    .orderBy(asc(aiEmployees.name))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200))
    .offset(Math.max(options.offset ?? 0, 0));
  return rows as EmployeeRecord[];
}

export async function getEmployee(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
): Promise<EmployeeRecord | null> {
  const [row] = await dbSession.db
    .select()
    .from(aiEmployees)
    .where(and(eq(aiEmployees.organizationId, organizationId), eq(aiEmployees.id, employeeId)))
    .limit(1);
  return (row as EmployeeRecord) ?? null;
}

export type EmployeePatch = Partial<Omit<CreateEmployeeInput, "scopes" | "status">>;

export async function updateEmployee(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
  patch: EmployeePatch,
): Promise<EmployeeRecord | null> {
  const existing = await getEmployee(dbSession, organizationId, employeeId);
  if (!existing) return null;
  if (existing.status === "archived") {
    throw new InvalidEmployeeInputError("An archived employee is part of the record and is not edited.");
  }

  const next = {
    ...(patch.name !== undefined ? { name: text(patch.name, "Name", MAX_NAME_CHARS, true)! } : {}),
    ...(patch.role !== undefined ? { role: text(patch.role, "Role", MAX_ROLE_CHARS, true)! } : {}),
    ...(patch.description !== undefined ? { description: text(patch.description, "Description", MAX_TEXT_CHARS) } : {}),
    ...(patch.objective !== undefined ? { objective: text(patch.objective, "Objective", MAX_TEXT_CHARS) } : {}),
    ...(patch.instructions !== undefined ? { instructions: text(patch.instructions, "Instructions", MAX_TEXT_CHARS) } : {}),
    ...(patch.autonomyMode !== undefined ? { autonomyMode: oneOf(patch.autonomyMode, AUTONOMY_MODES, "supervised", "Autonomy") } : {}),
    ...(patch.approvalPolicy !== undefined ? { approvalPolicy: text(patch.approvalPolicy, "Approval policy", MAX_NAME_CHARS) ?? "standard" } : {}),
    ...(patch.spendLimitCents !== undefined ? { spendLimitCents: patch.spendLimitCents } : {}),
    ...(patch.riskCeiling !== undefined ? { riskCeiling: oneOf(patch.riskCeiling, RISK_CEILINGS, "low", "Risk ceiling") } : {}),
    ...(patch.memoryScope !== undefined ? { memoryScope: oneOf(patch.memoryScope, MEMORY_SCOPES, "work", "Memory scope") } : {}),
    ...(patch.mayCommunicateExternally !== undefined ? { mayCommunicateExternally: patch.mayCommunicateExternally } : {}),
    ...(patch.mayDelegate !== undefined ? { mayDelegate: patch.mayDelegate } : {}),
    updatedAt: new Date(),
  };
  await dbSession.db.update(aiEmployees).set(next)
    .where(and(eq(aiEmployees.organizationId, organizationId), eq(aiEmployees.id, employeeId)));
  return getEmployee(dbSession, organizationId, employeeId);
}

/** Work this employee owns that has not finished. */
export async function openWorkCount(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
): Promise<number> {
  const rows = await dbSession.db
    .select({ status: agentTasks.status })
    .from(agentTasks)
    .where(and(eq(agentTasks.organizationId, organizationId), eq(agentTasks.employeeId, employeeId)));
  return rows.filter((row) => !TERMINAL_STATES.has(row.status as TaskState)).length;
}

/**
 * Moves an employee through its lifecycle.
 *
 * Pausing blocks new execution and leaves everything already recorded alone.
 * Archiving is refused while the employee still owns unfinished Work, because
 * the alternative is Work with no owner — the caller reassigns first, which is
 * a decision about who picks it up rather than something to infer here.
 */
export async function setEmployeeStatus(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
  status: EmployeeStatus,
): Promise<EmployeeRecord | null> {
  const existing = await getEmployee(dbSession, organizationId, employeeId);
  if (!existing) return null;
  if (existing.status === status) return existing;
  if (!canTransitionEmployee(existing.status, status)) {
    throw new InvalidEmployeeInputError(`An employee cannot go from ${existing.status} to ${status}.`);
  }
  if (status === "archived") {
    const open = await openWorkCount(dbSession, organizationId, employeeId);
    if (open > 0) throw new EmployeeHasOpenWorkError(open);
  }
  await dbSession.db.update(aiEmployees).set({ status, updatedAt: new Date() })
    .where(and(eq(aiEmployees.organizationId, organizationId), eq(aiEmployees.id, employeeId)));
  return getEmployee(dbSession, organizationId, employeeId);
}

/**
 * Hands unfinished Work to another employee.
 *
 * The receiving employee has to be able to run: handing Work to a paused or
 * archived colleague is the same as orphaning it, only harder to see.
 */
export async function reassignWork(
  dbSession: DbSession,
  organizationId: string,
  fromEmployeeId: string,
  toEmployeeId: string,
): Promise<number> {
  const target = await getEmployee(dbSession, organizationId, toEmployeeId);
  if (!target) throw new InvalidEmployeeInputError("The receiving employee does not exist in this workspace.");
  if (target.status !== "active") {
    throw new InvalidEmployeeInputError("Work can only be reassigned to an active employee.");
  }
  const rows = await dbSession.db
    .select({ id: agentTasks.id, status: agentTasks.status })
    .from(agentTasks)
    .where(and(eq(agentTasks.organizationId, organizationId), eq(agentTasks.employeeId, fromEmployeeId)));

  let moved = 0;
  for (const row of rows) {
    if (TERMINAL_STATES.has(row.status as TaskState)) continue;
    await dbSession.db.update(agentTasks).set({ employeeId: toEmployeeId, updatedAt: new Date() })
      .where(and(eq(agentTasks.organizationId, organizationId), eq(agentTasks.id, row.id)));
    moved += 1;
  }
  return moved;
}

/* ── scopes ───────────────────────────────────────────────────────────────── */

export async function grantScope(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
  userId: string,
  scope: EmployeeScope,
): Promise<void> {
  if (!SCOPE_KINDS.includes(scope.kind)) {
    throw new InvalidEmployeeInputError(`${scope.kind} is not a kind of scope.`);
  }
  const value = text(scope.value, "Scope value", MAX_NAME_CHARS, true)!;
  await dbSession.db.insert(aiEmployeeScopes).values({
    id: crypto.randomUUID(),
    organizationId,
    employeeId,
    scopeKind: scope.kind,
    value,
    grantedBy: userId,
    createdAt: new Date(),
  }).onConflictDoNothing();
}

export async function revokeScope(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
  scope: EmployeeScope,
): Promise<void> {
  await dbSession.db.delete(aiEmployeeScopes).where(and(
    eq(aiEmployeeScopes.organizationId, organizationId),
    eq(aiEmployeeScopes.employeeId, employeeId),
    eq(aiEmployeeScopes.scopeKind, scope.kind),
    eq(aiEmployeeScopes.value, scope.value),
  ));
}

/**
 * Everything one employee is allowed to reach, grouped by kind.
 *
 * A kind with no rows is absent from the result rather than present and empty,
 * so a caller cannot mistake "granted nothing" for "granted everything".
 */
export async function employeeScopes(
  dbSession: DbSession,
  organizationId: string,
  employeeId: string,
): Promise<Partial<Record<ScopeKind, string[]>>> {
  const rows = await dbSession.db
    .select({ scopeKind: aiEmployeeScopes.scopeKind, value: aiEmployeeScopes.value })
    .from(aiEmployeeScopes)
    .where(and(
      eq(aiEmployeeScopes.organizationId, organizationId),
      eq(aiEmployeeScopes.employeeId, employeeId),
    ))
    .orderBy(asc(aiEmployeeScopes.value));

  const out: Partial<Record<ScopeKind, string[]>> = {};
  for (const row of rows) {
    const kind = row.scopeKind as ScopeKind;
    (out[kind] ??= []).push(row.value);
  }
  return out;
}
