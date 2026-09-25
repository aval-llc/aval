/** Component E2E with controlled APIs/audio. Does not claim live provider validation. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const output = await mkdtemp(join(tmpdir(), 'aval-chat-visual-'));
const root = process.cwd();
const { chromium } = await import(process.env.AVAL_PLAYWRIGHT_MODULE || 'playwright');
await build({ stdin: { contents: `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {NextIntlClientProvider} from 'next-intl';
import messages from './messages/en.json';
import {AvalAssistant} from './app/components/aval-assistant';
import {ExperienceProvider} from './app/components/experience';
import {AppearanceProvider} from './app/components/appearance-provider';
import {PreferenceContext} from './app/components/preference-context';
import {DEFAULT_ONBOARDING} from './lib/onboarding/preferences';
function Harness(){const [state,setState]=useState(DEFAULT_ONBOARDING);return <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><ExperienceProvider><AppearanceProvider isGuest><PreferenceContext.Provider value={{state,busy:false,error:'',edit(){},help(){},async setMode(mode){await fetch('/api/preferences',{method:'PUT',body:JSON.stringify({mode})});setState({...state,preferences:{...state.preferences,autonomy:[mode]}});}}}><main style={{padding:40}}><h1>Portfolio overview</h1><p>Controlled component test</p></main><AvalAssistant view="overview" onCreateDraft={()=>{}}/></PreferenceContext.Provider></AppearanceProvider></ExperienceProvider></NextIntlClientProvider>};
createRoot(document.getElementById('root')).render(<Harness/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: join(output, 'app.js'), platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const js = await readFile(join(output, 'app.js'));
const css = ':root{--font-inter:Arial}body,button,input,select,textarea{font-family:Arial,sans-serif}*{box-sizing:border-box}button,input,textarea,select{font:inherit}' + (await readFile('app/globals.css', 'utf8')).replace(/^@import.*$/gm, '') + await readFile('app/minimal-chat.css', 'utf8') + await readFile('app/enterprise.css', 'utf8');
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(js); }
  else if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); res.end(css); }
  else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
let history = [], taskStatus = 'RUNNING', lastTask, mode;
await context.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  let data = {};
  if (path === '/api/assistant/history') { if (request.method() === 'POST') history.push(request.postDataJSON()); data = { messages: history, before: null }; }
  else if (path === '/api/agents/employees') data = { employees: [{ id:'maya', name:'Maya', role:'Resident operations', autonomyMode:'assisted' }] };
  else if (path === '/api/agents/employees/maya') { mode = request.postDataJSON().autonomyMode; data = { employee: { id:'maya', name:'Maya', role:'Resident operations', autonomyMode:mode } }; }
  else if (path === '/api/preferences') mode = request.postDataJSON().mode;
  else if (path === '/api/agents/tasks' && request.method() === 'POST') { lastTask = request.postDataJSON(); data = { taskId: 'run-1' }; history.push({ id:lastTask.chatMessageId+'-run',role:'assistant',taskId:'run-1',taskAgentId:lastTask.employeeId }); }
  else if (path === '/api/agents/tasks/run-1') data = { id:'run-1', status:taskStatus, createdAt:Date.now()-42000, finishedAt:taskStatus === 'COMPLETED' ? Date.now() : null, trace:[{ sequence:1,kind:'tool_call',tool:'get_portfolio_metrics',mutates:false,policy:'allow' },{ sequence:2,kind:'tool_call',tool:'send_external_message',mutates:true,policy:'allow' }], result:taskStatus === 'COMPLETED' ? { headline:'Portfolio review ready',narrative:'Your records have been checked.' } : null };
  else if (path === '/api/agents/approvals') data = { approvals: [] };
  else if (path === '/api/assistant/transcribe') data = { text:'Check open maintenance requests' };
  await route.fulfill({ json:data });
});
try {
  await page.goto('http://127.0.0.1:'+server.address().port);
  const launcher = page.locator('.aval-orb-launcher');
  await page.waitForFunction(()=>document.querySelector('.aval-greeting-typed')?.textContent === 'Do you have any questions about your portfolio?');
  assert.equal(await page.locator('.aval-inline-welcome .aval-thinking-orb').getAttribute('data-orb-state'),'solving');
  assert.equal(await page.locator('.aval-inline-chat').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.locator('.aval-composer-beam[data-active]').waitFor();
  await page.waitForTimeout(900);
  console.log(await page.locator('.aval-composer-beam').evaluate(el=>({beamHeight:el.getBoundingClientRect().height,after:getComputedStyle(el,'::after').opacity,before:getComputedStyle(el,'::before').opacity})));
  await page.screenshot({path:join(output,'resting.png')});
  await page.keyboard.press('Escape');
  await page.screenshot({ path:join(output,'closed.png') });
  await launcher.click(); await page.locator('.aval-minimal-composer textarea').fill('Review my portfolio');
  assert.equal(await page.locator('textarea').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  await page.screenshot({ path:join(output,'composer.png') });
  await page.locator('.aval-minimal-agent').click(); await page.getByRole('button',{name:'Maya Resident operations'}).click();
  await page.locator('.aval-minimal-mode select').selectOption('supervised');
  await page.waitForFunction(()=>document.querySelector('.aval-minimal-mode select').value === 'supervised');
  assert.equal(mode,'supervised');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByText('Review my portfolio',{exact:true}).waitFor();
  await page.locator('.aval-activity-rail[data-status="RUNNING"]').waitFor();
  assert.equal(await page.locator('.aval-activity-rail .aval-thinking-orb').getAttribute('data-orb-state'),'searching');
  assert.equal(lastTask.employeeId,'maya');
  await page.screenshot({ path:join(output,'running.png') });
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.aval-inline-chat').isVisible(),false);
  taskStatus = 'COMPLETED'; await page.locator('.aval-unread').waitFor({timeout:10000});
  await launcher.click(); await page.getByText('Portfolio review ready').waitFor();
  const summary = page.locator('.aval-activity-summary'); assert.equal(await summary.getAttribute('aria-expanded'),'false');
  assert.match(await summary.innerText(),/1 lookup.*1 action/);
  await page.screenshot({ path:join(output,'completed.png') });
  await summary.click(); assert.equal(await page.locator('.aval-activity-rail ol').isVisible(),true);
  await page.screenshot({ path:join(output,'expanded.png') });
  await page.reload(); await page.getByText('Portfolio review ready').waitFor();
  await page.getByRole('button',{name:'Tools',exact:true}).click();
  await page.getByRole('button',{name:'Use current page context',exact:true}).hover();
  await page.screenshot({ path:join(output,'plus.png') });
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.aval-inline-chat').isVisible(),true);
  await page.getByRole('button',{name:'Start voice input',exact:true}).click(); await page.getByRole('button',{name:'Stop recording',exact:true}).waitFor();
  await page.screenshot({ path:join(output,'recording.png') });
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('textarea').value.includes('Check open maintenance requests'));
  await page.emulateMedia({reducedMotion:'reduce'}); await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(output,'mobile.png')});
  assert.ok(await page.locator('.aval-minimal-send').isVisible());
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
  history = [];
  await page.evaluate(()=>localStorage.setItem('aval.theme','dark'));
  await page.reload();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.locator('.aval-inline-welcome').waitFor();
  await page.screenshot({path:join(output,'dark-mobile.png')});
  await page.emulateMedia({reducedMotion:'no-preference'}); await page.setViewportSize({width:1280,height:900});
  await page.locator('.aval-composer-beam[data-active]').waitFor(); await page.waitForTimeout(1000);
  await page.screenshot({path:join(output,'dark-resting.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,output,checks:['employee routing','persisted policy mutation','minimize without cancellation','completion unread','accurate collapsed summary','trace expansion','history reload','plus Escape','controlled microphone transcript','mobile reduced motion'],providerLiveValidated:false}));
} catch (error) {
  await page.screenshot({path:join(output,'failure.png')});
  console.log(output, await page.locator('.aval-liquid-actions').evaluate(el => ({html:el.outerHTML, focus:document.activeElement?.outerHTML}))); throw error;
} finally { await browser.close(); await new Promise(done => server.close(done)); }
