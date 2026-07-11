'use strict';

const http = require('http');
const WS = require('ws');
const proto = require('@livekit/protocol');
const { AccessToken, RoomServiceClient, DataPacket_Kind } = require('livekit-server-sdk');

const PORT = process.env.PORT || 8080;

const LK_API_KEY = 'APIAsfxvEYsPGA2';
const LK_API_SECRET = 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
const LK_URL = 'wss://jack-6u9u95rm.livekit.cloud';
const ROOM_NAME = 'bookmark-room';
const AGENT_IDENTITY = 'railway-agent';

const roomService = new RoomServiceClient(LK_URL.replace('wss://', 'https://'), LK_API_KEY, LK_API_SECRET);

let signalWs = null;

// Отправка
async function sendResponse(toIdentity, data) {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    await roomService.sendData(ROOM_NAME, bytes, DataPacket_Kind.RELIABLE, { destinationIdentities: [toIdentity] });
    console.log(`[RESPONSE] to ${toIdentity} | ${data.message}`);
  } catch (e) {
    console.error('[RESPONSE ERROR]', e.message);
  }
}

// Обработка
function processData(msg, from) {
  console.log(`[INCOMING SUCCESS] from=${from} action=${msg.action}`, msg);
  if (msg.action === 'hello' || msg.action === 'data') {
    sendResponse(from, { action: 'reply', message: (msg.text || msg.message || 'привет') + ' фисташка' });
  }
}

async function connectSignal() {
  if (signalWs) return;

  const at = new AccessToken(LK_API_KEY, LK_API_SECRET, { identity: AGENT_IDENTITY });
  at.addGrant({ roomJoin: true, room: ROOM_NAME, canSubscribe: true, canPublishData: true });

  const token = await at.toJwt();
  const ws = new WS(`${LK_URL}/rtc?access_token=${token}&protocol=15&auto_subscribe=1`);

  signalWs = ws;

  ws.on('open', () => console.log('[SIGNAL] Opened'));

  ws.on('message', (data) => {
    try {
      const signal = proto.SignalResponse.fromBinary(new Uint8Array(data));
      const caseName = signal.message?.case;

      if (caseName === 'join') console.log('[SIGNAL] JOINED');

      if (caseName === 'dataChannelMessage' || caseName === 'userPacket') {
        const pkt = signal.message.value;
        const from = pkt.participantIdentity;
        const payload = pkt.user?.payload || pkt.payload;

        if (payload) {
          const text = new TextDecoder().decode(payload);
          console.log('[RAW DATA RECEIVED]', text);
          try {
            processData(JSON.parse(text), from);
          } catch(e) {
            console.error('[JSON PARSE FAIL]', e.message);
          }
        }
      }
    } catch(e) {
      console.error('[SIGNAL PARSE ERROR]', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[SIGNAL] Closed, reconnect...');
    signalWs = null;
    setTimeout(connectSignal, 3000);
  });
}

// HTTP
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: true}));
    return;
  }
  if (req.url === '/webhook') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      console.log('[WEBHOOK] OK, size', body.length);
      res.writeHead(200);
      res.end('{}');
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log('=== Agent v8 started ===');
  connectSignal();
});
