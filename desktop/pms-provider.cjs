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
 * compromised page nor a compromised cloud can turn this into a general-purpose
 * browser. A step arrives as one of six named kinds against a labelled target,
 * and a provider driver decides what that means for its own app.
 *
 * Session isolation is per provider (`persist:pms-<provider>`), which keeps a
 * PMS session out of the Aval session and out of every other provider's.
 */

const { BrowserWindow, session } = require("electron");

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

function partitionFor(provider) {
  return `persist:pms-${String(provider).replace(/[^a-z0-9_-]/gi, "")}`;
}

const windows = new Map();

function sessionWindow(provider, { show = false } = {}) {
  const existing = windows.get(provider);
  if (existing && !existing.isDestroyed()) {
    if (show) existing.show();
    return existing;
  }
  const window = new BrowserWindow({
    show,
    width: 1180,
    height: 820,
    title: `Sign in to ${provider}`,
    webPreferences: {
      partition: partitionFor(provider),
      // The provider's own page. It gets no Aval bridge, no node, and no
      // access to anything of ours.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: undefined,
    },
  });
  windows.set(provider, window);
  window.on("closed", () => windows.delete(provider));
  return window;
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
    const driver = driverFor(provider);
    if (!driver) return { available: [], error: NO_DRIVER };
    return driver.discoverCapabilities({ window: () => sessionWindow(provider) });
  },

  async sessionStatus({ provider } = {}) {
    const driver = driverFor(provider);
    if (!driver) return { ready: false, session: "BLOCKED", reason: NO_DRIVER };
    return driver.sessionStatus({ window: () => sessionWindow(provider) });
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
    const driver = driverFor(provider);
    if (!driver) return { session: "BLOCKED", recovered: false, reason: NO_DRIVER };
    return driver.recoverSession({ window: () => sessionWindow(provider, { show: true }) });
  },

  async healthCheck({ provider } = {}) {
    const driver = driverFor(provider);
    if (!driver) return { session: "BLOCKED", usable: false, detail: NO_DRIVER, checkedAt: new Date() };
    return driver.healthCheck({ window: () => sessionWindow(provider) });
  },

  async reconcile({ provider, action, payload } = {}) {
    const driver = driverFor(provider);
    // Throws rather than answering "none found". A duplicate check that did not
    // happen must never look like one that found nothing, or the first retry
    // after a lost outcome creates a second record.
    if (!driver) throw new Error(NO_DRIVER);
    return driver.reconcile({ action, payload, window: () => sessionWindow(provider) });
  },

  async execute({ provider, action, steps, payload } = {}) {
    const driver = driverFor(provider);
    if (!driver) return { ok: false, error: NO_DRIVER, retryable: false, session: "BLOCKED" };
    return driver.execute({ action, steps, payload, window: () => sessionWindow(provider) });
  },

  async verify({ provider, action, execution, payload } = {}) {
    const driver = driverFor(provider);
    if (!driver) return { confirmed: false, detail: NO_DRIVER };
    return driver.verify({ action, execution, payload, window: () => sessionWindow(provider) });
  },
};

/** Drop every provider session on this device. Used when a connection is revoked. */
async function clearProviderSession(provider) {
  const window = windows.get(provider);
  if (window && !window.isDestroyed()) window.destroy();
  windows.delete(provider);
  await session.fromPartition(partitionFor(provider)).clearStorageData();
}

// The drivers this build ships with. Registered here rather than discovered,
// so what a desktop can drive is a reviewed list rather than whatever happens
// to be on disk.
registerProviderDriver("appfolio", require("./providers/appfolio.cjs").driver);

module.exports = { pms, registerProviderDriver, clearProviderSession, partitionFor };
