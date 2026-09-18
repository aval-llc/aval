/**
 * The schemas the model reads, and the payload shape the adapters read.
 *
 * Pure, with no storage in it — the same split as `capability-rules.ts` /
 * `capability.ts` and `deployment-rules.ts` / `deployments.ts`. `tools.ts` does
 * the execution that needs a database; everything here can be read and tested
 * without one, which matters because this is the layer that failed silently the
 * first time (see tests/pms-tools.test.ts).
 *
 * Until this existed the ten write tools were half-wired in a way that read as
 * finished: `lib/agents/registry.ts` carried their permissions, risk levels and
 * approval requirements, `tool-map.ts` mapped them to actions, and
 * `lib/agents/runtime.ts` filtered them against the capability matrix. But no
 * schema was ever offered to the model and `runTool` had no branch for them, so
 * the runtime filter was narrowing an empty set and a model that somehow named
 * `create_work_order` got `Unknown tool`. It failed safe and it was not wired.
 *
 * The schema and its payload mapping are one object per tool because they are
 * one decision. In separate files they drift, and the drift is silent: the model
 * sends `property_id`, the adapter reads `propertyId`, and the write fails at
 * the provider with a message about a missing field nobody can trace back.
 */

import type { ToolSchema } from "@/lib/ask-aval/anthropic.ts";
import { PMS_PROVIDERS } from "./providers/index.ts";

const PROVIDER_IDS = PMS_PROVIDERS.map((provider) => provider.id);

/**
 * A static enum of every PMS Aval knows, not the per-org list.
 *
 * The schema cannot vary per request, and the honest narrowing already happened
 * twice: assembly excluded providers this workspace has not connected or this
 * agent is not deployed into, and `pmsWriteAllowed` re-resolves at execution. A
 * closed enum here adds the one thing those cannot — it stops the model
 * inventing a provider name outright.
 */
const provider = { type: "string", enum: PROVIDER_IDS } as const;

const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });

/** Present only when the model supplied a non-empty string. Never `null`. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Drops keys whose value is undefined, so an absent optional stays absent. */
function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

interface PmsWriteToolSpec {
  schema: ToolSchema;
  /** snake_case tool args → the payload shape adapters and the runner read. */
  payload: (args: Record<string, unknown>) => Record<string, unknown>;
}

