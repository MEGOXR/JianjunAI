const userDataService = require('../services/userDataService');
const greetingService = require('../services/greetingService');
const nameExtractorService = require('../services/nameExtractorService');
const promptService = require('../services/promptService');
const suggestionService = require('../services/suggestionService');
const memoryService = require('../services/memoryService');
const azureBlobService = require('../services/azureBlobService');
const supabaseService = require('../services/supabaseService');
const ErrorHandler = require('../middleware/errorHandler');
const AzureClientFactory = require('../utils/AzureClientFactory');
const StreamSmoother = require('../utils/StreamSmoother');

// Provider支持
const ConfigService = require('../services/ConfigService');
const ProviderFactory = require('../services/ProviderFactory');

// 性能计时工具
class PerformanceTimer {
  constructor(requestId) {
    this.requestId = requestId;
    this.timings = {};
    this.startTime = Date.now();
    this.marks = [];
  }

  mark(label, metadata = {}) {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const lastMark = this.marks.length > 0 ? this.marks[this.marks.length - 1] : null;
    const delta = lastMark ? now - lastMark.timestamp : elapsed;

    const mark = {
      label,
      timestamp: now,
      elapsed,
      delta,
      ...metadata
    };

    this.marks.push(mark);
    console.log(`[${this.requestId}] ⏱️ ${label}: +${delta}ms (total: ${elapsed}ms)`, metadata);

    return mark;
  }

  getReport() {
    return {
      requestId: this.requestId,
      totalTime: Date.now() - this.startTime,
      marks: this.marks
    };
  }
}

// 环境变量读取辅助函数
function getEnvVar(name) {
  return process.env[name] || process.env[`APPSETTING_${name}`] || null;
}

// 使用 userId 作为 key 来存储对话历史
const chatHistories = new Map();

// 内存管理配置
const MAX_HISTORY_SIZE = 100;
const CLEANUP_INTERVAL = 15 * 60 * 1000;
const MAX_IDLE_TIME = 2 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_USER = 31;

// 清理功能
function cleanupChatHistories() {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [userId, history] of chatHistories.entries()) {
    const lastAccess = history.lastAccess || 0;
    if (now - lastAccess > MAX_IDLE_TIME) {
      chatHistories.delete(userId);
      cleanedCount++;
      continue;
    }

    if (history.messages && history.messages.length > MAX_MESSAGES_PER_USER) {
      history.messages.splice(0, history.messages.length - MAX_MESSAGES_PER_USER);
    }
  }

  if (chatHistories.size > MAX_HISTORY_SIZE) {
    const sortedEntries = [...chatHistories.entries()]
      .sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));

    const toRemove = sortedEntries.slice(0, chatHistories.size - MAX_HISTORY_SIZE);
    toRemove.forEach(([userId]) => {
      chatHistories.delete(userId);
      cleanedCount++;
    });
  }

  if (cleanedCount > 0) {
    console.log(`Memory cleanup: removed ${cleanedCount} histories. Current size: ${chatHistories.size}`);
  }
}

// 启动定期清理
const cleanupTimer = setInterval(cleanupChatHistories, CLEANUP_INTERVAL);

// 优雅关闭
process.on('SIGTERM', () => {
  clearInterval(cleanupTimer);
  chatHistories.clear();
});

// 获取用户ID
const getUserId = (ws) => {
  if (!ws.userId) {
    console.error('WebSocket没有用户ID，JWT认证可能失败');
    throw new Error('User ID not found - authentication required');
  }
  return ws.userId;
};

/**
 * 构建用户消息（支持 Vision API）
 * @param {string} prompt - 文本内容
 * @param {array} images - base64 编码的图片数组
 * @returns {object} - 用户消息对象
 */
const buildUserMessage = (prompt, images = []) => {
  // 如果没有图片，返回简单的文本消息
  if (!images || images.length === 0) {
    return { role: "user", content: prompt };
  }

  // 如果有图片，构建 Vision API 格式的消息
  const content = [];

  // 添加文本部分（如果有）
  if (prompt && prompt.trim()) {
    content.push({ type: "text", text: prompt });
  }

  // 添加图片部分
  images.forEach(imageBase64 => {
    content.push({
      type: "image_url",
      image_url: {
        url: imageBase64,
        detail: "high"  // 使用高分辨率分析
      }
    });
  });

  // 如果没有文本，添加默认提示
  if (content.length === images.length) {
    content.unshift({
      type: "text",
      text: "请分析这些图片并提供专业的整形建议"
    });
  }

  return { role: "user", content };
};

