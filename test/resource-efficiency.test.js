'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater, normalizeConfig, DEFAULT_POLL_INTERVAL } = require('../index');
const { createBotProcessManager, saveConfigAndRestart } = require('../bot-process-manager');
const appendBoundedLog = require('../gui-log');

const baseConfig = {
  username: 'offline-user', osuApiKey: 'not-a-real-key', streamElementsToken: 'not-a-real-token',
  channelId: 'offline-channel', commandName: 'osu', pollInterval: 60000,
  display: { username: true, worldRank: true, nationalRank: true, pp: true, accuracy: true },
};

function osuData(rank = '100') {
  return [{ pp_rank: rank, pp_country_rank: '5', pp_raw: '1234.4', accuracy: '98.25', country: 'US', level: '99.1', playcount: '500', count_rank_ssh: '1', count_rank_ss: '2', count_rank_sh: '3', count_rank_s: '4', count_rank_a: '5', total_seconds_played: '7200' }];
}

function makeHttp({ rank = '100', command = null, blockOsu = null } = {}) {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.includes('osu.ppy.sh')) {
        if (blockOsu) await blockOsu;
        return { data: osuData(rank) };
      }
      if (command && url.endsWith(`/offline-channel/${command._id}`)) return { data: command };
      return { data: command ? [command] : [] };
    },
    async post(url, body) { calls.push({ method: 'POST', url, body }); return { data: { _id: 'new-id', ...body } }; },
    async put(url, body) { calls.push({ method: 'PUT', url, body }); return { data: body }; },
  };
}

test('pollInterval accepts only finite numeric values from 10 to 3600 seconds', () => {
  for (const invalid of [0, -1, NaN, Infinity, '10000', null, 9999, 3600001]) {
    assert.equal(normalizeConfig({ pollInterval: invalid }).pollInterval, DEFAULT_POLL_INTERVAL, String(invalid));
  }
  assert.equal(normalizeConfig({ pollInterval: 10000 }).pollInterval, 10000);
  assert.equal(normalizeConfig({ pollInterval: 3600000 }).pollInterval, 3600000);
});

test('invalid pollInterval always schedules using the safe 60 second default', async () => {
  const delays = [];
  const updater = createUpdater({
    config: { ...baseConfig, pollInterval: '0' }, http: makeHttp(), logger: { log() {}, error() {} },
    setTimer: (_, delay) => { delays.push(delay); return delays.length; }, clearTimer() {},
  });
  assert.equal(updater.config.pollInterval, DEFAULT_POLL_INTERVAL);
  updater.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delays, [DEFAULT_POLL_INTERVAL]);
  await updater.stop();
});

