import { sql } from 'drizzle-orm';
import type { DbSession } from '@/db/postgres/session';
import { payloadHash } from '../../agents/canonical-payload.ts';
import { agentsPaused } from '../../agents/pause.ts';
import { recordEvidence } from '../../agents/evidence.ts';
import { recordExternalReference } from '../../agents/tasks.ts';
import { parseCommitFlow, flowDigest, type FlowStep } from './steps.ts';

export const BROWSER_PROTOCOL = 2;
const ACTION = 'maintenance.work_order.create';
const LEASE_SECONDS = 120;
export const BUILDIUM_WORK_ORDER_FLOW: FlowStep[] = [
  {kind:'open',page:'Request work orders'},
  {kind:'fill',label:'Subject',from:'summary'},
  {kind:'choose',label:'Vendor',from:'vendorName'},
  {kind:'fill',label:'Work to be performed',from:'description'},
  {kind:'choose',label:'Priority',from:'priority'},
  {kind:'commit',button:'Save work order'},
  {kind:'capture',label:'Work order',as:'externalId'},
];
export interface BrowserIdentity { origin: string; accountId: string; staffId: string }
export interface MaterialFacts {
  requestId: string; propertyId: string; unitId: string; status: string;
  symptoms: string; accessRestrictions: string; linkedWorkOrderIds: string[];
}
export interface BrowserManifest {
  protocol: 2; connectionId: string; provider: string; identity: BrowserIdentity;
  action: typeof ACTION; payload: Record<string, unknown>; payloadDigest: string;
  facts: MaterialFacts; factsDigest: string; reference: string;
  flowId: string; flowDigest: string; steps: FlowStep[];
}
export interface BrowserClaim {
  queueId: string; generation: number; mode: 'prepare' | 'verify';
  manifest: BrowserManifest; externalId: string | null;
}
type QueueRow = {
  id: string; connection_id: string; protocol_json: BrowserManifest; approval_id: string;
  status: string; lease_generation: number; leased_by: string | null; lease_expires_at: Date | null;
  submitted_at: Date | null; review_due_at: Date | null; verification_attempts: number; external_id: string | null;
  lease_valid: boolean;
};
export class BrowserProtocolError extends Error {}
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new BrowserProtocolError(message);
}
export function parseIdentity(value: unknown): BrowserIdentity {
  const v = value as BrowserIdentity;
  requireThat(v && typeof v.origin === 'string', 'PMS identity is missing');
  let url: URL;
  try { url = new URL(v.origin); } catch { throw new BrowserProtocolError('Invalid PMS origin'); }
  requireThat(url.protocol === 'https:' && url.origin === v.origin && !url.username && !url.password, 'Invalid PMS origin');
  for (const key of ['accountId', 'staffId'] as const) requireThat(typeof v[key] === 'string' && v[key].length > 0 && v[key].length <= 200, 'PMS account and staff identity are required');
  return {origin: v.origin, accountId: v.accountId, staffId: v.staffId};
}
export function materialFacts(value: unknown): MaterialFacts {
  const v = value as MaterialFacts;
  const result = {} as MaterialFacts;
  for (const key of ['requestId','propertyId','unitId','status','symptoms','accessRestrictions'] as const) {
    requireThat(v && typeof v[key] === 'string' && v[key].length <= 8000, `Missing material fact: ${key}`);
    result[key] = v[key].normalize('NFC').replace(/\s+/g, ' ').trim();
  }
  requireThat(result.requestId && result.propertyId && result.unitId && result.status && result.symptoms, 'Request identity or symptoms are missing');
  requireThat(Array.isArray(v.linkedWorkOrderIds) && v.linkedWorkOrderIds.length <= 100 && v.linkedWorkOrderIds.every(x => typeof x === 'string' && x.length <= 200), 'Invalid linked work orders');
  result.linkedWorkOrderIds = [...new Set(v.linkedWorkOrderIds)].sort();
  return result;
}

