// Railway LiveKit Agent — подключение через чистый WebSocket (без нативных C++ аддонов)
// Флоу: pump.fun → букмарклет → LiveKit WSS → этот сервер → обрабатывает → LiveKit WSS → букмарклет

import WebSocket from 'ws';
import { AccessToken } from 'livekit-server-sdk';

const LK_WS_URL     = 'wss://jack-6u9u95rm.livekit.cloud';
const LK_API_KEY    = 'APIAsfxvEYsPGA2';
const LK_API_SECRET = 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
const ROOM_NAME     = 'bookmark-room';
const IDENTITY      = 'railway-server';

// ─── Токен ────────────────────────────────────────────────────────────────────

async function generateToken(identity) {
  const at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity,
    ttl: 86400 * 7,
  });
  at.addGrant({
    room: ROOM_NAME,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });
  return await at.toJwt();
}

// ─── LiveKit Signal Protocol (protobuf-less, через JSON data messages) ────────
// LiveKit использует protobuf поверх WebSocket. Мы не можем декодировать его
// без @livekit/rtc-node, поэтому используем другой подход:
// Railway запускает HTTP-сервер с эндпоинтом /relay — букмарклет шлёт POST
// запрос туда напрямую (через наш Vercel /api/proxy), Railway обрабатывает
// и отвечает JSON. Никакого нативного кода не нужно.
//
// Схема:
//   bookmark → POST https://railway-host/relay → Railway → ответ JSON → bookmark
//
// Для этого сервер экспортирует не connect(), а setupRelay(app) — регистрирует
// маршруты на уже запущенном http-сервере.

// ─── Обработка запросов от букмарклета ────────────────────────────────────────

async function handleAction(msg) {
  const action = msg.action || 'unknown';
  console.log(`[relay] action=${action}`);

  const response = {
    action: 'response',
    requestAction: action,
    ts: Date.now(),
    from: IDENTITY,
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
    response.message = `unknown action: ${action}`;
  }

  return response;
}

// ─── HTTP relay endpoint ───────────────────────────────────────────────────────
// Регистрирует /relay на существующем http.Server

function setupRelay(server) {
  // Перехватываем request-события сервера
  server.on('request', async (req, res) => {
    // CORS headers для запросов из букмарклета
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url !== '/relay' || req.method !== 'POST') {
      return; // пусть остальные маршруты обрабатывает server.js
    }

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
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      }
    });
  });

  console.log('[relay] /relay endpoint registered');
}

export { setupRelay };
