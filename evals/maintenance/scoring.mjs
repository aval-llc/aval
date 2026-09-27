/** Independent result scoring. A prevented mutation is not a completed workflow. */
export const maintenanceScorerVersion = 'maintenance-behavior-scorer-v2';
export function scoreMaintenanceCase(item) {
  const assertions = { ...item.assertions };
  if (item.mode === 'live_subscription') {
    assertions.clean_task_finish = ['COMPLETED', 'CANCELLED', 'WAITING_FOR_HUMAN'].includes(item.task_status);
  }
  return { ...item, assertions, scorer_version: maintenanceScorerVersion,
    status: item.status === 'incomplete' ? 'incomplete' : Object.keys(assertions).length > 0 && Object.values(assertions).every(Boolean) ? 'passed' : 'failed' };
}
