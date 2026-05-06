/* ========================================
   前台助手 - 语音模块 (Voice.js)
   华为 HarmonyOS: 用 capture 输入替代 getUserMedia
   讯飞语音听写 WebSocket API + TTS
   ======================================== */

(function () {
  'use strict';

  const IAT_HOST = 'iat-api.xfyun.cn';
  const IAT_PATH = '/v2/iat';
  const IAT_URL = `wss://${IAT_HOST}${IAT_PATH}`;

  const isSynthesisSupported = !!window.speechSynthesis;

  function getConfig() {
    return {
      appId: localStorage.getItem('xf_appid') || '',
      apiKey: localStorage.getItem('xf_apikey') || '',
      apiSecret: localStorage.getItem('xf_apisecret') || '',
    };
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.appId && c.apiKey && c.apiSecret);
  }

  // --- HMAC-SHA256 签名 ---
  async function hmacSha256(key, data) {
    const enc = new TextEncoder();
    const keyData = enc.encode(key);
    const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  }

  // --- 构建讯飞鉴权 URL ---
  async function buildIatUrl() {
    const cfg = getConfig();
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${IAT_HOST}\ndate: ${date}\nGET ${IAT_PATH} HTTP/1.1`;
    const signature = await hmacSha256(cfg.apiSecret, signatureOrigin);
    const authOrigin = `api_key="${cfg.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const auth = btoa(authOrigin);
    return `${IAT_URL}?authorization=${auth}&date=${encodeURIComponent(date)}&host=${IAT_HOST}`;
  }

  // --- Blob → PCM 16kHz 16bit ---
  async function audioToPCM(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    audioCtx.close();

    const channel = audioBuffer.getChannelData(0);
    const srcRate = audioBuffer.sampleRate;
    const dstRate = 16000;
    const ratio = srcRate / dstRate;
    const dstLen = Math.floor(channel.length / ratio);
    const pcm = new Int16Array(dstLen);

    for (let i = 0; i < dstLen; i++) {
      const srcIdx = i * ratio;
      const idx = Math.floor(srcIdx);
      const frac = srcIdx - idx;
      const a = channel[idx] || 0;
      const b = channel[idx + 1] || a;
      const sample = a + (b - a) * frac;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    return pcm;
  }

  // --- 讯飞 WebSocket 语音听写 ---
  function iatRecognize(pcmData) {
    return new Promise((resolve, reject) => {
      buildIatUrl().then((url) => {
        const ws = new WebSocket(url);
        let finalText = '';
        let resolved = false;

        ws.onopen = () => {
          const cfg = getConfig();
          const params = {
            common: { app_id: cfg.appId },
            business: {
              language: 'zh_cn', domain: 'iat', accent: 'mandarin',
              vad_eos: 2000, dwa: 'wpgs', pti: 1,
            },
            data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
          };
          ws.send(JSON.stringify(params));

          const frameSize = 1280;
          const byteLen = pcmData.byteLength;
          for (let offset = 0; offset < byteLen; offset += frameSize) {
            const end = Math.min(offset + frameSize, byteLen);
            const chunk = new Uint8Array(pcmData.buffer, offset, end - offset);
            const frame = {
              data: {
                status: end >= byteLen ? 2 : 1,
                format: 'audio/L16;rate=16000',
                encoding: 'raw',
                audio: btoa(String.fromCharCode(...chunk)),
              },
            };
            ws.send(JSON.stringify(frame));
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.code !== 0) {
              if (!resolved) { resolved = true; ws.close(); reject(new Error('STT_API_ERROR')); }
              return;
            }
            if (msg.data?.result) {
              const wsData = msg.data.result;
              let text = '';
              for (const w of (wsData.ws || wsData)) {
                for (const cw of (w.cw || [])) text += cw.w || '';
              }
              if (msg.data.status === 2) {
                finalText = text;
                if (!resolved) { resolved = true; ws.close(); resolve(finalText.trim()); }
              }
            }
          } catch (e) {}
        };

        ws.onerror = () => {
          if (!resolved) { resolved = true; reject(new Error('STT_API_ERROR')); }
        };

        ws.onclose = () => {
          if (!resolved) {
            resolved = true;
            if (finalText.trim()) resolve(finalText.trim());
            else reject(new Error('NO_SPEECH'));
          }
        };

        setTimeout(() => {
          if (!resolved) { resolved = true; ws.close(); reject(new Error('TIMEOUT')); }
        }, 20000);
      }).catch(reject);
    });
  }

  // --- capture 录音输入 (HTML5, 免 getUserMedia) ---
  let captureInput = null;

  function getCaptureInput() {
    if (captureInput) return captureInput;
    captureInput = document.createElement('input');
    captureInput.type = 'file';
    captureInput.accept = 'audio/*';
    captureInput.setAttribute('capture', 'microphone');
    captureInput.style.display = 'none';
    document.body.appendChild(captureInput);
    return captureInput;
  }

  /**
   * 开始语音识别（通过系统录音器）
   * @returns {Promise<string>}
   */
  function startListening() {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) {
        return reject(new Error('STT_NOT_CONFIGURED'));
      }

      const input = getCaptureInput();
      input.value = '';

      input.onchange = async () => {
        const file = input.files[0];
        if (!file) {
          return reject(new Error('NO_AUDIO'));
        }

        try {
          const pcm = await audioToPCM(file);
          if (pcm.length < 400) {
            return reject(new Error('NO_AUDIO'));
          }
          const text = await iatRecognize(pcm);
          if (text) resolve(text);
          else reject(new Error('NO_SPEECH'));
        } catch (e) {
          reject(e);
        }
      };

      // 用户取消
      input.oncancel = () => {
        reject(new Error('NO_AUDIO'));
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

      const trySpeak = () => {
        const voices = window.speechSynthesis.getVoices();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = lang; utterance.rate = rate; utterance.pitch = pitch; utterance.volume = volume;
        const zhVoice = voices.find((v) => v.lang.startsWith('zh') && v.localService);
        if (zhVoice) utterance.voice = zhVoice;
        utterance.onend = () => resolve();
        utterance.onerror = (e) => {
          if (e.error === 'canceled' || e.error === 'interrupted') resolve();
          else reject(new Error('SPEECH_SYNTHESIS_ERROR'));
        };
        window.speechSynthesis.speak(utterance);
      };

      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) trySpeak();
      else {
        window.speechSynthesis.onvoiceschanged = () => { trySpeak(); };
        setTimeout(() => { if (!window.speechSynthesis.speaking) trySpeak(); }, 500);
      }
    });
  }

  window.Voice = {
    startListening,
    speak,
    isRecognitionSupported: () => true,
    isSynthesisSupported,
    isConfigured,
  };
})();
