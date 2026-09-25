/**
 * The canonical capability vocabulary.
 *
 * Agents reason in these names — `work_order.create`, not `create_work_order`
 * and not `appfolioCreateWorkOrder()`. A capability is provider-independent: it
 * names an outcome in the property-management domain. Which tool delivers it,
 * against which provider, is resolved below it: by `CAPABILITY_TOOLS` here, and
 * then by the PMS capability matrix (`lib/pms/capability.ts`) for writes into a
 * system of record.
 *
 * The vocabulary is closed. A Specialist may only declare capabilities listed
 * here, and a test holds every Specialist to that, so a typo cannot quietly
 * become a capability nobody implements.
 *
 * `CAPABILITY_TOOLS` is honest about what exists. A capability with no entry
 * has no executor yet: a Specialist that declares it is DEFINED or ROUTABLE,
 * never TOOLED, for that capability. Nothing here grants authority — a tool
 * still needs its permission in the caller's envelope (permissions.ts) and, for
 * a PMS write, an `allow` from the capability matrix.
 */

export const CANONICAL_CAPABILITIES = [
  // portfolio, property and unit
  "portfolio.read", "portfolio.metrics.read", "portfolio.series.read",
  "property.read", "property.setup.prepare", "unit.read", "unit.setup.prepare",
  "occupancy.read", "owner.read", "client.read",

  // leasing and marketing
  "lead.read", "lead.create", "lead.update", "prospect.message.prepare",
  "listing.read", "listing.prepare", "listing.publish",
  "showing.read", "showing.schedule",
  "application.read", "application.send", "application.review.prepare",
  "marketing.channels.read", "leasing.funnel.read", "leasing.velocity.read",

  // screening
  "screening.read", "screening.request", "screening.decision.prepare", "adverse_action.prepare",

  // residents and communication
  "resident.read", "resident.message.prepare", "resident.message.send",
  "communication.read", "communication.channels.read", "communication.send", "communication.call",
  "accommodation.intake", "accommodation.read",

  // leases, renewals, notices, deposits
  "lease.read", "lease.draft", "lease.status.update", "lease.execute",
  "renewal.read", "renewal.prepare", "notice.prepare", "deposit.read", "deposit.prepare",

  // documents and knowledge
  "document.read", "document.extract", "knowledge.read",

  // receivables
  "charge.read", "charge.prepare", "payment.read", "payment.post",
  "ledger.read", "delinquency.read", "payment_plan.prepare", "payment_plan.create",
  "collections.prepare",

  // maintenance, turns, inspections, vendors
  "maintenance.read", "maintenance.request.read", "maintenance.request.create",
  "work_order.read", "work_order.create", "work_order.update", "work_order.close",
  "vendor.read", "vendor.dispatch", "vendor.prepare", "vendor.insurance.read",
  "purchase_order.prepare", "inventory.read",
  "turn.read", "turn.prepare", "inspection.read", "inspection.prepare",
  "key_access.read",

  // accounting and finance
  "accounting.read", "gl.read", "journal_entry.prepare", "bank.read", "reconciliation.prepare",
  "budget.read", "financial.statement.read", "invoice.read", "invoice.prepare",
  "bill.read", "bill.prepare", "payment.prepare",
  "owner.statement.prepare", "owner.distribution.prepare", "owner.contribution.prepare",

  // risk, insurance, compliance
  "risk.read", "insurance.read", "compliance.read", "compliance.prepare",
  "fair_housing.review", "incident.read", "incident.prepare", "claim.prepare",

  // affordable housing
  "affordable.read", "recertification.prepare", "voucher.read", "nspire.read",

  // utilities and sustainability
  "utility.read", "utility.bill.read", "utility.prepare", "sustainability.read",

  // HOA / associations
  "association.read", "assessment.read", "violation.prepare", "architectural_request.prepare",
  "board.prepare",

  // commercial
  "commercial.read", "cam.read", "cam.prepare",

  // data, reporting, provenance
  "analytics.read", "report.prepare", "provenance.read", "data.conflicts.read",
  "integration.health.read",

  // market
  "market.public.read", "market.comparables.read", "pricing.recommend",

  // internal operations
  "staff.read", "sop.read", "task.route",
] as const;

export type CanonicalCapability = (typeof CANONICAL_CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CANONICAL_CAPABILITIES);

export function isCanonicalCapability(value: string): value is CanonicalCapability {
  return CAPABILITY_SET.has(value);
}

/**
 * The registry tools that deliver each capability today.
 *
 * Several capabilities map to the same read, because the read tools are
 * portfolio-shaped rather than entity-shaped — `get_portfolio_metrics` is the
 * honest answer to "how many units are occupied" and to "what is the NOI" until
 * entity reads exist. That is recorded here rather than papered over with a
 * capability name per tool.
 *
 * `work_order.create` maps to both the Aval-native tool and the PMS write. They
 * are the same outcome through two adapters: the native record when no PMS is
 * connected or the PMS path is not permitted, the PMS write when it is. The
 * capability matrix decides which of the two the model is actually offered.
 */
