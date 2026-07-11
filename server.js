'use strict';

/**
 * Railway LiveKit Agent v4 — PURE WebSocket, NO WebRTC
 *
 * АРХИТЕКТУРА:
 *   Букмарклет → publishData({reliable:true}) → wss://*.livekit.cloud
 *                                                      ↓
 *   Railway подключается к той же комнате через ЧИСТЫЙ WebSocket
 *   (LiveKit Signaling Protocol, @livekit/protocol protobuf-es)
 *   SignalResponse.fromBinary() → DataPacket → processData()
 *   Ответ: roomService.sendData() → REST API → букмарклет
 *
 * ПОЧЕМУ НЕ WEBRTC:
 *   Нет @roamhq/wrtc нативных deps, нет NO_SOCKET, нет navigator is not defined.
 *   Только ws + protobuf-es.
 */

var http  = require('http');
var WS    = require('ws');
var proto = require('@livekit/protocol');
var { AccessToken, RoomServiceClient, DataPacket_Kind } = require('livekit-server-sdk');

var PORT           = process.env.PORT               || 8080;
var LK_API_KEY     = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET  = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_WS_URL      = process.env.LIVEKIT_URL        || 'wss://jack-6u9u95rm.livekit.cloud';
var LK_HTTP_URL    = LK_WS_URL.replace(/^wss?:\/\//, 'https://');
var ROOM_NAME      = 'bookmark-room';
var AGENT_IDENTITY = 'railway-agent';

// ─── RoomServiceClient — отправляет ответ обратно через REST API ──────────────
var roomService = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);

function sendDataToRoom(data, toIdentities) {
  var bytes = new TextEncoder().encode(JSON.stringify(data));
  var opts  = { destinationIdentities: toIdentities || [] };
  return roomService
    .sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE, opts)
    .then(function () { console.log('[sendData] OK  action=' + data.action); })
    .catch(function (e) { console.error('[sendData] ERR ' + e.message); });
}

// ─── Обработка данных от букмарклета ────────────────────────────────────────
function processData(msg, fromIdentity) {
  var action  = msg.action  || 'unknown';
  var payload = msg.payload || {};
  console.log('[relay] from=' + fromIdentity + ' action=' + action);

  if (action === 'data') {
    console.log('[data] url='   + payload.url);
    console.log('[data] title=' + payload.title);
    sendDataToRoom({
      action: 'ack', ok: true,
      message: 'Railway получил данные!',
      url: payload.url, title: payload.title, ts: Date.now(),
    }, [fromIdentity]);

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
          var d; try { d = JSON.parse(t); } catch (e) { d = t.substring(0, 4000); }
          sendDataToRoom({ action: 'fetch_result', ok: true, status: r.status, data: d, ts: Date.now() }, [fromIdentity]);
        });
      })
      .catch(function (e) {
        sendDataToRoom({ action: 'fetch_result', ok: false, error: e.message, ts: Date.now() }, [fromIdentity]);
      });

  } else {
    sendDataToRoom({ action: 'ack', ok: true, echo: action }, [fromIdentity]);
  }
}

// ─── Парсим DataPacket из бинарного буфера (protobuf-es fromBinary) ─────────
function tryParseDataPacket(buf) {
  try {
    var sig = proto.SignalResponse.fromBinary(buf);
    // DataPacket приходит как sig.dataChannelMessage или напрямую
    if (sig.message && sig.message.case === 'dataChannelMessage') {
      return sig.message.value;
    }
    // Попробуем напрямую как DataPacket
    var dp = proto.DataPacket.fromBinary(buf);
    return dp;
  } catch (e) {
    return null;
  }
}

// ─── LiveKit Signaling WebSocket Client ──────────────────────────────────────
var signalWs       = null;
var pingInterval   = null;
var reconnectTimer = null;
var agentConnected = false;

