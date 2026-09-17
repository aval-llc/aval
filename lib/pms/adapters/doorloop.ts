/**
 * DoorLoop — the first provider with a real write path.
 *
 * Chosen deliberately as the proving ground: its API key is self-serve, its
 * terms carry no automation prohibition, and its writes are ordinary REST. If
 * the machinery only worked on a provider we had also negotiated access to, we
 * would not have tested the machinery.
 *
 * NOT LIVE-VALIDATED. Every request shape here comes from DoorLoop's published
 * API documentation and is covered by fixtures in tests/pms-doorloop.test.ts.
 * No call has been made against a real DoorLoop tenant, because no credential
 * exists in this workspace. Per AGENTS.md, that means this adapter is
 * implemented and unverified — the distinction belongs in the release notes.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decryptSecret } from "@/lib/integrations/crypto.ts";
import { providerJson, record, requiredString, safeSegment } from "@/lib/integrations/http.ts";
import { registerWriteAdapter, type WriteAdapter } from "../flows.ts";
import { registerGrantProbe, type GrantProbe } from "../grants.ts";
import type { PmsAction } from "../types.ts";

const BASE = "https://app.doorloop.com/api";

async function apiKey(organizationId: string): Promise<string> {
  const db = getDb();
  const [connection] = await db
    .select({ ciphertext: integrationConnections.accessTokenCiphertext })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.organizationId, organizationId),
        eq(integrationConnections.provider, "doorloop"),
        eq(integrationConnections.status, "connected"),
      ),
    )
    .limit(1);

  if (!connection?.ciphertext) throw new Error("No connected DoorLoop credential for this workspace.");
  const secret = (globalThis as { process?: { env?: Record<string, string> } }).process?.env
    ?.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("INTEGRATION_TOKEN_ENCRYPTION_KEY is unavailable.");
  return decryptSecret(connection.ciphertext, secret);
}

function headers(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" };
}

/**
 * Grant discovery for DoorLoop.
 *
 * Probes with the least destructive operation the API offers: a bounded GET
 * against each collection the actions touch. A 200 means the key can read that
 * collection, which on DoorLoop's permission model is the prerequisite for
 * writing it. It never POSTs to find out — the brief forbids probing by
 * attempting a real write, and a probe that creates a work order to see whether
 * it can create work orders has already done the damage it was checking for.
 *
 * Read access is necessary but not sufficient for write, so this deliberately
 * under-claims: a key that can read but not write yields an `available` entry,
 * the first real write fails, and the failure is reported rather than masked.
 * Over-claiming here costs one clear error; under-claiming would hide a
 * capability the customer paid for.
 */
const probe: GrantProbe = async (organizationId) => {
  const key = await apiKey(organizationId);
  const available: PmsAction[] = [];

  const checks: ReadonlyArray<{ path: string; actions: readonly PmsAction[] }> = [
    {
      path: "/work-orders?page_size=1",
      actions: [
        "maintenance.work_orders.read",
        "maintenance.work_order.create",
        "maintenance.work_order.update_status",
        "maintenance.work_order.close",
      ],
    },
    { path: "/vendors?page_size=1", actions: ["maintenance.vendor.dispatch"] },
    { path: "/lease-transactions?page_size=1", actions: ["arrears.ledger.read", "arrears.payment.post"] },
    { path: "/leases?page_size=1", actions: ["leasing.lease.update_status", "reporting.financials.read"] },
    { path: "/applications?page_size=1", actions: ["leasing.applications.read", "leasing.application.send"] },
  ];

  for (const check of checks) {
    try {
      await providerJson(`${BASE}${check.path}`, { method: "GET", headers: headers(key) });
      available.push(...check.actions);
    } catch {
      // A collection this key cannot read is a collection we do not claim.
      // Silence per-collection rather than failing the whole probe: a narrow key
      // is a valid configuration, not an error.
    }
  }

  return { available };
};

interface AdapterInput {
  organizationId: string;
  providerId: string;
  action: PmsAction;
  payload: unknown;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("PMS write payload must be an object.");
  }
  return payload as Record<string, unknown>;
}

async function post(key: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  return record(await providerJson(`${BASE}${path}`, { method: "POST", headers: headers(key), body: JSON.stringify(body) }));
}

async function put(key: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  return record(await providerJson(`${BASE}${path}`, { method: "PUT", headers: headers(key), body: JSON.stringify(body) }));
}

const createWorkOrder: WriteAdapter = async (input: AdapterInput) => {
  const key = await apiKey(input.organizationId);
  const payload = payloadRecord(input.payload);
  try {
    const created = await post(key, "/work-orders", {
      property: requiredString(payload.propertyId, "property id"),
      unit: typeof payload.unitId === "string" ? payload.unitId : undefined,
      summary: requiredString(payload.summary, "summary", 200),
      description: typeof payload.description === "string" ? payload.description.slice(0, 4000) : undefined,
      priority: typeof payload.priority === "string" ? payload.priority : "medium",
    });
    return { ok: true, externalId: requiredString(created.id, "work order id") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "DoorLoop rejected the work order." };
  }
};

const updateWorkOrderStatus: WriteAdapter = async (input: AdapterInput) => {
  const key = await apiKey(input.organizationId);
  const payload = payloadRecord(input.payload);
  const id = safeSegment(requiredString(payload.workOrderId, "work order id"));
  try {
    await put(key, `/work-orders/${id}`, { status: requiredString(payload.status, "status", 40) });
    return { ok: true, externalId: String(payload.workOrderId) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "DoorLoop rejected the status change." };
  }
};

const closeWorkOrder: WriteAdapter = async (input: AdapterInput) => {
  const key = await apiKey(input.organizationId);
  const payload = payloadRecord(input.payload);
  const id = safeSegment(requiredString(payload.workOrderId, "work order id"));
  try {
    await put(key, `/work-orders/${id}`, {
      status: "closed",
      resolution: typeof payload.resolution === "string" ? payload.resolution.slice(0, 2000) : undefined,
    });
    return { ok: true, externalId: String(payload.workOrderId) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "DoorLoop rejected the close." };
  }
};

const dispatchVendor: WriteAdapter = async (input: AdapterInput) => {
  const key = await apiKey(input.organizationId);
  const payload = payloadRecord(input.payload);
  const id = safeSegment(requiredString(payload.workOrderId, "work order id"));
  try {
    await put(key, `/work-orders/${id}`, {
      assignedToVendor: requiredString(payload.vendorId, "vendor id"),
      status: "assigned",
    });
    return { ok: true, externalId: String(payload.workOrderId) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "DoorLoop rejected the vendor assignment." };
  }
};

/**
 * Registration.
 *
 * Only maintenance is registered. Arrears and leasing adapters are deliberately
 * absent: their write paths resolve to `unlearned` on DoorLoop, which is the
 * honest state — the machinery is shared and complete, the DoorLoop-specific
 * request shapes for posting to a trust ledger are not written, and inventing
 * them from documentation without a sandbox is how you post a payment to the
 * wrong lease.
 */
export function registerDoorLoop(): void {
  registerGrantProbe("doorloop", probe);
  registerWriteAdapter("doorloop", "maintenance.work_order.create", createWorkOrder);
  registerWriteAdapter("doorloop", "maintenance.work_order.update_status", updateWorkOrderStatus);
  registerWriteAdapter("doorloop", "maintenance.work_order.close", closeWorkOrder);
  registerWriteAdapter("doorloop", "maintenance.vendor.dispatch", dispatchVendor);
}

export const __testing = { probe, createWorkOrder, updateWorkOrderStatus, closeWorkOrder, dispatchVendor, BASE };
