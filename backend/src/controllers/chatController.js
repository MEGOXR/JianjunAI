const { AzureOpenAI } = require("openai");
const userDataService = require('../services/userDataService');
const greetingService = require('../services/greetingService');
const nameExtractorService = require('../services/nameExtractorService');
const promptService = require('../services/promptService');
const ErrorHandler = require('../middleware/errorHandler');

// 环境变量读取辅助函数（处理 Azure App Service 的 APPSETTING_ 前缀）
function getEnvVar(name) {
  return process.env[name] || process.env[`APPSETTING_${name}`] || null;
}

// 从环境变量中获取 Azure OpenAI 配置
const endpoint = getEnvVar('AZURE_OPENAI_ENDPOINT');
const apiKey = getEnvVar('AZURE_OPENAI_API_KEY');
const apiVersion = getEnvVar('OPENAI_API_VERSION');
const deployment = getEnvVar('AZURE_OPENAI_DEPLOYMENT_NAME');

// 验证配置的函数（延迟到实际使用时检查）
function validateAzureConfig() {
  if (!endpoint || !apiKey || !apiVersion || !deployment) {
    console.error('Azure OpenAI configuration missing. Please check environment variables.');
    console.error(`Endpoint: ${endpoint ? '已设置' : '未设置'}`);
    console.error(`API Key: ${apiKey ? '已设置' : '未设置'}`);
    console.error(`API Version: ${apiVersion ? '已设置' : '未设置'}`);
    console.error(`Deployment: ${deployment ? '已设置' : '未设置'}`);
    throw new Error('Azure OpenAI credentials not configured');
  }
}

// 使用 userId 作为 key 来存储对话历史
const chatHistories = new Map();

// 内存管理配置 - 更加保守的设置
const MAX_HISTORY_SIZE = 100; // 减少到100个用户
const CLEANUP_INTERVAL = 15 * 60 * 1000; // 15分钟清理一次
const MAX_IDLE_TIME = 2 * 60 * 60 * 1000; // 2小时空闲时间
const MAX_MESSAGES_PER_USER = 20; // 每个用户最多保存20条消息

// 增强的清理功能
function cleanupChatHistories() {
  const now = Date.now();
  let cleanedCount = 0;
  let memoryFreed = 0;
  
  // 记录清理前的内存使用
  const usedBefore = process.memoryUsage();
  
  for (const [userId, history] of chatHistories.entries()) {
    // 检查最后访问时间
    const lastAccess = history.lastAccess || 0;
    if (now - lastAccess > MAX_IDLE_TIME) {
      // 估算释放的内存
      const memorySize = JSON.stringify(history).length;
      memoryFreed += memorySize;
      
      chatHistories.delete(userId);
      cleanedCount++;
      continue;
    }
    
    // 限制每个用户的消息数量
    if (history.messages && history.messages.length > MAX_MESSAGES_PER_USER) {
      const removedMessages = history.messages.splice(0, history.messages.length - MAX_MESSAGES_PER_USER);
      memoryFreed += JSON.stringify(removedMessages).length;
      console.log(`Trimmed ${removedMessages.length} old messages for user ${userId}`);
    }
  }
  
  // 如果仍然超过最大大小，删除最久未使用的
  if (chatHistories.size > MAX_HISTORY_SIZE) {
    const sortedEntries = [...chatHistories.entries()]
      .sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
    
    const toRemove = sortedEntries.slice(0, chatHistories.size - MAX_HISTORY_SIZE);
    toRemove.forEach(([userId, history]) => {
      memoryFreed += JSON.stringify(history).length;
      chatHistories.delete(userId);
      cleanedCount++;
    });
  }
  
  // 强制垃圾回收（如果可用）
  if (global.gc) {
    global.gc();
  }
  
  const usedAfter = process.memoryUsage();
  const heapFreed = usedBefore.heapUsed - usedAfter.heapUsed;
  
  if (cleanedCount > 0 || memoryFreed > 0) {
    console.log(`Memory cleanup: removed ${cleanedCount} histories, freed ~${Math.round(memoryFreed/1024)}KB data, heap change: ${Math.round(heapFreed/1024)}KB. Current size: ${chatHistories.size}`);
  }
  
  // 检查内存压力
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  if (heapUsedMB > 100) { // 如果堆内存超过100MB
    console.warn(`High memory usage detected: ${heapUsedMB}MB heap used`);
    // 更激进的清理
    const aggressiveCleanup = Math.floor(chatHistories.size * 0.3); // 清理30%
    if (aggressiveCleanup > 0) {
      const entriesToRemove = [...chatHistories.entries()]
        .sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0))
        .slice(0, aggressiveCleanup);
      
      entriesToRemove.forEach(([userId]) => chatHistories.delete(userId));
      console.log(`Aggressive cleanup: removed ${aggressiveCleanup} additional histories`);
    }
  }
}

