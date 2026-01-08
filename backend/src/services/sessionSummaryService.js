/**
 * 会话总结服务
 * 在用户断开连接或空闲超时时异步生成会话摘要
 */
const supabaseService = require('./supabaseService');
const ProviderFactory = require('./ProviderFactory');

const SESSION_SUMMARY_PROMPT = `你是一个医疗咨询助手的记忆管理员。
请根据以下对话内容，生成一个简洁的会话摘要。

要求：
1. 100-200字以内
2. 提取用户的主要问题和关注点
3. 记录达成的结论或建议
4. 使用第三人称描述（"用户"而非"你"）
5. 保留关键的医疗信息（项目名称、预算、顾虑等）
6. 如果对话太短或只是简单问候，也要如实记录（如"用户进行了简单问候"）

对话内容:
{conversation}

请输出摘要（仅输出摘要内容，不要其他格式）:`;

/**
 * 生成会话摘要
 * @param {string} sessionId - 会话ID
 * @param {Array} messages - 消息数组 [{ role, content }, ...]
 * @returns {string|null} 生成的摘要
 */
async function generateSessionSummary(sessionId, messages) {
  // 过滤系统消息，只保留用户和助手对话
  const conversation = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const speaker = m.role === 'user' ? '用户' : '杨院长';
      // 处理 content 可能是数组的情况（Vision API）
      const content = typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content) ? m.content.map(c => c.text || '[图片]').join(' ') : '');
      return `${speaker}: ${content}`;
    })
    .join('\n');

  // 对话太短不生成摘要
  if (conversation.length < 50) {
    console.log(`[SessionSummary] 对话太短 (${conversation.length} 字符)，跳过摘要生成`);
    return null;
  }

  try {
    const provider = ProviderFactory.getLLMProvider();
    await provider.initialize();

    const response = await provider.createCompletion(
      SESSION_SUMMARY_PROMPT.replace('{conversation}', conversation),
      {
        maxCompletionTokens: 300,
        temperature: 0.3
      }
    );

    const summary = response.trim();
    console.log(`[SessionSummary] 会话 ${sessionId} 摘要生成成功 (${summary.length} 字符)`);

    // 保存到数据库
    if (supabaseService.isAvailable()) {
      await supabaseService.updateSessionSummary(sessionId, summary);
    }

    return summary;
  } catch (error) {
    console.error('[SessionSummary] 生成会话摘要失败:', error.message);
    return null;
  }
}

/**
 * 异步生成会话摘要（不阻塞主流程）
 * @param {string} sessionId - 会话ID
 * @param {Array} messages - 消息数组
 */
function generateSessionSummaryAsync(sessionId, messages) {
  // 使用 setImmediate 确保不阻塞断开流程
  setImmediate(async () => {
    try {
      await generateSessionSummary(sessionId, messages);
    } catch (error) {
      console.error('[SessionSummary] 异步生成失败:', error.message);
    }
  });
}

module.exports = {
  generateSessionSummary,
  generateSessionSummaryAsync
};
