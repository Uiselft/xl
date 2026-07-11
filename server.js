import http from 'node:http';
import { connect } from './livekit-listener.js';

const PORT = process.env.PORT || 8080;

// Простой HTTP сервер для Railway health check
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'livekit-agent' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('LiveKit Agent is running.\n');
});

server.listen(PORT, () => {
  console.log(`[server] HTTP health check on port ${PORT}`);
  // Запускаем LiveKit агент
  connect();
});
