'use strict';

var http = require('http');
var crypto = require('crypto');
var { RoomServiceClient, WebhookReceiver, DataPacket_Kind, AccessToken } = require('livekit-server-sdk');

var PORT          = process.env.PORT               || 8080;
var LK_API_KEY    = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_HTTP_URL   = 'https://jack-6u9u95rm.livekit.cloud';
var ROOM_NAME     = 'bookmark-room';

// ─── RoomServiceClient — отправляет ответ букмарклету ────────────────────────
var roomService = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);

function sendDataToRoom(data) {
  var bytes = Buffer.from(JSON.stringify(data));
  console.log('[sendData] action=' + data.action + ' bytes=' + bytes.length);
  return roomService.sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE)
    .then(function() {
      console.log('[sendData] OK');
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
      message: 'Railway received!',
      url: payload.url,
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
          var d; try { d = JSON.parse(t); } catch(e) { d = t.substring(0, 4000); }
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

// ─── WebhookReceiver — получает события от LiveKit (dataPacketReceived) ───────
var webhookReceiver = new WebhookReceiver(LK_API_KEY, LK_API_SECRET);

// ─── HTTP server ──────────────────────────────────────────────────────────────
var server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Webhook-Id,Webhook-Timestamp,Webhook-Signature');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /webhook — LiveKit webhook events
  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(chunk) { body += chunk.toString(); });
    req.on('end', function() {
      console.log('[webhook] received ' + body.length + ' bytes');
      try {
        var authHeader = req.headers['authorization'] || '';
        var event = webhookReceiver.receive(body, authHeader);
        console.log('[webhook] event=' + event.event);

        if (event.event === 'data_packet_received' && event.dataPacket && event.dataPacket.value) {
          var value = event.dataPacket.value;
          // value.case === 'user' => value.value.payload is Uint8Array
          if (value.case === 'user') {
            var payloadBytes = value.value.payload;
            var str = Buffer.from(payloadBytes).toString('utf8');
            console.log('[webhook] data: ' + str.substring(0, 200));
            try {
              var msg = JSON.parse(str);
              processData(msg);
            } catch(e) {
              console.error('[webhook] parse error: ' + e.message);
            }
          }
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('[webhook] error: ' + e.message);
        // Если верификация подписи не прошла — попробуем без неё (dev режим)
        try {
          var parsed = JSON.parse(body);
          console.log('[webhook] fallback parse event=' + parsed.event);
          if (parsed.event === 'data_packet_received' && parsed.dataPacket) {
            var dp = parsed.dataPacket;
            if (dp.user && dp.user.payload) {
              var rawBytes = Buffer.from(dp.user.payload, 'base64');
              var str2 = rawBytes.toString('utf8');
              console.log('[webhook] fallback data: ' + str2.substring(0, 200));
              try { processData(JSON.parse(str2)); } catch(e2) {}
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e2) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      }
    });
    return;
  }

  // GET / — health check
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    service: 'railway-livekit-webhook-receiver',
    ts: Date.now()
  }));
});

server.listen(PORT, function() {
  console.log('[server] Railway LiveKit webhook receiver on port ' + PORT);
  console.log('[server] Configure LiveKit webhook URL to: https://xl-production.up.railway.app/webhook');
});
