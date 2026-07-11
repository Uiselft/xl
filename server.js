'use strict';

/**
 * Railway LiveKit Agent Server
 *
 * АРХИТЕКТУРА (правильная):
 *   Букмарклет → publishData() → LiveKit room (WS)
 *                                       ↓
 *   Railway подключается к той же комнате как server-side участник
 *   через @livekit/rtc-node (настоящий WebSocket клиент, не HTTP webhook)
 *                                       ↓
 *   Railway: получает DataReceived → processData() → sendData() обратно в комнату
 *                                       ↓
 *   Букмарклет: RoomEvent.DataReceived → alert()
 *
 * ПОЧЕМУ НЕ ВЕБХУКИ:
 *   LiveKit webhooks НЕ доставляют data_packet_received.
 *   Вебхуки только для: room_started/finished, participant_joined/left,
 *   track_published/unpublished, egress_started/ended.
 *   Единственный способ получать publishData() — быть в комнате через WebSocket.
 */

var http = require('http');
var { RoomServiceClient, DataPacket_Kind, AccessToken } = require('livekit-server-sdk');
var { Room, RoomEvent, DataPacket_Kind: RtcDataKind, RemoteParticipant } = require('@livekit/rtc-node');

var PORT          = process.env.PORT               || 8080;
var LK_API_KEY    = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_WS_URL     = process.env.LIVEKIT_URL        || 'wss://jack-6u9u95rm.livekit.cloud';
var LK_HTTP_URL   = 'https://jack-6u9u95rm.livekit.cloud';
var ROOM_NAME     = 'bookmark-room';
var AGENT_IDENTITY = 'railway-agent';

// ─── RoomServiceClient — отправляет ответ букмарклету ────────────────────────
var roomService = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);

function sendDataToRoom(data) {
  var bytes = Buffer.from(JSON.stringify(data));
  console.log('[sendData] action=' + data.action + ' bytes=' + bytes.length);
  return roomService.sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE)
    .then(function() {
      console.log('[sendData] OK — ответ отправлен букмарклету');
    })
    .catch(function(e) {
      console.error('[sendData] ERROR: ' + e.message);
    });
}

// ─── Обработка входящего сообщения от букмарклета ────────────────────────────
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
      message: 'Railway received via RTC!',
      url: payload.url,
      title: payload.title,
      ts: Date.now()
    });

  } else if (action === 'fetch') {
    var url = payload.url || msg.url || '';
    console.log('[fetch] ' + url);
    fetch(url, {
      headers: Object.assign(
        { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json,*/*' },
        payload.headers || {}
      )
    })
      .then(function(r) {
        return r.text().then(function(t) {
          var d;
          try { d = JSON.parse(t); } catch(e) { d = t.substring(0, 4000); }
          sendDataToRoom({ action: 'fetch_result', ok: true, status: r.status, data: d, ts: Date.now() });
        });
      })
      .catch(function(e) {
        sendDataToRoom({ action: 'fetch_result', ok: false, error: e.message, ts: Date.now() });
      });

  } else {
    console.log('[relay] unknown action: ' + action);
    sendDataToRoom({ action: 'ack', ok: true, message: 'unknown action: ' + action });
  }
}

// ─── LiveKit Agent — подключается к комнате через WebSocket ──────────────────
var agentRoom = null;
var reconnectTimer = null;
var isConnecting = false;

async function connectAgent() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    // Генерируем токен для агента
    var at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
      identity: AGENT_IDENTITY,
      ttl: 86400, // 24 часа
    });
    at.addGrant({
      room: ROOM_NAME,
      roomJoin: true,
      canPublish: false,
      canPublishData: true,
      canSubscribe: true,
    });
    var token = await at.toJwt();

    // Создаём комнату через @livekit/rtc-node
    var room = new Room();
    agentRoom = room;

    room.on(RoomEvent.DataReceived, function(payload, participant, kind, topic) {
      var fromId = (participant && participant.identity) ? participant.identity : 'unknown';
      // Игнорируем данные от самого агента
      if (fromId === AGENT_IDENTITY) return;

      console.log('[agent] DataReceived from=' + fromId + ' bytes=' + payload.byteLength + ' topic=' + topic);
      try {
        var str = Buffer.from(payload).toString('utf8');
        console.log('[agent] data: ' + str.substring(0, 300));
        var msg = JSON.parse(str);
        processData(msg);
      } catch(e) {
        console.error('[agent] parse error: ' + e.message);
      }
    });

    room.on(RoomEvent.ParticipantConnected, function(p) {
      console.log('[agent] Participant joined: ' + p.identity);
    });

    room.on(RoomEvent.ParticipantDisconnected, function(p) {
      console.log('[agent] Participant left: ' + p.identity);
    });

    room.on(RoomEvent.Disconnected, function(reason) {
      console.log('[agent] Disconnected from room, reason=' + reason + '. Reconnect in 5s...');
      agentRoom = null;
      isConnecting = false;
      reconnectTimer = setTimeout(connectAgent, 5000);
    });

    room.on(RoomEvent.ConnectionStateChanged, function(state) {
      console.log('[agent] ConnectionState: ' + state);
    });

    console.log('[agent] Connecting to room: ' + ROOM_NAME + ' at ' + LK_WS_URL);
    await room.connect(LK_WS_URL, token, {
      autoSubscribe: true,
    });
    console.log('[agent] Connected! Waiting for data from bookmarklets...');
    isConnecting = false;

  } catch(e) {
    console.error('[agent] Connection failed: ' + e.message);
    isConnecting = false;
    reconnectTimer = setTimeout(connectAgent, 5000);
  }
}

// ─── HTTP server (health check + ручной relay для отладки) ────────────────────
var server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET / — health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'railway-livekit-rtc-agent',
      room: ROOM_NAME,
      agentConnected: agentRoom !== null,
      ts: Date.now()
    }));
    return;
  }

  // POST /relay — прямой HTTP relay (fallback, если LiveKit недоступен)
  if (req.method === 'POST' && req.url === '/relay') {
    var body = '';
    req.on('data', function(chunk) { body += chunk.toString(); });
    req.on('end', function() {
      try {
        var msg = JSON.parse(body);
        console.log('[relay-http] action=' + (msg.action || '?'));
        processData(msg);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Received via HTTP relay' }));
      } catch(e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /webhook — ОСТАВЛЕН для совместимости, но теперь только логирует
  if (req.method === 'POST' && req.url === '/webhook') {
    var body2 = '';
    req.on('data', function(chunk) { body2 += chunk.toString(); });
    req.on('end', function() {
      console.log('[webhook] received (NOTE: data_packet_received не существует в LK webhooks!): ' + body2.substring(0, 200));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, note: 'webhooks do not carry data packets — use RTC agent' }));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, function() {
  console.log('[server] Railway LiveKit RTC Agent on port ' + PORT);
  console.log('[server] NOTE: Using @livekit/rtc-node (WebSocket) — NOT webhooks');
  console.log('[server] LiveKit webhooks cannot deliver publishData() events!');
  // Подключаемся к комнате сразу при старте
  connectAgent();
});
