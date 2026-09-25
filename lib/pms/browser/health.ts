/**
 * How a customer-authorized provider connection is doing.
 *
 * For an API connection "connected" is about a key. For this one it is about a
 * session on somebody's laptop, which is a different kind of fact: it lapses on
 * its own, it can be revoked by the provider, and it can be perfectly healthy
 * while the person who owns it is asleep. So the states below are the ones an
 * operator can act on, and they are kept apart because the remedies differ —
 * telling somebody their session expired when the provider actually refused
 * their role sends them to sign in again and again.
 *
 * Stored on `integration_connections.metadataJson` rather than a new table,
 * for the same reason grants are: that row is already unique per
 * (organization, provider), which is exactly the grain of a connection's
 * health.
 */

import { and, eq } from "drizzle-orm";
import type { DbSession } from "@/db/postgres/session";
import { integrationConnections } from "@/db/postgres/schema";
import type { ProviderSessionState } from "./adapter.ts";

export type ConnectionState =
  /** A usable session. Work can be drained. */
  | "CONNECTED"
  /** Nobody has signed in on this device yet. */
  | "SESSION_REQUIRED"
  /** There was a session and it lapsed. Signing in again resumes the work. */
  | "SESSION_EXPIRED"
  /** The provider refused this user's role. Signing in again changes nothing. */
  | "PERMISSION_DENIED"
  /** The provider did not answer, or is rate limiting. */
  | "PROVIDER_UNAVAILABLE"
  /** The recorded workflow no longer matches the page. Replay is unsafe. */
  | "UI_CHANGED"
  /** Reachable and working badly — slow, flaky, partially refusing. */
  | "DEGRADED";

export interface ConnectionHealthRecord {
  state: ConnectionState;
  /** Words for the operator. Present whenever the state is not CONNECTED. */
  detail?: string;
  /** The device that last reported. Identifies which laptop needs attention. */
  runnerId?: string;
  checkedAt: string | null;
  /** Last time this connection actually completed a provider read or write. */
  lastVerifiedAt?: string | null;
}

const UNKNOWN: ConnectionHealthRecord = { state: "SESSION_REQUIRED", checkedAt: null };

/**
 * The connection state a provider session state implies.
 *
 * One place, so the runner, the settings panel and the capability resolver
 * cannot disagree about what `MFA_REQUIRED` means.
 */
export function stateForSession(session: ProviderSessionState): ConnectionState {
  switch (session) {
    case "ACTIVE":
      return "CONNECTED";
    case "NEW":
    case "AUTHENTICATING":
      return "SESSION_REQUIRED";
    case "EXPIRED":
      return "SESSION_EXPIRED";
    case "MFA_REQUIRED":
      // Not expired: the session is fine and the provider wants a code only a
      // person can supply. Signing in is exactly the right instruction.
      return "SESSION_REQUIRED";
    case "PERMISSION_DENIED":
      return "PERMISSION_DENIED";
    case "PROVIDER_CHANGED":
      return "UI_CHANGED";
    case "BLOCKED":
      return "PROVIDER_UNAVAILABLE";
  }
}

/**
 * Whether the queued write stays queued.
 *
 * Separate from `needsPerson` because they are different questions and
 * collapsing them loses the case that matters most: a session that lapsed needs
 * somebody to sign in *and* the work should still be there when they do. A
 * refused role and a changed page do not come back by waiting, so those stop.
 */
export function awaitsProvider(state: ConnectionState): boolean {
  return state === "SESSION_REQUIRED" || state === "SESSION_EXPIRED"
    || state === "PROVIDER_UNAVAILABLE" || state === "DEGRADED";
}

/**
 * Whether somebody has to do something before this connection works again.
 *
 * A provider outage resolves itself and a degraded one usually does. Everything
 * else here is waiting on a person: signing in, being given a wider PMS role,
 * or — for a page that changed under a recorded workflow — Aval recording a new
 * one. Reported alongside `awaitsProvider`, never instead of it.
 */
export function needsPerson(state: ConnectionState): boolean {
  return state === "SESSION_REQUIRED" || state === "SESSION_EXPIRED"
    || state === "PERMISSION_DENIED" || state === "UI_CHANGED";
}

function parse(json: string): Record<string, unknown> {
  try {
    const held = JSON.parse(json);
    return held && typeof held === "object" ? (held as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readConnectionHealth(
  dbSession: DbSession,
  organizationId: string,
  providerId: string,
): Promise<ConnectionHealthRecord> {
  const [row] = await dbSession.db
    .select({ metadataJson: integrationConnections.metadataJson })
    .from(integrationConnections)
    .where(and(
      eq(integrationConnections.organizationId, organizationId),
      eq(integrationConnections.provider, providerId),
    ))
    .limit(1);
  if (!row) return UNKNOWN;

  const held = parse(row.metadataJson)["providerSession"];
  if (!held || typeof held !== "object") return UNKNOWN;
  const record = held as Partial<ConnectionHealthRecord>;
  return {
    state: record.state ?? "SESSION_REQUIRED",
    detail: record.detail,
    runnerId: record.runnerId,
    checkedAt: record.checkedAt ?? null,
    lastVerifiedAt: record.lastVerifiedAt ?? null,
  };
}

/**
 * Record what a device just observed about the provider session.
 *
 * `verified` marks a completed provider operation rather than a successful
 * poll: a session can be perfectly alive and still never have been used to do
 * anything, and an operator deciding whether to trust this connection wants the
 * second date, not the first.
 */
export async function recordConnectionHealth(
  dbSession: DbSession,
  organizationId: string,
  providerId: string,
  observed: { state: ConnectionState; detail?: string; runnerId?: string; verified?: boolean },
): Promise<void> {
  const [row] = await dbSession.db
    .select({ metadataJson: integrationConnections.metadataJson })
    .from(integrationConnections)
    .where(and(
      eq(integrationConnections.organizationId, organizationId),
      eq(integrationConnections.provider, providerId),
    ))
    .limit(1);
  // No connection row is not an error here. Health is a fact about a connection
  // that exists; inventing one to hang it on would create a connection nobody
  // made.
  if (!row) return;

  const metadata = parse(row.metadataJson);
  const previous = (metadata.providerSession ?? {}) as Partial<ConnectionHealthRecord>;
  const now = new Date().toISOString();
  metadata.providerSession = {
    state: observed.state,
    detail: observed.detail,
    runnerId: observed.runnerId,
    checkedAt: now,
    lastVerifiedAt: observed.verified ? now : previous.lastVerifiedAt ?? null,
  } satisfies ConnectionHealthRecord;

  await dbSession.db
    .update(integrationConnections)
    .set({ metadataJson: JSON.stringify(metadata), updatedAt: new Date() })
    .where(and(
      eq(integrationConnections.organizationId, organizationId),
      eq(integrationConnections.provider, providerId),
    ));
}