exports.buildUserMessage = buildUserMessage;

exports.sendMessage = async (ws, prompt, images = []) => {
  // 创建请求ID和计时器
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const timer = new PerformanceTimer(requestId);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${requestId}] 🚀 新请求开始`);
  console.log(`用户: ${ws.userId}`);
  console.log(`问题: ${prompt || '(仅图片)'}`);
  console.log(`图片: ${images.length} 张`);
  console.log(`${'='.repeat(60)}`);

  timer.mark('请求接收完成', { prompt: prompt.substring(0, 50), imageCount: images.length });

  const useProvider = ConfigService.isProviderEnabled();
  let uploadedImageUrls = []; // 存储上传到 Azure Blob 的图片信息

  try {
    // 🖼️ 上传图片到 Azure Blob Storage（如果有图片）
    if (images && images.length > 0 && azureBlobService.isAvailable()) {
      timer.mark('开始上传图片到 Azure Blob Storage');

      try {
        // 将 base64 图片转换为 Buffer
        const imageBuffers = images.map(base64 =>
          azureBlobService.base64ToBuffer(base64)
        );

        // 批量上传
        uploadedImageUrls = await azureBlobService.uploadImages(imageBuffers, ws.userId);

        timer.mark('图片上传完成', {
          imageCount: uploadedImageUrls.length,
          totalSize: uploadedImageUrls.reduce((sum, img) => sum + img.size, 0)
        });

        console.log(`[${requestId}] ✅ ${uploadedImageUrls.length} 张图片已上传到 Azure Blob Storage`);
      } catch (uploadError) {
        console.error(`[${requestId}] ⚠️ 图片上传失败，将使用 base64:`, uploadError.message);
        // 上传失败不影响对话继续，使用原 base64
      }
    }
    // 1. 验证配置
    timer.mark('开始验证配置');
    if (useProvider) {
      console.log(`使用 ${ConfigService.getProviderType()} Provider`);
    } else {
      AzureClientFactory.validateConfig();
      console.log('Azure配置验证通过');
    }
    timer.mark('配置验证完成');

    // 2. 获取用户ID
    const userId = getUserId(ws);
    timer.mark('用户ID获取完成', { userId });

    // 3. 异步获取用户数据
    timer.mark('开始获取用户数据');
    const userDataPromise = userDataService.getUserData(userId);

    // 4. 获取增强的系统提示词（包含Memobase记忆）
    timer.mark('开始获取增强系统提示词');
    let enhancedSystemPrompt = promptService.getSystemPrompt();
    try {
      enhancedSystemPrompt = await memoryService.getEnhancedSystemPrompt(userId);
      timer.mark('增强系统提示词获取完成', { hasMemory: enhancedSystemPrompt.includes('用户记忆档案') });
    } catch (err) {
      console.warn('获取增强系统提示词失败，使用默认提示词:', err.message);
    }

    // 5. 初始化或获取对话历史
    timer.mark('开始初始化对话历史');
    let loadedFromSupabase = false;

    if (!chatHistories.has(userId)) {
      // 尝试从 userDataService 获取 (本地缓存)
      let savedHistory = [];
      try {
        const userData = await userDataPromise;
        savedHistory = userData?.chatHistory || [];
      } catch (e) {
        console.warn('获取本地用户数据失败:', e.message);
      }

      // 如果本地没有历史，尝试从 Supabase 获取 (持久化存储)
      // 这解决了 Azure重新部署后本地文件丢失导致上下文丢失的问题
      if (savedHistory.length === 0) {
        try {
          savedHistory = await memoryService.getLegacyChatHistory(userId, 10);
          if (savedHistory.length > 0) {
            loadedFromSupabase = true;
          }
        } catch (e) {
          console.warn('从Supabase获取历史失败:', e.message);
        }
      }

      // 初始化内存中的历史记录
      chatHistories.set(userId, {
        messages: [
          {
            role: "system",
            content: enhancedSystemPrompt
          },
          ...savedHistory // 恢复历史消息
        ],
        lastAccess: Date.now()
      });
      timer.mark('创建新的对话历史', { source: loadedFromSupabase ? 'Supabase' : 'Local/Empty' });
    } else {
      // 更新现有历史中的系统提示词
      const historyData = chatHistories.get(userId);
      if (historyData?.messages?.[0]?.role === 'system') {
        historyData.messages[0].content = enhancedSystemPrompt;
      }
    }

    // 6. 获取当前内存中的历史记录
    let historyData = chatHistories.get(userId);
    timer.mark('获取对话历史完成', { messageCount: historyData?.messages?.length });

    // 确保格式正确
    if (Array.isArray(historyData)) {
      chatHistories.set(userId, {
        messages: historyData,
        lastAccess: Date.now()
      });
      historyData = chatHistories.get(userId);
    } else if (historyData && typeof historyData === 'object') {
      historyData.lastAccess = Date.now();
    } else {
      historyData = {
        messages: [
          { role: "system", content: promptService.getSystemPrompt() }
        ],
        lastAccess: Date.now()
      };
      chatHistories.set(userId, historyData);
    }

    let history = historyData.messages || [];

    // 7. 添加用户消息（支持 Vision API）
    const userMessage = buildUserMessage(prompt, images);
    history.push(userMessage);
    timer.mark('用户消息添加完成', { hasImages: images.length > 0 });

    // 8. 缓冲用户消息到 Memobase（异步，不阻塞）
    const textContent = prompt || (images.length > 0 ? `上传了${images.length}张图片咨询` : '');
    memoryService.processUserMessage(userId, textContent).catch(err => {
      console.warn('缓冲用户消息到Memobase失败:', err.message);
    });

    // 7. 发送初始化消息
    ws.send(JSON.stringify({
      type: 'init',
      userId: userId,
      requestId: requestId,
      timing: timer.getReport()
    }));
    timer.mark('初始化消息发送完成');

    // ==================================================================================
    // 🧠 主动回忆 (Active Recall) & 🌊 平滑流式输出 (Stream Smoothing)
    // ==================================================================================

    // 初始化平滑器
    // 创建一个发送函数，用来封装 ws.send
    let tokenIndex = 0;
    const sendToWs = (chunk) => {
      tokenIndex++;
      ws.send(JSON.stringify({
        data: chunk,
        timing: {
          elapsed: Date.now() - timer.startTime,
          tokenIndex: tokenIndex
        }
      }));
    };

    const smoother = new StreamSmoother(sendToWs, {
      minDelay: 15,
      maxDelay: 40
    });

    // 辅助函数：定义如何清洗文本（去除 Markdown 干扰）
    // 辅助函数：定义如何清洗文本（不再去除 Markdown，前端已支持）
    const cleanText = (text) => text;

    // 辅助函数：创建 LLM 流
    const createStream = async (inputMessages) => {
      let currentStream;
      if (useProvider) {
        const llmProvider = ProviderFactory.getLLMProvider();
        await llmProvider.initialize();
        currentStream = await llmProvider.createChatStream(inputMessages, { maxCompletionTokens: 1000 });
      } else {
        AzureClientFactory.validateConfig();
        const client = AzureClientFactory.getClient();
        currentStream = await client.chat.completions.create({
          model: AzureClientFactory.getDeploymentName(),
          messages: inputMessages,
          stream: true,
          max_completion_tokens: 2000,
          stop: null
        });
      }
      return currentStream;
    };

    // 🕵️ 意图识别 & 主动回忆 (递归版)
    // 允许 LLM 在一次回复中多次触发搜索 (目前限制为 3 次以防死循环)

    let assistantResponse = '';
    let searchBuffer = ''; // 用于检测 [SEARCH: ...] 的临时缓冲

    // ⏱️ 时间感知计算
    // 计算距离上次会话的时间，并注入到 Prompt 中
    let timeAwarenessPrompt = '';

    // 【修改】注入当前时间，确保 LLM 知道现在的绝对时间
    const now = new Date();
    const currentDateStr = now.toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'long'
    });

    // 基础时间上下文
    let timeContext = `\n[System Note: Time Context]\nCurrent Date & Time: ${currentDateStr}\n`;

    try {
      // 尝试从 userDataService 获取最后访问时间
      // 注意：此时 history 已经被更新了当前消息，所以要看更早的时间可能需要查 Supabase 或 user metadata
      // 简化逻辑：如果在 history 初始化时发现是 loadedFromSupabase，或者 chatHistories 虽然有值但是 lastAccess 很久以前

      // 我们通过 userDataService 获取的原始 data 来判断
      const userData = await userDataPromise;
      if (userData && userData.lastVisit) {
        const lastVisitDate = new Date(userData.lastVisit);
        // const now = new Date(); // 上面定义了
        const diffHours = (now - lastVisitDate) / (1000 * 60 * 60);

        if (diffHours > 24) {
          const days = Math.floor(diffHours / 24);
          const dateStr = lastVisitDate.toLocaleDateString('zh-CN');
          timeAwarenessPrompt = `