export const CAPABILITY_TOOLS: Partial<Record<CanonicalCapability, readonly string[]>> = {
  "portfolio.read": ["get_portfolio_metrics", "get_property_breakdown"],
  "portfolio.metrics.read": ["get_portfolio_metrics"],
  "portfolio.series.read": ["get_metric_series"],
  "property.read": ["get_property_breakdown"],
  "unit.read": ["get_property_breakdown"],
  "occupancy.read": ["get_portfolio_metrics", "get_property_breakdown"],

  "lead.read": ["get_leasing_funnel"],
  "leasing.funnel.read": ["get_leasing_funnel"],
  "leasing.velocity.read": ["get_leasing_velocity"],
  "marketing.channels.read": ["get_marketing_channels"],
  "listing.publish": ["publish_listing"],
  "showing.schedule": ["book_viewing"],
  "application.send": ["send_application"],
  "prospect.message.prepare": ["reply_to_inquiry"],

  "resident.read": ["read_maintenance_context"],
  "communication.read": ["read_conversation", "list_conversations"],
  "communication.channels.read": ["get_communication_channels"],
  "communication.send": ["send_external_message"],
  "resident.message.send": ["send_external_message"],
  "communication.call": ["place_call"],

  "lease.read": ["list_documents", "read_document"],
  "lease.status.update": ["update_lease_status"],
  "lease.execute": ["execute_lease"],
  "document.read": ["list_documents", "read_document"],

  "accounting.read": ["get_accounting_breakdown", "get_operating_statement"],
  "financial.statement.read": ["get_operating_statement"],
  "gl.read": ["get_accounting_breakdown"],
  "ledger.read": ["get_delinquent_accounts"],
  "delinquency.read": ["get_delinquent_accounts"],
  "charge.read": ["get_delinquent_accounts"],
  "payment.read": ["get_delinquent_accounts"],
  "payment.post": ["post_payment"],
  "payment_plan.create": ["create_payment_plan"],

  "maintenance.read": ["get_maintenance_performance"],
  "maintenance.request.read": ["read_maintenance_context"],
  "maintenance.request.create": ["create_maintenance_work_order"],
  "work_order.read": ["get_maintenance_performance"],
  "work_order.create": ["create_maintenance_work_order", "create_work_order"],
  "work_order.update": ["update_work_order_status"],
  "work_order.close": ["close_work_order"],
  "vendor.dispatch": ["dispatch_vendor"],

  "analytics.read": ["get_metric_series", "get_operations_insights"],
  "provenance.read": ["get_operations_insights", "get_data_conflicts"],
  "data.conflicts.read": ["get_data_conflicts"],
  "risk.read": ["get_operations_insights", "get_delinquent_accounts"],
};

/**
 * The existing workflow-shaped PMS action names, as aliases of the canonical
 * capability they deliver.
 *
 * `PmsAction` values key stored flows, authorizations and certification
 * records (`pms_action_flows`), so they are not renamed. This map is how a
 * canonical name and a stored one refer to the same thing.
 */
export const PMS_ACTION_ALIASES: Readonly<Record<string, CanonicalCapability>> = {
  "maintenance.work_orders.read": "work_order.read",
  "maintenance.work_order.create": "work_order.create",
  "maintenance.work_order.update_status": "work_order.update",
  "maintenance.work_order.close": "work_order.close",
  "maintenance.vendor.dispatch": "vendor.dispatch",
  "arrears.ledger.read": "ledger.read",
  "arrears.payment_plan.create": "payment_plan.create",
  "arrears.payment.post": "payment.post",
  "leasing.applications.read": "application.read",
  "leasing.inquiry.reply": "prospect.message.prepare",
  "leasing.viewing.book": "showing.schedule",
  "leasing.application.send": "application.send",
  "leasing.lease.update_status": "lease.status.update",
  "reporting.financials.read": "financial.statement.read",
};

/** The tools a set of capabilities resolves to, deduplicated, in first-seen order. */
export function toolsForCapabilities(capabilities: readonly string[]): string[] {
  const tools: string[] = [];
  for (const capability of capabilities) {
    for (const tool of CAPABILITY_TOOLS[capability as CanonicalCapability] ?? []) {
      if (!tools.includes(tool)) tools.push(tool);
    }
  }
  return tools;
}

/** The capabilities in a list that no tool delivers yet. */
export function untooledCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.filter((capability) => !CAPABILITY_TOOLS[capability as CanonicalCapability]?.length);
}
