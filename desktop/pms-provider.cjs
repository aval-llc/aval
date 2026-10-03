"use strict";

/**
 * The desktop's provider surface: structured actions, never browser commands.
 *
 * Aval's customer-authorized PMS access rests on one arrangement — the customer
 * signs into their PMS themselves, on their own machine, and Aval operates
 * inside the session they established. Nothing here collects a password or an
 * authenticator code, and nothing here can: the only sign-in path shows the
 * provider's own page to the person and waits.
 *
 * What the renderer may ask for is a closed list of provider operations. There
 * is deliberately no `navigate(url)` and no `evaluate(script)`, so neither a
 * compromised page can hand the main process a write payload. The broker fetches
 * approved instructions directly from Aval and validates their commit boundary.
 *
 * Session isolation is per workspace, connection and provider.
 */

const { BrowserWindow, session } = require("electron");
const { partitionFor: boundPartitionFor } = require('./pms-broker.cjs');

/** Where a provider lives. A connection supplies the customer's own host. */
const drivers = new Map();

/**
 * Register the code that knows one provider's web app.
 *
 * A driver implements the parts that cannot be generic — finding an existing
 * record, replaying steps against real labels, reading the record back. Until a
 * provider has one, this module can establish and observe a session and will
 * refuse to write, which is the correct order: a write we cannot verify or
 * de-duplicate is worse than no write.
 */
function registerProviderDriver(provider, driver) {
  drivers.set(provider, driver);
}

function partitionFor(binding) {
  return boundPartitionFor(binding);
}

const windows = new Map();
const observers = new Map();

/** Separate read-only surface: identity/request refreshes cannot unload an
 * already prepared form. It shares only the connection's isolated session. */
function observationWindow(binding) {
  const key=partitionFor(binding);
  const existing=observers.get(key);
  if(existing&&!existing.isDestroyed())return existing;
  const observer=new BrowserWindow({show:false,webPreferences:{partition:key,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  observer.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const guard=(event,url)=>{try{if(new URL(url).origin!==binding.identity.origin)event.preventDefault();}catch{event.preventDefault();}};
  observer.webContents.on('will-navigate',guard);
  observer.webContents.on('will-redirect',guard);
  observers.set(key,observer);
  observer.on('closed',()=>observers.delete(key));
  const parent=sessionWindow(binding);
  parent.once('closed',()=>{if(!observer.isDestroyed())observer.close();});
  return observer;
}

function sessionWindow(binding, { show = false } = {}) {
  const key = partitionFor(binding);
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (show) existing.show();
    return existing;
  }
  const window = new BrowserWindow({
    show,
    width: 1180,
    height: 820,
    title: `Sign in to ${binding.provider}`,
    webPreferences: {
      partition: key,
      // The provider's own page. It gets no Aval bridge, no node, and no
      // access to anything of ours.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: undefined,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url).origin;
    // Authentication may leave the tenant; execution still checks its exact
    // bound origin in the provider driver. Never allow arbitrary subdomains.
    if(destination !== binding.identity.origin && !(binding.provider === 'buildium' && destination === 'https://signin.managebuilding.com')) event.preventDefault();
  });
  windows.set(key, window);
  window.on("closed", () => windows.delete(key));
  return window;
}

/** Only the main-process broker can construct a session from a server binding. */
function protocolDriverFor(binding) {
  const driver = driverFor(binding.provider);
  if(!driver || typeof driver.createProtocolSession !== 'function') return null;
  return driver.createProtocolSession(binding, {window: () => sessionWindow(binding),observationWindow:()=>observationWindow(binding)});
}

/** Setup is also main-process owned: the renderer names only a provider. */
function setupDriverFor(binding) {
  const driver = driverFor(binding.provider);
  if(!driver || typeof driver.setup !== 'function') return null;
  return { driver, run: () => driver.setup(binding, {window: () => sessionWindow(binding,{show:true}),observationWindow:()=>observationWindow(binding)}) };
}

function driverFor(provider) {
  return drivers.get(provider) ?? null;
}

const NO_DRIVER = "Aval has no workflow for this provider on this device yet.";

/**
 * The surface the preload exposes. Every method takes a provider and returns a
 * structured result; none of them takes a URL, a selector or a script.
 */
const pms = {
  async supported({ provider } = {}) {
    const driver = driverFor(provider);
    return driver ? driver.supported() : [];
  },

  /**
   * What this customer's signed-in session can actually reach.
   *
   * Distinct from `supported`, which is what this device knows how to drive.
   * A driver that can create work orders says so either way; whether *this*
   * login may is a question only the provider can answer.
   */
  async discoverCapabilities({ provider } = {}) {
    return { available: [], error: `${provider}: reconnect a verified restricted staff account in Aval Desktop.` };
  },

  async sessionStatus({ provider } = {}) {
    return { ready: false, session: "BLOCKED", reason: `${provider}: a connection-specific session is required.` };
  },

  /**
   * Put the provider's own sign-in page in front of the person.
   *
   * This is the whole of Aval's involvement in authentication: it shows the
   * window. The customer types their own password and completes their own MFA
   * with the provider, and Aval neither sees nor stores either. A provider that
   * demands a code mid-session therefore resolves to `MFA_REQUIRED` and waits
   * for a person rather than being worked around.
   */
  async recoverSession({ provider } = {}) {
    return { session: "BLOCKED", recovered: false, reason: `${provider}: complete restricted staff setup before sign-in.` };
  },

  async healthCheck({ provider } = {}) {
    return { session: "BLOCKED", usable: false, detail: `${provider}: connection verification required`, checkedAt: new Date() };
  },

  async reconcile({ provider } = {}) {
    const driver = driverFor(provider);
    // Throws rather than answering "none found". A duplicate check that did not
    // happen must never look like one that found nothing, or the first retry
    // after a lost outcome creates a second record.
    if (!driver) throw new Error(NO_DRIVER);
    throw new Error('Use the privileged PMS protocol broker');
  },

  async execute({ provider } = {}) {
    const driver = driverFor(provider);
    if (!driver) return { ok: false, error: NO_DRIVER, retryable: false, session: "BLOCKED" };
    return { ok: false, error: 'Use the privileged PMS protocol broker', retryable: false, session: 'BLOCKED' };
  },

  async verify({ provider } = {}) {
    const driver = driverFor(provider);
    if (!driver) return { confirmed: false, detail: NO_DRIVER };
    return { confirmed: false, detail: 'Use the privileged PMS protocol broker' };
  },
};

/** Drop only this connection's session. Used when a connection is revoked. */
async function clearProviderSession(binding) {
  const key = partitionFor(binding);
  const window = windows.get(key);
  if (window && !window.isDestroyed()) window.destroy();
  windows.delete(key);
  await session.fromPartition(key).clearStorageData();
}

// The drivers this build ships with. Registered here rather than discovered,
// so what a desktop can drive is a reviewed list rather than whatever happens
// to be on disk.
registerProviderDriver("appfolio", require("./providers/appfolio.cjs").driver);
registerProviderDriver("buildium", require("./providers/buildium.cjs").driver);

module.exports = { pms, registerProviderDriver, clearProviderSession, partitionFor, protocolDriverFor, setupDriverFor };