export async function registerBrowserDevice(s: DbSession, org: string, user: string, id: string, secret: string) {
  requireThat(/^[a-f0-9-]{36}$/.test(id) && /^[a-f0-9]{64}$/.test(secret), 'Invalid device registration');
  const hash = await payloadHash(secret);
  await s.db.execute(sql`insert into pms_browser_devices(id,organization_id,user_id,token_hash)
    values(${id},${org},${user},${hash}) on conflict do nothing`);
  await authenticateBrowserDevice(s, org, user, id, secret);
  return {protocol: BROWSER_PROTOCOL, organizationId: org, deviceId: id};
}
export async function authenticateBrowserDevice(s: DbSession, org: string, user: string, id: string, secret: string) {
  const hash = await payloadHash(secret);
  const result = await s.db.execute(sql`select id from pms_browser_devices where organization_id=${org}
    and id=${id} and user_id=${user} and token_hash=${hash} and revoked=false for share`);
  requireThat(result.rows.length === 1, 'This Desktop device must reconnect');
}

/** Binding is established by the privileged Desktop driver after human setup. */
export async function bindBrowserConnection(s: DbSession, org: string, device: string, input: {
  connectionId: string; identity: unknown; feasibility: Record<string, unknown>;
}) {
  const identity = parseIdentity(input.identity);
  const gates = ['restrictedStaff','permittedAccess','searchableReference','nonWritingPreparation','observableIdentity','propertyScoped','controlledVendor'];
  requireThat(gates.every(key => input.feasibility?.[key] === true), 'Complete the PMS feasibility checks first');
  requireThat(/^\d{1,20}$/.test(String(input.feasibility.allowedPropertyId??'')), 'A stable Buildium demo property is required');
  requireThat(typeof input.feasibility.controlledVendorId==='string'&&String(input.feasibility.controlledVendorId).length<=100
    && input.feasibility.controlledVendorName==='Aval Demo Vendor — DO NOT CONTACT','The controlled Buildium demo vendor is required');
  const connections = await s.db.execute<{provider:string;metadata_json:Record<string,unknown>}>(sql`select provider,metadata_json from integration_connections
    where organization_id=${org} and id=${input.connectionId} and status in ('verification_required','connected') for update`);
  requireThat(connections.rows[0], 'Connection is unavailable');
  await s.db.execute(sql`insert into pms_browser_bindings(id,organization_id,device_id,provider,identity_json,feasibility_json,enabled)
    values(${input.connectionId},${org},${device},${connections.rows[0].provider},${JSON.stringify(identity)}::jsonb,${JSON.stringify(input.feasibility)}::jsonb,true)
    on conflict(id) do nothing`);
  const binding = await getBinding(s, org, input.connectionId);
  requireThat(binding.device_id === device && await payloadHash(binding.identity_json) === await payloadHash(identity), 'Connection is already bound to another account or device');
  const metadata=connections.rows[0].metadata_json??{};
  const next={...metadata,pmsGrants:{available:[ACTION],probed:true,probedAt:new Date().toISOString()},pmsDesktop:{
    ...(typeof metadata.pmsDesktop==='object'&&metadata.pmsDesktop?metadata.pmsDesktop:{}),allowedPropertyId:input.feasibility.allowedPropertyId,
  }};
  await s.db.execute(sql`update integration_connections set status='connected',external_account_id=${identity.accountId},
    external_account_name=${identity.staffId},metadata_json=${JSON.stringify(next)}::jsonb,updated_at=now()
    where organization_id=${org} and id=${input.connectionId}`);
  return {connectionId: input.connectionId, identity};
}
async function getBinding(s: DbSession, org: string, id: string) {
  const r = await s.db.execute<{id:string;provider:string;device_id:string;identity_json:BrowserIdentity;feasibility_json:Record<string,unknown>}>(sql`
    select b.id,b.provider,b.device_id,b.identity_json,b.feasibility_json from pms_browser_bindings b
    join integration_connections c on c.id=b.id and c.organization_id=b.organization_id
    where b.organization_id=${org} and b.id=${id} and b.enabled and c.status in ('verification_required','connected') for share of b,c`);
  requireThat(r.rows[0], 'Reconnect and verify a restricted PMS staff account');
  return r.rows[0];
}

