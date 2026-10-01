import type { maintenanceReceipt } from './maintenance-receipt';

/** Fixed, opt-in owner-approved wording. Never interpolate source text or actor prose. */
export const MAINTENANCE_ACKNOWLEDGEMENTS = {
  version: 'maintenance-ack-v1',
  en: 'Thank you for reporting the issue. An internal maintenance work order has been created. This is an acknowledgement of the request, not confirmation that a vendor has been contacted, an appointment scheduled, or a repair completed.',
  'es-mx': 'Gracias por reportar el problema. Se creó una orden interna de mantenimiento. Este acuse confirma el registro de la solicitud, no que se haya contactado a un proveedor, programado una cita o completado la reparación.',
} as const;

export function maintenanceAcknowledgement(receipt: Awaited<ReturnType<typeof maintenanceReceipt>>, locale: string) {
  if (!receipt?.execution.historical || !receipt.execution.verified || receipt.execution.recordDrift || !receipt.identityUnchanged || !receipt.communication.taskSentNoMessage || receipt.emergencyPolicy?.acknowledgementVersion !== MAINTENANCE_ACKNOWLEDGEMENTS.version) return null;
  const emergency = receipt.execution.priority === 'emergency';
  if (emergency && receipt.emergencyPolicy.status !== 'approved') return null;
  const es = locale === 'es-mx';
  const draft = MAINTENANCE_ACKNOWLEDGEMENTS[es ? 'es-mx' : 'en'] + (emergency ? '\n\n' + receipt.emergencyPolicy.guidance![es ? 'esMx' : 'en'] : '');
  return { headline: es ? 'Orden interna registrada' : 'Internal work order recorded', confidence: 'high',
    narrative: (es ? 'La orden interna se creó. El flujo del agente no cierra la reparación. Borrador no enviado:\n\n' : 'The internal work order was created. Completing this agent task does not close the repair. Unsent draft:\n\n') + draft,
    resident_reply_draft: draft, templateVersion: MAINTENANCE_ACKNOWLEDGEMENTS.version,
    evidenceRevision: receipt.evidenceRevision, executionId: receipt.execution.executionId, policyRevision: receipt.emergencyPolicy.revision };
}
