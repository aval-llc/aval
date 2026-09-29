/** Real Chromium, preload and inference service; only the model RPC is synthetic. */
const { app, BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { CodexAppServerService } = require('../codex-app-server.cjs');
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
app.setPath('userData', fixture.userData);
const rpc = new EventEmitter();
rpc.request = async (method) => {
  if (method === 'thread/start') return { thread: { id: 'synthetic-thread' }, model: 'gpt-6-luna' };
  if (method === 'turn/start') {
    queueMicrotask(() => {
      const emit = (method, params) => rpc.emit('notification', { method, params: { threadId: 'synthetic-thread', turnId: 'synthetic-turn', ...params } });
      emit('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 40 } } });
      emit('item/completed', { item: { type: 'agentMessage', text: JSON.stringify({ calls: [{ name: 'create_maintenance_work_order', input: fixture.input }] }) } });
      emit('turn/completed', { turn: { id: 'synthetic-turn', status: 'completed' } });
    });
    return { turn: { id: 'synthetic-turn' } };
  }
  throw Error(`Unexpected synthetic RPC: ${method}`);
};
const service = { rpc, workspaceDir: fixture.userData, state: { account: { type: 'chatgpt' }, active: true, models: [{ id: 'gpt-6-luna' }] } };
ipcMain.handle('aval:codex:infer', (_, payload) => CodexAppServerService.prototype.infer.call(service, payload));
ipcMain.handle('aval:codex:set-model', () => ({}));
ipcMain.handle('aval:codex:set-active', () => ({}));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: resolve(__dirname, '../preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(fixture.url);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = () => { const button = document.querySelector('button');
      if (button) { button.click(); resolve(); }
      else if (Date.now() > deadline) reject(Error('Runner button did not render'));
      else setTimeout(tick, 50);
    }; tick();
  })`);
  const status = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const tick = () => { const text = document.body.innerText;
      if (text.includes('Agents connected')) resolve(text);
      else if (document.querySelector('[role="status"]') || Date.now() > deadline) reject(Error(text));
      else setTimeout(tick, 50);
    }; tick();
  })`);
  console.log(JSON.stringify({ browserRunner: status, syntheticModel: true }));
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => app.exit(2), 60000).unref();
