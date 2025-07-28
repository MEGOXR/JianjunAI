const { AzureOpenAI } = require("openai");
const userDataService = require('../services/userDataService');
const greetingService = require('../services/greetingService');
const nameExtractorService = require('../services/nameExtractorService');
const promptService = require('../services/promptService');

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

// 内存管理配置
const MAX_HISTORY_SIZE = 1000;
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1小时
const MAX_IDLE_TIME = 24 * 60 * 60 * 1000; // 24小时

// 定期清理不活跃的聊天历史
function cleanupChatHistories() {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [userId, history] of chatHistories.entries()) {
    // 检查最后访问时间
    const lastAccess = history.lastAccess || 0;
    if (now - lastAccess > MAX_IDLE_TIME) {
      chatHistories.delete(userId);
      cleanedCount++;
    }
  }
  
  // 如果仍然超过最大大小，删除最久未使用的
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
    console.log(`Cleaned up ${cleanedCount} inactive chat histories. Current size: ${chatHistories.size}`);
  }
}

// 启动定期清理
setInterval(cleanupChatHistories, CLEANUP_INTERVAL);

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
      const history = chatHistories.get(userId) || [];
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
    if (Array.isArray(historyData)) {
      // 兼容旧格式
      chatHistories.set(userId, {
        messages: historyData,
        lastAccess: Date.now()
      });
      historyData = chatHistories.get(userId);
    } else {
      historyData.lastAccess = Date.now();
    }

    const history = Array.isArray(historyData) ? historyData : historyData.messages;
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

    console.log('准备调用Azure OpenAI，历史消息数:', history.length);
    console.log('部署名称:', deployment);
    
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
    history.push({ role: "assistant", content: cleanedResponse });

    // 恢复为原来的历史记录长度限制
    if (history.length > 10) {
      history.splice(1, 2);
    }
    
    // 保存聊天历史到持久化存储
    await userDataService.updateChatHistory(userId, history);
    
    // 更新内存中的历史记录
    const updatedHistoryData = chatHistories.get(userId);
    if (updatedHistoryData && !Array.isArray(updatedHistoryData)) {
      updatedHistoryData.messages = history;
      updatedHistoryData.lastAccess = Date.now();
    }

    ws.send(JSON.stringify({ done: true }));
  } catch (error) {
    console.error("Azure OpenAI 调用出错:", error);
    console.error("错误详情:", {
      message: error.message,
      stack: error.stack,
      response: error.response?.data
    });
    ws.send(JSON.stringify({ error: "服务器内部错误", details: error.message }));
  }
};


// 修改断开连接的处理方法
exports.handleDisconnect = (ws) => {
  // 不再删除历史记录，只清理 ws 相关资源
  if (ws.readyState === ws.OPEN) {
    ws.close();
  }
};

// 新增：处理用户连接时的初始化
exports.handleConnection = async (ws, wxNickname) => {
  try {
    console.log('处理WebSocket连接初始化, wxNickname:', wxNickname);
    
    const userId = getUserId(ws);
    console.log('获取用户ID:', userId);
    
    const userData = await userDataService.getUserData(userId);
    console.log('获取用户数据成功');
    
    // 生成智能问候语
    const greeting = greetingService.generateGreeting(userData, wxNickname);
    console.log('生成问候语成功:', greeting.substring(0, 50) + '...');
    
    // 更新用户最后访问时间
    if (wxNickname) {
      await userDataService.updateUserInfo(userId, { wxNickname });
      console.log('更新用户信息成功');
    }
    
    // 发送问候消息
    ws.send(JSON.stringify({
      type: 'greeting',
      data: greeting,
      userId: userId
    }));
    console.log('问候消息发送成功');
    
    return userId;
  } catch (error) {
    console.error('handleConnection 出错:', error);
    console.error('错误堆栈:', error.stack);
    
    // 发送错误信息给客户端
    try {
      ws.send(JSON.stringify({
        type: 'error',
        data: '连接初始化失败',
        error: error.message
      }));
    } catch (sendError) {
      console.error('发送错误消息失败:', sendError);
    }
    
    throw error; // 重新抛出错误
  }
};
