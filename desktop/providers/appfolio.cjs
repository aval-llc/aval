"use strict";

/**
 * AppFolio, driven as the customer's own signed-in user.
 *
 * The first production driver behind the `ProviderDriver` contract, and it is
 * written to be honest about a hard constraint: **nobody has run this against
 * AppFolio.** Aval has no AppFolio account, no sandbox and no documentation of
 * their page structure. So this file separates what is genuinely known from
 * what is not, and refuses on the second rather than guessing.
 *
 * What is real here, and provider-neutral:
 *
 *   - collecting a page's accessible names and roles (a read, and a DOM API)
 *   - resolving a named target through the shared matching rules
 *   - acting on the element those rules chose
 *   - telling a signed-in page from a sign-in page by whether it asks for a
 *     password, which is true of every web app and guesses nothing
 *
 * What is **not** known, and is declared rather than invented, is `UNRESOLVED`
 * below: the host a customer's tenancy lives on, the names of the pages, and
 * the labels on them. The step vocabulary already refuses selectors, so there
 * is no way to paper over this with a CSS path — and inventing plausible
 * labels would produce a driver that looks finished, fails on first contact
 * with a real tenancy, and would have been reported as working.
 *
 * Consequently every capability-bearing operation refuses while `UNRESOLVED`
 * is non-empty. `reconcile` throws rather than returning "none found", because
 * a duplicate check that did not happen must never look like one that found
 * nothing: that is the difference between a retry and a second work order.
 *
 * Certification stays `simulator_e2e_tested`. When an authorized customer
 * session is available, `resolve()` fills the map from what is actually on the
 * screen and the same code runs — which is the point of writing it this way.
 */

const { ROLES_FOR, matchNode, pageStates, describeMiss } = require("./semantic-match.cjs");

/**
 * Everything about AppFolio that Aval has not seen.
 *
 * Emptying this list is what makes the driver usable, and it can only be
 * emptied by looking at a real authorized session. Each entry names the fact,
 * not a guess at it.
 */
const UNRESOLVED = [
  "tenancy host — AppFolio customers are on their own subdomain; the customer supplies it",
  "page identity — which URL or in-app view corresponds to the 'Maintenance' and 'New Work Order' pages",
  "field labels — the visible text beside the unit, description and priority inputs",
  "work-order search — how an existing work order is found by unit, for the duplicate check",
  "identifier label — the text beside the created work order's number",
];

const CAPABILITIES = ["maintenance.work_order.create"];

/**
 * Reads the page into names and roles.
 *
 * A constant, reviewed script that runs in the provider's tab. It is not a
 * channel: cloud cannot influence what it does, it takes no argument, and it
 * only reads. The alternative — letting a caller send script — is the thing
 * the whole boundary exists to prevent.
 */
const COLLECT = `(() => {
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'th') return 'heading';
    if (tag === 'td') return 'cell';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (type === 'password') return 'password';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    return 'text';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const owner = document.getElementById(labelledBy);
      if (owner) return (owner.textContent || '').trim();
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return (label.textContent || '').trim();
    }
    const wrapping = el.closest('label');
    if (wrapping) return (wrapping.textContent || '').trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    return (el.textContent || '').trim().slice(0, 200);
  };
  const out = [];
  const all = document.querySelectorAll('button,a,input,select,textarea,th,td,h1,h2,h3,h4,h5,h6,[role]');
  for (let i = 0; i < all.length && out.length < 800; i++) {
    const el = all[i];
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const name = nameOf(el);
    if (!name) continue;
    out.push({ name, role: roleOf(el), index: i, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' });
  }
  return out;
})()`;

/** Acts on the element the matcher chose, addressed by document order. */
const actScript = (index, action, value) => `(() => {
  const all = document.querySelectorAll('button,a,input,select,textarea,th,td,h1,h2,h3,h4,h5,h6,[role]');
  const el = all[${Number(index)}];
  if (!el) return { ok: false, reason: 'the element is no longer on the page' };
  if (${JSON.stringify(action)} === 'click') { el.click(); return { ok: true }; }
  if (${JSON.stringify(action)} === 'read') { return { ok: true, value: (el.value !== undefined ? el.value : el.textContent || '').trim() }; }
  const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, ${JSON.stringify(String(value ?? ""))});
  else el.value = ${JSON.stringify(String(value ?? ""))};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`;

async function collect(window) {
  return window().webContents.executeJavaScript(COLLECT, true);
}

/**
 * Whether the customer is signed in.
 *
 * A page that asks for a password is a sign-in page. That is true of every web
 * application and requires knowing nothing about AppFolio, which is exactly why
 * it is the one session fact this driver is willing to assert.
 */
function signedIn(nodes) {
  return !nodes.some((node) => node.role === "password");
}

const blocked = (reason) => ({ ready: false, session: "BLOCKED", reason });

