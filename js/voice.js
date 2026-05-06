/* ========================================
   前台助手 - 语音模块 (Voice.js)
   讯飞语音听写 WebSocket + TTS
   ======================================== */

(function () {
  'use strict';

  const IAT_HOST = 'iat-api.xfyun.cn';
  const IAT_PATH = '/v2/iat';
  const IAT_URL = `wss://${IAT_HOST}${IAT_PATH}`;
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
    const keyData = enc.encode(key);
    const ck = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', ck, enc.encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  async function buildUrl() {
    const c = getCfg();
    const date = new Date().toUTCString();
    const origin = `host: ${IAT_HOST}\ndate: ${date}\nGET ${IAT_PATH} HTTP/1.1`;
    const sig = await hmacSha256(c.apiSecret, origin);
    const authOrigin = `api_key="${c.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`;
    const auth = btoa(authOrigin);
    return `${IAT_URL}?authorization=${auth}&date=${encodeURIComponent(date)}&host=${IAT_HOST}`;
  }

  // --- 音频文件 → PCM 16kHz 16bit ---
  async function fileToPCM(file, onStatus) {
    onStatus && onStatus('解码音频…');
    const buf = await file.arrayBuffer();
    let audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    } catch (e) {
      throw new Error('AUDIO_CONTEXT_FAILED');
    }
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(buf);
    } catch (e) {
      audioCtx.close();
      console.error('decodeAudioData failed:', e, 'file type:', file.type, 'size:', file.size);
      throw new Error('AUDIO_DECODE_FAILED');
    }
    audioCtx.close();

    const channel = audioBuffer.getChannelData(0);
    const srcRate = audioBuffer.sampleRate;
    const dstRate = 16000;
    const ratio = srcRate / dstRate;
    const dstLen = Math.floor(channel.length / ratio);
    if (dstLen < 400) throw new Error('AUDIO_TOO_SHORT');
    const pcm = new Int16Array(dstLen);

    for (let i = 0; i < dstLen; i++) {
      const si = i * ratio;
      const idx = Math.floor(si);
      const frac = si - idx;
      const a = channel[idx] || 0;
      const b = channel[idx + 1] || a;
      const s = a + (b - a) * frac;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    return pcm;
  }

  // --- 讯飞 WebSocket 听写 ---
  function iatRecognize(pcmData, onStatus) {
    onStatus && onStatus('识别中…');
    return new Promise((resolve, reject) => {
      buildUrl().then((url) => {
        const ws = new WebSocket(url);
        let finalText = '';
        let done = false;

        ws.onopen = () => {
          const c = getCfg();
          ws.send(JSON.stringify({
            common: { app_id: c.appId },
            business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 2000, dwa: 'wpgs', pti: 1 },
            data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
          }));

          const frameSize = 1280;
          const len = pcmData.byteLength;
          for (let off = 0; off < len; off += frameSize) {
            const end = Math.min(off + frameSize, len);
            const chunk = new Uint8Array(pcmData.buffer, off, end - off);
            ws.send(JSON.stringify({
              data: {
                status: end >= len ? 2 : 1,
                format: 'audio/L16;rate=16000',
                encoding: 'raw',
                audio: btoa(String.fromCharCode(...chunk)),
              },
            }));
          }
        };

        ws.onmessage = (e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.code !== 0) {
              if (!done) { done = true; ws.close(); reject(new Error('STT_CODE_' + m.code)); }
              return;
            }
            if (m.data?.result) {
              const r = m.data.result;
              let text = '';
              for (const w of (r.ws || [])) {
                for (const cw of (w.cw || [])) text += (cw.w || '');
              }
              if (m.data.status === 2) {
                finalText = text;
                if (!done) { done = true; ws.close(); resolve(finalText.trim() || ''); }
              }
            }
          } catch (_) {}
        };

        ws.onerror = () => {
          if (!done) { done = true; reject(new Error('STT_WS_ERROR')); }
        };

        ws.onclose = () => {
          if (!done) {
            done = true;
            if (finalText.trim()) resolve(finalText.trim());
            else reject(new Error('NO_SPEECH'));
          }
        };

        setTimeout(() => {
          if (!done) { done = true; ws.close(); reject(new Error('TIMEOUT')); }
        }, 25000);
      }).catch(reject);
    });
  }

  // --- file input ---
  let inputEl = null;
  function getInput() {
    if (inputEl) return inputEl;
    inputEl = document.createElement('input');
    inputEl.type = 'file';
    inputEl.accept = 'audio/*';
    inputEl.style.display = 'none';
    document.body.appendChild(inputEl);
    return inputEl;
  }

  /**
   * 开始语音识别
   * @param {Function} onStatus - (statusText) 每阶段回调
   * @returns {Promise<string>}
   */
  function startListening(onStatus) {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) return reject(new Error('STT_NOT_CONFIGURED'));

      const input = getInput();
      input.value = '';

      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return reject(new Error('NO_AUDIO'));

        try {
          onStatus && onStatus('解码音频…');
          const pcm = await fileToPCM(file, onStatus);
          if (pcm.length < 400) return reject(new Error('AUDIO_TOO_SHORT'));

          onStatus && onStatus('识别中…');
          const text = await iatRecognize(pcm, onStatus);

          if (text && text.trim()) resolve(text.trim());
          else reject(new Error('NO_SPEECH'));
        } catch (e) {
          reject(e);
        }
      };

      input.click();
    });
  }

  // --- TTS ---
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
        u.onerror = (ev) => {
          if (ev.error === 'canceled' || ev.error === 'interrupted') resolve();
          else reject(new Error('SPEECH_SYNTHESIS_ERROR'));
        };
        window.speechSynthesis.speak(u);
      };
      if (window.speechSynthesis.getVoices().length > 0) go();
      else {
        window.speechSynthesis.onvoiceschanged = () => { go(); };
        setTimeout(() => { if (!window.speechSynthesis.speaking) go(); }, 500);
      }
    });
  }

  window.Voice = { startListening, speak, isRecognitionSupported: () => true, isSynthesisSupported, isConfigured };
})();
