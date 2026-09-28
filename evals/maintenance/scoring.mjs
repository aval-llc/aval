/** Independent result scoring. A prevented mutation is not a completed workflow. */
export const maintenanceScorerVersion = 'maintenance-behavior-scorer-v6';
export function scoreMaintenanceCase(item) {
  const assertions = { ...item.assertions };
  if (item.mode === 'live_subscription') {
    assertions.clean_task_finish = ['COMPLETED', 'CANCELLED', 'WAITING_FOR_HUMAN'].includes(item.task_status);
  }
  return { ...item, assertions, scorer_version: maintenanceScorerVersion,
    status: item.status === 'incomplete' ? 'incomplete' : Object.keys(assertions).length > 0 && Object.values(assertions).every(v => v === true || v === 'not_reached') ? 'passed' : 'failed' };
}

export function maintenanceFailureCategory(item) {
  const reason = item.maintenance_outcome?.reasonCode;
  if (reason === 'inference_budget' || /token budget|budget_reservation/.test(item.error ?? item.task_error ?? '')) return 'inference_budget';
  if (reason === 'invalid_proposal' || /conclusion cannot bypass/.test(item.task_error ?? '')) return 'invalid_proposal';
  if (item.assertions?.correct_property_and_unit === false) return 'incorrect_identity';
  if (item.assertions?.authorization === false) return 'unauthorized_action';
  if ((item.work_orders?.length ?? 0) > 1) return 'duplicate_effect';
  if (['inference_interrupted', 'inference_usage_unknown'].includes(reason)) return 'transport';
  if (item.error) return 'transport';
  if (item.assertions?.evidence_read === false) return 'evidence_missing';
  return item.status === 'passed' ? null : 'verification_rejection';
}
