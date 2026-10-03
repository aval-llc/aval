"use strict";

/**
 * Buildium protocol-2 adapter.
 *
 * This adapter is deliberately narrower than Buildium itself. It operates one
 * customer-authorized maintenance path: an existing Buildium task becomes one
 * work order. It never opens invoice, payment, communication or scheduling
 * controls. The Aval reference is written into the subject because the trial
 * account exposes no searchable custom field; the task's Work orders view is
 * then the independent duplicate check and read-back surface.
 *
 * Credentials and MFA stay in Buildium's own page. Setup can read the freshly
 * loaded authenticated profile in a separate observation window. The email
 * principal is bound with the tenant and rechecked against session changes.
 * Live writes still require the independent feasibility and approval gates.
 */

const ACTION = "maintenance.work_order.create";
const REFERENCE = /^AVAL-[a-f0-9]{32}$/;
const ID = /^\d{1,20}$/;
const PRIORITY = Object.freeze({ low: "Low", medium: "Normal", high: "High", emergency: "High" });

function clean(value) { return String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim(); }
function requireValue(value, message) { if (!value) throw new Error(message); return value; }
function originFor(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || !/^[a-z0-9-]+\.managebuilding\.com$/i.test(url.hostname)) {
    throw new Error("Buildium must use the exact HTTPS managebuilding.com tenant origin");
  }
  return url.origin;
}
function numeric(value, label) {
  const text = String(value ?? "");
  if (!ID.test(text)) throw new Error(`Buildium ${label} must be a stable numeric ID`);
  return text;
}

function profileEvidence(value, origin) {
  const v=value??{};
  let url;try{url=new URL(v.url);}catch{return null;}
  const email=clean(v.email).toLowerCase();
  if(url.origin!==origin||url.pathname!=='/manager/app/settings/my-settings/general'
    ||v.heading!=='My settings'||v.emailCount!==1||!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    ||!clean(v.firstName)||!clean(v.lastName)||!clean(v.accountLabel))return null;
  return {origin,accountId:new URL(origin).hostname,email,name:`${clean(v.firstName)} ${clean(v.lastName)}`,
    source:'authenticated-profile',executionIdentityVerified:false};
}

