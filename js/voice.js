/* ========================================
   前台助手 - 语音模块 (Voice.js)
   直接抓 PCM + 讯飞 WebSocket 听写
   绕过 encode/decode 兼容问题
   ======================================== */

(function () {
  'use strict';

  const IAT_HOST = 'iat-api.xfyun.cn';
  const IAT_PATH = '/v2/iat';
  const IAT_URL = `wss://${IAT_HOST}${IAT_PATH}`;
  const SAMPLE_RATE = 16000;
  const isSynthesisSupported = !!window.speechSynthesis;

  function getCfg() {
    return {
      appId: localStorage.getItem('xf_appid') || '',
      apiKey: localStorage.getItem('xf_apikey') || '',
      apiSecret: localStorage.getItem('xf_apisecret') || '',
    };
  }
  function isConfigured() {
    const c = getCfg();
    return !!(c.appId && c.apiKey && c.apiSecret);
  }

  // --- HMAC-SHA256 ---
  async function hmacSha256(key, data) {
    const enc = new TextEncoder();
    const ck = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  async function buildUrl() {
    const c = getCfg();
    const date = new Date().toUTCString();
    const origin = `host: ${IAT_HOST}\ndate: ${date}\nGET ${IAT_PATH} HTTP/1.1`;
    const sig = await hmacSha256(c.apiSecret, origin);
    const authOrigin = `api_key="${c.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`;
    return `${IAT_URL}?authorization=${btoa(authOrigin)}&date=${encodeURIComponent(date)}&host=${IAT_HOST}`;
  }

  // --- 讯飞 WebSocket 听写 ---
  function iatRecognize(pcmData, onStatus) {
    onStatus && onStatus('识别中…');
    return new Promise((resolve, reject) => {
      buildUrl().then((url) => {
        const ws = new WebSocket(url);
        let finalText = '', done = false;
        ws.onopen = () => {
          const c = getCfg();
          ws.send(JSON.stringify({
            common: { app_id: c.appId },
            business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 2000, dwa: 'wpgs', pti: 1 },
            data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
          }));
          const len = pcmData.byteLength;
          for (let off = 0; off < len; off += 1280) {
            const end = Math.min(off + 1280, len);
            const chunk = new Uint8Array(pcmData.buffer, off, end - off);
            ws.send(JSON.stringify({ data: { status: end >= len ? 2 : 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: btoa(String.fromCharCode(...chunk)) } }));
          }
        };
        ws.onmessage = (e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.code !== 0) {
              const errCode = m.code || 0;
              const errMsg = m.message || '';
              if (!done) { done = true; ws.close(); reject(new Error('STT_CODE_' + errCode + (errMsg ? '_' + errMsg : ''))); }
              return;
            }
            if (m.data?.result) {
              let text = '';
              for (const w of (m.data.result.ws || [])) for (const cw of (w.cw || [])) text += (cw.w || '');
              if (m.data.status === 2) { finalText = text; if (!done) { done = true; ws.close(); resolve(finalText.trim() || ''); } }
            }
          } catch (_) {}
        };
        ws.onerror = () => { if (!done) { done = true; reject(new Error('STT_WS_ERROR')); } };
        ws.onclose = () => { if (!done) { done = true; finalText.trim() ? resolve(finalText.trim()) : reject(new Error('NO_SPEECH')); } };
        setTimeout(() => { if (!done) { done = true; ws.close(); reject(new Error('TIMEOUT')); } }, 25000);
      }).catch(reject);
    });
  }

  /**
   * 开始语音识别 — 直接抓 PCM 采样
   * @param {Function} onStatus
   * @returns {Promise<string>}
   */
  function startListening(onStatus) {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) return reject(new Error('STT_NOT_CONFIGURED'));
      onStatus && onStatus('请求麦克风…');

      navigator.mediaDevices.getUserMedia({ audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true } })
        .then((stream) => {
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
          const source = audioCtx.createMediaStreamSource(stream);
          const bufferSize = 4096;
          const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
          const chunks = [];

          processor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            // 拷贝 Float32 → Int16
            const int16 = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) {
              int16[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
            }
            chunks.push(int16);
          };

          source.connect(processor);
          processor.connect(audioCtx.destination);
          onStatus && onStatus('录音中…');

          // 6 秒后自动停止
          setTimeout(() => {
            processor.disconnect();
            source.disconnect();
            audioCtx.close();
            stream.getTracks().forEach((t) => t.stop());

            if (chunks.length === 0) return reject(new Error('NO_AUDIO'));

            // 拼接所有 Int16 分块
            const totalLen = chunks.reduce((s, c) => s + c.length, 0);
            const pcm = new Int16Array(totalLen);
            let offset = 0;
            for (const c of chunks) {
              pcm.set(c, offset);
              offset += c.length;
            }

            if (pcm.length < 800) return reject(new Error('AUDIO_TOO_SHORT'));

            iatRecognize(pcm.buffer, onStatus).then(resolve).catch(reject);
          }, 6000);
        })
        .catch((err) => {
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            reject(new Error('PERMISSION_DENIED'));
          } else {
            reject(new Error('MEDIA_DEVICES_NOT_SUPPORTED'));
          }
        });
    });
  }

  function speak(text, options) {
    const { lang = 'zh-CN', rate = 1.0, pitch = 1.0, volume = 1.0 } = options || {};
    return new Promise((resolve, reject) => {
      if (!isSynthesisSupported) return reject(new Error('SPEECH_SYNTHESIS_NOT_SUPPORTED'));
      window.speechSynthesis.cancel();
      const go = () => {
        const voices = window.speechSynthesis.getVoices();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang; u.rate = rate; u.pitch = pitch; u.volume = volume;
        const zv = voices.find((v) => v.lang.startsWith('zh') && v.localService);
        if (zv) u.voice = zv;
        u.onend = () => resolve();
        u.onerror = (ev) => { if (ev.error === 'canceled' || ev.error === 'interrupted') resolve(); else reject(new Error('SPEECH_SYNTHESIS_ERROR')); };
        window.speechSynthesis.speak(u);
      };
      if (window.speechSynthesis.getVoices().length > 0) go();
      else { window.speechSynthesis.onvoiceschanged = () => { go(); }; setTimeout(() => { if (!window.speechSynthesis.speaking) go(); }, 500); }
    });
  }

  window.Voice = { startListening, speak, isRecognitionSupported: () => !!navigator.mediaDevices?.getUserMedia, isSynthesisSupported, isConfigured };
})();
