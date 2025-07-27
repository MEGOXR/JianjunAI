require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws'); // 引入 WebSocket 模块
const chatController = require('./controllers/chatController'); // 导入 WebSocket 聊天控制器

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

const wss = new WebSocketServer({ server });

// 处理 WebSocket 连接
wss.on('connection', (ws) => {
  console.log('WebSocket 连接已建立');

  // 监听消息
  ws.on('message', async (message) => {
    try {
      const { prompt } = JSON.parse(message);
      if (!prompt) {
        ws.send(JSON.stringify({ error: "缺少必要的 'prompt' 参数" }));
        return;
      }

      // 调用 Azure OpenAI，返回流式数据
      await chatController.sendMessage(ws, prompt);
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