test('concurrent poll requests share one in-flight poll; a slow cycle does not accumulate work', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const http = makeHttp({ blockOsu: blocked });
  const timers = [];
  const updater = createUpdater({ config: baseConfig, http, logger: { log() {}, error() {} }, setTimer: fn => { timers.push(fn); return fn; }, clearTimer() {} });
  const first = updater.pollOnce();
  const second = updater.pollOnce();
  assert.equal(http.calls.filter(call => call.url.includes('osu.ppy.sh')).length, 1);
  updater.start();
  assert.equal(timers.length, 0, 'next timer must wait for the slow cycle');
  release();
  await Promise.all([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(http.calls.filter(call => call.url.includes('osu.ppy.sh')).length, 1);
  assert.equal(timers.length, 1, 'only one future poll is scheduled');
  await updater.stop();
});

test('unchanged statistics do not repeat StreamElements writes', async () => {
  const http = makeHttp();
  const updater = createUpdater({ config: baseConfig, http, logger: { log() {}, error() {} } });
  await updater.pollOnce();
  const writesAfterFirstPoll = http.calls.filter(call => call.method === 'PUT' || call.method === 'POST').length;
  await updater.pollOnce();
  assert.equal(writesAfterFirstPoll, 1);
  assert.equal(http.calls.filter(call => call.method === 'PUT' || call.method === 'POST').length, 1);
  assert.equal(http.calls.filter(call => call.url.includes('streamelements')).length, 2, 'second poll makes no StreamElements request');
});

test('startup skips PUT when the remote command already has the exact reply', async () => {
  const expected = '🎵 osu! | 👤 offline-user | 🌍 #100 | 🇺🇸 #5 | 🎯 1,234pp | ✨ 98.25%';
  const http = makeHttp({ command: { _id: 'existing-id', command: 'osu', reply: expected, cooldown: { global: 17, user: 3 }, aliases: ['stats'], keywords: ['rank'] } });
  const updater = createUpdater({ config: baseConfig, http, logger: { log() {}, error() {} } });
  const result = await updater.pollOnce();
  assert.equal(result.changed, false);
  assert.equal(updater.lastMessage, expected);
  assert.equal(http.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(http.calls.filter(call => call.url.includes('streamelements')).length, 1);
});

test('changed message preserves detail metadata and caches the command ID', async () => {
  const command = { _id: 'existing-id', command: 'osu', reply: 'old reply', enabled: false, cost: 12, cooldown: { global: 37, user: 9 }, aliases: ['stats'], keywords: ['rank'] };
  const http = makeHttp({ command });
  const updater = createUpdater({ config: baseConfig, http, logger: { log() {}, error() {} } });
  await updater.pollOnce();
  const seCalls = http.calls.filter(call => call.url.includes('streamelements'));
  assert.deepEqual(seCalls.map(call => call.method), ['GET', 'GET', 'PUT']);
  const sent = seCalls[2].body;
  assert.deepEqual(sent.cooldown, command.cooldown);
  assert.deepEqual(sent.aliases, command.aliases);
  assert.deepEqual(sent.keywords, command.keywords);
  assert.equal(sent.enabled, false);
  assert.equal(sent.cost, 12);
});

test('later changed polls refresh command detail without listing again', async () => {
  let osuPolls = 0;
  const command = { _id: 'cached-id', command: 'osu', reply: 'old', cooldown: { global: 10, user: 2 }, aliases: ['stats'] };
  const calls = [];
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.includes('osu.ppy.sh')) return { data: osuData(osuPolls++ === 0 ? '100' : '101') };
      if (url.endsWith('/offline-channel/cached-id')) return { data: command };
      return { data: [command] };
    },
    async put(url, body) { calls.push({ method: 'PUT', url, body }); command.reply = body.reply; return { data: body }; },
  };
  const updater = createUpdater({ config: baseConfig, http, logger: { log() {}, error() {} } });
  await updater.pollOnce();
  command.cooldown = { global: 42, user: 8 };
  await updater.pollOnce();
  const seCalls = calls.filter(call => call.url.includes('streamelements'));
  assert.deepEqual(seCalls.map(call => call.method), ['GET', 'GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(seCalls.at(-1).body.cooldown, { global: 42, user: 8 });
  assert.match(seCalls.at(-1).body.reply, /#101/);
});

test('404 after listing recovers from an externally recreated command', async () => {
  const calls = [];
  let lists = 0;
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.includes('osu.ppy.sh')) return { data: osuData() };
      if (url.endsWith('/offline-channel/deleted-id')) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (url.endsWith('/offline-channel/recreated-id')) return { data: { _id: 'recreated-id', command: 'osu', reply: 'old', aliases: ['new'], cooldown: { global: 22, user: 4 } } };
      lists++;
      return { data: [lists === 1
        ? { _id: 'deleted-id', command: 'osu', reply: 'old', aliases: ['old'] }
        : { _id: 'recreated-id', command: 'osu', reply: 'old', aliases: ['new'], cooldown: { global: 22, user: 4 } }] };
    },
    async put(url, body) {
      calls.push({ method: 'PUT', url, body });
      if (url.endsWith('/deleted-id')) throw Object.assign(new Error('not found'), { response: { status: 404 } });
      return { data: body };
    },
  };
  const updater = createUpdater({ config: baseConfig, http, logger: { log() {}, error() {} } });
  await updater.pollOnce();
  assert.deepEqual(calls.filter(call => call.url.includes('streamelements')).map(call => call.method), ['GET', 'GET', 'GET', 'GET', 'PUT']);
  assert.equal(calls.at(-1).url.endsWith('/recreated-id'), true);
  assert.deepEqual(calls.at(-1).body.aliases, ['new']);
  assert.deepEqual(calls.at(-1).body.cooldown, { global: 22, user: 4 });
});

