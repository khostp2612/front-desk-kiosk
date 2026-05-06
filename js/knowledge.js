/* ========================================
   前台助手 - 知识库匹配引擎 (Knowledge.js)
   三层匹配：FAQ精确 → 扩展模糊 → null(LLM兜底)
   ======================================== */

(function () {
  'use strict';

  /**
   * 简单中文分词：按常见分隔符 + 标点拆分，过滤空串
   * @param {string} text
   * @returns {string[]}
   */
  function tokenize(text) {
    if (!text) return [];
    // 按空白、标点、中英文逗句分号冒号等切分
    const tokens = text.split(/[\s,，。！？、；：·""''（）()【】\[\]{}「」《》\n\r\t]+/);
    // 同时提取每个字（单字粒度）和二元词组，提升命中率
    const chars = text.replace(/[\s,，。！？、；：·""''（）()【】\[\]{}「」《》\n\r\t]/g, '');
    const bigrams = [];
    for (let i = 0; i < chars.length - 1; i++) {
      bigrams.push(chars[i] + chars[i + 1]);
    }
    // 合并 分词结果 + 单字 + 二元组，去重
    const all = tokens.concat(chars.split('')).concat(bigrams);
    return [...new Set(all.filter((t) => t.length > 0))];
  }

  /**
   * 判断输入中是否包含某个词组（支持多词）
   * @param {string} input
   * @param {string} phrase
   * @returns {boolean}
   */
  function includesPhrase(input, phrase) {
    return input.indexOf(phrase) !== -1;
  }

  /**
   * Layer 1: 精确关键词匹配
   * 对用户输入分词，计算每个FAQ的关键词命中率
   * @param {string} userInput 原始用户输入
   * @param {Array} faqList FAQ 条目列表
   * @returns {{ answer: string|null, score: number, faq: object|null }}
   */
  function matchExact(userInput, faqList) {
    if (!userInput || !faqList || faqList.length === 0) {
      return { answer: null, score: 0, faq: null };
    }

    const input = userInput.trim();
    const tokens = tokenize(input);
    let best = { answer: null, score: 0, faq: null };

    for (const faq of faqList) {
      const keywords = faq.keywords || [];
      if (keywords.length === 0) continue;

      // 计算命中关键词数
      let hitCount = 0;
      for (const kw of keywords) {
        // 直接包含匹配（最高优先级）
        if (includesPhrase(input, kw)) {
          hitCount++;
          continue;
        }
        // 分词粒度匹配
        for (const token of tokens) {
          if (token.length >= 2 && kw.indexOf(token) !== -1) {
            hitCount++;
            break;
          }
        }
      }

      // 关键字命中率 = 命中的关键字数 / 关键字总数
      const score = hitCount / keywords.length;

      // 如果有关键词命中，检查 context 字段是否匹配
      let contextMatch = true;
      if (faq.context && faq.context.length > 0) {
        contextMatch = includesPhrase(input, faq.context);
      }

      // 阈值 >= 0.5 且有关键词命中，或关键词全部命中
      const qualified = score >= 0.5 || hitCount >= keywords.length * 0.5;

      if (qualified && contextMatch && score > best.score) {
        best = { answer: faq.answer, score, faq };
      }
    }

    return best;
  }

  /**
   * Layer 2: 扩展知识库模糊匹配
   * 在用户上传的文本中查找包含输入词的段落
   * @param {string} userInput
   * @param {string} extendedText 扩展知识文本
   * @returns {{ answer: string|null, score: number }}
   */
  function matchExtended(userInput, extendedText) {
    if (!userInput || !extendedText) {
      return { answer: null, score: 0 };
    }

    const input = userInput.trim();
    // 提取用户输入中的核心词（>=2字的token）
    const tokens = tokenize(input).filter((t) => t.length >= 2);
    if (tokens.length === 0) return { answer: null, score: 0 };

    // 按换行或双换行分割段落
    const paragraphs = extendedText.split(/\n\s*\n|\n(?=\S)/);
    let best = { answer: null, score: 0 };

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length < 5) continue;

      let hitCount = 0;
      let exactMatchCount = 0;
      for (const token of tokens) {
        if (includesPhrase(trimmed, token)) {
          hitCount++;
          if (includesPhrase(trimmed, token)) exactMatchCount++;
        }
      }

      // 评分：命中率 + 长度权重（略长段落更可能是有效答案）
      const hitRatio = hitCount / tokens.length;
      const lengthBonus = Math.min(trimmed.length / 200, 0.15);
      const score = hitRatio * 0.85 + lengthBonus;

      if (score > best.score && hitRatio >= 0.3) {
        best = { answer: trimmed, score };
      }
    }

    return best;
  }

  /**
   * 加载FAQ数据：优先 localStorage，其次 data/faq-default.json
   * @returns {Promise<Array>}
   */
  async function loadFAQ() {
    // 先查 localStorage
    const stored = window.Storage && window.Storage.loadFAQ();
    if (stored && Array.isArray(stored) && stored.length > 0) {
      return stored;
    }

    // 回退到默认FAQ文件
    try {
      const resp = await fetch('data/faq-default.json');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      // 自动存入 localStorage 以便离线
      if (window.Storage) {
        window.Storage.saveFAQ(data);
      }
      return data;
    } catch (e) {
      console.warn('Knowledge: failed to load faq-default.json', e);
      return [];
    }
  }

  /**
   * 三层匹配入口
   * @param {string} userInput
   * @returns {Promise<{ answer: string|null, source: string, matched: boolean }>}
   */
  async function match(userInput) {
    if (!userInput || typeof userInput !== 'string') {
      return { answer: null, source: 'none', matched: false };
    }

    const input = userInput.trim();
    if (input.length === 0) {
      return { answer: null, source: 'none', matched: false };
    }

    // --- Layer 1: FAQ 精确匹配 ---
    const faqList = await loadFAQ();
    const layer1 = matchExact(input, faqList);
    if (layer1.answer && layer1.score >= 0.5) {
      return {
        answer: layer1.answer,
        source: 'faq',
        matched: true,
        score: layer1.score,
      };
    }

    // --- Layer 2: 扩展知识库模糊匹配 ---
    if (window.Storage) {
      const extendedText = window.Storage.loadExtendedKnowledge();
      if (extendedText) {
        const layer2 = matchExtended(input, extendedText);
        if (layer2.answer && layer2.score >= 0.3) {
          return {
            answer: layer2.answer,
            source: 'extended',
            matched: true,
            score: layer2.score,
          };
        }
      }
    }

    // --- Layer 3: 无匹配，返回 null 触发 LLM 兜底 ---
    return { answer: null, source: 'none', matched: false };
  }

  // --- 导出 ---
  window.Knowledge = {
    match,
    loadFAQ,
    matchExact,
    matchExtended,
    tokenize,
  };
})();
