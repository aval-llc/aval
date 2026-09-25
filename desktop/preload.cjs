"use strict";
 

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (method, payload) => ipcRenderer.invoke(`aval:codex:${method}`, payload);

contextBridge.exposeInMainWorld("avalDesktop", Object.freeze({
  setChatBackground: (background, theme = "light") => ipcRenderer.invoke("aval:chat:background", { background, theme }),
  getState: () => invoke("get-state"),
  connect: () => invoke("connect"),
  cancelLogin: () => invoke("cancel-login"),
  logout: () => invoke("logout"),
  refresh: () => invoke("refresh"),
  setActive: (active) => invoke("set-active", { active: active === true }),
  setModel: (modelId) => invoke("set-model", { modelId }),
  ask: (payload) => invoke("ask", payload),
  cancelTurn: (conversationId) => invoke("cancel-turn", { conversationId }),
  /**
   * Provider operations for the customer-authorized browser path.
   *
   * Structured actions only. There is no method here that takes a URL or a
   * script, so the page cannot ask the main process to browse arbitrarily —
   * which is what keeps a recorded workflow the only thing that can run.
   */
  pms: Object.freeze({
    supported: (input) => ipcRenderer.invoke("aval:pms:supported", input),
    sessionStatus: (input) => ipcRenderer.invoke("aval:pms:session-status", input),
    discoverCapabilities: (input) => ipcRenderer.invoke("aval:pms:discover-capabilities", input),
    recoverSession: (input) => ipcRenderer.invoke("aval:pms:recover-session", input),
    healthCheck: (input) => ipcRenderer.invoke("aval:pms:health-check", input),
    reconcile: (input) => ipcRenderer.invoke("aval:pms:reconcile", input),
    execute: (input) => ipcRenderer.invoke("aval:pms:execute", input),
    verify: (input) => ipcRenderer.invoke("aval:pms:verify", input),
  }),
  onEvent: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("aval:codex:event", handler);
    return () => ipcRenderer.removeListener("aval:codex:event", handler);
  },
}));
