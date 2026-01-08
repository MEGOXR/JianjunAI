/**
 * 每日总结服务
 * 聚合当天所有会话的摘要，并支持懒加载生成
 *
 * 信息有损回退机制：
 * - 当预计算的总结中没有用户询问的具体细节时
 * - 自动回退到原始记录搜索
 */

const supabaseService = require('./supabaseService');
const ProviderFactory = require('./ProviderFactory');

const DAILY_SUMMARY_PROMPT = `你是一个医疗咨询助手的记忆管理员。
请将以下多个会话摘要合并成一个简洁的每日总结。

要求：
1. 200-400字以内
2. 合并相同主题，去除重复信息
3. 保留所有关键的医疗信息（项目名称、预算、具体数字）
4. 按重要性排序
5. 提取3-5个关键话题标签

会话摘要列表:
{summaries}

请按以下JSON格式输出:
{
  "summary": "每日总结内容...",
  "key_topics": ["话题1", "话题2", ...]
}`;

/**
 * 生成每日总结
 * @param {string} userUuid - 用户UUID
 * @param {string} date - 日期 (YYYY-MM-DD)
 * @returns {object|null} 每日总结
 */
async function generateDailySummary(userUuid, date) {
  if (!supabaseService.isAvailable()) {
    console.warn('[DailySummary] Supabase 不可用，跳过生成');
    return null;
  }

  // 获取当天所有会话摘要
  const sessions = await supabaseService.getSessionSummariesByDate(userUuid, date);

  if (sessions.length === 0) {
    console.log(`[DailySummary] 用户 ${userUuid} 在 ${date} 无会话记录`);
    return null;
  }

  console.log(`[DailySummary] 用户 ${userUuid} 在 ${date} 有 ${sessions.length} 个会话`);

  // 如果只有一个会话，直接使用其摘要
  if (sessions.length === 1 && sessions[0].summary) {
    const result = {
      summary: sessions[0].summary,
      key_topics: [],
      session_count: 1,
      message_count: sessions[0].message_count || 0
    };
    await supabaseService.saveDailySummary(userUuid, date, result);
    return result;
  }

  // 合并多个会话摘要
  const summariesText = sessions
    .filter(s => s.summary)
    .map((s, i) => `会话${i + 1}: ${s.summary}`)
    .join('\n\n');

  if (!summariesText) {
    console.log(`[DailySummary] 用户 ${userUuid} 在 ${date} 无有效摘要`);
    return null;
  }

  try {
    const provider = ProviderFactory.getLLMProvider();
    await provider.initialize();

    const response = await provider.createCompletion(
      DAILY_SUMMARY_PROMPT.replace('{summaries}', summariesText),
      {
        maxCompletionTokens: 500,
        temperature: 0.3,
        responseFormat: { type: 'json_object' }
      }
    );

    const result = JSON.parse(response.trim());
    result.session_count = sessions.length;
    result.message_count = sessions.reduce((sum, s) => sum + (s.message_count || 0), 0);

    await supabaseService.saveDailySummary(userUuid, date, result);
    console.log(`[DailySummary] 用户 ${userUuid} 每日总结生成成功`);

    return result;
  } catch (error) {
    console.error('[DailySummary] 生成每日总结失败:', error.message);
    return null;
  }
}

/**
 * 获取每日总结（懒加载：如果没有则现场生成）
 * @param {string} userUuid - 用户UUID
 * @param {string} date - 日期 (YYYY-MM-DD)
 * @returns {object|null} 每日总结
 */
async function getDailySummary(userUuid, date) {
  if (!supabaseService.isAvailable()) {
    return null;
  }

  // 先尝试从缓存获取
  let summary = await supabaseService.getDailySummary(userUuid, date);

  if (!summary) {
    // 懒加载生成
    console.log(`[DailySummary] 用户 ${userUuid} 的 ${date} 总结不存在，触发懒加载生成`);
    summary = await generateDailySummary(userUuid, date);
  }

  return summary;
}

/**
 * 获取每日总结，如果总结中可能缺少细节，则附带原始记录
 * (信息有损回退机制)
 *
 * @param {string} wechatOpenId - 微信OpenID
 * @param {string} date - 日期 (YYYY-MM-DD)
 * @param {string} query - 用户的具体问题（用于判断是否需要细节）
 * @returns {object} { summary, rawMessages?, needsDetailSearch }
 */
async function getDailySummaryWithFallback(wechatOpenId, date, query = '') {
  const result = {
    summary: null,
    rawMessages: null,
    needsDetailSearch: false
  };

  if (!supabaseService.isAvailable()) {
    return result;
  }

  // 获取用户信息
  const user = await supabaseService.getUserByWechatId(wechatOpenId);
  if (!user) {
    return result;
  }

  // 获取每日总结
  const dailySummary = await getDailySummary(user.uuid, date);

  if (dailySummary) {
    result.summary = dailySummary.summary;
  }

  // 检测是否需要细节搜索
  // 如果用户询问包含具体信息的关键词，则触发原始记录搜索
  const detailPatterns = [
    /具体|详细|原话|说的是|什么名字|叫什么|多少钱|几号|哪一天|第一句|最后/,
    /药|价格|费用|预算|医生|医院|时间|日期|地址|电话/
  ];

  const needsDetail = detailPatterns.some(pattern => pattern.test(query));

  if (needsDetail || !dailySummary) {
    console.log(`[DailySummary] 检测到细节查询或无总结，触发原始记录搜索`);
    result.needsDetailSearch = true;

    // 获取原始记录作为补充
    try {
      const rawMessages = await supabaseService.searchMessages(wechatOpenId, {
        startTime: `${date}T00:00:00`,
        endTime: `${date}T23:59:59`,
        limit: 20,
        order: 'asc'
      });

      if (rawMessages && rawMessages.length > 0) {
        result.rawMessages = rawMessages;
        console.log(`[DailySummary] 获取到 ${rawMessages.length} 条原始记录作为补充`);
      }
    } catch (error) {
      console.error('[DailySummary] 获取原始记录失败:', error.message);
    }
  }

  return result;
}

module.exports = {
  generateDailySummary,
  getDailySummary,
  getDailySummaryWithFallback
};
