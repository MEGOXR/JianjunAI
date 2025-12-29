const userDataService = require('../services/userDataService');
const greetingService = require('../services/greetingService');
const nameExtractorService = require('../services/nameExtractorService');
const promptService = require('../services/promptService');
const suggestionService = require('../services/suggestionService');
const ErrorHandler = require('../middleware/errorHandler');
const AzureClientFactory = require('../utils/AzureClientFactory');

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
const MAX_MESSAGES_PER_USER = 8;

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

exports.sendMessage = async (ws, prompt) => {
  // 创建请求ID和计时器
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const timer = new PerformanceTimer(requestId);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${requestId}] 🚀 新请求开始`);
  console.log(`用户: ${ws.userId}`);
  console.log(`问题: ${prompt}`);
  console.log(`${'='.repeat(60)}`);
  
  timer.mark('请求接收完成', { prompt: prompt.substring(0, 50) });
  
  const useProvider = ConfigService.isProviderEnabled();
  
  try {
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
    
    // 4. 初始化或获取对话历史
    timer.mark('开始初始化对话历史');
    if (!chatHistories.has(userId)) {
      userDataPromise.then(userData => {
        const savedHistory = userData?.chatHistory || [];
        if (savedHistory.length > 0 && !chatHistories.has(userId)) {
          chatHistories.set(userId, {
            messages: savedHistory,
            lastAccess: Date.now()
          });
          timer.mark('从存储加载历史记录', { historyLength: savedHistory.length });
        }
      }).catch(console.error);
      
      chatHistories.set(userId, {
        messages: [
          {
            role: "system",
            content: promptService.getSystemPrompt()
          }
        ],
        lastAccess: Date.now()
      });
      timer.mark('创建新的对话历史');
    }
    
    // 5. 更新历史记录
    let historyData = chatHistories.get(userId);
    timer.mark('获取对话历史完成', { messageCount: historyData?.messages?.length });
    
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
          {
            role: "system",
            content: promptService.getSystemPrompt()
          }
        ],
        lastAccess: Date.now()
      };
      chatHistories.set(userId, historyData);
    }

    let history = historyData.messages || [];
    
    // 6. 添加用户消息
    history.push({ role: "user", content: prompt });
    timer.mark('用户消息添加完成');

    // 7. 发送初始化消息
    ws.send(JSON.stringify({ 
      type: 'init',
      userId: userId,
      requestId: requestId,
      timing: timer.getReport()
    }));
    timer.mark('初始化消息发送完成');
    
    // 8. 调用LLM
    let stream;
    timer.mark('开始调用LLM');
    
    if (useProvider) {
      // Provider模式
      const llmProvider = ProviderFactory.getLLMProvider();
      timer.mark('Provider工厂获取完成');
      
      await llmProvider.initialize();
      timer.mark('Provider初始化完成');
      
      console.log(`调用 ${llmProvider.getName()}，模型:`, llmProvider.getModelInfo());
      
      stream = await llmProvider.createChatStream(history, {
        maxTokens: 1000,
        temperature: 0.5
      });
      timer.mark('Provider流创建完成');
    } else {
      // Azure模式 - 使用工厂类获取客户端
      AzureClientFactory.validateConfig();
      const client = AzureClientFactory.getClient();
      timer.mark('Azure客户端创建完成');

      stream = await client.chat.completions.create({
        model: AzureClientFactory.getDeploymentName(),
        messages: history,
        stream: true,
        max_tokens: 2000,
        temperature: 0.5,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        stop: null
      });
      timer.mark('Azure流创建完成');
    }
    
    console.log('LLM流创建成功');
    
    // 9. 处理流式响应
    let assistantResponse = '';
    let firstTokenReceived = false;
    let tokenCount = 0;
    
    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content !== undefined) {
        // 记录首个token时间
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          timer.mark('🎯 首个Token接收 (TTFT)', { 
            ttft: Date.now() - timer.startTime,
            tokenCount: 1
          });
        }
        
        tokenCount++;
        assistantResponse += content;
        
        // 清理并发送内容
        const cleanedContent = content
          .replace(/\*\*\*([^*]+)\*\*\*/g, '「$1」')
          .replace(/\*\*([^*]+)\*\*/g, '「$1」')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/#{1,6}\s*/g, '')
          .replace(/^\s*[-*+]\s+/gm, '• ')
          .replace(/`([^`]+)`/g, '「$1」');
          
        ws.send(JSON.stringify({ 
          data: cleanedContent,
          timing: {
            elapsed: Date.now() - timer.startTime,
            tokenIndex: tokenCount
          }
        }));
      }
    }
    
    timer.mark('流式响应处理完成', { 
      totalTokens: tokenCount,
      responseLength: assistantResponse.length 
    });
    
    // 10. 保存助手响应
    history.push({ role: "assistant", content: assistantResponse });
    
    // 11. 限制历史长度
    if (history.length > 10) {
      const systemMessage = history.find(msg => msg.role === 'system');
      const recentHistory = history.slice(-9);
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
    
    const greeting = await greetingService.generateGreeting(userId, userData, userInfo);
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

// Stub functions to make index.js work
exports.handleConnection = async (ws) => {
  console.log('🔗 WebSocket connection handled');
};

exports.handleDisconnect = async (ws) => {
  console.log('🔌 WebSocket disconnection handled');
};

// 存储语音识别会话
const speechSessions = new Map();

exports.handleStreamingSpeechStart = async (ws, data) => {
  console.log('🎤 开始语音识别会话:', data.sessionId);
  console.log('音频配置:', JSON.stringify(data.config || {}, null, 2));

  try {
    // 初始化会话数据
    speechSessions.set(data.sessionId, {
      ws: ws,
      userId: ws.userId,
      audioChunks: [],
      startTime: Date.now(),
      config: data.config || {},
      totalBytes: 0
    });

    console.log('✅ 语音识别会话初始化成功:', data.sessionId);

    // 发送确认消息给前端
    ws.send(JSON.stringify({
      type: 'speech_status',
      sessionId: data.sessionId,
      status: 'started',
      message: '语音识别会话已启动'
    }));

  } catch (error) {
    console.error('初始化语音识别会话失败:', error);
    ws.send(JSON.stringify({
      type: 'speech_result',
      sessionId: data.sessionId,
      error: '语音识别初始化失败'
    }));
  }
};

exports.handleStreamingSpeechFrame = async (ws, data) => {
  const session = speechSessions.get(data.sessionId);
  if (!session) {
    console.error('未找到语音识别会话:', data.sessionId);
    return;
  }

  // 收集音频数据
  if (data.audio) {
    // 将base64字符串转换为Buffer
    let audioBuffer;
    if (typeof data.audio === 'string') {
      audioBuffer = Buffer.from(data.audio, 'base64');
    } else if (Buffer.isBuffer(data.audio)) {
      audioBuffer = data.audio;
    } else {
      console.error('不支持的音频数据格式:', typeof data.audio);
      return;
    }

    session.audioChunks.push(audioBuffer);
    session.totalBytes += audioBuffer.length;

    // 每5帧输出一次统计，避免日志过多
    if (session.audioChunks.length % 5 === 0) {
      console.log(`收到音频帧: ${audioBuffer.length} 字节, 总计: ${session.audioChunks.length} 帧, 累计: ${session.totalBytes} 字节`);
    }
  }
};

exports.handleStreamingSpeechEnd = async (ws, data) => {
  console.log('🛑 结束语音识别会话:', data.sessionId);

  const session = speechSessions.get(data.sessionId);
  if (!session) {
    console.error('未找到语音识别会话:', data.sessionId);
    return;
  }

  try {
    // 合并所有音频数据
    const totalAudioSize = session.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    console.log(`合并音频数据: ${session.audioChunks.length} 帧, 总大小: ${totalAudioSize} 字节`);

    if (totalAudioSize === 0) {
      console.log('没有音频数据，跳过识别');
      ws.send(JSON.stringify({
        type: 'speech_result',
        sessionId: data.sessionId,
        text: '',
        message: '没有检测到音频'
      }));
      speechSessions.delete(data.sessionId);
      return;
    }

    // 验证所有音频块都是Buffer
    const validChunks = session.audioChunks.filter(chunk => Buffer.isBuffer(chunk));
    if (validChunks.length !== session.audioChunks.length) {
      console.warn(`过滤掉 ${session.audioChunks.length - validChunks.length} 个无效的音频块`);
    }

    // 合并音频buffer
    const combinedAudio = Buffer.concat(validChunks);
    console.log(`开始Azure语音识别, 音频大小: ${combinedAudio.length} 字节`);

    // 使用Azure Speech Services进行识别
    const recognizedText = await performAzureSpeechRecognition(combinedAudio);

    console.log('✅ 语音识别完成:', recognizedText);

    // 发送识别结果
    ws.send(JSON.stringify({
      type: 'speech_result',
      sessionId: data.sessionId,
      text: recognizedText,
      success: true
    }));

    // 🔥 通知前端显示语音消息并直接发送给LLM
    if (recognizedText && recognizedText.trim()) {
      console.log('🤖 [VERSION 2.1.0] 通知前端显示语音消息并发送给LLM:', recognizedText.trim());

      // 立即发送语音消息给前端显示
      console.log('📤 发送voice_message_display消息到前端');
      ws.send(JSON.stringify({
        type: 'voice_message_display',
        text: recognizedText.trim(),
        sessionId: data.sessionId,
        version: '2.1.0'
      }));

      // 立即调用LLM处理
      console.log('🚀 立即调用LLM处理语音识别结果');
      exports.sendMessage(ws, recognizedText.trim());
    }

  } catch (error) {
    console.error('语音识别失败:', error);
    ws.send(JSON.stringify({
      type: 'speech_result',
      sessionId: data.sessionId,
      error: '语音识别失败: ' + error.message
    }));
  } finally {
    // 清理会话
    speechSessions.delete(data.sessionId);
  }
};

exports.handleStreamingSpeechCancel = async (ws, data) => {
  console.log('🚫 取消语音识别会话:', data.sessionId);
  speechSessions.delete(data.sessionId);
};

// Azure Speech Services 语音识别函数
async function performAzureSpeechRecognition(audioBuffer) {
  const sdk = require('microsoft-cognitiveservices-speech-sdk');

  // 从环境变量获取Azure Speech配置
  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION || 'koreacentral';
  const language = process.env.AZURE_SPEECH_LANGUAGE || 'zh-CN';

  if (!speechKey) {
    throw new Error('Azure Speech Key未配置');
  }

  console.log(`使用Azure Speech Services: region=${speechRegion}, language=${language}`);

  return new Promise((resolve, reject) => {
    let isResolved = false;
    let recognizer = null;

    try {
      // 创建语音配置
      const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
      speechConfig.speechRecognitionLanguage = language;

      // 创建音频配置
      const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
      const audioStream = sdk.AudioInputStream.createPushStream(audioFormat);
      const audioConfig = sdk.AudioConfig.fromStreamInput(audioStream);

      // 创建识别器
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      // 安全关闭函数
      const safeClose = () => {
        if (recognizer && !isResolved) {
          try {
            recognizer.close();
          } catch (e) {
            console.warn('识别器关闭时出现警告:', e.message);
          }
        }
      };

      // 设置识别事件
      recognizer.recognized = (s, e) => {
        if (isResolved) return;

        if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
          console.log(`Azure识别结果: "${e.result.text}"`);
          isResolved = true;
          safeClose();
          resolve(e.result.text);
        } else if (e.result.reason === sdk.ResultReason.NoMatch) {
          console.log('Azure未识别到语音内容');
          isResolved = true;
          safeClose();
          resolve('');
        }
      };

      recognizer.canceled = (s, e) => {
        if (isResolved) return;

        console.error('Azure识别被取消:', e.errorDetails);
        isResolved = true;
        safeClose();
        reject(new Error(`识别被取消: ${e.errorDetails}`));
      };

      recognizer.sessionStopped = (s, e) => {
        console.log('Azure识别会话结束');
        // 不在这里关闭，让其他事件处理
      };

      // 写入音频数据
      audioStream.write(audioBuffer);
      audioStream.close();

      // 开始识别
      console.log('开始Azure语音识别...');
      recognizer.recognizeOnceAsync();

      // 设置超时
      setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          safeClose();
          reject(new Error('语音识别超时'));
        }
      }, 10000);

    } catch (error) {
      console.error('Azure语音识别初始化失败:', error);
      isResolved = true;
      reject(error);
    }
  });
}