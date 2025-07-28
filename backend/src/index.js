require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws'); // 引入 WebSocket 模块
const chatController = require('./controllers/chatController'); // 导入 WebSocket 聊天控制器
const SecurityMiddleware = require('./middleware/security');

const app = express();
const port = process.env.PORT || 8080;

// 中间件配置
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    port: port
  });
});

// 配置检查端点
app.get('/config-check', (req, res) => {
  const config = {
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT ? '已设置' : '未设置',
    azureApiKey: process.env.AZURE_OPENAI_API_KEY ? '已设置' : '未设置',
    azureApiVersion: process.env.OPENAI_API_VERSION ? '已设置' : '未设置',
    azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME ? '已设置' : '未设置',
    nodeEnv: process.env.NODE_ENV || '未设置',
    port: port
  };
  
  res.status(200).json(config);
});

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

// WebSocket测试端点
app.get('/ws-test', (req, res) => {
  res.status(200).json({ 
    message: 'WebSocket服务器运行中',
    wsConnections: wss.clients.size,
    timestamp: new Date().toISOString()
  });
});

// 处理 WebSocket 连接
wss.on('connection', async (ws, req) => {
  console.log('WebSocket 连接已建立');
  console.log('请求URL:', req.url);
  console.log('请求头:', JSON.stringify(req.headers, null, 2));
  
  // 从请求头获取用户信息
  const userId = req.headers['user-id'];
  const wxNickname = decodeURIComponent(req.headers['wx-nickname'] || '');
  
  // 验证用户ID
  if (!SecurityMiddleware.isValidUserId(userId)) {
    console.warn(`Invalid userId attempted connection: ${userId}`);
    ws.close(1008, 'Invalid user credentials');
    return;
  }
  
  // 检查速率限制
  if (!SecurityMiddleware.checkRateLimit(userId)) {
    console.warn(`Rate limit exceeded for user: ${userId}`);
    ws.close(1008, 'Too many requests');
    return;
  }
  
  // 清理微信昵称
  const sanitizedNickname = SecurityMiddleware.sanitizeInput(wxNickname);
  
  ws.userId = userId;
  
  // 初始化连接并发送问候
  await chatController.handleConnection(ws, sanitizedNickname);

  // 监听消息
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'init') {
        // 客户端初始化请求，重新发送问候
        console.log('收到init消息:', data);
        const sanitizedNickname = SecurityMiddleware.sanitizeInput(data.wxNickname || '');
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
      
      // 验证输入
      const inputValidation = SecurityMiddleware.validateInput(data.prompt);
      if (!inputValidation.valid) {
        ws.send(JSON.stringify({ error: inputValidation.error }));
        return;
      }
      
      // 检查速率限制
      if (!SecurityMiddleware.checkRateLimit(ws.userId, 60000, 30)) { // 每分钟30条消息
        ws.send(JSON.stringify({ error: '发送太频繁，请稍后再试' }));
        return;
      }

      // 清理输入内容
      const sanitizedPrompt = SecurityMiddleware.sanitizeInput(data.prompt);
      const sanitizedNickname = SecurityMiddleware.sanitizeInput(data.wxNickname || wxNickname);
      
      // 调用 Azure OpenAI，返回流式数据
      await chatController.sendMessage(ws, sanitizedPrompt, sanitizedNickname);
    } catch (error) {
      console.error('WebSocket 错误:', error);
      ws.send(JSON.stringify({ error: '服务器内部错误', details: error.message }));
    }
  });

  // 处理连接关闭
  ws.on('close', () => {
    chatController.handleDisconnect(ws);
    console.log('WebSocket 连接已关闭');
  });
});