function authenticationDigest(cookies){
  // Do not retain values or export them to Aval. JavaScript-owned analytics
  // cookies are not identity evidence and commonly change on profile reads.
  const held=cookies.filter(c=>c.httpOnly===true&&c.secure===true);
  if(!held.length)throw Error('Buildium has no observable secure HTTP-only session; automated writes are disabled');
  const canonical=held.map(c=>[c.domain,c.path,c.name,c.value]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return require('node:crypto').createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function approvedPayload(value) {
  const v = value && typeof value === "object" ? value : {};
  const out = {
    propertyId: numeric(v.propertyId, "property"),
    unitId: numeric(v.unitId, "unit"),
    requestId: numeric(v.requestId, "request"),
    reference: String(v.reference ?? ""),
    summary: clean(v.summary),
    description: clean(v.description),
    priority: String(v.priority ?? "medium").toLowerCase(),
    vendorId: String(v.vendorId ?? ""),
    vendorName: clean(v.vendorName),
  };
  if (!REFERENCE.test(out.reference)) throw new Error("Buildium action has no valid Aval reference");
  if (!out.summary || out.summary.length > 200 || !out.description || out.description.length > 4000) throw new Error("Buildium summary and work details are required");
  if (!Object.hasOwn(PRIORITY, out.priority)) throw new Error("Buildium priority is unsupported");
  if (!out.vendorId || out.vendorId.length > 100 || out.vendorName !== "Aval Demo Vendor — DO NOT CONTACT") {
    throw new Error("The supervised pilot only permits the controlled Aval demo vendor");
  }
  return out;
}
function subjectFor(payload) { return `${payload.summary} [${payload.reference}]`; }

function exactFlow(steps) {
  const expected = [
    ["open", "Request work orders"],
    ["fill", "Subject", "summary"],
    ["choose", "Vendor", "vendorName"],
    ["fill", "Work to be performed", "description"],
    ["choose", "Priority", "priority"],
  ];
  if (!Array.isArray(steps) || steps.length !== expected.length) throw new Error("The reviewed Buildium preparation flow changed");
  for (let i = 0; i < expected.length; i += 1) {
    const [kind, target, from] = expected[i];
    const step = steps[i];
    const held = step?.page ?? step?.label;
    if (step?.kind !== kind || held !== target || (from && step.from !== from)) throw new Error("The reviewed Buildium preparation flow changed");
  }
}

/** Page implementation used by Electron. No method accepts a URL. */
function electronPage(binding, window, observationWindow) {
  const origin = originFor(binding.identity.origin);
  const wc = () => window().webContents;
  const readWc=()=>{if(!observationWindow)throw Error('Update Aval Desktop: an isolated read-back window is required');return observationWindow().webContents;};
  const navigate = async (contents,path) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error("Buildium navigation left the bound tenant");
    await contents.loadURL(url.toString(),{extraHeaders:'Cache-Control: no-cache\n'});
    const landed = new URL(contents.getURL());
    if (landed.origin !== origin) throw new Error("Buildium sign-in is required in the restricted Desktop window");
  };
  const go=path=>navigate(wc(),path);
  const readGo=path=>navigate(readWc(),path);
  const run = (fn, arg) => wc().executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`, true);
  const readRun=(fn,arg)=>readWc().executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`,true);
  const readUntil=async(snapshot,ready,label)=>{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      const value=await readRun(snapshot);
      if(ready(value))return value;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw Error(`Buildium ${label} did not finish loading; verification is incomplete`);
  };
  let identityProof=null;
  const sessionDigest=async()=>{
    // A root URL excludes cookies scoped to /manager. Check the application
    // path used by the actual form, not the tenant's public homepage.
    const cookies=await wc().session.cookies.get({url:`${origin}/manager/app/`});
    return authenticationDigest(cookies);
  };
  const text = value => clean(value);

  const snapshotIdentity = function snapshotIdentity() {
    const buttons = [...document.querySelectorAll("button")];
    const account = buttons.find(button => /\bAccount\b/i.test(button.textContent || ""));
    return { origin: location.origin, staffId: (account?.textContent || "").replace(/\s+/g, " ").trim() };
  };
  const requestSnapshot = function requestSnapshot() {
    const href = document.querySelector("#lnkLocationPropertySummary")?.getAttribute("href") || "";
    const match = href.match(/\/properties\/(\d+)\/units\/(\d+)\/summary/);
    const leaf = value => [...document.querySelectorAll("*")].find(el => el.children.length === 0 && (el.textContent || "").trim() === value)?.parentElement?.innerText || "";
    const linked = [...document.querySelectorAll('a[href*="/work-order/"]')].map(a => (a.getAttribute("href") || "").match(/\/work-order\/(\d+)/)?.[1]).filter(Boolean);
    return {
      url: location.href, title: document.querySelector("h1")?.textContent || "",
      status: document.querySelector("#taskQuickEdit_Status a")?.textContent || "",
      priority: document.querySelector("#taskQuickEdit_Priority a")?.textContent || "",
      propertyId: match?.[1] || "", unitId: match?.[2] || "",
      description: leaf("DESCRIPTION").replace(/^DESCRIPTION\s*/i, ""),
      accessRestrictions: leaf("TENANT SCHEDULING").replace(/^TENANT SCHEDULING\s*/i, ""),
      linkedWorkOrderIds: linked,
    };
  };
  const listWorkOrders = function (reference) {
    const matches = [...document.querySelectorAll('a[href*="/work-order/"]')].filter(a => (a.closest("tr")?.innerText || a.textContent || "").includes(`[${reference}]`));
    // A row can contain both a subject link and a View link to the same record.
    const records=new Map();
    for(const a of matches){const href=a.getAttribute('href')||'';const id=href.match(/\/work-order\/(\d+)(?:[/?#]|$)/)?.[1];
      if(id)records.set(id,{href,text:a.closest('tr')?.innerText||a.textContent||''});}
    return [...records.values()];
  };
  const fillForm = function (input) {
    const set = (selector, value) => {
      const el = document.querySelector(selector); if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value")?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true;
    };
    if (!set("#workOrderSubject", input.subject) || !set("#workDetails", input.description)) return { ok: false, reason: "Buildium work-order fields changed" };
    const priority = document.querySelector("#taskQuickEdit_Priority a");
    if ((priority?.textContent || "").trim() !== input.priority) {
      priority?.click();
      const choices = [...document.querySelectorAll("a,li,button")].filter(el => (el.textContent || "").trim() === input.priority);
      if (choices.length !== 1) return { ok: false, reason: "Buildium priority choices changed" };
      choices[0].click();
    }
    return { ok: true };
  };
  const searchVendor = function (name) {
    const input=document.querySelector("#workOrderVendor_innerSelectizeInput"); if(!input)return{ok:false};
    const setter=Object.getOwnPropertyDescriptor(input.constructor.prototype,"value")?.set;
    if(setter)setter.call(input,name);else input.value=name;
    input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("keyup",{bubbles:true}));return{ok:true};
  };
  const chooseVendor = function (input) {
    const matches=[...document.querySelectorAll(".option[data-value]")].filter(el=>(el.textContent||"").replace(/\s+/g," ").trim()===input.vendorName
      && (!input.vendorId||el.getAttribute("data-value")===input.vendorId));
    if(matches.length!==1)return{ok:false,reason:matches.length?"Controlled demo vendor is ambiguous":"Controlled demo vendor is unavailable"};
    const id=matches[0].getAttribute("data-value")||"";matches[0].click();return{ok:true,vendorId:id,vendorName:input.vendorName};
  };
  const formSnapshot = function () {
    const vendor = document.querySelector("#workOrderVendor");
    const selected = vendor?.options?.[vendor.selectedIndex];
    return {
      subject: document.querySelector("#workOrderSubject")?.value || "",
      description: document.querySelector("#workDetails")?.value || "",
      vendorId: selected?.value || "", vendorName: (selected?.textContent || "").trim(),
      priority: (document.querySelector("#taskQuickEdit_Priority a")?.textContent || "").trim(),
      commitButtons: [...document.querySelectorAll("#btn-addWorkOrder")].filter(el => !el.disabled).length,
      accountingVisible: Boolean(document.querySelector("#navMenu-Accounting")),
    };
  };
  const commitForm = function commitForm(input) {
    const account = [...document.querySelectorAll("button")].find(button => /\bAccount\b/i.test(button.textContent || ""));
    const staffId = (account?.textContent || "").replace(/\s+/g, " ").trim();
    const vendor = document.querySelector("#workOrderVendor"); const selected = vendor?.options?.[vendor.selectedIndex];
    const current = { origin: location.origin, staffId,
      subject: document.querySelector("#workOrderSubject")?.value || "", description: document.querySelector("#workDetails")?.value || "",
      vendorId: selected?.value || "", vendorName: (selected?.textContent || "").trim(),
      priority: (document.querySelector("#taskQuickEdit_Priority a")?.textContent || "").trim() };
    if (Date.now() >= Date.parse(input.expiresAt) || current.origin !== input.identity.origin || current.staffId !== input.accountLabel
      || current.subject !== input.subject || current.description.replace(/\s+/g," ").trim() !== input.description
      || current.vendorId !== input.vendorId || current.vendorName !== input.vendorName || current.priority !== input.priority
      || document.querySelector("#navMenu-Accounting")) return { ok: false, reason: "Buildium identity, permission or approved fields changed" };
    const buttons = [...document.querySelectorAll("#btn-addWorkOrder")].filter(el => !el.disabled);
    if (buttons.length !== 1) return { ok: false, reason: "Buildium commit button changed" };
    buttons[0].click(); return { ok: true };
  };
  const detailSnapshot = function () {
    const body = document.body.innerText || "";
    const locationHref = [...document.querySelectorAll('a[href*="/properties/"][href*="/units/"]')][0]?.getAttribute("href") || "";
    const loc = locationHref.match(/\/properties\/(\d+)\/units\/(\d+)\/summary/);
    const path = location.pathname.match(/\/tasks\/(\d+)\/work-order\/(\d+)/);
    const lineAfter = label => { const bits = body.split(/\n/).map(x=>x.trim()).filter(Boolean); const at=bits.indexOf(label); return at>=0?bits[at+1]||"":""; };
    return { requestId:path?.[1]||"",externalId:path?.[2]||"",propertyId:loc?.[1]||"",unitId:loc?.[2]||"",
      heading:[...document.querySelectorAll("main *")].map(el=>(el.textContent||"").trim()).find(x=>/ - #\d+-\d+$/.test(x))||"",
      priority:(document.querySelector("#taskQuickEdit_Priority a")?.textContent||"").trim(),vendorName:lineAfter("Vendor"),description:lineAfter("Work to be performed") };
  };

  const page = {
    async showLogin() {
      window().show();
      const current = wc().getURL();
      // Do not reset an in-progress login, or navigate away from a signed-in
      // session when the customer presses Verify again.
      if (!current || current === 'about:blank') await wc().loadURL(`${origin}/manager`);
    },
    async identity() {
      let current; try { current=new URL(wc().getURL()); } catch { current=null; }
      if(current?.origin!==origin)return {origin,accountId:new URL(origin).hostname,staffId:'',verified:false};
      const v=await run(snapshotIdentity);
      if(!text(v.staffId))return {origin,accountId:new URL(origin).hostname,staffId:'',verified:false};
      identityProof=null;
      let before=null;
      try{before=await sessionDigest();}catch(error){
        if(!String(error.message).includes('no observable secure HTTP-only session'))throw error;
      }
      const profile=await page.setupProfile();
      let after=null;
      try{after=await sessionDigest();}catch(error){
        if(!String(error.message).includes('no observable secure HTTP-only session'))throw error;
      }
      if(!profile)return {origin,accountId:new URL(origin).hostname,staffId:text(v.staffId),verified:false};
      const fresh=await run(snapshotIdentity);
      if(fresh.origin!==origin||text(fresh.staffId)!==text(v.staffId))throw Error('Buildium account changed during identity verification');
      // Profile reads establish who is signed in, independently of where the
      // provider stores authentication. Cookie inspection is an additional
      // write guard, not a prerequisite for reading a synthetic request.
      if(!before||before!==after)return {origin,accountId:new URL(origin).hostname,staffId:`email:${profile.email}`,profile,verified:false};
      identityProof={staffId:`email:${profile.email}`,accountLabel:text(fresh.staffId),sessionDigest:after,verifiedAt:Date.now()};
      return {origin,accountId:new URL(origin).hostname,staffId:identityProof.staffId,verified:true};
    },
    async setupProfile() {
      // Reload from Buildium rather than trusting an editable, unsaved profile
      // value or renderer-supplied email. Never call this during prepared writes.
      await readGo('/manager/app/settings/my-settings/general');
      const deadline=Date.now()+8000;
      while(Date.now()<deadline) {
        const snapshot=await readRun(function(){
          const emails=[...document.querySelectorAll('input[type="email"]')];
          const account=[...document.querySelectorAll('button')].find(el=>/\bAccount\b/.test(el.textContent||''));
          return {url:location.href,heading:document.querySelector('h1')?.textContent?.trim()||'',
            emailCount:emails.length,email:emails[0]?.value||'',
            firstName:document.querySelector('input[placeholder="First"]')?.value||'',
            lastName:document.querySelector('input[placeholder="Last"]')?.value||'',accountLabel:account?.textContent||''};
        });
        const evidence=profileEvidence(snapshot,origin);
        if(evidence)return evidence;
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      return null;
    },
    async request(id) {
      await readGo(`/manager/app/tasks/${numeric(id,"request")}/task-summary`);
      return readUntil(requestSnapshot,v=>Boolean(v.propertyId&&v.unitId&&v.status&&v.description),'request');
    },
    async permissions() { const v=await run(formSnapshot); return {createWorkOrder:v.commitButtons===1,accounting:v.accountingVisible===true}; },
    async openForm(id) { await go(`/manager/app/tasks/${numeric(id,"request")}/work-order/add`); },
    async controlledVendor(name) {
      const searched=await run(searchVendor,name);if(!searched.ok)return null;await new Promise(r=>setTimeout(r,500));
      const chosen=await run(chooseVendor,{vendorName:name,vendorId:""});return chosen.ok?{id:chosen.vendorId,name:chosen.vendorName}:null;
    },
    async fill(input) {
      const base=await run(fillForm,input);if(!base.ok)return base;
      const searched=await run(searchVendor,input.vendorName);if(!searched.ok)return{ok:false,reason:"Buildium vendor search changed"};
      await new Promise(r=>setTimeout(r,500));return run(chooseVendor,input);
    },
    async form() { return run(formSnapshot); },
    async commit(input) {
      const proof=identityProof;identityProof=null;
      if(!proof||proof.staffId!==input.identity.staffId||Date.now()-proof.verifiedAt>4000||await sessionDigest()!==proof.sessionDigest)
        throw Error('Buildium session changed or identity proof expired before submission');
      return run(commitForm,{...input,accountLabel:proof.accountLabel});
    },
    async find(requestId,reference) {
      await readGo(`/manager/app/tasks/${numeric(requestId,"request")}/work-orders`);
      const deadline=Date.now()+8000;
      while(Date.now()<deadline){
        const loaded=await readRun(function(){return {empty:document.body.innerText.includes('No work orders yet'),
          hasRows:[...document.querySelectorAll('a[href*="/work-order/"]')].some(el=>/\/work-order\/\d+(?:[/?#]|$)/.test(el.getAttribute('href')||''))};});
        if(loaded.empty)return [];
        if(loaded.hasRows)return readRun(listWorkOrders,reference);
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      throw Error('Buildium work-order list did not finish loading; absence is unverified');
    },
    async detail(requestId,externalId) {
      await readGo(`/manager/app/tasks/${numeric(requestId,"request")}/work-order/${numeric(externalId,"work order")}`);
      return readUntil(detailSnapshot,v=>Boolean(v.externalId&&v.propertyId&&v.unitId&&v.heading&&v.vendorName&&v.description),'work-order read-back');
    },
  };
  return page;
}

function createSession(binding, page) {
  const boundIdentity = { ...binding.identity, origin: originFor(binding.identity.origin) };
  let expected = null;
  const identity = async () => {
    const current = await page.identity();
    if(current.verified!==true)throw Error("Buildium unique staff identity is not verified; account initials cannot authorize a write");
    return {origin:originFor(current.origin),accountId:clean(current.accountId),staffId:clean(current.staffId)};
  };
  const matchesDetail = (detail, payload) => detail.externalId && detail.requestId === payload.requestId
    && detail.propertyId === payload.propertyId && detail.unitId === payload.unitId
    && detail.heading.includes(`[${payload.reference}]`) && clean(detail.vendorName) === payload.vendorName
    && clean(detail.description) === payload.description && clean(detail.priority) === PRIORITY[payload.priority];
  return {
    protocol: 2,
    identity,
    permissions: () => page.permissions(),
    async findByReference(reference, options={}) {
      if (!REFERENCE.test(reference)) throw Error("Invalid Aval reference");
      const payload = approvedPayload(options.manifest?.payload ?? expected ?? {});
      if (payload.reference !== reference) throw Error("Buildium reference does not match the approved action");
      const rows = await page.find(payload.requestId, reference);
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw Error("More than one Buildium work order has the Aval reference");
      const link = new URL(String(rows[0].href ?? ''), boundIdentity.origin);
      const match = link.pathname.match(/^\/manager\/app\/tasks\/(\d+)\/work-order\/(\d+)\/?$/);
      if(link.origin!==boundIdentity.origin||match?.[1]!==payload.requestId)throw Error('Buildium lookup returned a different tenant or request');
      const id = match?.[2];
      if (!id || (options.externalId && String(options.externalId) !== id)) throw Error("Buildium work-order identity is ambiguous");
      const detail = await page.detail(payload.requestId,id);
      if (!matchesDetail(detail,payload)) throw Error("Buildium read-back differs from the approved work order");
      return {externalId:id,reference,form:payload};
    },
    async prepare(steps, value) {
      exactFlow(steps); expected=approvedPayload(value);
      await page.openForm(expected.requestId);
      const filled=await page.fill({subject:subjectFor(expected),description:expected.description,vendorId:expected.vendorId,vendorName:expected.vendorName,priority:PRIORITY[expected.priority]});
      if(!filled?.ok)throw Error(filled?.reason||"Buildium form could not be prepared");
    },
    async readRequest(requestId) {
      const v=await page.request(requestId); const match=String(v.url??"").match(/\/tasks\/(\d+)\/task-summary/);
      return {requestId:match?.[1]||"",propertyId:String(v.propertyId??""),unitId:String(v.unitId??""),status:clean(v.status),
        symptoms:clean(v.description),accessRestrictions:clean(v.accessRestrictions),linkedWorkOrderIds:[...new Set(v.linkedWorkOrderIds??[])].map(String).sort()};
    },
    async readForm() {
      const p=requireValue(expected,"Buildium form has not been prepared"); const v=await page.form();
      if(v.subject!==subjectFor(p)||clean(v.description)!==p.description||String(v.vendorId)!==p.vendorId||clean(v.vendorName)!==p.vendorName||clean(v.priority)!==PRIORITY[p.priority]) {
        return {...p,formChanged:true};
      }
      return p;
    },
    async commit(step,value,identityAtApproval,expiresAt) {
      if(step?.kind!=="commit"||step.button!=="Save work order")throw Error("Buildium commit boundary changed");
      const current=await identity();
      if(current.origin!==identityAtApproval.origin||current.accountId!==identityAtApproval.accountId||current.staffId!==identityAtApproval.staffId) {
        throw Error("Buildium signed-in account changed before commit");
      }
      const p=approvedPayload(value); const result=await page.commit({subject:subjectFor(p),description:p.description,vendorId:p.vendorId,vendorName:p.vendorName,
        priority:PRIORITY[p.priority],identity:identityAtApproval,expiresAt});
      if(!result?.ok)throw Error(result?.reason||"Buildium refused the approved commit");
    },
  };
}

const driver = {
  provider: "buildium", accessModes: ["customer_desktop_session"], capabilities: [ACTION],
  supported: () => [ACTION],
  createProtocolSession(binding,{window,page,observationWindow}={}) { return createSession(binding,page?page():electronPage(binding,window,observationWindow)); },
  async setup(binding,{window,page,observationWindow}={}) {
    const p=page?page():electronPage(binding,window,observationWindow); await p.showLogin();
    const identity=await p.identity();
    if(!identity.staffId)return{session:"AUTHENTICATING",recovered:false,reason:"Sign in as the restricted Aval staff user in the Buildium window, then check the connection again. Complete any authentication Buildium requests."};
    if(identity.verified!==true){
      const profile=identity.profile??(typeof p.setupProfile==='function'?await p.setupProfile():null);
      const requestId=String(binding.preflightRequestId??'');
      if(profile&&ID.test(requestId)){
        const request=await p.request(requestId);
        if(String(request.propertyId)!==String(binding.allowedPropertyId)||!ID.test(String(request.unitId)))
          return {session:'BLOCKED',recovered:false,reason:'The source request does not belong to the selected demo property; no action was taken.'};
        return {session:'BLOCKED',recovered:false,readOnlyReady:true,profile,request,
          reason:`Read-only verified: ${profile.name} (${profile.email}); request ${requestId}, property ${request.propertyId}, unit ${request.unitId}. Assessment can be tested. Automated Buildium writes remain disabled: the execution-time session guard is not validated.`};
      }
      return{session:"BLOCKED",recovered:false,profile,
        reason:profile?`Signed in as ${profile.name} (${profile.email}). Login is confirmed; automated writes remain disabled until execution-time identity and duplicate-safe read-back checks pass.`
          :"Buildium sign-in is visible, but this adapter cannot yet verify a unique staff identity. Account initials are not sufficient; automated creation remains disabled."};
    }
    const preflight=String(binding.preflightRequestId??"");
    if(!ID.test(preflight))return{session:"BLOCKED",recovered:false,reason:"Choose one synthetic Buildium request for the non-writing preflight."};
    const request=await p.request(preflight); await p.openForm(preflight); const permissions=await p.permissions();
    const vendor=await p.controlledVendor("Aval Demo Vendor — DO NOT CONTACT");
    const propertyScoped=String(request.propertyId)===String(binding.allowedPropertyId??"");
    // Merely finding the work-order form does not establish persisted search or
    // direct-route authorization. Only an implemented provider preflight may
    // supply those observations; absent observations remain unknown, not true.
    const checks=typeof p.pilotPreflight==='function'?await p.pilotPreflight():{};
    const feasible=permissions.createWorkOrder===true&&permissions.accounting===false&&propertyScoped&&Boolean(vendor?.id)
      &&checks.searchableReference===true&&checks.administrationDenied===true&&checks.accountingDenied===true;
    return {session:feasible?"ACTIVE":"PERMISSION_DENIED",recovered:feasible,identity,discovered:feasible?[ACTION]:[],
      feasibility:{restrictedStaff:permissions.accounting===false&&checks.administrationDenied===true&&checks.accountingDenied===true,permittedAccess:permissions.createWorkOrder===true,searchableReference:checks.searchableReference===true,
        nonWritingPreparation:true,observableIdentity:Boolean(identity.staffId),propertyScoped,allowedPropertyId:String(binding.allowedPropertyId??""),
        controlledVendor:Boolean(vendor?.id),controlledVendorId:vendor?.id,controlledVendorName:vendor?.name},
      reason:feasible?undefined:`Verified Buildium login: ${identity.staffId}. Preflight must still verify restricted access, property scope, the controlled vendor, and a persisted searchable Aval reference before automated creation.`};
  },
};

module.exports={driver,createSession,approvedPayload,subjectFor,exactFlow,PRIORITY,profileEvidence,electronPage,authenticationDigest};