const driver = {
  provider: "appfolio",
  accessModes: ["customer_desktop_session"],

  supported() {
    // What this driver would implement. Whether it *can* is `sessionStatus`,
    // and today it cannot — see UNRESOLVED.
    return CAPABILITIES;
  },

  async sessionStatus({ window }) {
    if (UNRESOLVED.length > 0) {
      return blocked(
        "Aval has not yet mapped AppFolio's screens against a real authorized session, so it will not "
        + "drive them. Outstanding: " + UNRESOLVED[0] + ".",
      );
    }
    try {
      const nodes = await collect(window);
      return signedIn(nodes)
        ? { ready: true, session: "ACTIVE" }
        : { ready: false, session: "EXPIRED", reason: "AppFolio is asking for a sign-in." };
    } catch (error) {
      return { ready: false, session: "EXPIRED", reason: error instanceof Error ? error.message : "The page could not be read." };
    }
  },

  async recoverSession({ window }) {
    // Aval's entire part in authentication: it shows the provider's own page.
    // The customer types their own password and completes their own second
    // factor, and neither passes through this process.
    const view = window();
    view.show();
    const nodes = await collect(window).catch(() => []);
    return signedIn(nodes) && nodes.length > 0
      ? { session: "ACTIVE", recovered: true }
      : { session: "MFA_REQUIRED", recovered: false, reason: "Sign in to AppFolio in the window that opened." };
  },

  async healthCheck({ window }) {
    const status = await this.sessionStatus({ window });
    return {
      session: status.session,
      usable: status.ready === true,
      detail: status.reason,
      checkedAt: new Date(),
    };
  },

  async discoverCapabilities() {
    if (UNRESOLVED.length > 0) {
      // An error rather than an empty list: absence is not denial, and
      // reporting "this login can do nothing" would be a claim about the
      // customer's PMS role that Aval has no basis for.
      return { available: [], error: "AppFolio capability discovery is not implemented yet." };
    }
    return { available: CAPABILITIES };
  },

  async reconcile() {
    // Throws rather than answering "none found". A duplicate check that did not
    // happen must never look like one that found nothing, or the first retry
    // after a lost outcome creates a second work order.
    throw new Error("Aval cannot yet search AppFolio for an existing work order, so it will not create one.");
  },

  async execute(input) {
    if (UNRESOLVED.length > 0) {
      return {
        ok: false,
        error: "Aval has no verified map of AppFolio's screens, so this workflow was not replayed.",
        retryable: false,
        session: "BLOCKED",
      };
    }
    return replaySteps(input);
  },

  async verify() {
    return { confirmed: false, detail: "Aval cannot yet read a work order back from AppFolio." };
  },

  /**
   * Fill in what a real authorized session shows.
   *
   * The seam this file is built around. Nothing else changes when the map is
   * known: the engine below already replays a flow against named targets.
   */
  resolve(map) {
    if (!map || typeof map !== "object") throw new Error("A provider map is required.");
    UNRESOLVED.length = 0;
    driver.map = map;
  },
};

/**
 * Replay a recorded flow against whatever is on screen.
 *
 * Provider-neutral: it resolves each step's named target through the shared
 * rules and acts on the one element they chose. An absent target means the page
 * changed under the flow; an ambiguous one means Aval cannot read the page
 * confidently enough to act. Both stop, and they are reported differently
 * because the remedies differ.
 */
async function replaySteps({ steps, payload, window }) {
  const captured = {};
  const fields = payload && typeof payload === "object" ? payload : {};

  for (const step of steps) {
    const nodes = await collect(window);

    if (step.kind === "expect") {
      if (!pageStates(nodes, step.text)) {
        return { ok: false, error: `The page does not say "${step.text}".`, retryable: false, session: "PROVIDER_CHANGED" };
      }
      continue;
    }
    if (step.kind === "open") {
      // Navigation is by the provider's own in-page controls, never a URL from
      // outside: a driver that accepted one would be a navigate(url) channel.
      const outcome = matchNode(nodes, step.page, ROLES_FOR.click);
      if (!outcome.found) {
        return { ok: false, error: describeMiss(step.page, outcome), retryable: false, session: "PROVIDER_CHANGED" };
      }
      await window().webContents.executeJavaScript(actScript(outcome.node.index, "click"), true);
      continue;
    }

    const roles = ROLES_FOR[step.kind === "choose" ? "choose" : step.kind === "capture" ? "capture" : step.kind === "fill" ? "fill" : "click"];
    const wanted = step.kind === "click" ? step.button : step.label;
    const outcome = matchNode(nodes, wanted, roles);
    if (!outcome.found) {
      return {
        ok: false,
        error: describeMiss(wanted, outcome),
        retryable: false,
        // An ambiguous page is not a changed one. A person has to look.
        session: outcome.reason === "ambiguous" ? "BLOCKED" : "PROVIDER_CHANGED",
      };
    }

    if (step.kind === "capture") {
      const read = await window().webContents.executeJavaScript(actScript(outcome.node.index, "read"), true);
      captured[step.as] = read && read.value;
      continue;
    }
    const action = step.kind === "click" ? "click" : "set";
    const value = step.kind === "click" ? undefined : fields[step.from];
    await window().webContents.executeJavaScript(actScript(outcome.node.index, action, value), true);
  }

  return { ok: true, externalId: captured.externalId, captured, session: "ACTIVE" };
}

module.exports = { driver, UNRESOLVED, CAPABILITIES, signedIn, replaySteps };
