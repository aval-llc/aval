"use strict";
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { PmsBroker } = require('./pms-broker.cjs');
const { protocolDriverFor, setupDriverFor } = require('./pms-provider.cjs');

function createPmsRuntime({ app, session, origin }) {
  let credentials;
  let scope;
  function deviceCredentials() {
    if(credentials) return credentials;
    if(!safeStorage.isEncryptionAvailable()) throw Error('System credential storage is unavailable');
    const file=path.join(app.getPath('userData'),'pms-device-v2.enc');
    if(fs.existsSync(file)) credentials=JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    else {
      credentials={id:randomUUID(),secret:randomBytes(32).toString('hex')};
      fs.writeFileSync(file,safeStorage.encryptString(JSON.stringify(credentials)),{mode:0o600,flag:'wx'});
    }
    return credentials;
  }
  const transport=async body=>{
    if(body.intent==='register') {
      const context=await session.defaultSession.fetch(`${origin}/api/pms/browser-v2`,{
        credentials:'include',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20_000),
      });
      if(!context.ok) throw Error('Sign in to the pilot workspace as its owner');
      const value=await context.json();
      if(typeof value.organizationId!=='string' || typeof value.userId!=='string') throw Error('Missing Aval workspace identity');
      scope={organizationId:value.organizationId,userId:value.userId,setupConnections:Array.isArray(value.setupConnections)?value.setupConnections:[]};
    }
    if(!scope) throw Error('Register the Desktop runner first');
    const root=deviceCredentials();
    // A device registration is per Aval user/workspace, not per installation.
    // Switching workspaces mid-attempt is rejected by the server headers below.
    const key=JSON.stringify([scope.organizationId,scope.userId]);
    const hex=createHmac('sha256',root.secret).update(`id:${key}`).digest('hex');
    const device={id:`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`,
      secret:createHmac('sha256',root.secret).update(`secret:${key}`).digest('hex')};
    const response=await session.defaultSession.fetch(`${origin}/api/pms/browser-v2`,{
      method:'POST',credentials:'include',redirect:'error',
      headers:{'content-type':'application/json',origin,'x-aval-pms-device':device.id,'x-aval-pms-secret':device.secret,
        'x-aval-pms-workspace':scope.organizationId,'x-aval-pms-user':scope.userId},
      body:JSON.stringify(body),signal:AbortSignal.timeout(20_000),
    });
    const result=await response.json();
    if(!response.ok) throw Error(result.error??'PMS runner could not connect');
    return body.intent==='register'?{...result,setupConnections:scope.setupConnections}:result;
  };
  const broker=new PmsBroker({transport,driverFor:protocolDriverFor});
  broker.setup=async provider=>{
    const registration=await transport({intent:'register',protocol:2});
    const candidates=Array.isArray(registration.setupConnections)?registration.setupConnections:[];
    const config=candidates.find(item=>item.provider===provider);
    if(!config)throw Error(`Configure the ${provider} Desktop session in Aval first`);
    const binding={organizationId:registration.organizationId,connectionId:config.connectionId,provider:config.provider,
      identity:{origin:config.origin,accountId:'pending',staffId:'pending'},preflightRequestId:config.preflightRequestId,allowedPropertyId:config.allowedPropertyId};
    const setup=setupDriverFor(binding);
    if(!setup)throw Error(`This Aval Desktop build has no ${provider} setup adapter`);
    const result=await setup.run();
    if(result.recovered!==true)return result;
    await transport({intent:'bind',protocol:2,connectionId:binding.connectionId,identity:result.identity,feasibility:result.feasibility});
    return result;
  };
  return broker;
}
module.exports={createPmsRuntime};
