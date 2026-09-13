"use strict";
 

const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell, session, nativeTheme } = require("electron");
const { CodexAppServerService } = require("./codex-app-server.cjs");

const { isChatWindowRequest, applyChatBackground, parseChatAppearance } = require("./chat-window.cjs");

const DEFAULT_APP_URL = "https://app.aval.llc";
const appUrl = new URL(process.env.AVAL_DESKTOP_URL || require("./package.json").avalDesktopUrl || DEFAULT_APP_URL);
const allowedOrigin = appUrl.origin;
let mainWindow = null;
let service = null;
let chatBackground = "white";
const chatWindows = new Set();

function isTrustedSender(event) {
  try {
    return new URL(event.senderFrame.url).origin === allowedOrigin;
  } catch {
    return false;
  }
}

function registerIpc(method, handler) {
  ipcMain.handle(`aval:codex:${method}`, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted Aval Desktop request.");
    return handler(payload);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    title: "Aval",
    titleBarStyle: "default",
    roundedCorners: true,
    backgroundColor: "#f4f4f1",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const { url } = details;
    if (isChatWindowRequest(details, mainWindow.webContents.getURL(), allowedOrigin)) return {
      action: "allow",
      overrideBrowserWindowOptions: { title: "Ask Aval", width: 500, height: 720, minWidth: 360, minHeight: 420,
        transparent: false, visualEffectState: "active",
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
        ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 9 } } : {}),
        movable: true, resizable: true, roundedCorners: true,
        backgroundColor: "#ffffff", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } },
    };
    try {
      if (new URL(url).protocol === "https:") void shell.openExternal(url);
    } catch { /* ignore malformed destinations */ }
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-create-window", (child, details) => {
    if (details.frameName !== "aval-chat") return;
    chatWindows.add(child);
    applyChatBackground(child, chatBackground);
    child.once('closed', () => chatWindows.delete(child));
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", event => event.preventDefault());
    const parent = mainWindow;
    const closeChat = () => { if (!child.isDestroyed()) child.close(); };
    parent?.once("closed", closeChat);
    child.once("closed", () => parent?.removeListener("closed", closeChat));
  });
  mainWindow.webContents.on("will-navigate", (event, destination) => {
    try {
      if (new URL(destination).origin === allowedOrigin) return;
    } catch { /* deny malformed navigation */ }
    event.preventDefault();
    try { if (new URL(destination).protocol === "https:") void shell.openExternal(destination); } catch { /* ignored */ }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  void mainWindow.loadURL(appUrl.toString());
}

app.whenReady().then(async () => {
  if (process.env.AVAL_DESKTOP_SMOKE_TEST === "1") {
    app.quit();
    return;
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  service = new CodexAppServerService({
    userDataDir: app.getPath("userData"),
    version: app.getVersion(),
    resourcesPath: process.resourcesPath,
    openExternal: (url) => shell.openExternal(url),
  });
  service.on("event", (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("aval:codex:event", payload);
  });
  registerIpc("get-state", () => service.getState());
  registerIpc("connect", async () => { await service.connect(); return service.getState(); });
  registerIpc("cancel-login", async () => { await service.cancelLogin(); return service.getState(); });
  registerIpc("logout", async () => { await service.logout(); return service.getState(); });
  registerIpc("refresh", async () => { await service.refresh(); return service.getState(); });
  registerIpc("set-active", ({ active } = {}) => service.setActive(active === true));
  registerIpc("set-model", ({ modelId } = {}) => service.setModel(modelId));
  registerIpc("ask", (payload) => service.ask(payload));
  registerIpc("cancel-turn", async (payload) => { await service.cancelTurn(payload || {}); return null; });
  ipcMain.handle('aval:chat:background', (event, payload) => {
    if (event.sender !== mainWindow?.webContents || !isTrustedSender(event)) throw new Error('Untrusted chat appearance request.');
    const { background, theme } = parseChatAppearance(payload);
    nativeTheme.themeSource = theme;
    chatBackground = background;
    for (const child of chatWindows) if (!child.isDestroyed()) applyChatBackground(child, background);
    return { nativeGlass: process.platform === 'darwin' && background === 'glass', nativeTitlebar: process.platform === 'darwin' };
  });
  createWindow();
  await service.start();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => {
  console.error("Aval failed during startup.", error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => service?.stop());
