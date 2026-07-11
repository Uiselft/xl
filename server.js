import http from 'node:http';
import { setupRelay } from './livekit-listener.js';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'relay-agent', ts: Date.now() }));
    return;
  }

  if (req.url === '/' ) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Railway Relay Agent is running. POST /relay to use.\n');
    return;
  }

  // Остальные маршруты (включая /relay) обрабатывает setupRelay
});

// Регистрируем /relay endpoint
setupRelay(server);

server.listen(PORT, () => {
  console.log(`[server] Railway Relay Agent listening on port ${PORT}`);
  console.log(`[server] POST /relay — принимает JSON команды от букмарклета`);
  console.log(`[server] GET  /health — health check для Railway`);
});
