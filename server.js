const { Agent } = require('livekit-server-sdk');

console.log('=== LiveKit Agent starting ===');

const agent = new Agent({
  apiKey: 'APIAsfxvEYsPGA2',
  apiSecret: 'JCHcXc1lYger14JRo6IRih7pJRg8UyoUayGuHMmEKoK',
  wsURL: 'wss://jack-6u9u95rm.livekit.cloud',
  // Можно добавить name: 'my-bookmark-agent'
});

agent.registerJob({
  jobType: 'room',           // Запускается при входе в комнату
  roomName: 'bookmark-room', // Название твоей комнаты
  handler: async (job) => {
    console.log(`✅ Agent joined room: ${job.room.name}`);

    // Слушаем сообщения от клиентов (букмарклетов)
    job.room.on('dataReceived', (payload, participant) => {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);

        console.log(`[INCOMING] from ${participant.identity}:`, msg);

        if (msg.action === 'hello' || msg.action === 'data') {
          const reply = {
            action: 'reply',
            message: (msg.text || msg.message || 'привет') + ' фисташка'
          };

          // Отправляем ответ
          job.room.localParticipant.publishData(
            new TextEncoder().encode(JSON.stringify(reply)),
            { reliable: true }
          );

          console.log('[RESPONSE] Sent фисташка');
        }
      } catch (e) {
        console.error('Parse error:', e.message);
      }
    });

    // Опционально: логируем подключения
    job.room.on('participantConnected', (p) => {
      console.log(`User joined: ${p.identity}`);
    });
  }
});

agent.start();
console.log('Agent is running...');
