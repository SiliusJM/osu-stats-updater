'use strict';

function createBotProcessManager({ spawnProcess, onLog = () => {}, onStopped = () => {}, onStarted = () => {}, shutdownTimeoutMs = 5000 }) {
  let current = null;
  let transition = Promise.resolve();
  let shuttingDown = false;

  function enqueue(action) {
    const result = transition.then(action, action);
    transition = result.catch(() => {});
    return result;
  }

  function waitForClose(record) {
    if (record.closed) return Promise.resolve();
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (!record.closed) {
          try { record.child.kill('SIGKILL'); } catch {}
        }
        // Do not start a replacement until the operating system reports close.
        // Keep waiting: an unconfirmed shutdown must never permit two bots.
      }, shutdownTimeoutMs);
      record.closeWaiters.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  function launch() {
    if (current || shuttingDown) return false;
    let child;
    try { child = spawnProcess(); }
    catch (error) {
      onLog(`ERROR al iniciar node: ${error.message}\n`);
      onStopped(1);
      return false;
    }

    const record = { child, closed: false, closeWaiters: [] };
    current = record;
    if (child.stdout) child.stdout.on('data', chunk => onLog(chunk.toString()));
    if (child.stderr) child.stderr.on('data', chunk => onLog(chunk.toString()));
    child.on('error', error => {
      onLog(`ERROR al iniciar node: ${error.message}\n`);
      if (current === record) {
        current = null;
        onStopped(1);
      }
      finish(record);
    });
    child.on('close', code => {
      if (current === record) {
        current = null;
        onStopped(code ?? 0);
      }
      finish(record);
    });
    onStarted();
    return true;
  }

  function finish(record) {
    if (record.closed) return;
    record.closed = true;
    for (const resolve of record.closeWaiters.splice(0)) resolve();
  }

  async function stopCurrent() {
    const record = current;
    if (!record) return false;
    try { record.child.kill('SIGTERM'); }
    catch (error) { onLog(`ERROR al detener node: ${error.message}\n`); }
    await waitForClose(record);
    return true;
  }

  return {
    start() {
      return enqueue(() => shuttingDown ? false : launch());
    },
    stop() {
      return enqueue(() => stopCurrent());
    },
    restart() {
      return enqueue(async () => {
        if (shuttingDown || !current) return false;
        await stopCurrent();
        return launch();
      });
    },
    shutdown() {
      shuttingDown = true;
      return enqueue(() => stopCurrent());
    },
    get isRunning() { return current !== null; },
    get process() { return current?.child ?? null; },
  };
}

async function saveConfigAndRestart({ manager, writeConfig, onRestarting = () => {}, onRestarted = () => {} }) {
  try {
    writeConfig();
    if (manager.isRunning) {
      onRestarting();
      if (await manager.restart()) onRestarted();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { createBotProcessManager, saveConfigAndRestart };