test('409 while creating discovers a command created concurrently and avoids duplicate creation', async () => {
  const calls = [];
  let lists = 0;
  const expected = '🎵 osu! | 👤 offline-user | 🌍 #100 | 🇺🇸 #5 | 🎯 1,234pp | ✨ 98.25%';
  const http = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.includes('osu.ppy.sh')) return { data: osuData() };
      lists++;
      return { data: lists === 1 ? [] : [{ _id: 'raced-id', command: 'osu', reply: expected }] };
    },
    async post(url) {
      calls.push({ method: 'POST', url });
      throw Object.assign(new Error('conflict'), { response: { status: 409 } });
    },
  };
  const updater = createUpdater({ config: baseConfig, http, logger: { log() {}, error() {} } });
  const result = await updater.pollOnce();
  assert.equal(result.changed, false);
  assert.deepEqual(calls.filter(call => call.url.includes('streamelements')).map(call => call.method), ['GET', 'POST', 'GET']);
});

class FakeChild extends EventEmitter {
  constructor(onExit) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.live = true;
    this.onExit = onExit;
  }
  kill() { setTimeout(() => { if (this.live) { this.live = false; this.emit('close', 0); this.onExit(); } }, 5); return true; }
}

function fakeSpawner() {
  const children = [];
  let live = 0;
  let maxLive = 0;
  return {
    children,
    get live() { return live; },
    get maxLive() { return maxLive; },
    spawn() {
      live++;
      maxLive = Math.max(maxLive, live);
      const child = new FakeChild(() => live--);
      children.push(child);
      return child;
    },
  };
}

test('rapid Start → Stop → Start never has two bot children alive', async () => {
  const fakes = fakeSpawner();
  const manager = createBotProcessManager({ spawnProcess: () => fakes.spawn(), shutdownTimeoutMs: 100 });
  await manager.start();
  const stopping = manager.stop();
  const starting = manager.start();
  await Promise.all([stopping, starting]);
  assert.equal(fakes.children.length, 2);
  assert.equal(fakes.maxLive, 1);
  assert.equal(fakes.live, 1);
  await manager.shutdown();
  assert.equal(fakes.live, 0);
});

test('restart waits for one clean close before spawning exactly one replacement', async () => {
  const fakes = fakeSpawner();
  const manager = createBotProcessManager({ spawnProcess: () => fakes.spawn(), shutdownTimeoutMs: 100 });
  await manager.start();
  assert.equal(await manager.restart(), true);
  assert.equal(fakes.children.length, 2);
  assert.equal(fakes.maxLive, 1);
  assert.equal(fakes.live, 1);
  await manager.shutdown();
});

test('saving config while active performs exactly one clean restart', async () => {
  const fakes = fakeSpawner();
  const manager = createBotProcessManager({ spawnProcess: () => fakes.spawn(), shutdownTimeoutMs: 100 });
  await manager.start();
  let writes = 0;
  let restartNotices = 0;
  let restartedNotices = 0;
  const result = await saveConfigAndRestart({
    manager,
    writeConfig: () => { writes++; },
    onRestarting: () => { restartNotices++; },
    onRestarted: () => { restartedNotices++; },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(writes, 1);
  assert.equal(restartNotices, 1);
  assert.equal(restartedNotices, 1);
  assert.equal(fakes.children.length, 2);
  assert.equal(fakes.maxLive, 1);
  await manager.shutdown();
});

test('a late event from an old process cannot clear the registered replacement', async () => {
  const fakes = fakeSpawner();
  const manager = createBotProcessManager({ spawnProcess: () => fakes.spawn(), shutdownTimeoutMs: 100 });
  await manager.start();
  const old = fakes.children[0];
  old.emit('error', new Error('simulated spawn failure'));
  await manager.start();
  const current = fakes.children[1];
  old.emit('close', 1);
  assert.equal(manager.process, current);
  assert.equal(manager.isRunning, true);
  await manager.shutdown();
});

test('shutdown waits for child close and leaves no child process running', async () => {
  const fakes = fakeSpawner();
  const manager = createBotProcessManager({ spawnProcess: () => fakes.spawn(), shutdownTimeoutMs: 100 });
  await manager.start();
  await manager.shutdown();
  assert.equal(manager.isRunning, false);
  assert.equal(fakes.live, 0);
  assert.equal(await manager.start(), false);
});

test('GUI log helper removes oldest entries and keeps a fixed bound', () => {
  const children = [];
  const area = {
    get childElementCount() { return children.length; },
    get firstElementChild() { return { remove() { children.shift(); } }; },
    appendChild(element) { children.push(element); },
  };
  for (let index = 0; index < 2000; index++) appendBoundedLog(area, { index }, 750);
  assert.equal(children.length, 750);
  assert.equal(children[0].index, 1250);
  assert.equal(children.at(-1).index, 1999);
});
