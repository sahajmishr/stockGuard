const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

function waitForReady(url, timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timed out waiting for ${url}`));
      return setTimeout(tick, 120);
    };
    tick();
  });
}

async function start({ script, port, env: extraEnv = {}, readyPath = '/ready' }) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => {
    output += d.toString();
  });
  child.stderr.on('data', (d) => {
    output += d.toString();
  });

  try {
    await waitForReady(`http://127.0.0.1:${port}${readyPath}`);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${err.message}\nchild output:\n${output}`);
  }

  return {
    child,
    port,
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill('SIGKILL');
      }),
  };
}

async function runToCompletion({ script, env: extraEnv = {}, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`script ${script} timed out`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

module.exports = { start, runToCompletion, waitForReady };
