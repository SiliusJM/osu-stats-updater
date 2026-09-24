'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { spawn } = require('child_process');
const { createBotProcessManager, saveConfigAndRestart } = require('./bot-process-manager');
const { normalizeConfig } = require('./index');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let win = null;
let allowQuit = false;
let quitInProgress = false;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

const botManager = createBotProcessManager({
  spawnProcess: () => spawn('node', [path.join(__dirname, 'index.js')], {
    cwd: __dirname, env: process.env, shell: false,
  }),
  onLog: chunk => send('bot-log', chunk),
  onStopped: code => send('bot-stopped', code),
});

function readConfig() {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { return normalizeConfig({}); }
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalizeConfig(data), null, 2), 'utf8');
}

function createWindow() {
  win = new BrowserWindow({
    width: 860, height: 660, minWidth: 640, minHeight: 500,
    backgroundColor: '#0d0d1a', title: 'osu! Stats Updater',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('gui.html');
  win.on('closed', () => {
    win = null;
    void botManager.shutdown();
  });
}

app.whenReady().then(createWindow);
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (allowQuit) return;
  event.preventDefault();
  if (quitInProgress) return;
  quitInProgress = true;
  void botManager.shutdown().finally(() => {
    allowQuit = true;
    app.quit();
  });
});

ipcMain.handle('load-config', () => readConfig());
ipcMain.handle('save-config', (_, data) => saveConfigAndRestart({
  manager: botManager,
  writeConfig: () => writeConfig(data),
  onRestarting: () => send('bot-log', '↻ Configuración guardada — reiniciando bot...\n'),
  onRestarted: () => send('bot-restarted'),
}));

ipcMain.handle('start-bot', async () => {
  if (botManager.isRunning) return { ok: false, error: 'El bot ya está corriendo' };
  const started = await botManager.start();
  return started ? { ok: true } : { ok: false, error: 'No se pudo iniciar el bot' };
});

ipcMain.handle('stop-bot', async () => {
  if (!botManager.isRunning) return { ok: false, error: 'El bot no está corriendo' };
  await botManager.stop();
  return { ok: true };
});

ipcMain.handle('test-connection', async () => {
  const cfg = readConfig();
  const results = { osu: null, se: null };
  try {
    const { data } = await axios.get('https://osu.ppy.sh/api/get_user', {
      params: { k: cfg.osuApiKey, u: cfg.username, m: 0 }, timeout: 10000,
    });
    if (Array.isArray(data) && data.length > 0) results.osu = { ok: true, msg: `Usuario encontrado: ${data[0].username}` };
    else results.osu = { ok: false, msg: `Usuario "${cfg.username}" no encontrado` };
  } catch (error) {
    results.osu = { ok: false, msg: error.response ? `HTTP ${error.response.status}` : error.message };
  }
  try {
    const { data } = await axios.get(`https://api.streamelements.com/kappa/v2/bot/commands/${cfg.channelId}`, {
      headers: { Authorization: `Bearer ${cfg.streamElementsToken}`, Accept: 'application/json' }, timeout: 10000,
    });
    const count = Array.isArray(data) ? data.length : (data.docs?.length ?? 0);
    results.se = { ok: true, msg: `Conectado — ${count} comandos encontrados` };
  } catch (error) {
    results.se = { ok: false, msg: error.response ? `HTTP ${error.response.status}` : error.message };
  }
  return results;
});
