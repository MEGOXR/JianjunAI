require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 8080;

// 中间件配置
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    port: port,
    message: 'Simple server is running'
  });
});

// 配置检查端点
app.get('/config-check', (req, res) => {
  console.log('Config check requested');
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

// 创建服务器
const server = app.listen(port, () => {
  console.log(`简单服务器运行在端口 ${port}`);
  console.log(`环境变量检查:`);
  console.log(`- NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`- PORT: ${process.env.PORT}`);
  console.log(`- Azure OpenAI Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT ? '已设置' : '未设置'}`);
  console.log('服务器启动成功！');
});

// 捕获未处理的错误
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});

console.log('正在启动简单服务器...');