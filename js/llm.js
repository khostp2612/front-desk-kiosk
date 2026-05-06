/* ========================================
   前台助手 - LLM 兜底模块 (LLM.js)
   调用 DeepSeek API
   ======================================== */

(function () {
  'use strict';

  const DEFAULT_BASE_URL = 'https://api.deepseek.com';

  /**
   * 获取 API Key
   * 优先级：localStorage > sessionStorage > 硬编码空字符串
   * @returns {string}
   */
  function getApiKey() {
    try {
      return localStorage.getItem('deepseek_api_key') ||
             sessionStorage.getItem('deepseek_api_key') ||
             '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 获取 API Base URL（可自定义，默认 DeepSeek 官方）
   * @returns {string}
   */
  function getBaseUrl() {
    try {
      return localStorage.getItem('deepseek_base_url') || DEFAULT_BASE_URL;
    } catch (e) {
      return DEFAULT_BASE_URL;
    }
  }

  /**
   * 构建 system prompt
   * @returns {string}
   */
  function buildSystemPrompt() {
    const storeName = (document.getElementById('store-name') || {}).textContent || '前台助手';
    return (
      `你是${storeName}的前台智能助手，回答简洁30字以内。` +
      '涉及价格、预约、定制、维修等具体业务，引导顾客联系工作人员处理。' +
      '不知道就说不知道，不要编造信息。' +
      '回答使用中文。'
    );
  }

  /**
   * 调用 DeepSeek Chat API
   * @param {string} userMessage
   * @param {object} [options]
   * @param {number} [options.timeout=15000] 超时毫秒
   * @param {number} [options.maxTokens=200] 最大输出长度
   * @param {number} [options.temperature=0.3] 温度参数（低=更稳定）
   * @returns {Promise<string>}
   */
  function askLLM(userMessage, options) {
    const {
      timeout = 15000,
      maxTokens = 200,
      temperature = 0.3,
    } = options || {};

    return new Promise((resolve, reject) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        return reject(new Error('API_KEY_MISSING'));
      }

      const baseUrl = getBaseUrl().replace(/\/+$/, '');
      const url = baseUrl + '/chat/completions';

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: userMessage },
          ],
          max_tokens: maxTokens,
          temperature: temperature,
          stream: false,
        }),
        signal: controller.signal,
      })
        .then((response) => {
          clearTimeout(timer);
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              return reject(new Error('API_KEY_INVALID'));
            }
            if (response.status === 429) {
              return reject(new Error('API_RATE_LIMITED'));
            }
            return reject(new Error('API_HTTP_ERROR'));
          }
          return response.json();
        })
        .then((data) => {
          const content = data?.choices?.[0]?.message?.content;
          if (!content) {
            return reject(new Error('API_EMPTY_RESPONSE'));
          }
          resolve(content.trim());
        })
        .catch((err) => {
          clearTimeout(timer);
          if (err.name === 'AbortError') {
            reject(new Error('API_TIMEOUT'));
          } else if (err.message === 'Failed to fetch' || err.message.includes('NetworkError')) {
            reject(new Error('API_NETWORK_ERROR'));
          } else {
            reject(err);
          }
        });
    });
  }

  /**
   * 检查 API Key 是否已配置
   * @returns {boolean}
   */
  function isConfigured() {
    return !!getApiKey();
  }

  // --- 导出 ---
  window.LLM = {
    askLLM,
    isConfigured,
    getApiKey,
  };
})();
