var http = require('http');
var crypto = require('crypto');
var WebSocket = require('ws');

var PORT        = process.env.PORT        || 8080;
var LK_API_KEY  = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_WS_URL   = 'wss://jack-6u9u95rm.livekit.cloud';
var LK_HTTP_URL = 'https://jack-6u9u95rm.livekit.cloud';
var ROOM_NAME   = 'bookmark-room';
var IDENTITY    = 'railway-server';

// ─── JWT (HS256, no deps) ────────────────────────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function makeToken(extra) {
  var h = b64url(Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})));
  var p = b64url(Buffer.from(JSON.stringify(Object.assign({
    iss: LK_API_KEY,
    sub: IDENTITY,
    jti: IDENTITY + '-' + Date.now(),
    exp: Math.floor(Date.now()/1000) + 86400
  }, extra))));
  var s = b64url(crypto.createHmac('sha256', LK_API_SECRET).update(h+'.'+p).digest());
  return h+'.'+p+'.'+s;
}

// ─── Send data via LiveKit HTTP API (SendData) ───────────────────────────────
function sendDataToRoom(data) {
  var jwt = makeToken({video:{roomAdmin:true,roomCreate:true,room:ROOM_NAME}});
  return fetch(LK_HTTP_URL + '/twirp/livekit.RoomService/SendData', {
    method: 'POST',
    headers: {'Authorization':'Bearer '+jwt,'Content-Type':'application/json'},
    body: JSON.stringify({
      room: ROOM_NAME,
      data: Buffer.from(JSON.stringify(data)).toString('base64'),
      kind: 1
    })
  }).then(function(r){
    return r.text().then(function(t){ console.log('[sendData] '+r.status+' '+t.substring(0,100)); });
  }).catch(function(e){ console.error('[sendData] error: '+e.message); });
}

// ─── Process message from bookmarklet ───────────────────────────────────────
function processData(msg) {
  var action  = msg.action  || 'unknown';
  var payload = msg.payload || {};
  console.log('[relay] action='+action+' url='+(payload.url||'?'));

  if (action === 'data') {
    console.log('[data] URL:    ' + payload.url);
    console.log('[data] Title:  ' + payload.title);
    console.log('[data] Cookie: ' + (payload.cookie||'').substring(0,120));
    if (payload.localStorage) console.log('[data] LS: '+payload.localStorage.substring(0,200));
    sendDataToRoom({action:'ack',ok:true,message:'Railway received!',url:payload.url,ts:Date.now()});

  } else if (action === 'fetch') {
    var url = payload.url || msg.url || '';
    console.log('[fetch] '+url);
    fetch(url, {headers:Object.assign({'User-Agent':'Mozilla/5.0','Accept':'application/json,*/*'},payload.headers||{})})
      .then(function(r){ return r.text().then(function(t){
        var d; try{d=JSON.parse(t);}catch(e){d=t.substring(0,4000);}
        sendDataToRoom({action:'fetch_result',ok:true,status:r.status,data:d,ts:Date.now()});
      });})
      .catch(function(e){ sendDataToRoom({action:'fetch_result',ok:false,error:e.message,ts:Date.now()}); });

  } else {
    console.log('[relay] unknown action: '+action);
  }
}

// ─── LiveKit Signal WebSocket connection ─────────────────────────────────────
// LiveKit Signal Protocol: JSON messages over WebSocket at /rtc?...
// DataPacket arrives as a JSON message with type "data_packet" or binary protobuf.
// We use the JSON/text frames approach via the "json" subprotocol hint.
//
// In practice LiveKit sends binary protobuf frames. We detect DataPacket by
// scanning the raw binary for our magic prefix (action field in JSON payload).
// Simpler: we connect and try to parse every binary frame as protobuf-lite.
//
// Easiest reliable approach: use the LiveKit server SDK HTTP polling via
// /twirp/livekit.RoomService/ListParticipants and react to events.
// BUT: that doesn't give us real-time data packets.
//
// REAL SOLUTION: Railway joins as a WebSocket participant and reads raw binary.
// LiveKit binary frames contain: SignalResponse { data_packet: DataPacket { data: bytes } }
// We don't have protobuf — but we can extract the UTF-8 JSON payload by scanning
// for the JSON start byte '{' after the protobuf field headers.

