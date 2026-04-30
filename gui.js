'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PORT = 3000;
const HOST = '127.0.0.1';

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>osu! Stats Updater - Configuración</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0d0d1a;
      color: #d0d0e8;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      padding: 40px 16px 60px;
    }
    .container { width: 100%; max-width: 580px; }
    .header { text-align: center; margin-bottom: 36px; }
    .header h1 { font-size: 26px; color: #ff79c6; margin-bottom: 6px; letter-spacing: -0.5px; }
    .header p  { color: #6666aa; font-size: 13px; }
    .card {
      background: #13132b;
      border: 1px solid #222244;
      border-radius: 14px;
      padding: 22px 24px;
      margin-bottom: 18px;
    }
    .card h2 {
      font-size: 14px;
      font-weight: 600;
      color: #bd93f9;
      margin-bottom: 18px;
      padding-bottom: 10px;
      border-bottom: 1px solid #1e1e40;
    }
    .field { margin-bottom: 14px; }
    .field:last-child { margin-bottom: 0; }
    .field label { display: block; font-size: 12px; color: #7777aa; margin-bottom: 5px; font-weight: 500; }
    .field input[type="text"],
    .field input[type="number"],
    .field textarea {
      width: 100%;
      background: #09091a;
      border: 1px solid #222244;
      border-radius: 8px;
      color: #d0d0e8;
      padding: 9px 12px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
      font-family: inherit;
    }
    .field input:focus,
    .field textarea:focus { border-color: #bd93f9; }
    .field textarea {
      resize: vertical;
      min-height: 72px;
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 11px;
      word-break: break-all;
      line-height: 1.5;
    }
    .toggles {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .toggle-item {
      display: flex;
      align-items: center;
      gap: 10px;
      background: #09091a;
      padding: 11px 13px;
      border-radius: 9px;
      border: 1px solid #222244;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      user-select: none;
    }
    .toggle-item:hover { border-color: #bd93f9; background: #0f0f22; }
    .toggle-item input[type="checkbox"] {
      width: 16px; height: 16px;
      accent-color: #ff79c6;
      cursor: pointer;
      flex-shrink: 0;
    }
    .toggle-item .label-text { font-size: 13px; color: #d0d0e8; }
    .toggle-item small { display: block; font-size: 11px; color: #6666aa; margin-top: 1px; }
    .save-btn {
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #ff79c6 0%, #bd93f9 100%);
      border: none;
      border-radius: 10px;
      color: #0d0d1a;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      letter-spacing: 0.3px;
      transition: opacity 0.2s, transform 0.1s;
      margin-top: 4px;
    }
    .save-btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .save-btn:active { transform: translateY(0); opacity: 1; }
    .toast {
      position: fixed;
      bottom: 28px;
      right: 28px;
      background: #50fa7b;
      color: #0d0d1a;
      padding: 12px 22px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 13px;
      opacity: 0;
      transform: translateY(16px);
      transition: opacity 0.25s, transform 0.25s;
      pointer-events: none;
      z-index: 9999;
    }
    .toast.show  { opacity: 1; transform: translateY(0); }
    .toast.error { background: #ff5555; color: #fff; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🎵 osu! Stats Updater</h1>
    <p>Configuración del bot · Cierra esta ventana cuando termines</p>
  </div>

  <div class="card">
    <h2>🎮 osu!</h2>
    <div class="field">
      <label>Nombre de usuario</label>
      <input type="text" id="username" placeholder="Tu username de osu!">
    </div>
    <div class="field">
      <label>osu! API Key</label>
      <input type="text" id="osuApiKey" placeholder="Tu clave de API de osu!">
    </div>
  </div>

  <div class="card">
    <h2>📺 StreamElements</h2>
    <div class="field">
      <label>Account ID (Channel ID)</label>
      <input type="text" id="channelId" placeholder="5edc06d994438f3f2a220c65">
    </div>
    <div class="field">
      <label>JWT Token</label>
      <textarea id="streamElementsToken" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."></textarea>
    </div>
  </div>

  <div class="card">
    <h2>⚙️ Comando</h2>
    <div class="field">
      <label>Nombre del comando (sin !)</label>
      <input type="text" id="commandName" placeholder="osu">
    </div>
    <div class="field">
      <label>Intervalo de actualización (segundos)</label>
      <input type="number" id="pollInterval" min="10" max="3600" placeholder="60">
    </div>
  </div>

  <div class="card">
    <h2>👁️ Mostrar en el chat</h2>
    <div class="toggles">
      <label class="toggle-item">
        <input type="checkbox" id="disp_username">
        <div><span class="label-text">👤 Nombre</span><small>Username de osu!</small></div>
      </label>
      <label class="toggle-item">
        <input type="checkbox" id="disp_worldRank">
        <div><span class="label-text">🌍 Puesto mundial</span><small>Ranking global</small></div>
      </label>
      <label class="toggle-item">
        <input type="checkbox" id="disp_nationalRank">
        <div><span class="label-text">🏳️ Puesto nacional</span><small>Ranking de tu país</small></div>
      </label>
      <label class="toggle-item">
        <input type="checkbox" id="disp_pp">
        <div><span class="label-text">🎯 PP total</span><small>Performance points</small></div>
      </label>
      <label class="toggle-item">
        <input type="checkbox" id="disp_accuracy">
        <div><span class="label-text">✨ Accuracy</span><small>% de precisión global</small></div>
      </label>
    </div>
  </div>

  <button class="save-btn" onclick="saveConfig()">💾 Guardar configuración</button>
</div>

<div class="toast" id="toast"></div>

<script>
  const TEXT_FIELDS    = ['username','osuApiKey','channelId','streamElementsToken','commandName'];
  const DISPLAY_FIELDS = ['username','worldRank','nationalRank','pp','accuracy'];

  async function loadConfig() {
    const cfg = await fetch('/config').then(r => r.json());

    TEXT_FIELDS.forEach(f => {
      const el = document.getElementById(f);
      if (el && cfg[f] != null) el.value = cfg[f];
    });

    const pi = document.getElementById('pollInterval');
    if (cfg.pollInterval) pi.value = Math.round(cfg.pollInterval / 1000);

    const d = cfg.display || {};
    DISPLAY_FIELDS.forEach(f => {
      const el = document.getElementById('disp_' + f);
      if (el) el.checked = (d[f] !== false);
    });
  }

  async function saveConfig() {
    const cfg = {};
    TEXT_FIELDS.forEach(f => {
      const el = document.getElementById(f);
      if (el) cfg[f] = el.value.trim();
    });

    const secs = parseInt(document.getElementById('pollInterval').value, 10);
    cfg.pollInterval = (isNaN(secs) || secs < 10 ? 60 : secs) * 1000;

    cfg.display = {};
    DISPLAY_FIELDS.forEach(f => {
      const el = document.getElementById('disp_' + f);
      cfg.display[f] = el ? el.checked : true;
    });

    if (!cfg.username)              { showToast('❌ Ingresa tu username de osu!', true); return; }
    if (!cfg.channelId)             { showToast('❌ Ingresa el Account ID de StreamElements', true); return; }
    if (!cfg.streamElementsToken)   { showToast('❌ Ingresa el JWT Token de StreamElements', true); return; }

    const res  = await fetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    const data = await res.json();
    if (data.ok) showToast('✅ Configuración guardada correctamente');
    else         showToast('❌ Error: ' + data.error, true);
  }

  function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = 'toast' + (isError ? ' error' : '') + ' show';
    setTimeout(() => { t.className = 'toast'; }, 3000);
  }

  loadConfig();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readConfig()));
    return;
  }

  if (req.method === 'POST' && req.url === '/save') {
    try {
      const body = await parseBody(req);
      writeConfig(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  osu! Stats Updater - Configuracion');
  console.log('  =====================================');
  console.log(`  Abriendo: ${url}`);
  console.log('');
  console.log('  Cierra esta ventana cuando termines.');
  console.log('');
  exec(`start ${url}`);
});
