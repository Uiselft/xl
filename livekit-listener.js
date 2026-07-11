// Railway LiveKit Agent — постоянный участник комнаты
// Флоу: pump.fun → букмарклет → LiveKit WSS → этот сервер → обрабатывает → LiveKit WSS → букмарклет
// Запуск: node livekit-listener.js

import { AccessToken } from 'livekit-server-sdk';

const LK_WS_URL    = 'wss://jack-6u9u95rm.livekit.cloud';
const LK_API_KEY   = 'APIAsfxvEYsPGA2';
const LK_API_SECRET = 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK';
const ROOM_NAME    = 'bookmark-room';
const IDENTITY     = 'railway-server';

let Room, RoomEvent, DataPacket_Kind;

async function generateToken(identity) {
  const at = new AccessToken(LK_API_KEY, LK_API_SECRET, {
    identity,
    ttl: 86400 * 7, // 7 дней
  });
  at.addGrant({
    room: ROOM_NAME,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });
  return await at.toJwt();
}

async function handleMessage(msg, participant, room) {
  const action = msg.action || 'unknown';
  console.log(`[LK] action=${action} from=${participant?.identity}`);

  const response = {
    action: 'response',
    requestAction: action,
    ts: Date.now(),
    from: IDENTITY,
  };

  if (action === 'ping') {
    response.ok = true;
    response.message = 'pong from Railway';

  } else if (action === 'fetch') {
    // Сервер делает HTTP запрос вместо букмарклета — обходит CORS/CSP
    const targetUrl = msg.url;
    console.log(`[LK] fetching: ${targetUrl}`);
    try {
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
          ...(msg.headers || {}),
        },
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.substring(0, 5000); }
      response.ok = true;
      response.status = res.status;
      response.data = data;
      console.log(`[LK] fetch done: ${res.status}`);
    } catch (err) {
      response.ok = false;
      response.error = err.message;
      console.error(`[LK] fetch failed: ${err.message}`);
    }

  } else if (action === 'data') {
    // Букмарклет прислал данные страницы
    const payload = msg.payload || {};
    console.log(`[LK] page data: url=${payload.url} title=${payload.title}`);
    response.ok = true;
    response.message = 'received';
    response.echo = { url: payload.url, title: payload.title };

  } else {
    response.ok = false;
    response.message = `unknown action: ${action}`;
  }

  // Отправить ответ конкретному участнику
  try {
    const enc = new TextEncoder().encode(JSON.stringify(response));
    await room.localParticipant.publishData(enc, {
      reliable: true,
      destinationIdentities: participant?.identity ? [participant.identity] : undefined,
    });
    console.log(`[LK] response sent to ${participant?.identity}`);
  } catch (err) {
    console.error(`[LK] send error: ${err.message}`);
  }
}

async function connect() {
  // Загружаем @livekit/rtc-node
  try {
    const mod = await import('@livekit/rtc-node');
    Room = mod.Room;
    RoomEvent = mod.RoomEvent;
    DataPacket_Kind = mod.DataPacket_Kind;
  } catch (err) {
    console.error('[LK] @livekit/rtc-node not found:', err.message);
    console.error('[LK] Run: npm install @livekit/rtc-node');
    process.exit(1);
  }

  const token = await generateToken(IDENTITY);
  const room = new Room();

  room.on(RoomEvent.DataReceived, (data, participant) => {
    try {
      const msg = JSON.parse(Buffer.from(data).toString('utf8'));
      handleMessage(msg, participant, room);
    } catch (err) {
      console.error('[LK] parse error:', err.message);
    }
  });

  room.on(RoomEvent.ParticipantConnected, (p) => {
    console.log(`[LK] joined: ${p.identity}`);
  });

  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    console.log(`[LK] left: ${p.identity}`);
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log('[LK] disconnected — reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  room.on(RoomEvent.ConnectionError, (err) => {
    console.error('[LK] connection error:', err.message);
    setTimeout(connect, 10000);
  });

  try {
    await room.connect(LK_WS_URL, token);
    console.log(`[LK] connected to room: ${ROOM_NAME} as ${IDENTITY}`);
  } catch (err) {
    console.error('[LK] connect failed:', err.message);
    setTimeout(connect, 10000);
  }
}

export { connect };