[System Note: Context Awareness]
用户上一次对话是在 ${days} 天前 (${dateStr})。
如果用户是回头客，请在回复中自然地体现出"好久不见"或承接上次话题的感觉，不要表现得像第一次认识一样。
但如果不确定，就保持礼貌专业即可。`;
          console.log(`[TimeAwareness] 检测到用户 ${days} 天未访问，注入时间感知提示`);
        }
      }
    } catch (e) {
      console.warn('时间感知计算失败:', e);
    }

    // 构建用于本次请求的消息列表
    // 注意：history 包含 [System, ...Previous, User]
    // 我们要在 System Prompt 之后插入 timeAwarenessPrompt，或者直接拼在 System Prompt 里
    // 为了不污染持久化的 system prompt，我们构建一个临时的 messages 数组

    let messagesForLlm = [...history]; // 浅拷贝

    // 如果有时间感知提示，且 history[0] 是 system，则追加提示
    // 或者作为第二条 system 消息插入
    if (messagesForLlm.length > 0 && messagesForLlm[0].role === 'system') {
      // 更新第一条 System Message 的内容 (仅对本次请求生效，不修改 history 对象)
      // 【修改】同时注入 current time 和 time awareness
      messagesForLlm[0] = {
        ...messagesForLlm[0],
        content: messagesForLlm[0].content + timeContext + timeAwarenessPrompt
      };
    }

    // 过滤掉不可接受的 role (防守性编程)
    messagesForLlm = messagesForLlm.filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant');

    // 准备进入循环
    let currentInputMessages = messagesForLlm;

    let searchAttemptCount = 0;
    const MAX_SEARCH_ATTEMPTS = 3;
    let firstTokenReceived = false;
    let tokenCount = 0;
    let isSearchTriggered = false; // 用于后续判断

    // ♻️ 主循环：处理流和搜索
    const searchedQueries = new Set(); // 🛡️ 防止重复搜索的集合

    while (searchAttemptCount < MAX_SEARCH_ATTEMPTS) {
      // 记录日志
      if (searchAttemptCount === 0) {
        timer.mark('开始第一次调用LLM');
      } else {
        console.log(`[${requestId}] 🔄 开始第 ${searchAttemptCount + 1} 轮 LLM 调用 (搜索深度: ${searchAttemptCount})`);
        timer.mark(`开始第${searchAttemptCount + 1}次调用LLM`);
        // 确保平滑器恢复 (因为搜索时暂停了)
        smoother.resume();
      }

      // 1. 创建流
      let stream;
      try {
        stream = await createStream(currentInputMessages);
      } catch (err) {
        console.error(`[${requestId}] 创建LLM流失败:`, err);
        // 如果是在递归步骤中失败，最好不要让整个请求挂掉，而是结束当前循环
        if (searchAttemptCount > 0) {
          smoother.push('\n(连接不稳定，请稍后再试)');
          break;
        }
        throw err; // 第一轮就失败则抛出
      }

      // 2. 处理流
      let foundSearchTagInThisLoop = false;

      // 每次新流开始，searchBuffer 应该是空的，因为上下文已经更新，LLM 是接着说的
      // 但要注意：如果上一轮 searchBuffer 里残留了半个 tag (理论上不应该，因为我们只会 break on full tag)，
      // 这里的逻辑是每次全新的生成。
      searchBuffer = '';

      for await (const chunk of stream) {
        const content = chunk.choices?.[0]?.delta?.content;
        if (content === undefined || content === null) continue;

        if (!firstTokenReceived) {
          firstTokenReceived = true;
          timer.mark('🎯 首个Token接收 (TTFT)');
        }

        tokenCount++;
        assistantResponse += content;

        // 🕵️ 实时检测 [SEARCH: ...] 标记
        searchBuffer += content;

        const openBracketIndex = searchBuffer.indexOf('[');

        if (openBracketIndex === -1) {
          // 没有 '['，安全输出
          // 额外检查：确保不会意外输出 SEARCH 标记
          if (searchBuffer.toUpperCase().includes('SEARCH')) {
            console.warn(`⚠️ 警告：尝试输出包含SEARCH的内容: "${searchBuffer}"`);
          }
          smoother.push(cleanText(searchBuffer));
          searchBuffer = '';
        } else {
          // 有 '['，可能是 tag
          // 先把 '[' 之前的内容安全输出
          if (openBracketIndex > 0) {
            const safePrefix = searchBuffer.substring(0, openBracketIndex);
            smoother.push(cleanText(safePrefix));
            searchBuffer = searchBuffer.substring(openBracketIndex);
          }

          // 现在 searchBuffer 以 '[' 开头
          // 检查是否有闭合的 ']'
          const closeBracketIndex = searchBuffer.indexOf(']');

          if (closeBracketIndex !== -1) {
            // ✅ 捕获到了完整 tag: [XXXX]
            const fullTag = searchBuffer.substring(0, closeBracketIndex + 1);

            // 检查是不是 SEARCH 指令
            if (fullTag.toUpperCase().includes('SEARCH')) {
              // 【修改】解析 JSON 或 String 参数
              let queryOrParams = fullTag.replace(/\[SEARCH:?/, '').replace(']', '').trim();

              // 尝试解析 JSON
              try {
                // 如果不以 { 开头，说明是旧文本格式，不做处理
                if (queryOrParams.startsWith('{')) {
                  queryOrParams = JSON.parse(queryOrParams);
                  console.log(`🕵️ 捕获到高级搜索指令:`, queryOrParams);
                } else {
                  console.log(`🕵️ 捕获到文本搜索指令: "${queryOrParams}"`);
                }
              } catch (e) {
                console.warn(`⚠️ SEARCH 参数不是有效的 JSON，回退为普通文本搜索: ${queryOrParams}`);
              }

              timer.mark('捕获到搜索指令', { query: JSON.stringify(queryOrParams), depth: searchAttemptCount });

              // ⏸️ 暂停平滑器 (防止用户看到这部分停顿)
              smoother.pause();

              // 从 assistantResponse 中移除该指令
              assistantResponse = assistantResponse.replace(fullTag, '');

              // 清理 searchBuffer
              searchBuffer = searchBuffer.substring(closeBracketIndex + 1);

              // --- 执行异步搜索 ---
              try {
                let searchResults = [];
                // 如果参数是空的，兜底用 prompt
                const finalParams = queryOrParams || prompt;
                const queryString = JSON.stringify(finalParams);

                // 🛡️ 重复搜索检测
                if (searchedQueries.has(queryString)) {
                  console.warn(`🛑 拦截到重复搜索: ${queryString}, 跳过实际查询`);
                  searchResults = []; // 既然重复，说明上次也没找到，或者找到了也已经包含了
                  // 特殊标记，让 Context 反映这是重复操作
                } else {
                  searchedQueries.add(queryString);
                  try {
                    searchResults = await memoryService.searchEvents(userId, finalParams, 3);
                  } catch (memobaseError) {
                    console.error('Memobase/Supabase 搜索失败:', memobaseError.message);
                    searchResults = [];
                  }
                }

                let searchResultContext = '';
                if (searchResults && searchResults.length > 0) {
                  console.log(`🔍 搜索完成，找到 ${searchResults.length} 条记录`);
                  console.log(`🔍 搜索结果详情:`, JSON.stringify(searchResults, null, 2));
                  searchResultContext = searchResults.map(e => {
                    const time = e.timestamp ? new Date(e.timestamp).toLocaleDateString() : '未知时间';
                    return `- [${time}]: ${e.content || e}`;
                  }).join('\n');
                  console.log(`🔍 格式化后的搜索上下文:\n${searchResultContext}`);
                } else {
                  console.log('🔍 搜索完成，无记录');
                  searchResultContext = '未找到相关历史记录。（注意：如果这是你刚刚搜索过的词，说明真的没有记录，请不要再次搜索相同的词，直接回答用户。）';
                }

                // 构建后续 Prompt
                const alreadySpoken = assistantResponse.trim();
                // const safeSearchQuery = typeof queryOrParams === 'object' ? JSON.stringify(queryOrParams) : queryOrParams;

                // 🔍 打印第一轮LLM生成的内容，用于调试
                console.log(`[${requestId}] 📝 第一轮LLM已生成内容: "${alreadySpoken}"`);

                // 🔍 检测是否需要清空第一轮内容
                let shouldClear = false;
                let clearReason = '';

                // 策略1: 检测负面判断词
                const negativePatterns = ['没找到', '没有找到', '查不到', '没有记录', '找不到', '无法找到', '没有相关'];
                const hasNegativeJudgment = negativePatterns.some(pattern => alreadySpoken.includes(pattern));

                if (hasNegativeJudgment) {
                  shouldClear = true;
                  clearReason = '包含负面判断';
                }

                // 策略2: 当搜索成功找到记录时，如果第一轮是"过渡话"，则清空
                // 这样可以避免"我来确认一下"这类话影响第二轮的判断
                const hasSearchResults = searchResults && searchResults.length > 0;
                const isTransitionalPhrase = alreadySpoken.includes('查') ||
                  alreadySpoken.includes('确认') ||
                  alreadySpoken.includes('稍等') ||
                  alreadySpoken.includes('片刻');

                if (hasSearchResults && isTransitionalPhrase) {
                  shouldClear = true;
                  clearReason = '搜索成功且第一轮为过渡话';
                }

                if (shouldClear) {
                  console.log(`[${requestId}] ⚠️ 将清空第一轮内容 (原因: ${clearReason})`);
                  assistantResponse = '';
                }

                const finalAlreadySpoken = assistantResponse.trim();
                console.log(`[${requestId}] 📝 最终传给第二轮的内容: "${finalAlreadySpoken}" (已清空: ${shouldClear}, 原因: ${clearReason || '无'})`);

                // 判断是否真的有搜索结果
                const hasActualResults = !searchResultContext.includes('未找到相关历史记录');

                const followUpSystemPrompt = `${promptService.getSystemPrompt()}