/** Server prepares the exact artifact that is displayed before human approval. */
export async function prepareBrowserManifest(s: DbSession, org: string, input: {
  connectionId:string; flowId:string; facts:MaterialFacts; payload:Record<string,unknown>; logicalActionId:string;
}): Promise<BrowserManifest> {
  requireThat(!await agentsPaused(s,org), 'Agent execution is paused');
  const binding = await getBinding(s,org,input.connectionId);
  const flow = await s.db.execute<{steps_json:unknown;digest:string}>(sql`select steps_json,digest from pms_action_flows
    where id=${input.flowId} and provider=${binding.provider} and action=${ACTION} and status='active'
    and ((organization_id=${org} and connection_id=${input.connectionId}) or (organization_id is null and connection_id is null))
    order by organization_id nulls last limit 1 for share`);
  requireThat(flow.rows[0], 'No reviewed flow for this connection');
  const steps = parseCommitFlow(typeof flow.rows[0].steps_json === 'string' ? JSON.parse(flow.rows[0].steps_json) : flow.rows[0].steps_json);
  const digest = await flowDigest(steps);
  requireThat(digest === flow.rows[0].digest, 'Reviewed flow changed');
  const facts = materialFacts(input.facts);
  requireThat(String(binding.feasibility_json.allowedPropertyId??'')===facts.propertyId, 'The request is outside the connection-bound demo property');
  requireThat(!['closed','cancelled','canceled','completed'].includes(facts.status.toLowerCase()), 'The PMS request is no longer open');
  const reference = `AVAL-${(await payloadHash([org,input.connectionId,input.logicalActionId])).slice(0,32)}`;
  // Identity comes from the verified request, never from model-selected names.
  const payload:Record<string,unknown> = {...input.payload,propertyId:facts.propertyId,unitId:facts.unitId,requestId:facts.requestId,reference};
  if(binding.provider==='buildium') {
    payload.vendorId=binding.feasibility_json.controlledVendorId;
    payload.vendorName=binding.feasibility_json.controlledVendorName;
  }
  return {protocol:2,connectionId:input.connectionId,provider:binding.provider,identity:binding.identity_json,
    action:ACTION,payload,payloadDigest:await payloadHash(payload),facts,factsDigest:await payloadHash(facts),
    reference,flowId:input.flowId,flowDigest:digest,steps};
}

/** Build the exact browser evidence attached to a model's approval card. */
export async function browserEvidenceForProposal(s:DbSession,org:string,input:Record<string,unknown>,logicalActionId:string) {
  if(input.provider!=='buildium')return{};
  const connection=await s.db.execute<{id:string}>(sql`select id from integration_connections where organization_id=${org}
    and provider='buildium' and status='connected' and auth_mode='customer_desktop_session' limit 1`);
  requireThat(connection.rows[0],'Connect and verify the restricted Buildium Desktop session first');
  const flow=await s.db.execute<{id:string}>(sql`select id from pms_action_flows where provider='buildium' and action=${ACTION} and status='active'
    and ((organization_id=${org} and connection_id=${connection.rows[0].id}) or (organization_id is null and connection_id is null))
    order by organization_id nulls last limit 1`);
  requireThat(flow.rows[0],'The reviewed Buildium work-order flow is unavailable');
  const requestId=String(input.request_id??''),propertyId=String(input.property_id??''),unitId=String(input.unit_id??'');
  requireThat(/^\d{1,20}$/.test(requestId)&&/^\d{1,20}$/.test(propertyId)&&/^\d{1,20}$/.test(unitId),'Use stable Buildium request, property and unit IDs');
  const payload={summary:String(input.summary??''),description:String(input.description??''),priority:String(input.priority??'medium')};
  const facts=materialFacts({requestId,propertyId,unitId,status:String(input.request_status??''),symptoms:String(input.description??''),
    accessRestrictions:String(input.access_restrictions??''),linkedWorkOrderIds:Array.isArray(input.linked_work_order_ids)?input.linked_work_order_ids:[]});
  return {pmsBrowser:await prepareBrowserManifest(s,org,{connectionId:connection.rows[0].id,flowId:flow.rows[0].id,facts,payload,logicalActionId})};
}

