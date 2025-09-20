require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws'); // 引入 WebSocket 模块
const chatController = require('./controllers/chatController'); // 导入 WebSocket 聊天控制器
const SecurityMiddleware = require('./middleware/security');
const AuthMiddleware = require('./middleware/auth');
const SecurityHeaders = require('./middleware/headers');
const heartbeatService = require('./services/heartbeatService');
const ErrorHandler = require('./middleware/errorHandler');
const speechRoutes = require('./routes/speechRoutes'); // 导入语音路由
const cleanupUtil = require('./utils/cleanup'); // 导入清理工具
const ProviderFactory = require('./services/ProviderFactory'); // 导入Provider工厂
const ConfigService = require('./services/ConfigService'); // 导入配置服务

const app = express();
const port = process.env.PORT || 8080;

// 启动时输出详细的环境配置信息
console.log('=== 应用启动配置信息 ===');
console.log(`- 当前时间: ${new Date().toISOString()}`);
console.log(`- Node.js 版本: ${process.version}`);
console.log(`- 工作目录: ${process.cwd()}`);
console.log(`- 环境: ${process.env.NODE_ENV || 'development'}`);
console.log(`- 端口: ${port}`);
console.log(`- 原始 PORT 环境变量: ${JSON.stringify(process.env.PORT)}`);
// 环境变量读取辅助函数（处理 Azure App Service 的 APPSETTING_ 前缀）
function getEnvVar(name) {
  return process.env[name] || process.env[`APPSETTING_${name}`] || null;
}

console.log('=== Azure OpenAI 配置 ===');
const azureEndpoint = getEnvVar('AZURE_OPENAI_ENDPOINT');
const azureApiKey = getEnvVar('AZURE_OPENAI_API_KEY');  
const azureApiVersion = getEnvVar('OPENAI_API_VERSION');
const azureDeployment = getEnvVar('AZURE_OPENAI_DEPLOYMENT_NAME');
console.log(`- AZURE_OPENAI_ENDPOINT: ${azureEndpoint ? '已设置' : '未设置'}`);
console.log(`- AZURE_OPENAI_API_KEY: ${azureApiKey ? '已设置' : '未设置'}`);
console.log(`- OPENAI_API_VERSION: ${azureApiVersion || '未设置'}`);
console.log(`- AZURE_OPENAI_DEPLOYMENT_NAME: ${azureDeployment || '未设置'}`);
console.log('=== 其他环境变量 ===');
console.log(`- JWT_SECRET: ${process.env.JWT_SECRET ? '已设置 (前10字符: ' + process.env.JWT_SECRET.substring(0, 10) + '...)' : '未设置'}`);
console.log(`- WEBSITE_HOSTNAME: ${process.env.WEBSITE_HOSTNAME || '未设置'}`);
console.log(`- WEBSITE_SITE_NAME: ${process.env.WEBSITE_SITE_NAME || '未设置'}`);
console.log('========================');

// 设置全局错误处理
ErrorHandler.setupGlobalErrorHandlers();

// 安全头部配置
SecurityHeaders.configure(app);

// 中间件配置
app.use(cors({
  origin: function(origin, callback) {
    // 允许的源
    const allowedOrigins = [
      'https://servicewechat.com',
      'http://localhost:3000',
      'https://mego-xr.com'
    ];
    
    // 允许没有origin的请求（比如移动应用）
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// 静态文件服务 - 用于诊断页面
app.use('/public', express.static('public'));

// 根路径 - Azure AlwaysOn健康检查
app.get('/', (req, res) => {
  res.status(200).json({ 
    service: 'JianjunAI API',
    status: 'OK',
    timestamp: new Date().toISOString(),
    port: port,
    version: '1.0.0'
  });
});


// 健康检查
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    port: port
  });
});

