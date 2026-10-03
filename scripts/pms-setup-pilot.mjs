/** Manual, loopback-only setup UI using real PostgreSQL routes and Desktop IPC.
 * Never enables inference, queue claims, grants, or provider writes.
 * Run with tests/integration/module-hooks.mjs and a migrated local database.
 */
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import {postgresEvaluation} from './lib/postgres-evaluation.mjs';
import {withVerifiedIdentityHeaders} from '../lib/auth/request-identity.ts';
import * as sessions from '../app/api/pms/session/route.ts';
import * as browser from '../app/api/pms/browser-v2/route.ts';

const [tenant, requestId, propertyId] = process.argv.slice(2);
if (!tenant || !/^https:\/\/[a-z0-9-]+\.managebuilding\.com$/.test(tenant)
  || !/^\d+$/.test(requestId ?? '') || !/^\d+$/.test(propertyId ?? '')) throw Error('Provide tenant HTTPS origin, synthetic request ID and property ID');
const port = 4187;
const origin = `http://127.0.0.1:${port}`;
const bootstrap = randomBytes(32).toString('hex');
const cookie = randomBytes(32).toString('hex');
const db = await postgresEvaluation();
const prepared = await sessions.POST(db.request('/api/pms/session', {
  provider: 'buildium', origin: tenant, preflightRequestId: requestId,
  allowedPropertyId: propertyId, session: 'NEW', discovered: [],
}));
if (!prepared.ok) throw Error(`Setup failed: ${await prepared.text()}`);
const bundle = await build({entryPoints: ['tests/fixtures/pms-setup-page.jsx'], bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', define: {'process.env.NODE_ENV': '"production"'}});
const html = `<!doctype html><meta charset="utf-8"><title>Aval — local Buildium pilot</title>
<style>body{background:#f4f4f1;color:#202722;font:16px -apple-system,BlinkMacSystemFont,sans-serif;margin:0}main{max-width:820px;margin:50px auto;padding:36px;background:white;border:1px solid #ddd;border-radius:18px}h1{font-size:28px}p{line-height:1.6;color:#535d55}small{letter-spacing:.06em}section{padding:24px;border:1px solid #d9dfd9;border-radius:14px;margin:24px 0}header{display:flex;gap:12px}.pms-session-state{font-size:12px}.credential-form{display:grid;gap:12px}label{display:grid;gap:6px;font-size:14px}input{padding:10px;border:1px solid #bbc3bb;border-radius:7px;font-size:15px}button{display:flex;align-items:center;gap:10px;background:#244a37;color:white;padding:12px 18px;border:0;border-radius:9px;margin-top:18px;font-size:15px;cursor:pointer}.pms-session-note{display:flex;gap:8px}.pms-session-error{color:#85321f}svg{flex-shrink:0}</style>
<div id="root"></div><script src="/setup.js"></script>`;
const server = createServer(async (req, res) => {
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) {res.writeHead(403);return res.end();}
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/start' && url.searchParams.get('token') === bootstrap) {
      res.writeHead(303, {'set-cookie': `aval-pilot=${cookie}; HttpOnly; SameSite=Strict; Path=/`, location:'/'});return res.end();
    }
    if (!(req.headers.cookie ?? '').split(';').some(v => v.trim() === `aval-pilot=${cookie}`)) {res.writeHead(401);return res.end('Open the local pilot bootstrap link.');}
    if (req.method === 'GET' && url.pathname === '/') {res.setHeader('content-type','text/html');return res.end(html);}
    if (req.method === 'GET' && url.pathname === '/setup.js') {res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
    const routes = url.pathname === '/api/pms/session' ? sessions : url.pathname === '/api/pms/browser-v2' ? browser : null;
    if (!routes || !['GET','POST'].includes(req.method)) {res.writeHead(404);return res.end();}
    if (req.method === 'POST' && req.headers.origin !== origin) {res.writeHead(403);return res.end();}
    let raw='';for await (const chunk of req) {raw += chunk;if(raw.length>64000)throw Error('Request too large');}
    if (req.method === 'POST' && routes === browser && JSON.parse(raw).intent !== 'register') {
      res.writeHead(403, {'content-type':'application/json'});return res.end(JSON.stringify({error:'Setup-only pilot: binding and writes remain disabled.'}));
    }
    const headers = withVerifiedIdentityHeaders(new Headers(Object.entries(req.headers).filter(([,v])=>typeof v==='string')), {
      userId:db.user,email:`${db.user}@example.invalid`,displayName:'Local synthetic pilot',emailVerified:true,
    });
    headers.set('cookie',`aval-active-organization=${db.org}`);
    const request = new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:raw}:{})});
    const response = await routes[req.method](request);
    res.writeHead(response.status, {'content-type':'application/json'});res.end(await response.text());
  } catch(error) {res.writeHead(500, {'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
server.listen(port, '127.0.0.1', () => console.log(`LOCAL_PILOT_URL=${origin}/start?token=${bootstrap}`));
async function shutdown(){server.close();await db.close();process.exit(0);}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