var lkWs = null;
var reconnectTimer = null;

function connectToLiveKit() {
  if (lkWs && (lkWs.readyState === WebSocket.OPEN || lkWs.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);

  var token = makeToken({video:{
    room: ROOM_NAME,
    roomJoin: true,
    canPublish: false,
    canPublishData: false,
    canSubscribe: true,
    hidden: true
  }});

  var wsUrl = LK_WS_URL + '/rtc?protocol=15&sdk=js&version=1.15.0&access_token=' + token;
  console.log('[lk] connecting to LiveKit...');

  var ws = new WebSocket(wsUrl);
  ws.binaryType = 'nodebuffer';
  lkWs = ws;

  ws.on('open', function() {
    console.log('[lk] connected to LiveKit room: '+ROOM_NAME);
  });

  ws.on('message', function(data) {
    // Try text first
    if (typeof data === 'string') {
      try {
        var msg = JSON.parse(data);
        if (msg.dataPacket || msg.data_packet) {
          var dp = msg.dataPacket || msg.data_packet;
          var raw = dp.data || (dp.user && dp.user.payload);
          if (raw) {
            var decoded = Buffer.from(raw, 'base64').toString('utf8');
            var parsed = JSON.parse(decoded);
            processData(parsed);
          }
        }
      } catch(e) { /* not JSON or not data packet */ }
      return;
    }

    // Binary: protobuf SignalResponse
    // Scan the buffer for JSON payload — look for '{' byte (0x7B)
    // This is a pragmatic approach when we don't have protobuf library
    try {
      var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      var str = buf.toString('binary');
      // Find all occurrences of '{' and try to parse JSON from there
      for (var i = 0; i < buf.length; i++) {
        if (buf[i] === 0x7B) { // '{'
          var slice = buf.slice(i).toString('utf8');
          // Find matching closing brace
          var depth = 0;
          for (var j = 0; j < slice.length; j++) {
            if (slice[j] === '{') depth++;
            else if (slice[j] === '}') { depth--; if (depth === 0) { slice = slice.substring(0, j+1); break; } }
          }
          try {
            var parsed = JSON.parse(slice);
            if (parsed.action) { processData(parsed); return; }
          } catch(e2) { /* keep scanning */ }
        }
      }
    } catch(e) { /* ignore */ }
  });

  ws.on('close', function(code, reason) {
    console.log('[lk] disconnected: '+code+' '+reason+' — reconnecting in 5s');
    lkWs = null;
    reconnectTimer = setTimeout(connectToLiveKit, 5000);
  });

  ws.on('error', function(e) {
    console.error('[lk] ws error: '+e.message);
    ws.terminate();
  });
}

// ─── HTTP server ────────────────────────────────────────────────────────────
var server = http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /webhook — получить данные от букмарклета и отправить ответ напрямую
  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(chunk) { body += chunk.toString(); });
    req.on('end', function() {
      try {
        var msg = JSON.parse(body);
        console.log('[webhook] received from bookmarklet');
        processData(msg);
        
        // СРАЗУ отправляем ответ букмарклету (не через LiveKit)
        var responseData = msg.payload || {};
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify({
          ok: true,
          message: 'Railway webhook received',
          received: {
            url: responseData.url,
            title: responseData.title
          },
          ts: Date.now()
        }));
      } catch(e) {
        console.error('[webhook] parse error: '+e.message);
        res.writeHead(400, {'content-type':'application/json'});
        res.end(JSON.stringify({ok:false,error:e.message}));
      }
    });
    return;
  }

  // GET / — health check
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({
    ok: true,
    service: 'railway-livekit-receiver',
    lk: lkWs ? lkWs.readyState : -1,
    ts: Date.now()
  }));
});

server.listen(PORT, function() {
  console.log('[server] Railway LiveKit receiver on port '+PORT);
  connectToLiveKit();
});