async function approvalFor(s: DbSession, org: string, approvalId: string, manifest: BrowserManifest) {
  // Order deployment revocation against the transaction that consumes a grant.
  // The predicate below alone would use a snapshot and permit a concurrent
  // pause of an existing deployment before our submission transition commits.
  await s.db.execute(sql`select id from agent_deployments where organization_id=${org} for share`);
  const r = await s.db.execute<{user_id:string; evidence_json:{pmsBrowser?:BrowserManifest}}>(sql`
    select t.user_id,a.evidence_json from agent_approvals a join agent_tasks t on t.id=a.task_id and t.organization_id=a.organization_id
    join organizations o on o.id=a.organization_id
    where a.organization_id=${org} and a.id=${approvalId} and a.tool_name='create_work_order'
    and a.status='approved' and a.expires_at>now() and a.approvals_received>=a.required_approvals
    and a.decided_by_user_id=o.owner_user_id
    and exists(select 1 from agent_approval_decisions d where d.organization_id=a.organization_id
      and d.approval_id=a.id and d.user_id=o.owner_user_id and d.decision='approved')
    and (not exists(select 1 from agent_deployments d where d.organization_id=t.organization_id)
      or exists(select 1 from agent_deployments d where d.organization_id=t.organization_id
        and d.persona_id=t.agent_id and d.provider=${manifest.provider} and d.status='active' and d.workflows_json ? 'maintenance'))
    and t.status not in ('COMPLETED','CANCELLED','FAILED','SUPERSEDED') and not t.cancel_requested
    and t.deadline_at>now() for share of a,t`);
  requireThat(r.rows[0]?.evidence_json.pmsBrowser, 'A current approval for this exact PMS action is required');
  requireThat(await payloadHash(r.rows[0].evidence_json.pmsBrowser) === await payloadHash(manifest), 'PMS action changed after approval');
  return r.rows[0].user_id;
}

export async function enqueueBrowserWrite(s: DbSession, org: string, approvalId: string, manifest: BrowserManifest) {
  requireThat(manifest.protocol === 2, 'Update Aval Desktop to use supervised PMS writes');
  const actor = await approvalFor(s,org,approvalId,manifest);
  const binding = await getBinding(s,org,manifest.connectionId);
  requireThat(await payloadHash(binding.identity_json) === await payloadHash(manifest.identity), 'PMS account changed');
  requireThat(!await agentsPaused(s,org), 'Agent execution is paused');
  const id=crypto.randomUUID();
  await s.db.execute(sql`insert into pms_write_queue
    (id,organization_id,provider,action,approval_id,flow_id,payload_json,idempotency_key,status,created_at,updated_at,connection_id,protocol_json,responsible_user_id)
    values(${id},${org},${manifest.provider},${ACTION},${approvalId},${manifest.flowId},${JSON.stringify(manifest.payload)}::jsonb,
      ${manifest.reference},'pending',now(),now(),${manifest.connectionId},${JSON.stringify(manifest)}::jsonb,${actor})
    on conflict(organization_id,idempotency_key) do nothing`);
  const result=await s.db.execute<{id:string;protocol_json:BrowserManifest;status:string}>(sql`select id,protocol_json,status from pms_write_queue
    where organization_id=${org} and idempotency_key=${manifest.reference} for share`);
  requireThat(result.rows[0] && await payloadHash(result.rows[0].protocol_json)===await payloadHash(manifest), 'The logical action already has a different approved payload');
  requireThat(result.rows[0].status!=='needs_review', 'This PMS attempt requires human reconciliation, not another submission');
  return result.rows[0].id;
}