【🔍 搜索结果插播】
系统已搜索到以下信息：
${searchResultContext}

**🚨 强制执行指令 - 必须严格遵守！**：

${hasActualResults ? `
✅ **搜索状态：成功找到记录**

1. **你必须这样回答**：
   "记得的！昨天你跟我聊过，具体是：[然后逐条列出上面搜索到的对话内容]"

2. **严格禁止**：
   ❌ 不要说"没有相关记录"
   ❌ 不要说"没有实质性对话"
   ❌ 不要说"只是简单问候"
   ❌ 不要判断对话是否"有意义"

3. **为什么？**
   - 用户问"昨天聊了什么"，是想知道**所有对话**，不管是问候、闲聊还是咨询
   - 上面列出的每一条都是**真实发生的对话**，必须如实告知
   - "还记得我是谁吗"也是对话内容，必须说出来

4. **标准回答模板**：
   "记得的！昨天咱们聊过。我看了一下记录，您当时[描述搜索到的对话内容]。"
` : `
❌ **搜索状态：未找到记录**

回答：
"抱歉，我查了一下昨天的记录，好像没有找到相关的对话。可能您记错了日期，或者是更早之前聊过的？"
`}

5. **如何回答**：${finalAlreadySpoken ? `请接着你刚才的话继续说，但要基于上面的搜索结果纠正或补充。` : '请直接基于搜索结果回答。'}

