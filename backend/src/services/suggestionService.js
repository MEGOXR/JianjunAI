const ProviderFactory = require('./ProviderFactory');

class SuggestionService {
  constructor() {
    this.provider = null;
    this.initProvider();
  }

  initProvider() {
    try {
      this.provider = ProviderFactory.getLLMProvider();
      console.log('建议问题服务初始化成功');
    } catch (error) {
      console.error('建议问题服务初始化失败:', error);
      this.provider = null;
    }
  }

  /**
   * 生成建议问题
   * @param {Array} conversationHistory - 完整对话历史
   * @param {string} lastResponse - AI的最后一次回复
   * @returns {Array} 建议问题数组
   */
  async generateSuggestions(conversationHistory, lastResponse) {
    if (!this.provider) {
      console.log('LLM Provider未初始化，跳过建议问题生成');
      return [];
    }

    // 智能判断是否需要生成建议问题
    if (!this.shouldGenerateSuggestions(conversationHistory, lastResponse)) {
      console.log('当前对话不适合生成建议问题，跳过');
      return [];
    }

    try {
      const prompt = this.buildSuggestionPrompt(conversationHistory, lastResponse);
      console.log('生成建议问题的提示词:', prompt.substring(0, 200) + '...');

      const response = await this.provider.createCompletion(prompt, {
        max_completion_tokens: 300
      });

      const content = response.trim();
      console.log('LLM返回的建议问题内容:', content);

      // 尝试解析JSON
      const suggestions = this.parseSuggestions(content);

      if (suggestions.length > 0) {
        console.log('成功生成建议问题:', suggestions);
        return suggestions.slice(0, 2); // 确保只返回2个
      } else {
        console.log('未能解析出有效的建议问题');
        return [];
      }

    } catch (error) {
      console.error('生成建议问题失败:', error);
      return [];
    }
  }

  /**
   * 智能判断是否应该生成建议问题
   * @param {Array} conversationHistory - 对话历史
   * @param {string} lastResponse - AI最后回复
   * @returns {boolean} 是否应该生成建议问题
   */
  shouldGenerateSuggestions(conversationHistory, lastResponse) {
    // 只保留最基本的过滤，其他交给LLM判断

    // 1. AI回复过于简短（少于20字符）- 这种情况确实不适合生成建议问题
    if (lastResponse.length < 20) {
      console.log('AI回复过于简短，不生成建议问题');
      return false;
    }

    // 2. 没有用户消息历史
    const userMessages = conversationHistory.filter(msg => msg.role === 'user');
    if (userMessages.length === 0) {
      console.log('没有用户消息历史，不生成建议问题');
      return false;
    }

    // 其他情况都交给LLM自己判断
    console.log('交给LLM判断是否生成建议问题');
    return true;
  }

  /**
   * 构建建议问题生成的提示词
   */
  buildSuggestionPrompt(conversationHistory, lastResponse) {
    // 提取最近的对话上下文（最多5轮对话）
    const recentHistory = conversationHistory.slice(-10); // 最多10条消息（5轮对话）

    const historyText = recentHistory
      .filter(msg => msg.role !== 'system')
      .map(msg => `${msg.role === 'user' ? '用户' : '杨院长'}: ${msg.content}`)
      .join('\n');

    return `你是杨院长的智能助手，负责判断是否需要生成建议问题。

请仔细分析以下对话，判断是否适合生成建议问题：

判断标准：
1. 【不生成】如果用户表达了结束意图（再见、谢谢、明白了、好的、知道了、没问题了）
2. 【不生成】如果杨院长的回复包含结束语（欢迎再次咨询、有问题随时联系、祝您健康美丽等）
3. 【不生成】如果是简单的问候对话（你好、早上好等）
4. 【不生成】如果用户连续问了相似的问题（表示可能在结束对话）
5. 【不生成】如果对话已经很完整，没有明显的延续点
6. 【生成】如果用户在咨询具体的医美项目，还有延伸问题的空间
7. 【生成】如果杨院长提到了多个方案，用户可能想了解对比

生成要求（如果需要生成）：
- 2个简短问题（8-15字）
- 与回复内容高度相关
- 以用户口吻，自然流畅
- 涵盖不同角度（效果、恢复期、注意事项、技术细节、适合人群等）
- 不要包含价格、费用、多少钱等金钱相关的问题

对话历史：
${historyText}

杨院长最新回复：
${lastResponse}

【重要】你只需要返回一个纯JSON数组，不要有任何其他文字或说明！
- 生成建议：["恢复期要多久？", "有什么注意事项？"]
- 不生成：[]`;
  }

