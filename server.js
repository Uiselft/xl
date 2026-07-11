'use strict';

/**
 * Railway LiveKit Agent Server v3
 *
 * СТЕК: livekit-client (pure JS) + ws полифил — БЕЗ нативных deps
 * Убран @livekit/rtc-node (Rust bindings, ломался на Railway при install)
 *
 * АРХИТЕКТУРА:
 *   Букмарклет → publishData() → wss://*.livekit.cloud
 *                                        ↓
 *   Railway подключается к той же комнате через livekit-client + ws
 *   RoomEvent.DataReceived → processData() → roomService.sendData()
 *                                        ↓
 *   Букмарклет → RoomEvent.DataReceived → alert()
 *
 * ПОЧЕМУ НЕ ВЕБХУКИ:
 *   LiveKit webhooks не доставляют publishData().
 *   data_packet_received не существует в LiveKit webhook API.
 */

// ─── WebSocket полифил — нужен livekit-client в Node.js ──────────────────────
var WebSocket = require('ws');
global.WebSocket = WebSocket;

// livekit-client v2 использует UMD build через require()
var LC = require('livekit-client');

var http    = require('http');
var { RoomServiceClient, DataPacket_Kind, AccessToken } = require('livekit-server-sdk');

var PORT           = process.env.PORT                || 8080;
var LK_API_KEY     = process.env.LIVEKIT_API_KEY     || 'APIAsfxvEYsPGA2';
var LK_API_SECRET  = process.env.LIVEKIT_API_SECRET  || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_WS_URL      = process.env.LIVEKIT_URL         || 'wss://jack-6u9u95rm.livekit.cloud';
var LK_HTTP_URL    = LK_WS_URL.replace(/^wss?:\/\//, 'https://');
var ROOM_NAME      = 'bookmark-room';
var AGENT_IDENTITY = 'railway-agent-' + Date.now();

// ─── RoomServiceClient — отправляет ответ обратно в комнату ──────────────────
var roomService = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);

function sendDataToRoom(data) {
  var bytes = new TextEncoder().encode(JSON.stringify(data));
  console.log('[sendData] action=' + data.action + ' bytes=' + bytes.length);
  return roomService
    .sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE)
    .then(function () {
      console.log('[sendData] OK — ответ отправлен букмарклету');
    })
    .catch(function (e) {
      console.error('[sendData] ERROR: ' + e.message);
    });
}

