import http from 'node:http';

const PORT = process.env.PORT || 8080;

// ─── CORS helper ──────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── Обработчик команд от букмарклета ─────────────────────────────────────────
async function handleAction(msg) {
  const action = msg.action || 'unknown';
  console.log(`[relay] action=${action}`);

  const response = {
    action: 'response',
    requestAction: action,
    ts: Date.now(),
    from: 'railway-relay',
  };

  if (action === 'ping') {
    response.ok = true;
    response.message = 'pong from Railway';

  } else if (action === 'fetch') {
    const targetUrl = msg.url;
    console.log(`[relay] fetching: ${targetUrl}`);
    try {
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
          ...(msg.headers || {}),
        },
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.substring(0, 5000); }
      response.ok = true;
      response.status = res.status;
      response.data = data;
      console.log(`[relay] fetch ok: ${res.status}`);
    } catch (err) {
      response.ok = false;
      response.error = err.message;
      console.error(`[relay] fetch failed: ${err.message}`);
    }

  } else if (action === 'data') {
    const payload = msg.payload || {};
    console.log(`[relay] page data: url=${payload.url} title=${payload.title}`);
    response.ok = true;
    response.message = 'received';
    response.echo = { url: payload.url, title: payload.title };

  } else {
    response.ok = false;
    response.message = unknown action: ${action};
  }

  return response;
}

// ─── HTTP сервер ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'railway-relay', ts: Date.now() }));
    return;
  }

  if (req.url === '/relay' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body);
        const result = await handleAction(msg);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[relay] parse error:', err.message);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON: ' + err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found', url: req.url }));
});

server.listen(PORT, () => {
  console.log(`[server] Railway Relay Agent listening on port ${PORT}`);
  console.log(`[server] POST /relay — принимает JSON команды от букмарклета`);
  console.log(`[server] GET  /health — health check`);
});
