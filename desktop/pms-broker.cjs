"use strict";

const { createHash } = require("node:crypto");
function canonical(value) {
  if (value === null) return 'null';
  if (['boolean','string'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw Error('Invalid PMS manifest value');
  if (Array.isArray(value)) return `[${value.map(entry=>canonical(entry===undefined?null:entry)).join(",")}]`;
  return `{${Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
function partitionFor(binding) {
  if (!binding?.organizationId || !binding?.connectionId || !binding?.provider) throw Error("A verified workspace and connection are required");
  return `persist:pms-v2-${digest([binding.organizationId,binding.connectionId,binding.provider])}`;
}

/** No renderer-supplied URL, payload, step list or grants enter this object. */
class PmsBroker {
  constructor({ transport, driverFor, now = Date.now }) {
    this.transport=transport; this.driverFor=driverFor; this.now=now;
    this.running=false; this.lastStatus={status:"idle"}; this.used=new Set();
  }
  status() { return {...this.lastStatus}; }
  async tick() {
    if(this.running) return this.status();
    this.running=true;
    let job, identity;
    try {
      const registration=await this.transport({intent:"register",protocol:2});
      const claimed=await this.transport({intent:"claim",protocol:2});
      job=claimed.instruction;
      if(!job) return this.lastStatus={status:"idle"};
      const m=job.manifest;
      if(m.protocol!==2 || m.action!=="maintenance.work_order.create" || digest(m.payload)!==m.payloadDigest || digest(m.steps)!==m.flowDigest) throw Error("Invalid approved PMS manifest");
      const commit=m.steps.findIndex(step=>step.kind==="commit");
      if(commit<0 || m.steps.filter(step=>step.kind==="commit").length!==1 || m.steps.slice(commit+1).some(step=>!["capture","expect"].includes(step.kind))) throw Error("Invalid PMS commit boundary");
      const binding={organizationId:registration.organizationId,connectionId:m.connectionId,provider:m.provider,identity:m.identity};
      const driver=this.driverFor(binding);
      if(!driver || driver.protocol!==2) throw Error("This PMS connection needs a verified protocol 2 adapter");
      identity=await driver.identity();
      if(digest(identity)!==digest(m.identity)) throw Error("Wrong PMS account or staff user");
      if(job.mode==="prepare") {
        const existing=await driver.findByReference(m.reference,{manifest:m,requestId:m.facts.requestId});
        if(existing) {
          // A pre-existing reference without a consumed grant is contradictory;
          // keep the record for human investigation, never make another one.
          throw Error("The PMS already contains this reference. Human reconciliation is required");
        }
        await driver.prepare(m.steps.slice(0,commit),m.payload);
        const facts=await driver.readRequest(m.facts.requestId);
        const form=await driver.readForm();
        const currentPermissions=await driver.permissions();
        identity=await driver.identity();
        if(digest(identity)!==digest(m.identity) || digest(form)!==m.payloadDigest) throw Error("Wrong account or form values changed");
        const started=this.now();
        const grant=await this.transport({protocol:2,intent:"grant",queueId:job.queueId,generation:job.generation,identity,facts,form,permissions:currentPermissions});
        if(this.now()-started>4000 || Date.parse(grant.expiresAt)<=this.now() || grant.queueId!==job.queueId || grant.generation!==job.generation || grant.payloadDigest!==m.payloadDigest || this.used.has(grant.grantId)) throw Error("PMS submission grant expired or was reused");
        this.used.add(grant.grantId);
        // Recheck the actual form/account after the network round trip. This
        // provider method must check again in the same page action as the click.
        await driver.commit(m.steps[commit],m.payload,m.identity,grant.expiresAt);
      }
      const record=await driver.findByReference(m.reference,{externalId:job.externalId,manifest:m,requestId:m.facts.requestId});
      const facts=record?.externalId ? await driver.readRequest(m.facts.requestId) : undefined;
      identity=await driver.identity();
      const confirmed=Boolean(record?.externalId && record.form && record.reference===m.reference && digest(record.form)===m.payloadDigest && digest(identity)===digest(m.identity));
      const result=await this.transport({protocol:2,intent:"result",queueId:job.queueId,generation:job.generation,
        kind:confirmed?"confirmed":"unknown",identity,externalId:record?.externalId,reference:record?.reference,form:record?.form,facts,
        reason:confirmed?undefined:"The PMS has not yet confirmed the approved work order"});
      return this.lastStatus=result;
    } catch(error) {
      const reason=error instanceof Error?error.message:"PMS execution stopped";
      if(job) {
        try {
          const result=await this.transport({protocol:2,intent:"result",queueId:job.queueId,generation:job.generation,
            kind:"blocked",identity:identity??job.manifest.identity,reason});
          return this.lastStatus={...result,reason};
        } catch { /* durable claim/grant recovery owns the next step */ }
      }
      return this.lastStatus={status:"needs_review",reason};
    } finally { this.running=false; }
  }
}
module.exports={PmsBroker,partitionFor,digest};
