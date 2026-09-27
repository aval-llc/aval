/** Isolated actors and real RLS sessions on an explicitly local, already migrated database. */
import {Client} from 'pg';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {withDbSession} from '../../db/postgres/session.ts';
import {withVerifiedIdentityHeaders} from '../../lib/auth/request-identity.ts';
import {env} from 'cloudflare:workers';

export async function postgresEvaluation() {
  const url=process.env.AVAL_TEST_DATABASE_URL;
  if(!url||!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw Error('Use an explicitly configured, migrated loopback test database');
  const admin=new Client({connectionString:url});await admin.connect();
  const role=`aval_eval_${randomBytes(5).toString('hex')}`,password=randomBytes(24).toString('base64url');
  const statement=await admin.query("SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",[role,password]);
  await admin.query(statement.rows[0].sql);await admin.query(`GRANT aval_app,aval_worker TO "${role}"`);
  const local=new URL(url);local.username=role;local.password=password;
  const config={connectionString:local.href};const previous={...env};env.DATABASE_URL=local.href;delete env.HYPERDRIVE;
  const user=`eval_${randomUUID()}`;const org=`org_${createHash('sha256').update(user).digest('hex').slice(0,24)}`;
  const session=(subject,work)=>{
    const organizationId=`org_${createHash('sha256').update(subject).digest('hex').slice(0,24)}`;
    return withDbSession(config,{principalId:subject,organizationId,actorId:subject,requestId:randomUUID(),auth:{userId:subject,email:`${subject}@example.invalid`,displayName:'Luna synthetic evaluation',source:'password'}},work,{initializeIdentity:async(client,identity)=>{
      const result=await client.query('SELECT aval_private.bootstrap_supabase_identity($1,$2,$3,true,$4,NULL) AS id',[subject,`${subject}@example.invalid`,'Luna synthetic evaluation',organizationId]);return {...identity,organizationId:result.rows[0].id};
    }});
  };
  const run=work=>session(user,work);
  await run(async()=>{});
  const request=(path,body)=>new Request(`https://app.aval.llc${path}`,{method:'POST',headers:withVerifiedIdentityHeaders(new Headers({'content-type':'application/json',cookie:`aval-active-organization=${org}`}),{userId:user,email:`${user}@example.invalid`,displayName:'Luna synthetic evaluation',emailVerified:true}),body:JSON.stringify(body)});
  return {admin,config,user,org,run,session,request,close:async()=>{for(const key of Object.keys(env))delete env[key];Object.assign(env,previous);await admin.query(`DROP OWNED BY "${role}"`);await admin.query(`DROP ROLE "${role}"`);await admin.end();}};
}