  /**
   * 解析LLM返回的建议问题
   */
  parseSuggestions(content) {
    try {
      // 尝试直接解析JSON
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return this.cleanSuggestions(parsed);
      }
      // 处理对象格式，查找包含数组的字段
      if (typeof parsed === 'object' && parsed !== null) {
        // 查找可能的数组字段
        const possibleKeys = ['需要生成', 'suggestions', 'questions', 'result'];
        for (const key of possibleKeys) {
          if (Array.isArray(parsed[key])) {
            return this.cleanSuggestions(parsed[key]);
          }
        }
        // 如果没有找到数组字段，检查是否所有值都是数组
        const values = Object.values(parsed);
        for (const value of values) {
          if (Array.isArray(value)) {
            return this.cleanSuggestions(value);
          }
        }
      }
    } catch (error) {
      // JSON解析失败，尝试提取数组
      console.log('直接JSON解析失败，尝试提取数组');
    }

    try {
      // 尝试提取包含在代码块中的JSON
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          return this.cleanSuggestions(parsed);
        }
        // 处理代码块中的对象格式
        if (typeof parsed === 'object' && parsed !== null) {
          const values = Object.values(parsed);
          for (const value of values) {
            if (Array.isArray(value)) {
              return this.cleanSuggestions(value);
            }
          }
        }
      }
    } catch (error) {
      console.log('代码块JSON解析失败');
    }

    try {
      // 尝试查找方括号内的内容
      const arrayMatch = content.match(/\[(.*?)\]/);
      if (arrayMatch) {
        const parsed = JSON.parse(`[${arrayMatch[1]}]`);
        if (Array.isArray(parsed)) {
          return this.cleanSuggestions(parsed);
        }
      }
    } catch (error) {
      console.log('方括号内容解析失败');
    }

    // 最后尝试：使用正则表达式提取引号内的内容
    const quotedStrings = content.match(/"([^"]+)"/g);
    if (quotedStrings && quotedStrings.length >= 2) {
      return this.cleanSuggestions(
        quotedStrings.slice(0, 2).map(s => s.replace(/"/g, ''))
      );
    }

    console.log('所有解析方法都失败，返回空数组');
    return [];
  }

  /**
   * 清理和验证建议问题
   */
  cleanSuggestions(suggestions) {
    // 黑名单：过滤掉可能是格式说明或系统指令的内容
    const blacklist = [
      '需要生成', '不需要生成', '无需生成',
      'suggestions', 'questions', 'result',
      '问题1', '问题2', '例如', '示例'
    ];

    return suggestions
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      // 过滤黑名单内容
      .filter(s => !blacklist.some(word => s.includes(word)))
      .map(s => {
        let cleaned = s.trim();
        // 确保问题以问号结尾
        if (!cleaned.endsWith('？') && !cleaned.endsWith('?')) {
          cleaned += '？';
        }
        return cleaned;
      })
      .filter(s => s.length <= 20 && s.length >= 4) // 合理的长度范围
      .slice(0, 2); // 确保最多2个
  }

  /**
   * 获取备用建议问题（当LLM生成失败时使用）
   */
  getFallbackSuggestions() {
    const fallbacks = [
      ['效果能维持多久？', '有副作用吗？'],
      ['恢复期要多久？', '术后怎么护理？'],
      ['有更好的方案吗？', '什么时候做最好？'],
      ['会很疼吗？', '需要复诊吗？']
    ];

    // 随机选择一组备用问题
    const randomIndex = Math.floor(Math.random() * fallbacks.length);
    return fallbacks[randomIndex];
  }

  /**
   * 获取初始建议问题（用于问候语后显示）
   */
  getInitialSuggestions() {
    const initialSuggestions = [
      ['想了解什么项目？', '有什么问题想咨询？'],
      ['想改善哪个部位？', '有什么美丽愿望？'],
      ['想做哪种类型的项目？', '有具体的问题吗？']
    ];

    // 随机选择一组初始问题
    const randomIndex = Math.floor(Math.random() * initialSuggestions.length);
    return initialSuggestions[randomIndex];
  }
}

module.exports = new SuggestionService();