/* ========================================
   前台助手 - 本地存储模块 (Storage.js)
   封装 localStorage 操作
   ======================================== */

(function () {
  'use strict';

  const KEYS = {
    FAQ: 'kiosk_faq',
    EXTENDED: 'kiosk_extended_knowledge',
    CONVERSATIONS: 'kiosk_conversations',
  };

  /**
   * 保存FAQ数据到 localStorage
   * @param {Array} faqList
   */
  function saveFAQ(faqList) {
    try {
      localStorage.setItem(KEYS.FAQ, JSON.stringify(faqList));
      return true;
    } catch (e) {
      console.warn('Storage saveFAQ error:', e);
      return false;
    }
  }

  /**
   * 从 localStorage 加载 FAQ 数据
   * 无数据时返回 null
   * @returns {Array|null}
   */
  function loadFAQ() {
    try {
      const raw = localStorage.getItem(KEYS.FAQ);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : null;
    } catch (e) {
      console.warn('Storage loadFAQ error:', e);
      return null;
    }
  }

  /**
   * 保存扩展知识库文本
   * @param {string} text
   */
  function saveExtendedKnowledge(text) {
    try {
      localStorage.setItem(KEYS.EXTENDED, text);
      return true;
    } catch (e) {
      console.warn('Storage saveExtendedKnowledge error:', e);
      return false;
    }
  }

  /**
   * 加载扩展知识库文本
   * @returns {string|null}
   */
  function loadExtendedKnowledge() {
    try {
      return localStorage.getItem(KEYS.EXTENDED);
    } catch (e) {
      console.warn('Storage loadExtendedKnowledge error:', e);
      return null;
    }
  }

  /**
   * 保存一条对话记录
   * 存储结构: [{user, assistant, timestamp}, ...]
   * 最多保留 maxCount 条
   * @param {string} userMsg
   * @param {string} assistantReply
   * @param {number} [maxCount=200]
   */
  function saveConversation(userMsg, assistantReply, maxCount) {
    if (maxCount === undefined) maxCount = 200;
    try {
      const raw = localStorage.getItem(KEYS.CONVERSATIONS);
      const list = raw ? JSON.parse(raw) : [];
      list.push({
        user: userMsg,
        assistant: assistantReply,
        timestamp: Date.now(),
      });
      // 截断旧记录
      if (list.length > maxCount) {
        list.splice(0, list.length - maxCount);
      }
      localStorage.setItem(KEYS.CONVERSATIONS, JSON.stringify(list));
      return true;
    } catch (e) {
      console.warn('Storage saveConversation error:', e);
      return false;
    }
  }

  /**
   * 加载最近对话记录
   * @param {number} [limit=50]
   * @returns {Array}
   */
  function loadConversations(limit) {
    if (limit === undefined) limit = 50;
    try {
      const raw = localStorage.getItem(KEYS.CONVERSATIONS);
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      return list.slice(-limit);
    } catch (e) {
      console.warn('Storage loadConversations error:', e);
      return [];
    }
  }

  /**
   * 清除所有存储数据
   */
  function clearAll() {
    try {
      Object.values(KEYS).forEach((key) => localStorage.removeItem(key));
      return true;
    } catch (e) {
      console.warn('Storage clearAll error:', e);
      return false;
    }
  }

  // --- 导出 ---
  window.Storage = {
    saveFAQ,
    loadFAQ,
    saveExtendedKnowledge,
    loadExtendedKnowledge,
    saveConversation,
    loadConversations,
    clearAll,
    KEYS,
  };
})();
