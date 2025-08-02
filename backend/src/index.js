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
  const { userId, wxNickname } = req.body;
  
  // 验证用户ID
  if (!SecurityMiddleware.isValidUserId(userId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
  
  // 生成JWT令牌
  const token = AuthMiddleware.generateToken(userId, wxNickname || '');
  
  res.json({
    token,
    expiresIn: '24h',
    tokenType: 'Bearer'
  });
});

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
const server = app.listen(port, () => {
  console.log(`服务器运行在端口 ${port}`);
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
    console.warn('WebSocket authentication failed');
    ws.close(1008, 'Authentication required');
    return;
  }
  
  const userId = ws.userId;
  const wxNickname = ws.wxNickname || '';
  
  // 检查速率限制
  if (!SecurityMiddleware.checkRateLimit(userId)) {
    console.warn(`Rate limit exceeded for user: ${userId}`);
    ws.close(1008, 'Too many requests');
    return;
  }
  
  // 清理微信昵称
  const sanitizedNickname = SecurityMiddleware.sanitizeWxNickname(wxNickname);
  
  ws.userId = userId;
  
  // 注册心跳监控
  heartbeatService.register(ws);
  
  // 初始化连接并发送问候
  await chatController.handleConnection(ws, sanitizedNickname);

  // 监听消息
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'init') {
        // 客户端初始化请求，重新发送问候
        console.log('收到init消息:', data);
        const sanitizedNickname = SecurityMiddleware.sanitizeWxNickname(data.wxNickname || '');
        console.log('处理后的昵称:', sanitizedNickname);
        
        try {
          await chatController.handleConnection(ws, sanitizedNickname);
          console.log('handleConnection 处理完成');
        } catch (error) {
          console.error('handleConnection 处理失败:', error);
          // 不要关闭连接，发送错误信息即可
          ws.send(JSON.stringify({ 
            type: 'error', 
            data: '初始化失败', 
            error: error.message 
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
      
      // 检查速率限制
      if (!SecurityMiddleware.checkRateLimit(ws.userId, 60000, 30)) { // 每分钟30条消息
        ws.send(JSON.stringify({ error: '发送太频繁，请稍后再试' }));
        return;
      }

      // 只有当有 prompt 时才发送消息
      if (data.prompt) {
        // 清理输入内容
        const sanitizedPrompt = SecurityMiddleware.sanitizeMedicalContent(data.prompt);
        const sanitizedNickname = SecurityMiddleware.sanitizeWxNickname(data.wxNickname || wxNickname);
        
        // 调用 Azure OpenAI，返回流式数据
        await chatController.sendMessage(ws, sanitizedPrompt, sanitizedNickname);
      }
    } catch (error) {
      console.error('WebSocket 错误:', error);
      ws.send(JSON.stringify({ error: '服务器内部错误', details: error.message }));
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
