import assert from 'node:assert/strict';
import test from 'node:test';
import { buildiumBase, buildiumCursor, fetchBuildiumPage, normalizeBuildium } from '../../lib/integrations/buildium.ts';
import { parseInboundMessage, splitWhatsappPayload } from '../../lib/integrations/inbound.ts';
import { changedSourceFields } from '../../lib/operations/import-existing.ts';
import { inboundToolAllowed } from '../../lib/agents/task-boundary.ts';
import { PILOT_POLICY, subscriptionDisabledResponse } from '../../lib/pilot-policy.ts';
import { gmailSender } from '../../lib/communications/gmail-sync.ts';
import { autonomyApproval } from '../../lib/agents/autonomy.ts';
import { getTool } from '../../lib/agents/registry.ts';
import { encryptBackup } from '../../scripts/backup-database.mjs';
import { generateKeyPairSync, privateDecrypt, createDecipheriv } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('hosted subscription and checkout gates are closed', () => {
  assert.deepEqual(PILOT_POLICY, { subscriptionOAuth: false, paidCheckout: false });
  assert.equal(subscriptionDisabledResponse().status, 409);
});
test('WhatsApp splits every entry, change, destination and sender', () => {
  const payload = { entry: ['a','b'].map(phone => ({ changes: [0,1].map(n => ({ value: { metadata: { phone_number_id: phone }, contacts: [{ wa_id: 'one', profile: { name: 'First' } }, { wa_id: 'two', profile: { name: 'Second' } }], messages: ['one','two'].map(from => ({ id: `${phone}-${n}-${from}`, from, text: { body: 'repair' } })) } })) })) };
  const parsed = splitWhatsappPayload(payload).map(p => parseInboundMessage('whatsapp',p,null));
  assert.equal(parsed.length, 8); assert.equal(new Set(parsed.map(p => p.externalMessageId)).size,8);
  assert.equal(parsed[1].contactDisplayName,'Second'); assert.equal(parsed[4].externalAccountKey,'b');
  assert.deepEqual(splitWhatsappPayload({entry:[{changes:[{value:{statuses:[]}}]}]}), []);
});
test('mutable changes and equivalent timestamps are distinguished', () => {
  assert.deepEqual(changedSourceFields({ summary:'before', completed_at:null, assigned_at:new Date('2026-01-01Z'), amount_cents:'100' }, { summary:'after', completedAt:'2026-01-02T00:00:00Z', assignedAt:'2026-01-01T00:00:00Z', amountCents:100, phone:undefined }), { summary:'after', completedAt:'2026-01-02T00:00:00Z' });
});
test('inbound permissions bind message, resident and unit and reject arbitrary actions', () => {
  const scope={conversationId:'c',messageId:'m',maintenance:{residentId:'r',propertyId:'p',unitId:'u'}};
  const args={conversation_id:'c',message_id:'m',resident_id:'r',property_id:'p',unit_id:'u'};
  assert.equal(inboundToolAllowed(scope,'create_maintenance_work_order',args),true);
  assert.equal(inboundToolAllowed(scope,'create_maintenance_work_order',{...args,unit_id:'other'}),false);
  assert.equal(inboundToolAllowed(scope,'send_external_message',{...args,to:'other@example.com'}),false);
  assert.equal(inboundToolAllowed(scope,'request_execution_plan',{}),false);
  assert.equal(inboundToolAllowed(scope,'dispatch_vendor',args),false);
  assert.ok(autonomyApproval(getTool('create_maintenance_work_order'),'autonomous',true));
});
test('Buildium refuses missing environments and validates checkpoints', () => {
  assert.equal(buildiumBase('sandbox'),'https://apisandbox.buildium.com/v1');
  assert.equal(buildiumBase('production'),'https://api.buildium.com/v1');
  assert.throws(() => buildiumBase(undefined)); assert.throws(() => buildiumBase('https://evil.test'));
  assert.throws(() => buildiumCursor('{"entity":0,"offset":-1}'));
});
test('Buildium maps lease rent and lifecycle status without retaining sensitive fields', () => {
  const batch=normalizeBuildium(3,[{Id:1,UnitId:2,LeaseFromDate:'2026-01-01',LeaseStatus:'Active',AccountDetails:{Rent:1500.25,SecurityDeposit:1000},CurrentTenants:[{Id:3,TaxId:'never-store'}]}]);
  assert.equal(batch.leases[0].rentCents,150025);assert.deepEqual(batch.leases[0].residentExternalIds,['3']);
  assert.equal(JSON.stringify(batch).includes('never-store'),false);
  assert.throws(()=>normalizeBuildium(3,[{Id:1,UnitId:2,LeaseFromDate:'2026-01-01',LeaseStatus:'Active',AccountDetails:{Rent:null}}]));
});
test('Buildium reads only selected sandbox and checkpoints a partial page', async t => {
  t.mock.method(globalThis,'fetch',async (url,init)=>{assert.match(String(url),/^https:\/\/apisandbox\.buildium\.com\/v1\/rentals\?/);assert.notEqual(init.method,'POST');return Response.json(Array.from({length:20},(_,n)=>({Id:n+1,Name:`Property ${n}`})));});
  const result=await fetchBuildiumPage({environment:'sandbox',clientId:'test',clientSecret:'test'}, {entity:0,offset:0});
  assert.deepEqual(result.next,{entity:0,offset:20});assert.equal(result.complete,false);
});
test('Gmail sender matching rejects multiple recipients and header injection', () => {
  assert.equal(gmailSender('Resident <TEST@example.com>'),'test@example.com');
  assert.equal(gmailSender('a@example.com, b@example.com'),null);
  assert.equal(gmailSender('a@example.com\r\nBcc: victim@example.com'),null);
});
test('backups round-trip through authenticated encryption without plaintext in output',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'aval-backup-test-'));
  try {
    const keys=generateKeyPairSync('rsa',{modulusLength:2048});
    const source=join(dir,'source'),target=join(dir,'encrypted');await writeFile(source,'synthetic backup');
    const manifest=await encryptBackup(source,target,keys.publicKey);
    const ciphertext=await readFile(target);assert.equal(ciphertext.includes(Buffer.from('synthetic backup')),false);
    const key=privateDecrypt({key:keys.privateKey,oaepHash:'sha256'},Buffer.from(manifest.encryptedKey,'base64'));
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(manifest.iv,'base64'));decipher.setAuthTag(Buffer.from(manifest.tag,'base64'));
    assert.equal(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString(),'synthetic backup');
  } finally {await rm(dir,{recursive:true,force:true});}
});