// 启动定期清理
const cleanupTimer = setInterval(cleanupChatHistories, CLEANUP_INTERVAL);

// 监控内存使用情况
function logMemoryUsage() {
  const usage = process.memoryUsage();
  console.log('Memory usage:', {
    rss: Math.round(usage.rss / 1024 / 1024) + 'MB',
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + 'MB', 
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + 'MB',
    external: Math.round(usage.external / 1024 / 1024) + 'MB',
    chatHistories: chatHistories.size
  });
}

// 每小时记录一次内存使用
const memoryTimer = setInterval(logMemoryUsage, 60 * 60 * 1000);

// 优雅关闭
process.on('SIGTERM', () => {
  clearInterval(cleanupTimer);
  clearInterval(memoryTimer);
  chatHistories.clear();
});

// 生成或获取用户ID
const getUserId = (ws) => {
  if (!ws.userId) {
    ws.userId = Math.random().toString(36).substring(7);
  }
  return ws.userId;
};

exports.sendMessage = async (ws, prompt, wxNickname) => {
  console.log('收到消息:', { prompt, wxNickname, userId: ws.userId });
  
  try {
    // 验证Azure配置
    validateAzureConfig();
    console.log('Azure配置验证通过');
    
    const userId = getUserId(ws);
    console.log('用户ID:', userId);
    
    // 获取用户数据
    const userData = await userDataService.getUserData(userId);
    
    // 检查是否需要更新名字
    const currentName = userData?.userInfo?.extractedName;
    if (!currentName || await nameExtractorService.shouldUpdateName(currentName, prompt)) {
      // 获取对话历史用于名字提取
      const historyObj = chatHistories.get(userId);
      const history = historyObj ? historyObj.messages || [] : [];
      const messagesForExtraction = [...history, { role: 'user', content: prompt }];
      
      // 使用LLM提取名字
      const extractedName = await nameExtractorService.extractNameFromConversation(messagesForExtraction);
      if (extractedName) {
        await userDataService.updateUserInfo(userId, { extractedName });
        console.log(`提取到用户名字: ${extractedName}`);
      }
    }
    
    // 获取或初始化用户的对话历史
    if (!chatHistories.has(userId)) {
      // 从持久化存储恢复历史记录
      const savedHistory = userData?.chatHistory || [];
      
      if (savedHistory.length > 0) {
        chatHistories.set(userId, {
          messages: savedHistory,
          lastAccess: Date.now()
        });
      } else {
        chatHistories.set(userId, {
          messages: [
            {
              role: "system",
              content: promptService.getSystemPrompt()
            }
          ],
          lastAccess: Date.now()
        });
      }
    }
    
    // 更新最后访问时间
    let historyData = chatHistories.get(userId);
    console.log('获取到的historyData:', historyData, '类型:', typeof historyData);
    
    if (Array.isArray(historyData)) {
      // 兼容旧格式
      console.log('转换旧格式数组为新对象格式');
      chatHistories.set(userId, {
        messages: historyData,
        lastAccess: Date.now()
      });
      historyData = chatHistories.get(userId);
    } else if (historyData && typeof historyData === 'object') {
      historyData.lastAccess = Date.now();
    } else {
      console.log('historyData为空或无效，重新初始化');
      historyData = {
        messages: [
          {
            role: "system",
            content: promptService.getSystemPrompt()
          }
        ],
        lastAccess: Date.now()
      };
      chatHistories.set(userId, historyData);
    }

    let history;
    if (Array.isArray(historyData)) {
      // 兼容旧格式：直接是数组
      history = historyData;
    } else if (historyData && Array.isArray(historyData.messages)) {
      // 新格式：对象包含messages数组
      history = historyData.messages;
    } else {
      // 初始化默认历史记录
      history = [
        {
          role: "system",
          content: promptService.getSystemPrompt()
        }
      ];
      console.log('初始化默认历史记录');
    }
    
    console.log('最终history数组长度:', history.length);
    console.log('history是数组:', Array.isArray(history));
    
    // 添加用户新消息
    history.push({ role: "user", content: prompt });

    // 发送初始化消息给客户端
    ws.send(JSON.stringify({ 
      type: 'init',
      userId: userId,
      history: history 
    }));

    // 创建 Azure OpenAI 客户端实例
    const client = new AzureOpenAI({
      apiKey,
      endpoint,
      apiVersion,
      deployment,
    });

    // 最终验证 history 是数组
    if (!Array.isArray(history)) {
      console.error('history不是数组！类型:', typeof history, '内容:', history);
      throw new Error('History must be an array');
    }
    
    console.log('准备调用Azure OpenAI，历史消息数:', history.length);
    console.log('部署名称:', deployment);
    console.log('history数组示例:', history.slice(0, 2));
    
    const stream = await client.chat.completions.create({
      model: deployment,  // 使用环境变量中的部署名称
      messages: history,
      stream: true,
      max_tokens: 1000,     // 增加长度限制以允许更详细的回答
      temperature: 0.5,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      stop: null  // 移除停止符号，让 AI 自然地完成回答
    });
    
    console.log('Azure OpenAI流创建成功');

    let assistantResponse = '';
    let isComplete = false;

    // 流式处理 AI 的回复
    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content !== undefined) {
        assistantResponse += content;
        // 对每个片段进行实时清理
        const cleanedContent = content
          .replace(/\*\*\*([^*]+)\*\*\*/g, '「$1」')  // 粗斜体
          .replace(/\*\*([^*]+)\*\*/g, '「$1」')      // 加粗
          .replace(/\*([^*]+)\*/g, '$1')             // 斜体
          .replace(/#{1,6}\s*/g, '')                 // 标题
          .replace(/^\s*[-*+]\s+/gm, '• ')          // 列表
          .replace(/`([^`]+)`/g, '「$1」')           // 行内代码
          .replace(/[#*_`~]/g, '');                  // 移除残留符号
        ws.send(JSON.stringify({ data: cleanedContent }));
        console.log('发送消息片段，长度:', cleanedContent.length);
      }

      // 如果 AI 给出了完整的段落结束标志
      if (chunk.choices?.[0]?.delta?.finish_reason) {
        isComplete = true;
        break;  // 确保在这里完成，不会继续请求
      }
    }

    // 清理回复中的Markdown格式符号，使其适合微信显示
    const cleanedResponse = promptService.cleanMarkdownForWeChat(assistantResponse);
    
    // 将清理后的 AI 回复添加到历史记录中
    if (!Array.isArray(history)) {
      console.error('在push回复时，history不是数组！类型:', typeof history);
      throw new Error('History must be an array for push operation');
    }
    
    history.push({ role: "assistant", content: cleanedResponse });

    // 智能历史记录管理 - 保持最近的对话但限制总长度
    if (history.length > MAX_MESSAGES_PER_USER) {
      // 保留系统消息和最近的对话
      const systemMessage = history[0]; // 系统提示
      const recentMessages = history.slice(-MAX_MESSAGES_PER_USER + 1);
      history.length = 0; // 清空数组
      history.push(systemMessage, ...recentMessages);
      console.log(`Trimmed history to ${history.length} messages for user ${userId}`);
    }
    
    // 保存聊天历史到持久化存储
    await userDataService.updateChatHistory(userId, history);
    
    // 更新内存中的历史记录
    const updatedHistoryData = chatHistories.get(userId);
    if (updatedHistoryData) {
      if (Array.isArray(updatedHistoryData)) {
        // 如果是旧格式数组，替换为新格式对象
        chatHistories.set(userId, {
          messages: history,
          lastAccess: Date.now()
        });
      } else {
        // 新格式对象，更新messages和lastAccess
        updatedHistoryData.messages = history;
        updatedHistoryData.lastAccess = Date.now();
      }
    }

    console.log('发送done标记给客户端');
    ws.send(JSON.stringify({ done: true }));
    console.log('done标记发送完成');
  } catch (error) {
    console.error("Azure OpenAI 调用出错:", error);
    ErrorHandler.handleWebSocketError(ws, error, 'Azure OpenAI Chat');
    
    // 检查是否是内容过滤错误
    if (error.code === 'content_filter' || error.message?.includes('content management policy')) {
      // 发送友好的内容过滤回复
      const contentFilterResponse = "很抱歉，您的消息涉及一些敏感内容，我无法回复。作为您的整形美容顾问，我更希望为您提供专业的医疗咨询服务。\n\n请问您有什么关于整形美容方面的问题吗？比如：\n• 面部轮廓改善\n• 皮肤护理建议\n• 手术方案咨询\n• 术后恢复指导\n\n我会用专业的知识为您解答～";
      
      // 模拟流式发送友好回复
      const chunks = contentFilterResponse.split('');
      for (let i = 0; i < chunks.length; i += 2) {
        const chunk = chunks.slice(i, i + 2).join('');
        ws.send(JSON.stringify({ data: chunk }));
        // 添加小延迟模拟真实的流式响应
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      ws.send(JSON.stringify({ done: true }));
    }
  }
};