/** Runs even while writes are paused. Checking an earlier write is read-only. */
export async function expireBrowserReviews(s:DbSession,org:string) {
  await s.db.execute(sql`update pms_write_queue set status='needs_review',review_due_at=now(),
    responsible_user_id=(select owner_user_id from organizations where id=${org}),
    last_error='This older Desktop action needs a new connection-bound approval. Nothing will be retried automatically.',
    leased_by=null,lease_expires_at=null,updated_at=now()
    where organization_id=${org} and protocol_json is null and status in ('pending','leased')`);
  await s.db.execute(sql`update pms_write_queue q set status='needs_review',review_due_at=now(),
    last_error='Approval expired, task stopped, or Desktop preparation could not finish. Human review is required.',
    leased_by=null,lease_expires_at=null,updated_at=now()
    where q.organization_id=${org} and q.protocol_json is not null and q.submitted_at is null
      and q.status in ('pending','leased') and (
        (q.attempts>=3 and q.lease_expires_at<now()) or not exists (
          select 1 from agent_approvals a join agent_tasks t on t.id=a.task_id and t.organization_id=a.organization_id
          where a.id=q.approval_id and a.organization_id=q.organization_id and a.status='approved' and a.expires_at>now()
            and t.deadline_at>now() and not t.cancel_requested and t.status not in ('COMPLETED','CANCELLED','FAILED','SUPERSEDED')
        ))`);
  await s.db.execute(sql`update pms_write_queue q set status='needs_review',
    last_error='The PMS result needs human verification. Do not repeat creation.',leased_by=null,lease_expires_at=null,updated_at=now()
    where q.organization_id=${org} and q.submitted_at is not null and q.status not in ('confirmed','needs_review') and q.review_due_at<=now()`);
  await s.db.execute(sql`update pms_write_queue q set responsible_user_id=o.owner_user_id
    from organizations o where q.organization_id=${org} and o.id=q.organization_id
    and q.protocol_json is not null and not exists(select 1 from access_grants g
      where g.organization_id=q.organization_id and g.principal_id=q.responsible_user_id
      and g.revoked_at is null and (g.expires_at is null or g.expires_at>now()))`);
}

export async function claimBrowserWrite(s: DbSession, org: string, device: string): Promise<BrowserClaim|null> {
  await expireBrowserReviews(s,org);
  const paused = await agentsPaused(s,org);
  // Serialize selection across devices within this workspace; SQL also excludes
  // any other in-flight/uncertain action for the same connection.
  await s.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pms:claim:${org}`},0))`);
  const r = await s.db.execute<QueueRow>(sql`with candidate as (
    select q.id from pms_write_queue q join pms_browser_bindings b on b.id=q.connection_id and b.organization_id=q.organization_id
    where q.organization_id=${org} and b.device_id=${device} and b.enabled and q.protocol_json->>'protocol'='2'
      and (q.lease_expires_at is null or q.lease_expires_at<now())
      and ((q.submitted_at is null and q.status in ('pending','leased') and not ${paused})
        or (q.submitted_at is not null and q.status in ('submission_unknown','verifying') and q.verify_after<=now()))
      and not exists(select 1 from pms_write_queue busy where busy.organization_id=q.organization_id
        and busy.connection_id=q.connection_id and busy.id<>q.id
        and (busy.status in ('submission_unknown','verifying','needs_review') or (busy.status='leased' and busy.lease_expires_at>now())))
    order by q.created_at asc limit 1 for update of q skip locked)
    update pms_write_queue q set status=case when q.submitted_at is null then 'leased' else 'verifying' end,
      leased_by=${device},lease_generation=q.lease_generation+1,lease_expires_at=now()+${LEASE_SECONDS}*interval '1 second',
      attempts=q.attempts+1,updated_at=now() from candidate where q.id=candidate.id returning q.*`);
  const row=r.rows[0];
  if(!row) return null;
  // Late reports are hints for a fresh read-back, never authority to settle.
  const evidence=await s.db.execute<{external_id:string}>(sql`select report_json->>'externalId' as external_id
    from pms_browser_reports where organization_id=${org} and queue_id=${row.id} and device_id=${device}
      and report_json->>'kind'='confirmed' and report_json->>'reference'=${row.protocol_json.reference}
      and report_json->'identity'=${JSON.stringify(row.protocol_json.identity)}::jsonb
    order by created_at desc limit 1`);
  return {queueId:row.id,generation:row.lease_generation,mode:row.submitted_at?'verify':'prepare',manifest:row.protocol_json,
    externalId:row.external_id??evidence.rows[0]?.external_id??null};
}

