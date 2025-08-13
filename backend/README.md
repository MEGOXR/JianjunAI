# 后端服务配置指南

## 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量

编辑 `.env` 文件，填入您的API密钥：

#### Azure OpenAI 配置（必需）
- `AZURE_OPENAI_ENDPOINT`: 您的Azure OpenAI服务端点
- `AZURE_OPENAI_API_KEY`: 您的API密钥
- `OPENAI_API_VERSION`: API版本（默认: 2024-02-15-preview）
- `AZURE_OPENAI_DEPLOYMENT_NAME`: 部署名称（如: gpt-35-turbo）

#### Azure Speech Service 配置（可选）
- `AZURE_SPEECH_KEY`: 语音服务密钥（不配置则使用模拟识别）
- `AZURE_SPEECH_REGION`: 服务区域（默认: eastasia）
- `AZURE_SPEECH_LANGUAGE`: 识别语言（默认: zh-CN）

### 3. 启动服务

开发模式（带热重载）：
```bash
npm run dev
```

生产模式：
```bash
npm start
```

服务将在 `http://localhost:3000` 启动

## 获取Azure API密钥

### Azure OpenAI
1. 登录 [Azure Portal](https://portal.azure.com)
2. 创建 Azure OpenAI 资源
3. 在"密钥和终结点"页面获取API密钥和端点

### Azure Speech Service（可选）
1. 在Azure Portal创建"语音服务"资源
2. 在"密钥和终结点"页面获取密钥
3. 记录服务区域（如: eastasia）


