'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_POLL_INTERVAL = 60000;
const MIN_POLL_INTERVAL = 10000;
const MAX_POLL_INTERVAL = 3600000;
const SE_BASE = 'https://api.streamelements.com/kappa/v2';

function normalizeConfig(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  const interval = config.pollInterval;
  config.pollInterval = typeof interval === 'number' && Number.isFinite(interval) &&
    interval >= MIN_POLL_INTERVAL && interval <= MAX_POLL_INTERVAL
    ? interval
    : DEFAULT_POLL_INTERVAL;
  return config;
}

function readConfig() {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { return normalizeConfig({}); }
}

function countryToFlag(code) {
  if (!code || code.length !== 2) return '🌍';
  return [...code.toUpperCase()].map(c => String.fromCodePoint(127397 + c.charCodeAt(0))).join('');
}

function fmt(n) {
  return n != null ? `#${Number(n).toLocaleString('en-US')}` : 'N/A';
}

function buildMessage(stats, config) {
  const { globalRank, countryRank, pp, accuracy, countryCode, level, playcount, countSS, countS, countA, hoursPlayed } = stats;
  const flag = countryToFlag(countryCode);
  const d = config.display || {};
  const parts = [];
  if (d.username !== false) parts.push(`👤 ${config.username}`);
  if (d.worldRank !== false) parts.push(`🌍 ${fmt(globalRank)}`);
  if (d.nationalRank !== false) parts.push(`${flag} ${fmt(countryRank)}`);
  if (d.pp !== false) parts.push(`🎯 ${pp.toLocaleString('en-US')}pp`);
  if (d.accuracy !== false) parts.push(`✨ ${accuracy.toFixed(2)}%`);
  if (d.level === true) parts.push(`⭐ Lvl ${level}`);
  if (d.playcount === true) parts.push(`🎮 ${playcount.toLocaleString('en-US')} plays`);
  if (d.grades === true) parts.push(`SS:${countSS} S:${countS} A:${countA}`);
  if (d.hoursPlayed === true) parts.push(`⏱️ ${hoursPlayed.toLocaleString('en-US')}h`);
  return `🎵 osu! | ${parts.join(' | ')}`;
}