export async function consumeBrowserGrant(s: DbSession, org: string, device: string, input: {
  queueId:string; generation:number; identity:unknown; facts:unknown; form:unknown;
  permissions?:{createWorkOrder:boolean;accounting:boolean};
}) {
  requireThat(!await agentsPaused(s,org), 'Agent execution is paused');
  requireThat(input.permissions?.createWorkOrder===true && input.permissions.accounting===false, 'Re-verify the restricted PMS role before submission');
  const r=await s.db.execute<QueueRow>(sql`select *,lease_expires_at>now() as lease_valid from pms_write_queue where organization_id=${org} and id=${input.queueId} for update`);
  const row=r.rows[0];
  requireThat(row && row.status==='leased' && !row.submitted_at && row.leased_by===device && row.lease_generation===input.generation && row.lease_valid, 'Submission permission expired or was already consumed');
  const m=row.protocol_json;
  const binding=await getBinding(s,org,row.connection_id);
  requireThat(binding.device_id===device && await payloadHash(parseIdentity(input.identity))===await payloadHash(m.identity)
    && await payloadHash(binding.identity_json)===await payloadHash(m.identity), 'Wrong PMS account or staff user');
  await approvalFor(s,org,row.approval_id,m);
  const capability=await s.db.execute(sql`select a.id from pms_write_authorizations a
    join integration_connections c on c.organization_id=a.organization_id and c.provider=a.provider
    where a.organization_id=${org} and a.provider=${m.provider} and a.action=${ACTION} and a.status='approved'
      and a.signed_authorization=true and a.approved_by_user_id is not null and c.id=${m.connectionId}
      and c.metadata_json->'pmsGrants'->'available' ? ${ACTION} for share of a,c`);
  requireThat(capability.rows.length===1, 'PMS write permission was withdrawn');
  const flow=await s.db.execute<{digest:string;steps_json:unknown}>(sql`select digest,steps_json from pms_action_flows
    where id=${m.flowId} and status='active' and ((organization_id=${org} and connection_id=${m.connectionId})
      or (organization_id is null and connection_id is null)) for share`);
  requireThat(flow.rows[0]?.digest===m.flowDigest, 'Approved flow changed');
  const steps=flow.rows[0].steps_json;
  requireThat(await flowDigest(parseCommitFlow(typeof steps==='string'?JSON.parse(steps):steps))===m.flowDigest, 'Flow integrity check failed');
  requireThat(await payloadHash(materialFacts(input.facts))===m.factsDigest, 'PMS request changed. Review a new proposal');
  requireThat(await payloadHash(input.form)===m.payloadDigest, 'The PMS form differs from the approved work order');
  // This durable transition happens before the browser click. Even loss of this
  // HTTP response makes the next attempt verification-only.
  const grantId=crypto.randomUUID();
  await s.db.execute(sql`update pms_write_queue set status='submission_unknown',submitted_at=now(),
    verify_after=now()+interval '1 minute',review_due_at=now()+interval '16 minutes',updated_at=now()
    where organization_id=${org} and id=${row.id} and lease_generation=${input.generation}`);
  return {grantId,queueId:row.id,generation:input.generation,expiresAt:new Date(Date.now()+5000).toISOString(),payloadDigest:m.payloadDigest};
}

