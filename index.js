'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

const SE_BASE = 'https://api.streamelements.com/kappa/v2';

// ─── Helpers ────────────────────────────────────────────────────────────────

function countryToFlag(code) {
  if (!code || code.length !== 2) return '🌍';
  return [...code.toUpperCase()]
    .map(c => String.fromCodePoint(127397 + c.charCodeAt(0)))
    .join('');
}

function fmt(n) {
  return n != null ? `#${Number(n).toLocaleString('en-US')}` : 'N/A';
}

// ─── osu! API v1 ─────────────────────────────────────────────────────────────

async function fetchOsuStats() {
  const config = getConfig();
  const { data } = await axios.get('https://osu.ppy.sh/api/get_user', {
    params: { k: config.osuApiKey, u: config.username, m: 0 },
    timeout: 15000,
  });

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Usuario "${config.username}" no encontrado en osu!`);
  }

  const u = data[0];
  return {
    globalRank:  parseInt(u.pp_rank, 10)         || null,
    countryRank: parseInt(u.pp_country_rank, 10)  || null,
    pp:          Math.round(parseFloat(u.pp_raw)  || 0),
    accuracy:    parseFloat(parseFloat(u.accuracy).toFixed(2)),
    countryCode: (u.country || 'XX').toUpperCase(),
    level:       Math.floor(parseFloat(u.level)   || 0),
    playcount:   parseInt(u.playcount, 10)        || 0,
    countSS:     (parseInt(u.count_rank_ssh, 10)  || 0) + (parseInt(u.count_rank_ss, 10) || 0),
    countS:      (parseInt(u.count_rank_sh, 10)   || 0) + (parseInt(u.count_rank_s, 10)  || 0),
    countA:      parseInt(u.count_rank_a, 10)     || 0,
    hoursPlayed: Math.floor((parseInt(u.total_seconds_played, 10) || 0) / 3600),
  };
}

function buildMessage(stats) {
  const config = getConfig();
  const { globalRank, countryRank, pp, accuracy, countryCode, level, playcount, countSS, countS, countA, hoursPlayed } = stats;
  const flag = countryToFlag(countryCode);
  const d = config.display || {};
  const parts = [];

  if (d.username     !== false) parts.push(`👤 ${config.username}`);
  if (d.worldRank    !== false) parts.push(`🌍 ${fmt(globalRank)}`);
  if (d.nationalRank !== false) parts.push(`${flag} ${fmt(countryRank)}`);
  if (d.pp           !== false) parts.push(`🎯 ${pp.toLocaleString('en-US')}pp`);
  if (d.accuracy     !== false) parts.push(`✨ ${accuracy.toFixed(2)}%`);
  if (d.level        === true)  parts.push(`⭐ Lvl ${level}`);
  if (d.playcount    === true)  parts.push(`🎮 ${playcount.toLocaleString('en-US')} plays`);
  if (d.grades       === true)  parts.push(`SS:${countSS} S:${countS} A:${countA}`);
  if (d.hoursPlayed  === true)  parts.push(`⏱️ ${hoursPlayed.toLocaleString('en-US')}h`);

  return `🎵 osu! | ${parts.join(' | ')}`;
}

// ─── StreamElements API ──────────────────────────────────────────────────────

function seHeaders() {
  const config = getConfig();
  return {
    Authorization: `Bearer ${config.streamElementsToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function findCommand() {
  const config = getConfig();
  const { data } = await axios.get(
    `${SE_BASE}/bot/commands/${config.channelId}`,
    { headers: seHeaders(), timeout: 10000 }
  );
  const list = Array.isArray(data) ? data : (data.docs ?? []);
  return list.find(c => c.command === config.commandName) ?? null;
}

async function createCommand(reply) {
  const config = getConfig();
  const { data } = await axios.post(
    `${SE_BASE}/bot/commands/${config.channelId}`,
    {
      command: config.commandName,
      reply,
      enabled: true,
      cost: 0,
      cooldown: { global: 5, user: 0 },
    },
    { headers: seHeaders(), timeout: 10000 }
  );
  return data;
}

async function updateCommand(id, reply) {
  const config = getConfig();
  // Fetch the existing command first to preserve keywords, cooldowns, aliases, etc.
  let base = { command: config.commandName };
  try {
    const { data: existing } = await axios.get(
      `${SE_BASE}/bot/commands/${config.channelId}/${id}`,
      { headers: seHeaders(), timeout: 10000 }
    );
    base = existing;
  } catch (fetchErr) { console.warn('[updateCommand] Could not fetch existing command, using minimal base:', fetchErr.message); }

  const { data } = await axios.put(
    `${SE_BASE}/bot/commands/${config.channelId}/${id}`,
    { ...base, command: config.commandName, reply },
    { headers: seHeaders(), timeout: 10000 }
  );
  return data;
}

async function upsertCommand(reply) {
  const config = getConfig();
  let existing = await findCommand();

  if (existing) {
    await updateCommand(existing._id, reply);
    console.log(`[SE] Updated  !${config.commandName}`);
    return;
  }

  try {
    await createCommand(reply);
    console.log(`[SE] Created  !${config.commandName}`);
  } catch (err) {
    // 409 Conflict → command was just created elsewhere; fall back to PUT
    if (err.response?.status === 409) {
      existing = await findCommand();
      if (existing) {
        await updateCommand(existing._id, reply);
        console.log(`[SE] Fallback-updated !${config.commandName}`);
        return;
      }
    }
    throw err;
  }
}

// ─── Poll loop ───────────────────────────────────────────────────────────────

let lastMessage = null;

async function poll() {
  const ts = new Date().toISOString();
  try {
    const stats   = await fetchOsuStats();
    const message = buildMessage(stats);

    if (message === lastMessage) {
      console.log(`[${ts}] No change.`);
      return;
    }

    await upsertCommand(message);
    lastMessage = message;
    console.log(`[${ts}] → ${message}`);
  } catch (err) {
    console.error(`[${ts}] ERROR: ${err.message}`);
    if (err.response) {
      console.error(`  HTTP ${err.response.status}:`, JSON.stringify(err.response.data));
    }
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

console.log(`osu! stats updater started`);
(function printBoot() {
  const config = getConfig();
  console.log(`  user     : ${config.username}`);
  console.log(`  command  : !${config.commandName}`);
  console.log(`  interval : ${config.pollInterval / 1000}s`);
  console.log('\u2500'.repeat(50));
}())

poll();
setInterval(poll, getConfig().pollInterval ?? 60000);
