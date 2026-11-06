const http = require('node:http');

const upstreams = (process.env.API_UPSTREAMS ?? 'http://127.0.0.1:8001,http://127.0.0.1:8002')
  .split(',')
  .map((raw) => raw.trim())
  .filter(Boolean)
  .map((url) => ({ url: new URL(url), healthy: true, served: 0, failures: 0 }));

const port = Number(process.env.PROXY_PORT ?? 8080);
const checkIntervalMs = Number(process.env.PROXY_CHECK_INTERVAL_MS ?? 5000);
const failureThreshold = Number(process.env.PROXY_FAILURE_THRESHOLD ?? 2);

let cursor = 0;

function pick() {
  const healthy = upstreams.filter((u) => u.healthy);
  const pool = healthy.length > 0 ? healthy : upstreams;
  const chosen = pool[cursor % pool.length];
  cursor += 1;
  return chosen;
}

async function probe() {
  await Promise.all(
    upstreams.map(async (upstream) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(new URL('/ready', upstream.url), { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          upstream.healthy = true;
          upstream.failures = 0;
        } else {
          upstream.failures += 1;
          if (upstream.failures >= failureThreshold) upstream.healthy = false;
        }
      } catch {
        upstream.failures += 1;
        if (upstream.failures >= failureThreshold) upstream.healthy = false;
      }
    }),
  );
}

const server = http.createServer((req, res) => {
  if (req.url === '/proxy/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        upstreams: upstreams.map((u) => ({ url: u.url.origin, healthy: u.healthy, served: u.served })),
      }),
    );
    return;
  }

  const upstream = pick();
  const target = new URL(req.url, upstream.url);

  const forwarded = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (upstreamRes) => {
      upstream.served += 1;
      if (upstreamRes.statusCode >= 500) upstream.failures += 1;
      res.writeHead(upstreamRes.statusCode, {
        ...upstreamRes.headers,
        'x-upstream': upstream.url.origin,
      });
      upstreamRes.pipe(res);
    },
  );

  forwarded.setTimeout(15000, () => {
    forwarded.destroy(new Error('upstream timeout'));
  });

  forwarded.on('error', (err) => {
    upstream.failures += 1;
    if (upstream.failures >= failureThreshold) upstream.healthy = false;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'BAD_GATEWAY', message: 'no healthy upstream', detail: err.message }));
  });

  req.pipe(forwarded);
});

const timer = setInterval(probe, checkIntervalMs);
probe();

server.listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'proxy listening',
      port,
      upstreams: upstreams.map((u) => u.url.origin),
    }),
  );
});

function shutdown() {
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