export interface BrowserResult {
  queueId:string; generation:number; identity:BrowserIdentity;
  kind:'confirmed'|'unknown'|'blocked'; externalId?:string; reference?:string;
  form?:Record<string,unknown>; facts?:MaterialFacts; reason?:string;
}
export async function recordBrowserResult(s:DbSession,org:string,device:string,report:BrowserResult) {
  requireThat(['confirmed','unknown','blocked'].includes(report.kind) && Number.isSafeInteger(report.generation) && report.generation>0, 'Invalid PMS result');
  const r=await s.db.execute<QueueRow>(sql`select *,lease_expires_at>now() as lease_valid from pms_write_queue where organization_id=${org} and id=${report.queueId} for update`);
  const row=r.rows[0]; requireThat(row, 'Unknown PMS attempt');
  // Only the bound device can contribute evidence, including after its lease.
  const b=await s.db.execute<{device_id:string}>(sql`select device_id from pms_browser_bindings where organization_id=${org} and id=${row.connection_id}`);
  requireThat(b.rows[0]?.device_id===device, 'Wrong device');
  await s.db.execute(sql`insert into pms_browser_reports(id,organization_id,queue_id,device_id,lease_generation,report_json)
    values(${crypto.randomUUID()},${org},${row.id},${device},${report.generation},${JSON.stringify(report)}::jsonb)`);
  if(row.leased_by!==device || row.lease_generation!==report.generation || !row.lease_valid) return {status:'evidence_retained'};
  const m=row.protocol_json;
  // A staff member may change the request between our grant and the PMS write.
  // Only the newly verified work-order link is expected to change at read-back.
  let factsMatch=false;
  if(report.facts && report.externalId) {
    const current=materialFacts(report.facts);
    const linked=current.linkedWorkOrderIds.includes(report.externalId);
    current.linkedWorkOrderIds=current.linkedWorkOrderIds.filter(id=>id!==report.externalId);
    factsMatch=linked && await payloadHash(current)===m.factsDigest;
  }
  const verified=report.kind==='confirmed' && row.submitted_at && report.externalId && report.form && report.reference===m.reference
    && factsMatch && await payloadHash(parseIdentity(report.identity))===await payloadHash(m.identity) && await payloadHash(report.form)===m.payloadDigest;
  const status=verified?'confirmed':row.submitted_at && row.verification_attempts<3?'submission_unknown':'needs_review';
  const nextMinute=row.verification_attempts===0?1:row.verification_attempts===1?5:15;
  await s.db.execute(sql`update pms_write_queue set status=${status},external_id=case when ${Boolean(verified)} then ${report.externalId??null} else external_id end,
    verification_attempts=verification_attempts+1,verify_after=submitted_at+${nextMinute}*interval '1 minute',
    review_due_at=coalesce(review_due_at,now()),last_error=${verified?null:(report.reason??'PMS result needs verification')},
    leased_by=null,lease_expires_at=null,updated_at=now()
    where organization_id=${org} and id=${row.id} and leased_by=${device} and lease_generation=${report.generation}`);
  if(verified) {
    // Attach the independently read-back receipt to the existing execution
    // ledger. Queue success is not a replacement task-completion mechanism.
    const execution=await s.db.execute<{task_id:string;step_index:number;idempotency_key:string}>(sql`
      select e.task_id,e.step_index,e.idempotency_key from agent_approvals a
      join agent_task_steps e on e.organization_id=a.organization_id and e.task_id=a.task_id and e.step_index=a.step_index
      where a.organization_id=${org} and a.id=${row.approval_id} and e.tool_name='create_work_order'
        and e.kind='mutation_reserved' and e.policy_effect='allow' and e.idempotency_key is not null and e.error is null`);
    for(const attempt of execution.rows) {
      await recordExternalReference(s,{organizationId:org,taskId:attempt.task_id,stepIndex:attempt.step_index,
        toolName:'create_work_order',sourceProvider:m.provider,externalRecordId:report.externalId});
      await recordEvidence(s,{organizationId:org,taskId:attempt.task_id,actionExecutionId:attempt.idempotency_key,
        toolName:'create_work_order',claim:'The approved PMS work order was read back with matching request context',
        expectedState:{exists:true,payloadDigest:m.payloadDigest},observedState:{exists:true,payloadDigest:await payloadHash(report.form)},
        evidenceType:'provider_reread',sourceProvider:m.provider,externalRecordId:report.externalId,
        observedAt:new Date(),payloadRef:`pms_browser_reports:${row.id}:${report.generation}`});
    }
  }
  return {status,externalId:verified?report.externalId:undefined};
}