// ─── Обработка сообщения от букмарклета ─────────────────────────────────────
function processData(msg) {
  var action  = msg.action  || 'unknown';
  var payload = msg.payload || {};
  console.log('[relay] action=' + action + ' url=' + (payload.url || '?'));

  if (action === 'data') {
    console.log('[data] URL:    ' + payload.url);
    console.log('[data] Title:  ' + payload.title);
    console.log('[data] Cookie: ' + (payload.cookie || '').substring(0, 120));
    sendDataToRoom({
      action: 'ack',
      ok: true,
      message: 'Railway received! (livekit-client agent)',
      url: payload.url,
      title: payload.title,
      ts: Date.now(),
    });

  } else if (action === 'fetch') {
    var url = payload.url || msg.url || '';
    console.log('[fetch] ' + url);
    fetch(url, {
      headers: Object.assign(
        { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,*/*' },
        payload.headers || {}
      ),
    })
      .then(function (r) {
        return r.text().then(function (t) {
          var d;
          try { d = JSON.parse(t); } catch (e) { d = t.substring(0, 4000); }
          sendDataToRoom({ action: 'fetch_result', ok: true, status: r.status, data: d, ts: Date.now() });
        });
      })
      .catch(function (e) {
        sendDataToRoom({ action: 'fetch_result', ok: false, error: e.message, ts: Date.now() });
      });

  } else {
    console.log('[relay] unknown action: ' + action);
    sendDataToRoom({ action: 'ack', ok: true, message: 'unknown action: ' + action });
  }
}

// ─── LiveKit Agent — подключается к комнате через livekit-client ─────────────
var agentRoom     = null;
var isConnecting  = false;
var reconnectTimer = null;

async function connectAgent() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    // Генерируем JWT токен для агента
    var at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
      identity: AGENT_IDENTITY,
      ttl: '24h',
    });
    at.addGrant({
      room: ROOM_NAME,
      roomJoin: true,
      canPublish: false,
      canPublishData: true,
      canSubscribe: true,
    });
    var token = await at.toJwt();

    // Создаём Room через livekit-client (pure JS)
    var room = new LC.Room({
      adaptiveStream: false,
      dynacast: false,
      stopLocalTrackOnUnpublish: false,
    });
    agentRoom = room;

    // Слушаем входящие данные
    room.on(LC.RoomEvent.DataReceived, function (rawData, participant, kind, topic) {
      var fromId = (participant && participant.identity) ? participant.identity : 'server';

      // Игнорируем данные от самого агента
      if (fromId === AGENT_IDENTITY || fromId.startsWith('railway-agent-')) return;

      console.log('[agent] DataReceived from=' + fromId + ' bytes=' + rawData.byteLength + ' topic=' + (topic || '-'));

      try {
        var str = new TextDecoder().decode(rawData);
        console.log('[agent] raw: ' + str.substring(0, 300));
        var msg = JSON.parse(str);
        processData(msg);
      } catch (e) {
        console.error('[agent] parse error: ' + e.message);
        sendDataToRoom({ action: 'error', error: 'parse error: ' + e.message });
      }
    });

    room.on(LC.RoomEvent.ParticipantConnected, function (p) {
      console.log('[agent] Participant joined: ' + p.identity);
    });

    room.on(LC.RoomEvent.ParticipantDisconnected, function (p) {
      console.log('[agent] Participant left: ' + p.identity);
    });

    room.on(LC.RoomEvent.Disconnected, function (reason) {
      console.log('[agent] Disconnected, reason=' + reason + '. Reconnect in 5s...');
      agentRoom   = null;
      isConnecting = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectAgent, 5000);
    });

    room.on(LC.RoomEvent.ConnectionStateChanged, function (state) {
      console.log('[agent] ConnectionState: ' + state);
    });

    room.on(LC.RoomEvent.ConnectionQualityChanged, function (quality, participant) {
      // тихо — слишком шумный ивент
    });

    console.log('[agent] Connecting to: ' + LK_WS_URL + ' room=' + ROOM_NAME);
    await room.connect(LK_WS_URL, token, { autoSubscribe: true });

    console.log('[agent] ✓ Connected! Waiting for data from bookmarklets...');
    isConnecting = false;

  } catch (e) {
    console.error('[agent] Connection failed: ' + e.message);
    isConnecting = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectAgent, 5000);
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
var server = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET / — health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'railway-livekit-agent-v3',
      room: ROOM_NAME,
      agentIdentity: AGENT_IDENTITY,
      agentConnected: agentRoom !== null && agentRoom.state === LC.ConnectionState.Connected,
      roomState: agentRoom ? agentRoom.state : 'disconnected',
      ts: Date.now(),
    }));
    return;
  }

  // POST /relay — прямой HTTP relay (отладка / fallback)
  if (req.method === 'POST' && req.url === '/relay') {
    var body = '';
    req.on('data', function (chunk) { body += chunk.toString(); });
    req.on('end', function () {
      try {
        var msg = JSON.parse(body);
        console.log('[relay-http] action=' + (msg.action || '?'));
        processData(msg);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'received via HTTP relay' }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /webhook — оставлен для совместимости, только логирует
  if (req.method === 'POST' && req.url === '/webhook') {
    var body2 = '';
    req.on('data', function (chunk) { body2 += chunk.toString(); });
    req.on('end', function () {
      try {
        var parsed = JSON.parse(body2);
        console.log('[webhook] event=' + (parsed.event || '?') + ' (data_packet_received не существует в LK webhooks)');
      } catch (e) {
        console.log('[webhook] raw: ' + body2.substring(0, 100));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, note: 'webhooks не доставляют publishData — используем RTC agent' }));
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, function () {
  console.log('');
  console.log('[server] Railway LiveKit Agent v3 started on port ' + PORT);
  console.log('[server] Stack: livekit-client (pure JS) + ws polyfill');
  console.log('[server] No native deps — @livekit/rtc-node removed');
  console.log('[server] Room: ' + ROOM_NAME + ' at ' + LK_WS_URL);
  console.log('');
  connectAgent();
});
