'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path   = require('path');
const fs     = require('fs');
const axios  = require('axios');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ── Single instance ──────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let win    = null;
let botProc = null;

// ── Config helpers ───────────────────────────────────────────────────────────

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 660,
    minWidth: 640,
    minHeight: 500,
    backgroundColor: '#0d0d1a',
    title: 'osu! Stats Updater',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile('gui.html');

  win.on('closed', () => {
    if (botProc) { botProc.kill('SIGTERM'); botProc = null; }
    win = null;
  });
}

app.whenReady().then(createWindow);

// Bring existing window to front if user tries to open a second instance
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (botProc) { botProc.kill('SIGTERM'); botProc = null; }
  app.quit();
});

// ── IPC: Config ──────────────────────────────────────────────────────────────

ipcMain.handle('load-config', () => readConfig());

ipcMain.handle('save-config', (_, data) => {
  try {
    writeConfig(data);
    if (botProc) {
      botProc.kill('SIGTERM');
      botProc = null;
      if (win) win.webContents.send('bot-log', '\u21bb Configuraci\u00f3n guardada \u2014 reiniciando bot...\n');
      setTimeout(() => {
        startBot();
        if (win) win.webContents.send('bot-restarted');
      }, 800);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Bot process helper ───────────────────────────────────────────────────────

function startBot() {
  if (botProc) return;
  botProc = spawn('node', [path.join(__dirname, 'index.js')], {
    cwd: __dirname, env: process.env, shell: false,
  });
  botProc.stdout.on('data', chunk => { if (win) win.webContents.send('bot-log', chunk.toString()); });
  botProc.stderr.on('data', chunk => { if (win) win.webContents.send('bot-log', chunk.toString()); });
  botProc.on('error', err => {
    botProc = null;
    if (win) { win.webContents.send('bot-log', `ERROR al iniciar node: ${err.message}\n`); win.webContents.send('bot-stopped', 1); }
  });
  botProc.on('close', code => { botProc = null; if (win) win.webContents.send('bot-stopped', code ?? 0); });
}

// ── IPC: Bot ─────────────────────────────────────────────────────────────────

ipcMain.handle('start-bot', () => {
  if (botProc) return { ok: false, error: 'El bot ya está corriendo' };
  startBot();
  return { ok: true };
});

ipcMain.handle('stop-bot', () => {
  if (!botProc) return { ok: false, error: 'El bot no está corriendo' };
  botProc.kill('SIGTERM');
  botProc = null;
  return { ok: true };
});

// ── IPC: Test connection ──────────────────────────────────────────────────────

ipcMain.handle('test-connection', async () => {
  const cfg = readConfig();
  const results = { osu: null, se: null };

  try {
    const { data } = await axios.get('https://osu.ppy.sh/api/get_user', {
      params: { k: cfg.osuApiKey, u: cfg.username, m: 0 },
      timeout: 10000,
    });
    if (Array.isArray(data) && data.length > 0)
      results.osu = { ok: true, msg: `Usuario encontrado: ${data[0].username}` };
    else
      results.osu = { ok: false, msg: `Usuario "${cfg.username}" no encontrado` };
  } catch (e) {
    results.osu = { ok: false, msg: e.response ? `HTTP ${e.response.status}` : e.message };
  }

  try {
    const { data } = await axios.get(
      `https://api.streamelements.com/kappa/v2/bot/commands/${cfg.channelId}`,
      { headers: { Authorization: `Bearer ${cfg.streamElementsToken}`, Accept: 'application/json' }, timeout: 10000 }
    );
    const count = Array.isArray(data) ? data.length : (data.docs?.length ?? 0);
    results.se = { ok: true, msg: `Conectado — ${count} comandos encontrados` };
  } catch (e) {
    results.se = { ok: false, msg: e.response ? `HTTP ${e.response.status}` : e.message };
  }

  return results;
});