async function connectSignal() {
  if (signalWs) return;

  var at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity: AGENT_IDENTITY,
    ttl: '24h',
  });
  at.addGrant({
    room: ROOM_NAME, roomJoin: true,
    canPublish: false, canPublishData: true, canSubscribe: true,
  });
  var token = await at.toJwt();

  // protocol=15, adaptive_stream=1 — нужно для DataPacket через signal WS
  var url = LK_WS_URL + '/rtc'
    + '?access_token=' + token
    + '&protocol=15'
    + '&sdk=js'
    + '&version=2.0.0'
    + '&os=linux'
    + '&auto_subscribe=1'
    + '&adaptive_stream=1';

  console.log('[signal] Connecting: ' + LK_WS_URL + ' room=' + ROOM_NAME);

  var ws = new WS(url);
  signalWs = ws;

  ws.on('open', function () {
    console.log('[signal] WS open');
  });

  ws.on('message', function (rawData, isBinary) {
    // LiveKit v1.x шлёт бинарные фреймы protobuf-es
    try {
      var buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

      if (!isBinary) {
        // Текстовый фрейм — LiveKit иногда шлёт base64 или строки
        var str = buf.toString('utf8');
        // Попробуем всё равно как protobuf (часто это бинарные данные в text frame)
        try {
          buf = Buffer.from(str, 'binary');
        } catch (_) { return; }
      }

      var sig = proto.SignalResponse.fromBinary(new Uint8Array(buf));
      var msgCase = sig.message && sig.message.case;

      // Debug: логируем все входящие типы кроме шума
      if (msgCase && msgCase !== 'pong' && msgCase !== 'speakersChanged' && msgCase !== 'roomUpdate') {
        console.log('[signal] msg.case=' + msgCase);
      }

      if (msgCase === 'join') {
        agentConnected = true;
        var join = sig.message.value;
        console.log('[signal] Joined room! server=' + (join.serverVersion || '?'));
        console.log('[agent] Connected! Waiting for data from bookmarklets...');

        // Пинг каждые 10 сек
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(function () {
          if (ws.readyState !== WS.OPEN) return;
          try {
            // Минимальный Ping: поле 1 (timestamp) = varint 0
            // Protobuf: field_number=1 wire_type=0 -> tag=0x08, value=0x00
            ws.send(Buffer.from([0x08, 0x00]));
          } catch (e) { /* тихо */ }
        }, 10000);
      }

      // publishData({reliable:true}) приходит как userPacket в SignalResponse
      if (msgCase === 'userPacket') {
        var up = sig.message.value;
        // up это DataPacket — содержит .user (UserPacket) и .participantIdentity
        var fromId   = up.participantIdentity || up.participantSid || 'unknown';
        var userPkt  = up.value && up.value.case === 'user' ? up.value.value : up.user;
        var raw      = userPkt && (userPkt.payload || userPkt.data);
        if (!raw) {
          console.log('[data] userPacket без payload, keys=' + Object.keys(up).join(','));
          return;
        }
        if (fromId === AGENT_IDENTITY) return;

        var text = Buffer.from(raw).toString('utf8');
        console.log('[data] userPacket from=' + fromId + ' len=' + text.length);
        try { processData(JSON.parse(text), fromId); }
        catch (e) { console.error('[data] parse: ' + e.message); }
      }

      // dataChannelMessage — старый путь (lossy через сигнальный WS)
      if (msgCase === 'dataChannelMessage') {
        var dc  = sig.message.value;
        var raw2 = dc.payload || dc.data;
        if (!raw2) return;
        var fromId2 = dc.participantSid || dc.participantIdentity || 'unknown';
        if (fromId2 === AGENT_IDENTITY) return;

        var text2 = Buffer.from(raw2).toString('utf8');
        console.log('[data] dataChannel from=' + fromId2 + ' len=' + text2.length);
        try { processData(JSON.parse(text2), fromId2); }
        catch (e) { console.error('[data] parse: ' + e.message); }
      }

    } catch (e) {
      // Тихо игнорируем фреймы которые не парсятся (ICE candidates и т.д.)
    }
  });

  ws.on('close', function (code, reason) {
    console.log('[signal] Closed ' + code + '. Reconnect in 5s...');
    agentConnected = false;
    signalWs = null;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSignal, 5000);
  });

  ws.on('error', function (e) {
    console.error('[signal] Error: ' + e.message);
    agentConnected = false;
    signalWs = null;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    try { ws.terminate(); } catch (_) {}
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSignal, 5000);
  });
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
var server = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, service: 'railway-livekit-agent-v4-pure-ws',
      room: ROOM_NAME, agentConnected: agentConnected,
      wsState: signalWs ? signalWs.readyState : -1,
      ts: Date.now(),
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/relay') {
    var body = '';
    req.on('data', function (c) { body += c.toString(); });
    req.on('end', function () {
      try {
        processData(JSON.parse(body), 'http-relay');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    var b2 = '';
    req.on('data', function (c) { b2 += c.toString(); });
    req.on('end', function () {
      try { var p2 = JSON.parse(b2); console.log('[webhook] event=' + (p2.event || '?')); } catch (_) {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, function () {
  console.log('');
  console.log('[server] Railway LiveKit Agent v4 — Pure WebSocket + protobuf-es');
  console.log('[server] NO WebRTC  |  NO native deps  |  ws + @livekit/protocol');
  console.log('[server] Room: ' + ROOM_NAME + ' @ ' + LK_WS_URL);
  console.log('');
  connectSignal();
});
