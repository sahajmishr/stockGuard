const http = require('node:http');

const state = {
  mode: 'ok',
  received: [],
  handler: null,
};

function reset() {
  state.mode = 'ok';
  state.received = [];
  state.handler = null;
}

function received() {
  return state.received;
}

function setMode(mode) {
  state.mode = mode;
}

function setHandler(fn) {
  state.handler = fn;
}

async function start(port = 4517) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      state.received.push(body);
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      try {
        const status = await (state.handler ? state.handler(body, state) : (state.mode === 'ok' ? 200 : 500));
        send(status, { ok: status < 300 });
      } catch (err) {
        send(500, { error: err.message });
      }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

module.exports = { start, reset, received, setMode, setHandler };
