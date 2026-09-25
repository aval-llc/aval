/**
 * The join between the capability matrix and the tool registry.
 *
 * `lib/agents/registry.ts` answers "what could this tool do and what does it
 * cost". The matrix answers "does this tool exist for this org on this
 * provider". They meet here, and nowhere else, so there is exactly one place to
 * read when asking why a tool was or was not offered.
 *
 * Read actions are absent on purpose: the existing read tools
 * (`get_maintenance_performance`, `get_delinquent_accounts`, …) already read the
 * shared envelope in `lib/operations/` and are not provider-scoped. Gating them
 * per provider would break the unified view, which is the one thing the four
 * workflows exist to produce together.
 */

import type { PmsAction } from "./types.ts";

export const PMS_WRITE_TOOLS: Readonly<Record<string, PmsAction>> = {
  create_work_order: "maintenance.work_order.create",
  update_work_order_status: "maintenance.work_order.update_status",
  close_work_order: "maintenance.work_order.close",
  dispatch_vendor: "maintenance.vendor.dispatch",
  create_payment_plan: "arrears.payment_plan.create",
  post_payment: "arrears.payment.post",
  reply_to_inquiry: "leasing.inquiry.reply",
  book_viewing: "leasing.viewing.book",
  send_application: "leasing.application.send",
  update_lease_status: "leasing.lease.update_status",
};

const ACTION_TO_TOOL: ReadonlyMap<PmsAction, string> = new Map(
  Object.entries(PMS_WRITE_TOOLS).map(([tool, action]) => [action, tool]),
);

/** True for any tool whose availability the capability matrix decides. */
export function isPmsWriteTool(toolName: string): boolean {
  return toolName in PMS_WRITE_TOOLS;
}

export function actionForTool(toolName: string): PmsAction | undefined {
  return PMS_WRITE_TOOLS[toolName];
}

export function toolForAction(action: PmsAction): string | undefined {
  return ACTION_TO_TOOL.get(action);
}

export const PMS_WRITE_TOOL_NAMES: readonly string[] = Object.keys(PMS_WRITE_TOOLS);