function createUpdater({ config: rawConfig, http = axios, logger = console, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const config = normalizeConfig(rawConfig ?? readConfig());
  let lastMessage = null;
  let inFlight = null;
  let timer = null;
  let stopped = true;
  let lastHeartbeat = 0;
  let cachedCommandId = null;

  function headers() {
    return {
      Authorization: `Bearer ${config.streamElementsToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async function fetchOsuStats() {
    const { data } = await http.get('https://osu.ppy.sh/api/get_user', {
      params: { k: config.osuApiKey, u: config.username, m: 0 }, timeout: 15000,
    });
    if (!Array.isArray(data) || data.length === 0) throw new Error(`Usuario "${config.username}" no encontrado en osu!`);
    const u = data[0];
    return {
      globalRank: parseInt(u.pp_rank, 10) || null,
      countryRank: parseInt(u.pp_country_rank, 10) || null,
      pp: Math.round(parseFloat(u.pp_raw) || 0),
      accuracy: parseFloat(parseFloat(u.accuracy).toFixed(2)),
      countryCode: (u.country || 'XX').toUpperCase(),
      level: Math.floor(parseFloat(u.level) || 0),
      playcount: parseInt(u.playcount, 10) || 0,
      countSS: (parseInt(u.count_rank_ssh, 10) || 0) + (parseInt(u.count_rank_ss, 10) || 0),
      countS: (parseInt(u.count_rank_sh, 10) || 0) + (parseInt(u.count_rank_s, 10) || 0),
      countA: parseInt(u.count_rank_a, 10) || 0,
      hoursPlayed: Math.floor((parseInt(u.total_seconds_played, 10) || 0) / 3600),
    };
  }

  async function findCommand() {
    const { data } = await http.get(`${SE_BASE}/bot/commands/${config.channelId}`, { headers: headers(), timeout: 10000 });
    const list = Array.isArray(data) ? data : (data.docs ?? []);
    const command = list.find(item => item.command === config.commandName) ?? null;
    cachedCommandId = command?._id ?? null;
    return command;
  }

  async function getCommand(id) {
    const { data } = await http.get(`${SE_BASE}/bot/commands/${config.channelId}/${id}`, {
      headers: headers(), timeout: 10000,
    });
    return data;
  }

  async function createCommand(reply) {
    const { data } = await http.post(`${SE_BASE}/bot/commands/${config.channelId}`, {
      command: config.commandName, reply, enabled: true, cost: 0, cooldown: { global: 5, user: 0 },
    }, { headers: headers(), timeout: 10000 });
    return data;
  }

  async function putCommand(existing, reply) {
    const { data } = await http.put(`${SE_BASE}/bot/commands/${config.channelId}/${existing._id}`,
      { ...existing, command: config.commandName, reply }, { headers: headers(), timeout: 10000 });
    return data;
  }

  async function upsertCommand(reply) {
    let existing = null;
    let metadataLoaded = false;
    if (cachedCommandId) {
      try {
        existing = await getCommand(cachedCommandId);
        metadataLoaded = true;
      } catch (err) {
        if (err.response?.status !== 404 && err.response?.status !== 409) throw err;
        cachedCommandId = null;
      }
    }
    if (!existing) existing = await findCommand();
    if (existing) cachedCommandId = existing._id;
    if (existing?.reply === reply) return { changed: false, command: existing };

    if (!existing) {
      try {
        const command = await createCommand(reply);
        return { changed: true, command };
      } catch (err) {
        if (err.response?.status !== 409) throw err;
        existing = await findCommand();
        if (!existing) throw err;
        if (existing.reply === reply) return { changed: false, command: existing };
      }
    }

    if (!metadataLoaded) {
      try {
        existing = await getCommand(existing._id);
        if (existing.reply === reply) return { changed: false, command: existing };
      } catch (err) {
        if (err.response?.status !== 404 && err.response?.status !== 409) throw err;
        cachedCommandId = null;
        existing = await findCommand();
        if (!existing) {
          if (err.response.status === 404) {
            const command = await createCommand(reply);
            return { changed: true, command };
          }
          throw err;
        }
        cachedCommandId = existing._id;
        if (existing.reply === reply) return { changed: false, command: existing };
        existing = await getCommand(existing._id);
      }
    }

    try {
      const command = await putCommand(existing, reply);
      return { changed: true, command };
    } catch (err) {
      // The command may have been deleted/recreated after the collection read.
      if (err.response?.status !== 404 && err.response?.status !== 409) throw err;
      const refreshed = await findCommand();
      if (refreshed?.reply === reply) return { changed: false, command: refreshed };
      if (!refreshed && err.response.status === 404) {
        try { return { changed: true, command: await createCommand(reply) }; }
        catch (createErr) {
          if (createErr.response?.status !== 409) throw createErr;
          const raced = await findCommand();
          if (!raced) throw createErr;
          if (raced.reply === reply) return { changed: false, command: raced };
          return { changed: true, command: await putCommand(raced, reply) };
        }
      }
      if (!refreshed) throw err;
      const full = await getCommand(refreshed._id);
      if (full.reply === reply) return { changed: false, command: full };
      return { changed: true, command: await putCommand(full, reply) };
    }
  }

  async function pollOnce() {
    if (inFlight) return inFlight;
    const cycle = (async () => {
      const ts = new Date().toISOString();
      try {
        const stats = await fetchOsuStats();
        const message = buildMessage(stats, config);
        if (message === lastMessage) {
          if (Date.now() - lastHeartbeat >= 30 * 60 * 1000) {
            logger.log(`[${ts}] Bot activo; estadísticas sin cambios.`);
            lastHeartbeat = Date.now();
          }
          return { changed: false, message };
        }
        const result = await upsertCommand(message);
        lastMessage = message;
        lastHeartbeat = Date.now();
        if (result.changed) logger.log(`[${ts}] → ${message}`);
        else logger.log(`[${ts}] Comando remoto ya estaba actualizado.`);
        return { ...result, message };
      } catch (err) {
        logger.error(`[${ts}] ERROR: ${err.message}`);
        if (err.response) logger.error(`  HTTP ${err.response.status}:`, JSON.stringify(err.response.data));
        return { error: err };
      }
    })();
    inFlight = cycle;
    try { return await cycle; }
    finally { if (inFlight === cycle) inFlight = null; }
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimer(async () => {
      timer = null;
      await pollOnce();
      schedule(config.pollInterval);
    }, delay);
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void pollOnce().finally(() => schedule(config.pollInterval));
  }

  async function stop() {
    stopped = true;
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (inFlight) await inFlight;
  }

  return { config, pollOnce, start, stop, get lastMessage() { return lastMessage; }, get inFlight() { return inFlight; } };
}

if (require.main === module) {
  const updater = createUpdater({ config: readConfig() });
  loggerBoot(updater.config);
  updater.start();
  const shutdown = () => { void updater.stop().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function loggerBoot(config) {
  console.log('osu! stats updater started');
  console.log(`  user     : ${config.username}`);
  console.log(`  command  : !${config.commandName}`);
  console.log(`  interval : ${config.pollInterval / 1000}s`);
  console.log('─'.repeat(50));
}

module.exports = { createUpdater, normalizeConfig, buildMessage, DEFAULT_POLL_INTERVAL, MIN_POLL_INTERVAL, MAX_POLL_INTERVAL };
