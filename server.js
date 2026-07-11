'use strict';

const http = require('http');
const WS = require('ws');
const proto = require('@livekit/protocol');
const { AccessToken, RoomServiceClient, DataPacket_Kind } = require('livekit-server-sdk');

const PORT = process.env.PORT || 8080;

// === ЗАХАРДКОЖЕННЫЕ КЛЮЧИ ===
const LK_API_KEY = 'APIAsfxvEYsPGA2';
const LK_API_SECRET = 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
const LK_URL = 'wss://jack-6u9u95rm.livekit.cloud';
const ROOM_NAME = 'bookmark-room';
const AGENT_IDENTITY = 'railway-agent';
// ============================

const roomService = new RoomServiceClient(LK_URL.replace('wss://', 'https://'), LK_API_KEY, LK_API_SECRET);

let signalWs = null;
let isConnected = false;

// Отправка ответа
async function sendResponse(toIdentity, data) {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    await roomService.sendData(
      ROOM_NAME,
      bytes,
      DataPacket_Kind.RELIABLE,
      { destinationIdentities: toIdentity ? [toIdentity] : [] }
    );
    console.log(`[RESPONSE] → ${toIdentity || 'all'} | ${data.message || data.action}`);
  } catch (e) {
    console.error('[RESPONSE] ERROR:', e.message);
  }
}

// Обработка данных от букмарклета
function processData(msg, fromIdentity) {
  console.log(`[INCOMING] from=${fromIdentity} action=${msg.action || 'unknown'}`, msg);

  if (msg.action === 'data' || msg.action === 'hello') {
    const text = msg.text || msg.message || 'привет';
    sendResponse(fromIdentity, {
      action: 'reply',
      message: text + ' фисташка',
      ts: Date.now()
    });
  } else {
    sendResponse(fromIdentity, { action: 'ack', message: 'Получил' });
  }
}

// Signaling
async function connectSignal() {
  if (signalWs) return;

  const at = new AccessToken(LK_API_KEY, LK_API_SECRET, { identity: AGENT_IDENTITY });
  at.addGrant({ roomJoin: true, room: ROOM_NAME, canSubscribe: true, canPublishData: true });

  const token = await at.toJwt();
  const url = `${LK_URL}/rtc?access_token=${token}&protocol=15&sdk=js&auto_subscribe=1`;

  console.log('[SIGNAL] Connecting to', LK_URL);

  const ws = new WS(url);
  signalWs = ws;

  ws.on('open', () => console.log('[SIGNAL] WS opened'));

  ws.on('message', (data) => {
    try {
      const uint8 = new Uint8Array(Buffer.from(data));
      const signal = proto.SignalResponse.fromBinary(uint8);
      const caseName = signal.message?.case;

      if (caseName === 'join') {
        isConnected = true;
        console.log('[SIGNAL] ✅ JOINED ROOM');
      }

      if (caseName === 'userPacket' || caseName === 'dataChannelMessage') {
        const pkt = signal.message.value;
        const from = pkt.participantIdentity || 'unknown';
        const payload = pkt.user?.payload || pkt.payload;

        if (payload && from !== AGENT_IDENTITY) {
          try {
            const text = Buffer.from(payload).toString('utf8');
            processData(JSON.parse(text), from);
          } catch (e) {
            console.error('[PARSE ERROR]', e.message);
          }
        }
      }
    } catch (e) {
      console.error('[SIGNAL MSG ERROR]', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[SIGNAL] Closed, reconnecting...');
    isConnected = false;
    signalWs = null;
    setTimeout(connectSignal, 5000);
  });

  ws.on('error', (e) => console.error('[SIGNAL] Error:', e.message));
}

// ==================== HTTP ====================
const server = http.createServer((req, res) => {
  console.log(`[HTTP ${req.method}] ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: true, connected: isConnected, room: ROOM_NAME}));
    return;
  }

  // Webhook для LiveKit
  if (req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log('[WEBHOOK] Получен запрос! Размер body:', body.length);
      console.log('[WEBHOOK] Headers:', JSON.stringify(req.headers, null, 2));

      try {
        const event = JSON.parse(body);
        console.log('[WEBHOOK] Event type:', event.event || event.type || 'unknown');
        console.dir(event, {depth: 2});
      } catch (e) {
        console.log('[WEBHOOK] Не JSON body:', body.substring(0, 300));
      }

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true}));
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n=== Railway LiveKit Agent v5 (улучшенный webhook) ===`);
  console.log(`Port: ${PORT} | Room: ${ROOM_NAME}`);
  connectSignal();
});
