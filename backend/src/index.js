require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws'); // 引入 WebSocket 模块
const chatController = require('./controllers/chatController'); // 导入 WebSocket 聊天控制器
const SecurityMiddleware = require('./middleware/security');

const app = express();
const port = process.env.PORT || 3000;

// 中间件配置
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// 创建 WebSocket 服务器
const server = app.listen(port, () => {
  console.log(`服务器运行在端口 ${port}`);
});

// 创建WebSocket服务器，支持/ws路径
const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});

// 处理 WebSocket 连接
wss.on('connection', async (ws, req) => {
  console.log('WebSocket 连接已建立');
  
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
        const sanitizedNickname = SecurityMiddleware.sanitizeInput(data.wxNickname || '');
        await chatController.handleConnection(ws, sanitizedNickname);
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
