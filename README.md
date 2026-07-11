# WebRTC Signaling Server (Railway)

Минимальный signaling-сервер для WebRTC DataChannel. Пересылает
offer / answer / ICE-кандидаты между пирами в одной "комнате".
Сами данные после установки соединения идут напрямую P2P — через сервер не проходят.

## Деплой на Railway

1. Создай новый проект на [railway.com](https://railway.com) → **Deploy from GitHub repo**
   (или **Empty Project → Deploy** и залей эту папку).
2. Railway сам определит Node.js, поставит зависимости и запустит `npm start`.
3. Railway задаёт переменную `PORT` автоматически — код её читает, ничего настраивать не нужно.
4. В настройках сервиса нажми **Generate Domain**, чтобы получить публичный адрес,
   например `webrtc-signaling-production.up.railway.app`.

## Проверка

- Открой `https://<твой-домен>/health` → должно вернуться `{"ok":true,...}`.
- В клиенте используй адрес `wss://<твой-домен>` (именно `wss://`, не `https://`).

## Локальный запуск

```bash
cd railway-signaling
npm install
npm start   # слушает ws://localhost:8080
```