const SPECS: readonly PmsWriteToolSpec[] = [
  {
    schema: {
      name: "create_work_order",
      description:
        "Create a work order in a connected PMS. Read the property and unit from the record layer first — "
        + "an invented property id writes a work order against the wrong building.",
      input_schema: {
        type: "object",
        properties: {
          provider,
          property_id: text(100),
          unit_id: text(100),
          summary: text(200),
          description: { type: "string", maxLength: 4000 },
          priority: { type: "string", enum: ["low", "medium", "high", "emergency"] },
        },
        required: ["provider", "property_id", "summary"],
      },
    },
    payload: (args) => compact({
      propertyId: str(args.property_id),
      unitId: str(args.unit_id),
      summary: str(args.summary),
      description: str(args.description),
      priority: str(args.priority),
    }),
  },
  {
    schema: {
      name: "update_work_order_status",
      description: "Change the status of an existing work order in a connected PMS.",
      input_schema: {
        type: "object",
        properties: { provider, work_order_id: text(100), status: text(40) },
        required: ["provider", "work_order_id", "status"],
      },
    },
    payload: (args) => compact({ workOrderId: str(args.work_order_id), status: str(args.status) }),
  },
  {
    schema: {
      name: "close_work_order",
      description:
        "Close a work order in a connected PMS. Closing is not the same as completing: state what resolved it.",
      input_schema: {
        type: "object",
        properties: { provider, work_order_id: text(100), resolution: { type: "string", maxLength: 2000 } },
        required: ["provider", "work_order_id"],
      },
    },
    payload: (args) => compact({ workOrderId: str(args.work_order_id), resolution: str(args.resolution) }),
  },
  {
    schema: {
      name: "dispatch_vendor",
      description:
        "Assign a vendor to an existing work order in a connected PMS. The vendor must already exist in that system.",
      input_schema: {
        type: "object",
        properties: { provider, work_order_id: text(100), vendor_id: text(100) },
        required: ["provider", "work_order_id", "vendor_id"],
      },
    },
    payload: (args) => compact({ workOrderId: str(args.work_order_id), vendorId: str(args.vendor_id) }),
  },
  {
    schema: {
      name: "create_payment_plan",
      description:
        "Create an arrears payment plan against a lease in a connected PMS. Amounts are in the lease's own currency, minor units.",
      input_schema: {
        type: "object",
        properties: {
          provider,
          lease_id: text(100),
          total_minor: { type: "integer", minimum: 1 },
          installments: { type: "integer", minimum: 1, maximum: 60 },
          first_due_date: text(10),
          note: { type: "string", maxLength: 2000 },
        },
        required: ["provider", "lease_id", "total_minor", "installments", "first_due_date"],
      },
    },
    payload: (args) => compact({
      leaseId: str(args.lease_id),
      totalMinor: typeof args.total_minor === "number" ? args.total_minor : undefined,
      installments: typeof args.installments === "number" ? args.installments : undefined,
      firstDueDate: str(args.first_due_date),
      note: str(args.note),
    }),
  },
  {
    schema: {
      name: "post_payment",
      description:
        "Post a received payment to a lease ledger in a connected PMS. This moves money in the system of record; "
        + "post only what a reconciled source shows was actually received.",
      input_schema: {
        type: "object",
        properties: {
          provider,
          lease_id: text(100),
          amount_minor: { type: "integer", minimum: 1 },
          received_on: text(10),
          method: { type: "string", enum: ["ach", "card", "check", "cash", "other"] },
          reference: { type: "string", maxLength: 200 },
        },
        required: ["provider", "lease_id", "amount_minor", "received_on"],
      },
    },
    payload: (args) => compact({
      leaseId: str(args.lease_id),
      amountMinor: typeof args.amount_minor === "number" ? args.amount_minor : undefined,
      receivedOn: str(args.received_on),
      method: str(args.method),
      reference: str(args.reference),
    }),
  },
  {
    schema: {
      name: "reply_to_inquiry",
      description: "Reply to a leasing inquiry inside a connected PMS, so the thread stays in the system of record.",
      input_schema: {
        type: "object",
        properties: { provider, inquiry_id: text(100), body: { type: "string", minLength: 1, maxLength: 4000 } },
        required: ["provider", "inquiry_id", "body"],
      },
    },
    payload: (args) => compact({ inquiryId: str(args.inquiry_id), body: str(args.body) }),
  },
  {
    schema: {
      name: "book_viewing",
      description: "Book a viewing against a unit in a connected PMS. Confirm availability before booking.",
      input_schema: {
        type: "object",
        properties: {
          provider,
          unit_id: text(100),
          prospect_id: text(100),
          starts_at: text(40),
          duration_minutes: { type: "integer", minimum: 5, maximum: 240 },
        },
        required: ["provider", "unit_id", "starts_at"],
      },
    },
    payload: (args) => compact({
      unitId: str(args.unit_id),
      prospectId: str(args.prospect_id),
      startsAt: str(args.starts_at),
      durationMinutes: typeof args.duration_minutes === "number" ? args.duration_minutes : undefined,
    }),
  },
  {
    schema: {
      name: "send_application",
      description: "Send a rental application to a prospect through a connected PMS.",
      input_schema: {
        type: "object",
        properties: { provider, prospect_id: text(100), unit_id: text(100) },
        required: ["provider", "prospect_id", "unit_id"],
      },
    },
    payload: (args) => compact({ prospectId: str(args.prospect_id), unitId: str(args.unit_id) }),
  },
  {
    schema: {
      name: "update_lease_status",
      description: "Change a lease's status in a connected PMS.",
      input_schema: {
        type: "object",
        properties: { provider, lease_id: text(100), status: text(40) },
        required: ["provider", "lease_id", "status"],
      },
    },
    payload: (args) => compact({ leaseId: str(args.lease_id), status: str(args.status) }),
  },
];

export const PMS_WRITE_TOOL_SCHEMAS: ToolSchema[] = SPECS.map((spec) => spec.schema);

const SPEC_BY_NAME: ReadonlyMap<string, PmsWriteToolSpec> = new Map(
  SPECS.map((spec) => [spec.schema.name, spec]),
);

export { SPEC_BY_NAME, str, compact };
