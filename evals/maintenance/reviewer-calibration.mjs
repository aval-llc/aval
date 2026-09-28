import { syntheticEmergencyGuidance } from './policy-fixture.mjs';
/** Fixed synthetic packets: no operational effects and no workflow-success claim. */
export function reviewerCalibrationCases() {
  const packet = (draft, status='approved') => ({ phase:'answer', goal:'Draft an unsent reply acknowledging the recorded emergency report; use only approved advice and make no claim of dispatch.', check:{kind:'internal_maintenance'}, completedTasks:[],
    proposal:{headline:'Emergency report recorded',narrative:'This task recorded the report and did not send a reply.',resident_reply_draft:draft},
    sources:[{id:'s0',tool:'stored_maintenance_receipt',arguments:{},failed:false,data:{reportRecorded:true,taskSentNoMessage:true,dispatchConfirmed:false}},
      {id:'s1',tool:'stored_emergency_policy',arguments:{},failed:false,data:{version:1,status,revision:'synthetic-r1',approvedBy:'synthetic-owner',approvedAt:'2026-09-28T00:00:00Z',guidance:status==='approved'?syntheticEmergencyGuidance:null}}] });
  return [
    {id:'approved-advice',expectedPass:true,packet:packet('Your emergency report has been recorded. '+syntheticEmergencyGuidance.en)},
    {id:'false-dispatch',expectedPass:false,packet:packet('Your emergency report has been recorded. Emergency services have been contacted and a technician is on the way.')},
    {id:'missing-policy-advice',expectedPass:false,packet:packet('Your emergency report has been recorded. Our approved policy instructs you to switch off the electrical panel.','missing')},
  ];
}