🛑 **严禁再次发起 [SEARCH]！** 所有信息已经在上面了。`;

                // 更新 Messages，准备下一轮递归
                currentInputMessages = [
                  { role: 'system', content: followUpSystemPrompt },
                  ...history.filter(m => m.role !== 'system'),
                  // 如果已清空alreadySpoken，则不添加assistant消息，让LLM重新开始
                  ...(finalAlreadySpoken ? [{ role: 'assistant', content: finalAlreadySpoken }] : [])
                ];

                // 🔍 打印第二轮LLM收到的完整消息
                console.log(`[${requestId}] 📋 第二轮LLM输入消息总数: ${currentInputMessages.length}`);
                console.log(`[${requestId}] 📋 第二轮System Prompt (前500字符):\n${followUpSystemPrompt.substring(0, 500)}...`);
                console.log(`[${requestId}] 📋 第二轮System Prompt包含搜索结果: ${followUpSystemPrompt.includes(searchResultContext)}`);
                console.log(`[${requestId}] 📋 搜索结果内容长度: ${searchResultContext.length} 字符`);

                foundSearchTagInThisLoop = true;
                isSearchTriggered = true;
                searchAttemptCount++;
                break; // 🚨 跳出 for await (stream)，进入下一次 createStream

              } catch (searchErr) {
                console.error('❌ 搜索流程异常:', searchErr);
                // 恢复并继续
                smoother.resume();
                searchAttemptCount = MAX_SEARCH_ATTEMPTS;
                break;
              }

            } else {
              // 是 [XXX] 但不是 SEARCH，当作普通文本输出
              smoother.push(cleanText(fullTag));
              searchBuffer = searchBuffer.substring(closeBracketIndex + 1);
            }
          } else {
            // 有 '[' 但没有 ']'，继续缓冲
            // 安全检查：如果缓冲太长，说明可能不是 tag，强制输出以防卡死
            if (searchBuffer.length > 100) { // 稍微放宽一点，因为 JSON 可能比较长
              smoother.push(cleanText(searchBuffer));
              searchBuffer = '';
            }
          }
        }
      } // end for await loop

      // stream 结束了
      if (!foundSearchTagInThisLoop) {
        // 如果流自然结束且没有 triggers，说明已经说完了
        break; // 退出 while loop
      }

      // 如果 foundSearchTagInThisLoop 为 true，while 循环会继续，使用新的 messages 再次请求 LLM
    }

    // 循环结束后，处理剩余的 searchBuffer
    if (searchBuffer) {
      smoother.push(cleanText(searchBuffer));
    }

    // 💡 确保所有内容都输出 (等待平滑器跑完)
    await smoother.flush();

    timer.mark('流式响应处理完成', {
      totalTokens: tokenCount,
      responseLength: assistantResponse.length
    });

    // 10. 保存助手响应
    history.push({ role: "assistant", content: assistantResponse });

    // 10.5 保存图片信息到 Supabase（如果有图片）
    if (uploadedImageUrls.length > 0 && supabaseService.isAvailable()) {
      timer.mark('开始保存图片信息到 Supabase');

      try {
        // 获取用户信息
        const user = await supabaseService.getUserByWechatId(userId);
        if (user) {
          // 获取或创建会话
          let session = await supabaseService.getActiveSession(user.uuid);
          if (!session) {
            session = await supabaseService.createSession(user.uuid);
          }

          // 保存带图片的消息（AI 的响应就是对图片的分析）
          await supabaseService.saveMessageWithImages(
            session.id,
            user.uuid,
            prompt || '(发送了图片)',
            uploadedImageUrls,
            assistantResponse // AI 对图片的分析结果
          );

          timer.mark('图片信息保存到 Supabase 完成', {
            imageCount: uploadedImageUrls.length
          });

          console.log(`[${requestId}] ✅ 图片信息已保存到 Supabase`);
        }
      } catch (supabaseError) {
        console.error(`[${requestId}] ⚠️ 保存图片信息到 Supabase 失败:`, supabaseError.message);
        // 不阻塞主流程
      }
    }

    // 11. 缓冲助手消息到 Memobase（异步，不阻塞）
    // 如果有图片，将AI分析结果作为特殊标记保存到Memobase
    if (uploadedImageUrls.length > 0) {
      const imageAnalysisSummary = `【图片分析】用户上传了${uploadedImageUrls.length}张图片，AI分析结果：${assistantResponse.substring(0, 200)}${assistantResponse.length > 200 ? '...' : ''}`;
      memoryService.processAssistantMessage(userId, imageAnalysisSummary).catch(err => {
        console.warn('缓冲图片分析结果到Memobase失败:', err.message);
      });
    } else {
      memoryService.processAssistantMessage(userId, assistantResponse).catch(err => {
        console.warn('缓冲助手消息到Memobase失败:', err.message);
      });
    }

    // 12. 限制历史长度
    if (history.length > 31) {
      const systemMessage = history.find(msg => msg.role === 'system');
      const recentHistory = history.slice(-30);
      history = systemMessage ? [systemMessage, ...recentHistory] : recentHistory;

      historyData.messages = history;
      timer.mark('历史记录裁剪完成');
    }

    // 12. 异步保存历史
    userDataService.updateChatHistory(userId, history)
      .then(() => timer.mark('历史记录持久化完成'))
      .catch(error => {
        console.error('保存历史失败:', error);
        timer.mark('历史记录持久化失败', { error: error.message });
      });

    // 13. 获取建议问题
    timer.mark('开始获取建议问题');
    const suggestions = await suggestionService.generateSuggestions(
      history,
      assistantResponse
    );
    timer.mark('建议问题获取完成', { suggestionCount: suggestions.length });

    // 14. 发送完成消息
    ws.send(JSON.stringify({
      done: true,
      suggestions: suggestions,
      timing: timer.getReport()
    }));

    // 最终报告
    const report = timer.getReport();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${requestId}] ✅ 请求处理完成`);
    console.log(`总耗时: ${report.totalTime}ms`);
    console.log(`TTFT: ${report.marks.find(m => m.label.includes('TTFT'))?.elapsed || 'N/A'}ms`);
    console.log(`Token数: ${tokenCount}`);
    console.log(`${'='.repeat(60)}\n`);

    // 记录用户活动（用于空闲检测兜底）
    memoryService.recordUserActivity(userId, history);

  } catch (error) {
    timer.mark('错误发生', { error: error.message });
    console.error('处理消息时出错:', error);

    ErrorHandler.handleWebSocketError(ws, error, 'Chat');
  }
};