// 认证端点 - 生成JWT令牌
app.post('/auth/token', (req, res) => {
  const { userId } = req.body;
  
  // 验证用户ID
  if (!SecurityMiddleware.isValidUserId(userId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  
  // 生成JWT令牌
  const token = AuthMiddleware.generateToken(userId);
  
  res.json({
    token,
    expiresIn: '24h',
    tokenType: 'Bearer'
  });
});

// 注册语音路由
app.use('/api', speechRoutes);

// 设置临时文件清理定时器（每30分钟清理一次超过1小时的文件）
const tempDir = require('path').join(__dirname, '../temp');
setInterval(() => {
  cleanupUtil.cleanupAndReport(tempDir, 60 * 60 * 1000); // 清理1小时前的文件
}, 30 * 60 * 1000); // 每30分钟执行一次

// 启动时立即清理一次
cleanupUtil.cleanupAndReport(tempDir, 60 * 60 * 1000).catch(console.error);

// LLM 连接预热
const warmupLLMConnection = async () => {
  try {
    console.log('正在预热LLM连接...');
    const ProviderFactory = require('./services/ProviderFactory');
    
    const provider = ProviderFactory.getLLMProvider();
    
    // 发送一个简单的请求来预热连接
    const response = await provider.createCompletion('测试连接', {
      max_tokens: 5,
      temperature: 0
    });
    
    console.log('✅ LLM连接预热成功');
  } catch (error) {
    console.warn('⚠️ LLM连接预热失败（不影响正常服务）:', error.message);
  }
};

// 服务器启动后进行预热（非阻塞）
setTimeout(() => {
  warmupLLMConnection();
}, 5000); // 延迟5秒启动，避免影响服务器启动速度

// 配置检查端点
app.get('/config-check', (req, res) => {
  const config = {
    timestamp: new Date().toISOString(),
    server: {
      port: port,
      originalPortEnv: process.env.PORT,
      nodeVersion: process.version,
      platform: process.platform,
      workingDirectory: process.cwd()
    },
    azure: {
      endpoint: azureEndpoint ? '已设置' : '未设置',
      apiKey: azureApiKey ? '已设置' : '未设置',
      apiVersion: azureApiVersion || '未设置',
      deployment: azureDeployment || '未设置'
    },
    environment: {
      nodeEnv: process.env.NODE_ENV || '未设置',
      websiteHostname: process.env.WEBSITE_HOSTNAME || '未设置',
      websiteSiteName: process.env.WEBSITE_SITE_NAME || '未设置'
    }
  };
  
  res.status(200).json(config);
});

// WebSocket测试端点 - 必须在server创建之前定义
app.get('/ws-test', (req, res) => {
  // 如果wss还没创建，返回基本信息
  const wsSize = typeof wss !== 'undefined' ? wss.clients.size : 0;
  const heartbeatStats = heartbeatService.getStats();
  res.status(200).json({ 
    message: 'WebSocket服务器运行中',
    wsConnections: wsSize,
    heartbeatStats,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware (must be last before server creation)
app.use(ErrorHandler.notFoundHandler);
app.use(ErrorHandler.expressErrorHandler);

// 创建 WebSocket 服务器
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`服务器运行在端口 ${port}`);
  console.log(`服务器地址: http://0.0.0.0:${port} (监听所有网络接口)`);
  console.log(`局域网访问: http://192.168.1.13:${port}`);
  console.log(`环境变量检查:`);
  console.log(`- NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`- PORT: ${process.env.PORT}`);
  console.log(`- Azure OpenAI Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT ? '已设置' : '未设置'}`);
});

console.log('正在创建WebSocket服务器...');
const wss = new WebSocketServer({ server });
console.log('WebSocket服务器创建完成，等待连接...');


// 处理 WebSocket 连接
wss.on('connection', async (ws, req) => {
  console.log('WebSocket 连接已建立');
  console.log('请求URL:', req.url);
  console.log('请求头:', JSON.stringify(req.headers, null, 2));
  
  // 使用JWT认证
  if (!AuthMiddleware.authenticateWebSocket(ws, req)) {
    console.warn('WebSocket authentication failed - closing connection');
    ws.close(1008, 'JWT authentication required');
    return;
  }
  
  const userId = ws.userId;
  
  // 检查速率限制
  if (!SecurityMiddleware.checkRateLimit(userId)) {
    console.warn(`Rate limit exceeded for user: ${userId}`);
    ws.close(1008, 'Too many requests');
    return;
  }
  
  ws.userId = userId;
  
  // 注册心跳监控
  heartbeatService.register(ws);
  
  // 初始化连接并发送问候
  await chatController.handleConnection(ws);

  // 监听消息
  ws.on('message', async (message) => {
    // 最基础的调试：确认消息事件被触发
    console.log('🔍 收到原始WebSocket消息，长度:', message.length, '字节');
    
    try {
      const data = JSON.parse(message);
      
      // 调试：记录所有收到的消息
      console.log('📨 WebSocket收到消息:', { 
        type: data.type, 
        userId: ws.userId, 
        messageId: data.messageId,
        sessionId: data.sessionId || 'undefined',
        hasAudio: !!data.audio,
        hasPrompt: !!data.prompt,
        hasConfig: !!data.config
      });
      
      // 特别关注语音相关消息
      if (data.type && data.type.startsWith('speech_')) {
        console.log(`🎯 语音消息详情 [${data.type}]:`, {
          sessionId: data.sessionId,
          config: data.config,
          audioSize: data.audio ? data.audio.length : 0
        });
      }
      
      if (data.type === 'init') {
        // 客户端初始化请求，重新发送问候
        console.log('收到init消息:', data);
        try {
          await chatController.handleConnection(ws);
          console.log('handleConnection 处理完成');
        } catch (error) {
          console.error('handleConnection 处理失败:', error);
          // 不要关闭连接，发送错误信息即可
          ws.send(JSON.stringify({ 
            type: 'error', 
            error: '初始化失败',
            details: error.message,
            data: '初始化失败'
          }));
        }
        return;
      }
      
      // 如果有 prompt 字段，验证输入
      if (data.prompt !== undefined) {
        const inputValidation = SecurityMiddleware.validateInput(data.prompt);
        if (!inputValidation.valid) {
          ws.send(JSON.stringify({ error: inputValidation.error, details: data.prompt }));
          return;
        }
      }
      
      // 处理流式语音识别消息（不受速率限制）
      if (data.type === 'speech_start') {
        console.log('🎤 开始流式语音识别:', data.sessionId, '配置:', JSON.stringify(data.config || {}));
        try {
          await chatController.handleStreamingSpeechStart(ws, data);
          console.log('✅ 流式语音识别启动成功:', data.sessionId);
        } catch (error) {
          console.error('❌ 流式语音识别启动失败:', data.sessionId, error.message);
          console.error('错误详情:', error);
          console.error('错误堆栈:', error.stack);
        }
        return;
      }
      
      if (data.type === 'speech_frame') {
        // 处理音频帧数据
        try {
          await chatController.handleStreamingSpeechFrame(ws, data);
        } catch (error) {
          console.error('处理音频帧错误 (捕获):', error.message);
        }
        return;
      }
      
      if (data.type === 'speech_end') {
        console.log('🛑 结束流式语音识别:', data.sessionId);
        try {
          await chatController.handleStreamingSpeechEnd(ws, data);
        } catch (error) {
          console.error('结束语音识别错误:', error.message);
        }
        return;
      }
      
      if (data.type === 'speech_cancel') {
        console.log('❌ 取消流式语音识别:', data.sessionId);
        try {
          await chatController.handleStreamingSpeechCancel(ws, data);
        } catch (error) {
          console.error('取消语音识别错误:', error.message);
        }
        return;
      }


      // 只有当有 prompt 时才发送消息
      if (data.prompt) {
        // 检查速率限制（仅对聊天消息进行限制）
        if (!SecurityMiddleware.checkRateLimit(ws.userId, 60000, 30)) { // 每分钟30条消息
          ws.send(JSON.stringify({ 
            error: '发送太频繁，请稍后再试',
            details: '每分钟最多30条消息'
          }));
          return;
        }
        
        // 清理输入内容
        const sanitizedPrompt = SecurityMiddleware.sanitizeMedicalContent(data.prompt);
        // 调用 Azure OpenAI，返回流式数据
        await chatController.sendMessage(ws, sanitizedPrompt);
      }
    } catch (error) {
      console.error('WebSocket 错误:', error);
      ws.send(JSON.stringify({ 
        error: '服务器内部错误', 
        details: error.message || '未知错误'
      }));
    }
  });

  // 处理连接关闭
  ws.on('close', () => {
    heartbeatService.unregister(ws);
    chatController.handleDisconnect(ws);
    console.log('WebSocket 连接已关闭');
  });
  
  // 处理连接错误
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    heartbeatService.unregister(ws);
  });
});

// 优雅关闭处理
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  heartbeatService.shutdown();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  heartbeatService.shutdown();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