// 增强的断开连接处理
exports.handleDisconnect = (ws) => {
  const userId = ws.userId;
  
  // 清理 WebSocket 相关资源
  if (ws.readyState === ws.OPEN) {
    ws.close();
  }
  
  // 更新最后访问时间但不删除历史记录
  if (userId && chatHistories.has(userId)) {
    const historyData = chatHistories.get(userId);
    if (historyData && typeof historyData === 'object') {
      historyData.lastAccess = Date.now();
    }
  }
  
  // 清理 WebSocket 对象上的用户数据
  delete ws.userId;
  delete ws.wxNickname;
  
  console.log(`WebSocket disconnected for user: ${userId || 'unknown'}`);
};

// 新增：处理用户连接时的初始化
exports.handleConnection = async (ws, wxNickname) => {
  try {
    console.log('处理WebSocket连接初始化, wxNickname:', wxNickname);
    
    const userId = getUserId(ws);
    console.log('获取用户ID:', userId);
    
    let userData = await userDataService.getUserData(userId);
    console.log('获取用户数据成功');
    
    // 生成智能问候语（基于时间判断是否需要）
    // 在更新用户信息之前检查是否需要问候语
    const greeting = await greetingService.generateGreeting(userData, wxNickname);
    
    // 更新用户最后访问时间（在问候语生成之后）
    if (wxNickname) {
      await userDataService.updateUserInfo(userId, { wxNickname });
      console.log('更新用户信息成功');
    }
    
    // 仅在需要时发送问候消息
    if (greeting) {
      console.log('生成问候语成功:', greeting.substring(0, 50) + '...');
      ws.send(JSON.stringify({
        type: 'greeting',
        data: greeting,
        userId: userId
      }));
      console.log('问候消息发送成功');
    } else {
      console.log('用户24小时内访问过，跳过问候消息');
    }
    
    return userId;
  } catch (error) {
    console.error('handleConnection 出错:', error);
    ErrorHandler.handleWebSocketError(ws, error, 'Connection Initialization');
    throw error; // 重新抛出错误
  }
};
