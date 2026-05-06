/* ========================================
   前台助手 - 语音模块 (Voice.js)
   getUserMedia 直接录音 + 讯飞听写
   GitHub Pages HTTPS → getUserMedia 可用
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

  // --- AudioBuffer → PCM 16kHz 16bit ---
  function bufferToPCM(audioBuffer) {
    const channel = audioBuffer.getChannelData(0);
    const srcRate = audioBuffer.sampleRate;
    const dstRate = 16000;
    const ratio = srcRate / dstRate;
    const dstLen = Math.floor(channel.length / ratio);
    if (dstLen < 400) throw new Error('AUDIO_TOO_SHORT');
    const pcm = new Int16Array(dstLen);
    for (let i = 0; i < dstLen; i++) {
      const si = i * ratio, idx = Math.floor(si), frac = si - idx;
      const a = channel[idx] || 0, b = channel[idx + 1] || a;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round((a + (b - a) * frac) * 32767)));
    }
    return pcm;
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
            if (m.code !== 0) { if (!done) { done = true; ws.close(); reject(new Error('STT_CODE_' + m.code)); } return; }
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
   * 开始语音识别 (getUserMedia + MediaRecorder)
   * @param {Function} onStatus - (msg) 每阶段回调
   * @returns {Promise<string>}
   */
  function startListening(onStatus) {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) return reject(new Error('STT_NOT_CONFIGURED'));

      onStatus && onStatus('请求麦克风…');

      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        onStatus && onStatus('录音中…');

        let mime = '';
        for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
          if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
        }
        const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
        const chunks = [];

        mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          if (chunks.length === 0) return reject(new Error('NO_AUDIO'));
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });

          try {
            onStatus && onStatus('解码音频…');
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const buf = await blob.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(buf);
            audioCtx.close();
            const pcm = bufferToPCM(audioBuffer);
            const text = await iatRecognize(pcm, onStatus);
            text && text.trim() ? resolve(text.trim()) : reject(new Error('NO_SPEECH'));
          } catch (e) {
            reject(e.message === 'AUDIO_TOO_SHORT' ? e : new Error('AUDIO_DECODE_FAILED'));
          }
        };

        mr.onerror = () => {
          stream.getTracks().forEach((t) => t.stop());
          reject(new Error('MEDIA_RECORDER_ERROR'));
        };

        // 录制 6 秒后自动停止
        mr.start();
        setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, 6000);
      }).catch((err) => {
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
        u.onerror = (ev) => {
          if (ev.error === 'canceled' || ev.error === 'interrupted') resolve();
          else reject(new Error('SPEECH_SYNTHESIS_ERROR'));
        };
        window.speechSynthesis.speak(u);
      };
      if (window.speechSynthesis.getVoices().length > 0) go();
      else { window.speechSynthesis.onvoiceschanged = () => { go(); }; setTimeout(() => { if (!window.speechSynthesis.speaking) go(); }, 500); }
    });
  }

  window.Voice = { startListening, speak, isRecognitionSupported: () => !!navigator.mediaDevices?.getUserMedia, isSynthesisSupported, isConfigured };
})();
