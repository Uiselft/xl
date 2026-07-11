import nodeDataChannel from 'node-datachannel';

const { PeerConnection } = nodeDataChannel;

export default class WebRTCPeer {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.dataChannel = null;
    this.iceCandidates = [];
    this.onIceCandidate = null; // будет задан снаружи для отправки кандидатов браузеру

    this.pc = new PeerConnection('server-peer', {
      iceServers: ['stun:stun.l.google.com:19302'],
    });

    this.pc.onStateChange((state) => {
      console.log('[WebRTC] Connection state:', state);
    });

    this.pc.onGatheringStateChange((state) => {
      console.log('[WebRTC] Gathering state:', state);
    });

    this.pc.onLocalCandidate((candidate, mid) => {
      console.log('[WebRTC] Local ICE candidate:', candidate);
      if (this.onIceCandidate) {
        this.onIceCandidate({ candidate, sdpMid: mid });
      }
    });

    // Когда браузер инициирует DataChannel
    this.pc.onDataChannel((channel) => {
      console.log('[WebRTC] DataChannel получен от браузера:', channel.getLabel());
      this.setupDataChannel(channel);
    });
  }

  setupDataChannel(channel) {
    this.dataChannel = channel;

    channel.onOpen(() => {
      console.log('[WebRTC] DataChannel открыт!');
    });

    channel.onMessage((msg) => {
      console.log('[WebRTC] Сообщение от браузера:', msg);
      if (this.onMessage) {
        this.onMessage(msg, channel);
      }
    });

    channel.onClosed(() => {
      console.log('[WebRTC] DataChannel закрыт');
      this.dataChannel = null;
    });

    channel.onError((err) => {
      console.error('[WebRTC] DataChannel ошибка:', err);
    });
  }

  async createOffer() {
    return new Promise((resolve, reject) => {
      // Создаём DataChannel со стороны сервера, чтобы инициировать offer
      const dc = this.pc.createDataChannel('server-channel');
      this.setupDataChannel(dc);

      this.pc.setLocalDescription('offer');

      // Ждём пока соберётся SDP
      const checkSdp = setInterval(() => {
        const sdp = this.pc.localDescription();
        if (sdp && sdp.sdp && sdp.sdp.length > 0) {
          clearInterval(checkSdp);
          console.log('[WebRTC] Offer создан');
          resolve(sdp);
        }
      }, 50);

      setTimeout(() => {
        clearInterval(checkSdp);
        reject(new Error('Timeout: offer не создался за 5 секунд'));
      }, 5000);
    });
  }

  async handleAnswer(answer) {
    try {
      this.pc.setRemoteDescription(answer.sdp, answer.type);
      console.log('[WebRTC] Answer установлен');
    } catch (err) {
      console.error('[WebRTC] Ошибка при обработке answer:', err);
      throw err;
    }
  }

  addIceCandidate(candidate) {
    try {
      if (candidate && candidate.candidate) {
        this.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || '0');
      }
    } catch (err) {
      console.error('[WebRTC] Ошибка добавления ICE candidate:', err);
    }
  }

  send(data) {
    if (this.dataChannel && this.dataChannel.isOpen()) {
      this.dataChannel.sendMessage(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  close() {
    try {
      if (this.dataChannel) this.dataChannel.close();
      if (this.pc) this.pc.close();
    } catch (err) {
      // ignore
    }
  }
}