// 其他导出函数保持不变
exports.sendGreeting = async (ws, userInfo = {}) => {
  const timer = new PerformanceTimer(`greeting_${Date.now()}`);

  try {
    const userId = getUserId(ws);
    timer.mark('开始生成问候语');

    const userData = await userDataService.getUserData(userId);
    timer.mark('用户数据获取完成');

    // 【修改】直接通过 greetingService 生成，已经在 greetingService 内部集成了 memoryService.getGreetingData
    const greeting = await greetingService.generateGreeting(userData, userId);
    timer.mark('问候语生成完成');

    ws.send(JSON.stringify({
      greeting,
      userInfo: userData?.userInfo || {},
      timing: timer.getReport()
    }));

    const suggestions = await suggestionService.getInitialSuggestions();
    timer.mark('初始建议获取完成');

    ws.send(JSON.stringify({
      suggestions,
      timing: timer.getReport()
    }));

  } catch (error) {
    console.error('生成问候语失败:', error);
    ws.send(JSON.stringify({
      greeting: "您好！我是杨院长，很高兴为您提供专业的整形美容咨询服务。请问有什么可以帮助您的？",
      timing: timer.getReport()
    }));
  }
};

// WebSocket 连接处理
exports.handleConnection = async (ws) => {
  console.log('🔗 WebSocket connection handled');

  const userId = ws.userId;
  if (!userId) return;

  // 通知 memoryService 用户已连接
  try {
    await memoryService.onUserConnect(userId, {
      nickname: ws.userNickname || null
    });
  } catch (err) {
    console.warn('记录用户连接失败:', err.message);
  }
};

exports.handleDisconnect = async (ws) => {
  console.log('🔌 WebSocket disconnection handled');

  const userId = ws.userId;
  if (!userId) return;

  // 获取会话消息（用于生成会话摘要）
  const history = chatHistories.get(userId);
  const messages = history?.messages || null;

  // 通知 memoryService 用户已断开（会刷新 Memobase 缓冲 + 生成会话摘要）
  try {
    await memoryService.onUserDisconnect(userId, messages);
  } catch (err) {
    console.warn('用户断开连接清理失败', err.message);
  }
};