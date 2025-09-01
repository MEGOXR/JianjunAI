# 火山引擎服务集成实施方案

## 项目概述
本方案旨在将火山引擎的ASR（语音识别）、LLM（大语言模型）和TTS（语音合成）服务集成到现有的医疗咨询应用中，与Azure服务并存，支持灵活切换。

## 架构设计

### 1. 服务提供者抽象层
创建统一的服务接口，支持多个云服务提供商：

```
backend/
├── src/
│   ├── providers/                   # 新增provider层（不影响现有结构）
│   │   ├── base/                    # 基础抽象接口
│   │   │   ├── LLMProvider.js       # LLM服务接口
│   │   │   ├── ASRProvider.js       # ASR服务接口
│   │   │   └── TTSProvider.js       # TTS服务接口
│   │   ├── azure/                   # Azure实现
│   │   │   ├── AzureLLMProvider.js
│   │   │   ├── AzureASRProvider.js
│   │   │   └── AzureTTSProvider.js
│   │   └── volcengine/              # 火山引擎实现
│   │       ├── VolcengineLLMProvider.js
│   │       ├── VolcengineASRProvider.js
│   │       └── VolcengineTTSProvider.js
│   ├── controllers/                 # 保持不变（仅调整调用方式）
│   │   ├── chatController.js        # 需要小幅重构
│   │   └── speechController.js      # 需要小幅重构
│   ├── services/                    # 保持不变（新增2个文件）
│   │   ├── ProviderFactory.js       # 新增：服务工厂
│   │   ├── ConfigService.js         # 新增：配置管理
│   │   ├── greetingService.js       # 无需改动
│   │   ├── nameExtractorService.js  # 无需改动
│   │   ├── promptService.js         # 无需改动
│   │   ├── speechService.js         # 需要重构为使用Provider
│   │   ├── suggestionService.js     # 无需改动
│   │   ├── userDataService.js       # 无需改动
│   │   └── warmupService.js         # 无需改动
│   ├── middleware/                  # 完全不受影响
│   ├── routes/                      # 完全不受影响
│   └── utils/                       # 完全不受影响
```

### 2. 配置管理
支持通过环境变量灵活切换服务提供商：

```env
# 服务提供商选择
PROVIDER_TYPE=volcengine  # 可选值: azure, volcengine

# Azure 配置（保持现有）
AZURE_OPENAI_ENDPOINT=xxx
AZURE_OPENAI_API_KEY=xxx
AZURE_SPEECH_KEY=xxx
AZURE_SPEECH_REGION=xxx

# 火山引擎配置
VOLCENGINE_ACCESS_KEY=xxx
VOLCENGINE_SECRET_KEY=xxx
VOLCENGINE_REGION=cn-north-1
VOLCENGINE_APP_ID=xxx
VOLCENGINE_APP_KEY=xxx

# 火山引擎服务端点
VOLCENGINE_LLM_ENDPOINT=https://open.volcengineapi.com
VOLCENGINE_ASR_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
VOLCENGINE_TTS_ENDPOINT=http://cloud-vms.volcengineapi.com
```

## 对现有代码的影响分析

### 需要修改的文件
1. **chatController.js** - 将直接调用Azure OpenAI改为使用LLMProvider（约100行代码调整）
2. **speechService.js** - 将Azure Speech SDK调用改为使用ASR/TTSProvider（约150行代码调整）
3. **speechController.js** - 调整为调用重构后的speechService（约10行代码调整）

### 无需修改的文件
- 所有middleware文件 - 完全不受影响
- 所有routes文件 - 完全不受影响
- 大部分services文件 - 保持原有逻辑不变
- utils文件 - 完全不受影响

### 改动示例
```javascript
// chatController.js 改动前
const { AzureOpenAI } = require("openai");
const client = new AzureOpenAI({
  apiKey, endpoint, apiVersion, deployment
});
const stream = await client.chat.completions.create({...});

// chatController.js 改动后
const { ProviderFactory } = require('../services/ProviderFactory');
const llmProvider = ProviderFactory.getLLMProvider();
const stream = await llmProvider.createChatStream({
  messages: history,
  options: { maxTokens: 2000, temperature: 0.5 }
});
```

## 实施步骤（PRP格式）

### 阶段0：准备工作

#### Task 0.1: 环境变量配置准备
**目标**: 准备火山引擎和Azure的配置
**责任人**: 用户手动配置
**输出**: 完整的.env文件

**具体步骤**:
```bash
# 1. 创建.env文件（如果不存在）
cp backend/.env.example backend/.env

# 2. 添加火山引擎配置（用户提供）
VOLCENGINE_ACCESS_KEY=<您的Access Key>
VOLCENGINE_SECRET_KEY=<您的Secret Key>
VOLCENGINE_APP_ID=<您的AppId>
VOLCENGINE_APP_KEY=<您的AppKey>
VOLCENGINE_REGION=cn-north-1

# 3. 确认Azure配置仍然存在
# 4. 添加Provider类型配置（默认先使用azure）
PROVIDER_TYPE=azure  # 初始保持azure，后续可切换
```

**验证点**: 
- [ ] 用户确认：火山引擎API密钥已配置
- [ ] 用户确认：现有Azure服务正常运行

---

### 第一阶段：服务抽象层开发（不影响现有服务）

#### Task 1.1: 创建Provider基础接口
**目标**: 建立统一的服务接口标准
**输入**: 现有Azure服务的API结构
**输出**: 三个基础接口文件
**风险**: 低（仅新增文件，不影响现有代码）

**具体步骤**:
```bash
# 1. 创建目录结构
mkdir -p backend/src/providers/base
mkdir -p backend/src/providers/azure
mkdir -p backend/src/providers/volcengine

# 2. 创建LLMProvider.js基础接口
# 文件: backend/src/providers/base/LLMProvider.js
class LLMProvider {
  async createChatStream(messages, options) { throw new Error('Not implemented'); }
  async createCompletion(prompt, options) { throw new Error('Not implemented'); }
  async validateConfig() { throw new Error('Not implemented'); }
  async healthCheck() { throw new Error('Not implemented'); }
}

# 3. 创建ASRProvider.js基础接口  
# 文件: backend/src/providers/base/ASRProvider.js
class ASRProvider {
  async startStreamingRecognition(sessionId, config) { throw new Error('Not implemented'); }
  async processAudioFrame(sessionId, audioBuffer) { throw new Error('Not implemented'); }
  async endStreamingRecognition(sessionId) { throw new Error('Not implemented'); }
  async speechToText(audioFile) { throw new Error('Not implemented'); }
}

# 4. 创建TTSProvider.js基础接口
# 文件: backend/src/providers/base/TTSProvider.js
class TTSProvider {
  async textToSpeech(text, options) { throw new Error('Not implemented'); }
  async streamTextToSpeech(text, options) { throw new Error('Not implemented'); }
  getSupportedVoices() { throw new Error('Not implemented'); }
}
```

**测试验证**:
```bash
# 运行语法检查
cd backend
npm run lint  # 确保新文件符合代码规范
```

**用户验证点**: 
- [ ] 确认：目录结构创建成功
- [ ] 确认：基础接口文件无语法错误

**Commit节点**: ✅ `git commit -m "feat: add provider base interfaces"`

#### Task 1.2: 实现Azure Provider适配器
**目标**: 将现有Azure代码封装为Provider
**输入**: chatController.js和speechService.js中的Azure代码
**输出**: 三个Azure Provider实现
**风险**: 低（封装现有逻辑，不改变功能）

**具体步骤**:
```javascript
# 1. 创建AzureLLMProvider.js
# 文件: backend/src/providers/azure/AzureLLMProvider.js
const { AzureOpenAI } = require("openai");
const LLMProvider = require('../base/LLMProvider');

class AzureLLMProvider extends LLMProvider {
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
  }
  
  async initialize() {
    // 从chatController.js第272-277行提取
    this.client = new AzureOpenAI({
      apiKey: this.config.apiKey,
      endpoint: this.config.endpoint,
      apiVersion: this.config.apiVersion,
      deployment: this.config.deployment
    });
  }
  
  async createChatStream(messages, options = {}) {
    // 从chatController.js第289-298行提取
    return await this.client.chat.completions.create({
      model: this.config.deployment,
      messages: messages,
      stream: true,
      max_tokens: options.maxTokens || 2000,
      temperature: options.temperature || 0.5,
      ...options
    });
  }
  
  async validateConfig() {
    return !!(this.config.apiKey && this.config.endpoint);
  }
  
  async healthCheck() {
    try {
      await this.client.chat.completions.create({
        model: this.config.deployment,
        messages: [{role: "user", content: "test"}],
        max_tokens: 1
      });
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }
}

# 2. 创建AzureASRProvider.js （简化示例）
# 3. 创建AzureTTSProvider.js （简化示例）
```

**单元测试**:
```javascript
# 文件: backend/tests/providers/azure.test.js
const AzureLLMProvider = require('../../src/providers/azure/AzureLLMProvider');

describe('AzureLLMProvider', () => {
  test('should validate config correctly', async () => {
    const provider = new AzureLLMProvider({
      apiKey: 'test-key',
      endpoint: 'test-endpoint'
    });
    expect(await provider.validateConfig()).toBe(true);
  });
});
```

**测试验证**:
```bash
# 1. 运行单元测试
npm test -- azure.test.js

# 2. 测试现有功能是否正常（不切换Provider）
npm run dev
# 发送测试消息，确认Azure服务仍正常工作
```

**用户验证点**: 
- [ ] 确认：Provider文件创建成功
- [ ] 确认：单元测试通过
- [ ] 确认：现有Azure功能未受影响

**Commit节点**: ✅ `git commit -m "feat: implement Azure provider adapters"`

#### Task 1.3: 创建服务工厂和配置管理
**目标**: 实现服务动态选择机制
**输入**: 环境变量配置
**输出**: ProviderFactory.js和ConfigService.js
**风险**: 低（新增服务层，不影响现有逻辑）

**具体步骤**:
```javascript
# 1. 创建ConfigService.js
# 文件: backend/src/services/ConfigService.js
class ConfigService {
  static getProviderType() {
    return process.env.PROVIDER_TYPE || 'azure';
  }
  
  static getProviderConfig(type) {
    if (type === 'azure') {
      return {
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiVersion: process.env.OPENAI_API_VERSION,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
        speechKey: process.env.AZURE_SPEECH_KEY,
        speechRegion: process.env.AZURE_SPEECH_REGION
      };
    } else if (type === 'volcengine') {
      return {
        accessKey: process.env.VOLCENGINE_ACCESS_KEY,
        secretKey: process.env.VOLCENGINE_SECRET_KEY,
        appId: process.env.VOLCENGINE_APP_ID,
        appKey: process.env.VOLCENGINE_APP_KEY,
        region: process.env.VOLCENGINE_REGION
      };
    }
    throw new Error(`Unknown provider type: ${type}`);
  }
  
  static validateConfig(type, config) {
    // 验证必要字段
    if (type === 'azure') {
      return !!(config.apiKey && config.endpoint);
    } else if (type === 'volcengine') {
      return !!(config.accessKey && config.secretKey);
    }
    return false;
  }
}

# 2. 创建ProviderFactory.js（单例模式）
# 文件: backend/src/services/ProviderFactory.js
const ConfigService = require('./ConfigService');

class ProviderFactory {
  static instances = {};
  
  static getLLMProvider() {
    const type = ConfigService.getProviderType();
    const key = `llm_${type}`;
    
    if (!this.instances[key]) {
      const config = ConfigService.getProviderConfig(type);
      if (type === 'azure') {
        const AzureLLMProvider = require('../providers/azure/AzureLLMProvider');
        this.instances[key] = new AzureLLMProvider(config);
      } else if (type === 'volcengine') {
        const VolcengineLLMProvider = require('../providers/volcengine/VolcengineLLMProvider');
        this.instances[key] = new VolcengineLLMProvider(config);
      }
      this.instances[key].initialize();
    }
    
    return this.instances[key];
  }
  
  // 类似实现 getASRProvider() 和 getTTSProvider()
}
```

**集成测试**:
```bash
# 文件: backend/tests/integration/provider-factory.test.js
# 测试Provider工厂是否正确返回实例
# 测试配置验证
# 测试Provider切换
```

**用户验证点**: 
- [ ] 确认：ConfigService正确读取环境变量
- [ ] 确认：ProviderFactory能返回Azure Provider
- [ ] 确认：单例模式工作正常

**Commit节点**: ✅ `git commit -m "feat: add provider factory and config service"`

#### Task 1.4: 重构chatController.js（渐进式）
**目标**: 使用Provider替代直接调用Azure SDK
**输入**: 现有的chatController.js
**输出**: 重构后的chatController.js
**风险**: 中（修改核心逻辑，需要充分测试）

**具体步骤**:
```javascript
# 1. 备份原文件
cp backend/src/controllers/chatController.js backend/src/controllers/chatController.js.backup

# 2. 创建兼容性包装函数（保证平滑过渡）
# 文件: backend/src/controllers/chatController.js
# 在文件顶部添加feature flag
const USE_PROVIDER = process.env.USE_PROVIDER === 'true'; // 默认false

// 保留原有import
const { AzureOpenAI } = require("openai");
// 添加新import（条件加载）
const ProviderFactory = USE_PROVIDER ? require('../services/ProviderFactory') : null;

# 3. 修改sendMessage函数（保持向后兼容）
exports.sendMessage = async (ws, prompt) => {
  try {
    let stream;
    
    if (USE_PROVIDER) {
      // 新方式：使用Provider
      const llmProvider = ProviderFactory.getLLMProvider();
      await llmProvider.initialize();
      stream = await llmProvider.createChatStream(history, {
        maxTokens: 2000,
        temperature: 0.5
      });
    } else {
      // 原方式：直接使用Azure SDK（第272-298行保持不变）
      validateAzureConfig();
      const client = new AzureOpenAI({...});
      stream = await client.chat.completions.create({...});
    }
    
    // 流式处理逻辑保持不变（第303-327行）
    for await (const chunk of stream) {
      // ... 原有逻辑
    }
  } catch (error) {
    // 错误处理保持不变
  }
}
```

**分阶段测试计划**:
```bash
# 阶段1：不启用Provider（确保兼容性）
USE_PROVIDER=false npm run dev
# 测试现有功能

# 阶段2：启用Provider但使用Azure
USE_PROVIDER=true PROVIDER_TYPE=azure npm run dev  
# 测试Provider模式下的Azure

# 阶段3：完全切换测试
# 对比两种模式的响应
```

**用户验证点**: 
- [ ] 确认：备份文件创建成功
- [ ] 确认：USE_PROVIDER=false时功能正常
- [ ] 确认：USE_PROVIDER=true时功能正常
- [ ] 确认：响应时间和质量无明显差异

**Commit节点**: ✅ `git commit -m "feat: add provider support to chatController with feature flag"`

---

### 🔄 中期验证节点

**综合测试**（Task 1.1-1.4完成后）:
```bash
# 完整的端到端测试
npm run test:e2e

# 性能基准测试
npm run benchmark

# 代码覆盖率检查
npm run coverage
```

**用户确认清单**:
- [ ] Azure服务仍然正常工作
- [ ] 新代码没有破坏现有功能
- [ ] 性能没有明显下降
- [ ] 准备进入火山引擎集成阶段

**重要Commit**: ✅ `git commit -m "feat: complete provider abstraction layer"`
**创建标签**: `git tag -a v1.0-provider-ready -m "Provider abstraction layer complete"`

### 第二阶段：火山引擎服务集成

#### Task 2.1: 安装和配置火山引擎SDK
**目标**: 集成火山引擎Node.js SDK
**输入**: package.json
**输出**: 更新的依赖和配置文件

**具体步骤**:
```bash
# 1. 安装火山引擎SDK
cd backend
npm install @volcengine/openapi --save
npm install @volcengine/rtc-sdk --save

# 2. 创建火山引擎配置文件
# 文件: backend/src/config/volcengine.config.js
# - 配置认证参数（AK/SK）
# - 配置服务端点
# - 配置超时和重试参数

# 3. 更新.env.example
# 添加火山引擎相关环境变量示例
```

#### Task 2.2: 实现VolcengineLLMProvider
**目标**: 实现火山引擎大模型接口
**输入**: 火山引擎API文档
**输出**: VolcengineLLMProvider.js

**具体步骤**:
```bash
# 文件: backend/src/providers/volcengine/VolcengineLLMProvider.js

# 1. 初始化火山引擎客户端
# - 使用@volcengine/openapi创建客户端
# - 配置认证信息
# - 设置服务地址

# 2. 实现createChatStream方法
# - 转换消息格式为火山引擎格式
# - 调用火山引擎流式API
# - 处理流式响应，转换为统一格式
# - 实现错误处理

# 3. 实现token计算和上下文管理
# - 实现消息历史管理
# - 控制token使用量
```

#### Task 2.3: 实现VolcengineASRProvider（双向流式模式）
**目标**: 实现火山引擎语音识别（使用双向流式优化版本）
**输入**: 火山引擎大模型流式语音识别API文档
**输出**: VolcengineASRProvider.js

**API端点信息**:
- **双向流式模式**: `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`
- **特点**: 尽快返回识别字符，速度优先，适合实时对话

**具体步骤**:
```javascript
# 文件: backend/src/providers/volcengine/VolcengineASRProvider.js

# 1. WebSocket连接建立
const WebSocket = require('ws');
const crypto = require('crypto');

class VolcengineASRProvider extends ASRProvider {
  constructor(config) {
    super();
    this.config = {
      accessKey: config.accessKey,
      secretKey: config.secretKey, 
      appId: config.speechAppId,
      cluster: 'volcengine_streaming_common',
      wsUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'
    };
    this.sessions = new Map(); // 管理多个会话
  }

# 2. 实现认证和连接协议
  async startStreamingRecognition(sessionId, options = {}) {
    const ws = new WebSocket(this.config.wsUrl);
    const session = {
      ws,
      sessionId,
      state: 'connecting',
      buffer: [],
      onResult: options.onResult || (() => {}),
      onFinal: options.onFinal || (() => {}),
      onError: options.onError || (() => {})
    };
    
    this.sessions.set(sessionId, session);
    
    ws.on('open', () => {
      // 发送Full Client Request（首包）
      const payload = {
        app: {
          appid: this.config.appId,
          token: this.generateToken(),
          cluster: this.config.cluster
        },
        user: {
          uid: sessionId
        },
        audio: {
          format: "wav",
          rate: 16000,
          channel: 1,
          bits: 16,
          language: "zh-CN"
        },
        request: {
          reqid: this.generateReqId(),
          nbest: 1,
          continuous_decoding: true, // 双向流式关键配置
          sequence: 1,
          sub_protocol_name: "full_client_request"
        }
      };
      
      this.sendMessage(ws, payload, 'full_client_request');
      session.state = 'connected';
    });
    
    ws.on('message', (data) => {
      this.handleMessage(session, data);
    });
    
    ws.on('error', (error) => {
      session.onError(error);
      this.sessions.delete(sessionId);
    });
    
    return session;
  }

# 3. 消息处理和协议实现
  sendMessage(ws, payload, messageType = 'audio') {
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(4);
    
    // 协议头：4字节（消息类型1字节 + 负载大小3字节）
    if (messageType === 'full_client_request') {
      header.writeUInt8(0x11, 0); // Full client request
    } else if (messageType === 'audio') {
      header.writeUInt8(0x10, 0); // Audio only client request
    }
    
    // 写入负载大小（小端序）
    header.writeUIntLE(payloadBytes.length, 1, 3);
    
    const message = Buffer.concat([header, payloadBytes]);
    ws.send(message);
  }

# 4. 音频数据处理（200ms为单包最佳性能）
  async processAudioFrame(sessionId, audioBuffer) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'connected') {
      throw new Error('Session not connected');
    }
    
    // 将音频数据分包，每包约200ms（3200字节 for 16kHz 16bit mono）
    const chunkSize = 3200;
    let offset = 0;
    
    while (offset < audioBuffer.length) {
      const chunk = audioBuffer.slice(offset, offset + chunkSize);
      const payload = {
        audio: chunk.toString('base64'),
        sequence: ++session.sequence || 1
      };
      
      this.sendMessage(session.ws, payload, 'audio');
      offset += chunkSize;
      
      // 避免发送过快
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

# 5. 结果处理（双向流式特性）
  handleMessage(session, rawData) {
    try {
      // 解析协议头
      const header = rawData.slice(0, 4);
      const messageType = header.readUInt8(0);
      const payloadSize = header.readUIntLE(1, 3);
      const payload = rawData.slice(4, 4 + payloadSize);
      
      const response = JSON.parse(payload.toString('utf8'));
      
      if (response.result) {
        // 双向流式：实时返回部分结果
        if (response.result.is_final === false) {
          session.onResult({
            text: response.result.text,
            confidence: response.result.confidence,
            isFinal: false,
            timestamp: Date.now()
          });
        } else {
          // 最终结果
          session.onFinal({
            text: response.result.text,
            confidence: response.result.confidence,
            isFinal: true,
            duration: response.result.duration || 0
          });
        }
      }
      
      if (response.error) {
        session.onError(new Error(response.error.message));
      }
    } catch (error) {
      session.onError(error);
    }
  }

# 6. 会话结束和清理
  async endStreamingRecognition(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      // 发送结束标记（负包）
      const endPayload = {
        sequence: -1 // 负包标记会话结束
      };
      
      this.sendMessage(session.ws, endPayload, 'audio');
      
      // 等待最终结果
      setTimeout(() => {
        session.ws.close();
        this.sessions.delete(sessionId);
      }, 1000);
    }
  }

# 7. 辅助方法
  generateToken() {
    // 基于AccessKey和SecretKey生成认证token
    const timestamp = Math.floor(Date.now() / 1000);
    const signString = `${this.config.accessKey}${timestamp}`;
    return crypto.createHmac('sha256', this.config.secretKey)
                 .update(signString).digest('hex');
  }
  
  generateReqId() {
    return crypto.randomBytes(16).toString('hex');
  }
}

module.exports = VolcengineASRProvider;
```

**关键技术点**:
1. **双向流式**: 设置`continuous_decoding: true`启用双向流式模式
2. **最佳性能**: 单包200ms音频数据（3200字节）获得最佳性能
3. **实时响应**: `is_final: false`的结果实时返回，提供流畅体验
4. **协议头**: 4字节协议头包含消息类型和负载大小
5. **会话管理**: 支持多会话并发，每个会话独立管理
6. **错误处理**: 完整的连接错误和解析错误处理机制

**测试验证**:
```bash
# 单元测试
npm test -- volcengine-asr.test.js

# 集成测试：测试200ms音频包处理性能
# 验证双向流式实时返回功能
# 测试多会话并发处理
```

**用户验证点**: 
- [ ] 确认：WebSocket连接建立成功
- [ ] 确认：音频实时识别工作正常
- [ ] 确认：双向流式模式性能最优
- [ ] 确认：多会话并发无问题

#### Task 2.4: 实现VolcengineTTSProvider
**目标**: 实现火山引擎语音合成
**输入**: 火山引擎TTS API文档
**输出**: VolcengineTTSProvider.js

**API端点信息**:
- **TTS API**: `https://openspeech.bytedance.com/api/v1/tts`
- **特点**: 支持流式合成，多种音色，实时语音生成

**具体步骤**:
```javascript
# 文件: backend/src/providers/volcengine/VolcengineTTSProvider.js

const https = require('https');
const crypto = require('crypto');
const TTSProvider = require('../base/TTSProvider');

class VolcengineTTSProvider extends TTSProvider {
  constructor(config) {
    super();
    this.config = {
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      appId: config.speechAppId,
      cluster: 'volcano_tts',
      endpoint: 'https://openspeech.bytedance.com/api/v1/tts'
    };
  }

# 1. 实现文本转语音（基础方法）
  async textToSpeech(text, options = {}) {
    const requestData = {
      app: {
        appid: this.config.appId,
        token: this.generateToken(),
        cluster: this.config.cluster
      },
      user: {
        uid: options.userId || 'default_user'
      },
      audio: {
        voice_type: options.voiceType || 'zh_female_shuangkuai_moon_bigtts', // 默认专业女声
        encoding: options.encoding || 'wav',
        speed_ratio: options.speed || 1.0,
        volume_ratio: options.volume || 1.0,
        pitch_ratio: options.pitch || 1.0
      },
      request: {
        reqid: this.generateReqId(),
        text: text,
        text_type: 'plain',
        operation: 'query',
        with_frontend: 1,
        frontend_type: 'unitTson'
      }
    };

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(requestData);
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': `Bearer ${this.generateToken()}`
        }
      };

      const req = https.request(this.config.endpoint, options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            const audioBuffer = Buffer.concat(chunks);
            resolve({
              audioBuffer,
              format: requestData.audio.encoding,
              sampleRate: 16000,
              duration: this.calculateDuration(text)
            });
          } else {
            reject(new Error(`TTS API error: ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

# 2. 实现流式TTS（长文本优化）
  async streamTextToSpeech(text, options = {}) {
    const maxChunkLength = 200; // 单次TTS文本限制
    const chunks = this.splitText(text, maxChunkLength);
    const audioChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = await this.textToSpeech(chunk, {
        ...options,
        userId: options.userId || 'stream_user'
      });
      
      audioChunks.push(result.audioBuffer);
      
      // 流式返回
      if (options.onChunk) {
        options.onChunk({
          index: i,
          total: chunks.length,
          audioBuffer: result.audioBuffer,
          text: chunk,
          isLast: i === chunks.length - 1
        });
      }
    }

    // 合并所有音频片段
    const combinedBuffer = Buffer.concat(audioChunks);
    return {
      audioBuffer: combinedBuffer,
      format: options.encoding || 'wav',
      sampleRate: 16000,
      chunks: audioChunks.length
    };
  }

# 3. 获取支持的音色列表
  getSupportedVoices() {
    return [
      {
        id: 'zh_female_shuangkuai_moon_bigtts',
        name: '爽快-月',
        gender: 'female',
        language: 'zh-CN',
        description: '专业女声，适合医疗咨询'
      },
      {
        id: 'zh_male_jingqiang_moon_bigtts', 
        name: '京腔-月',
        gender: 'male',
        language: 'zh-CN',
        description: '专业男声，磁性温和'
      },
      {
        id: 'zh_female_wennuan_moon_bigtts',
        name: '温暖-月',
        gender: 'female', 
        language: 'zh-CN',
        description: '温暖女声，亲切友好'
      }
    ];
  }

# 4. 文本分段处理
  splitText(text, maxLength) {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks = [];
    let current = '';
    const sentences = text.split(/[。！？；\n]/);

    for (const sentence of sentences) {
      if ((current + sentence).length <= maxLength) {
        current += sentence + '。';
      } else {
        if (current) chunks.push(current.trim());
        current = sentence + '。';
      }
    }

    if (current) chunks.push(current.trim());
    return chunks.filter(chunk => chunk.length > 0);
  }

# 5. 辅助工具方法
  generateToken() {
    const timestamp = Math.floor(Date.now() / 1000);
    const signString = `${this.config.accessKey}${timestamp}`;
    return crypto.createHmac('sha256', this.config.secretKey)
                 .update(signString).digest('hex');
  }
  
  generateReqId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  calculateDuration(text) {
    // 估算语音时长（中文约2.5字/秒）
    return Math.ceil(text.length / 2.5);
  }
  
  async validateConfig() {
    return !!(this.config.accessKey && this.config.secretKey && this.config.appId);
  }
  
  async healthCheck() {
    try {
      const result = await this.textToSpeech('测试', { userId: 'health_check' });
      return {
        status: 'healthy',
        provider: 'Volcengine TTS',
        audioSize: result.audioBuffer.length
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: 'Volcengine TTS',
        error: error.message
      };
    }
  }
}

module.exports = VolcengineTTSProvider;
```

**关键技术点**:
1. **流式合成**: 长文本自动分段，逐段生成音频
2. **音色选择**: 提供专业医疗咨询适用的音色选项
3. **智能分段**: 按句号等自然停顿点分割文本
4. **音频合并**: 多段音频无缝拼接
5. **性能优化**: 支持并发生成和流式返回
6. **错误处理**: 完整的API错误和网络错误处理

**测试验证**:
```bash
# 单元测试
npm test -- volcengine-tts.test.js

# 测试流式合成功能
# 验证音色效果
# 测试长文本分段处理
```

**用户验证点**: 
- [ ] 确认：TTS API连接成功
- [ ] 确认：音频质量满足要求
- [ ] 确认：流式合成功能正常
- [ ] 确认：多种音色可选择

#### Task 2.5: 集成测试和切换机制
**目标**: 确保两套服务可以无缝切换
**输入**: 所有Provider实现
**输出**: 测试用例和切换脚本

**具体步骤**:
```bash
# 1. 创建测试套件
# 文件: backend/tests/providers.test.js
# - 测试Azure Provider功能
# - 测试Volcengine Provider功能  
# - 测试服务切换逻辑
# - 性能对比测试

# 2. 创建切换脚本
# 文件: backend/scripts/switch-provider.js
# - 读取当前配置
# - 验证目标Provider配置
# - 更新环境变量
# - 重启服务

# 3. 创建健康检查
# 文件: backend/src/utils/healthCheck.js
# - 检查Provider连接状态
# - 验证API可用性
# - 监控响应时间
```

### 第三阶段：火山引擎ECS部署方案（用户已准备）

#### Task 3.1: 火山引擎ECS初始环境配置
**目标**: 配置ECS服务器基础环境
**前提**: 用户已创建ECS实例并获取登录信息
**输出**: 可运行Node.js应用的服务器环境

**用户需提供的信息**:
```bash
# 请提供以下信息：
VOLCENGINE_ECS_IP=<您的ECS公网IP>
VOLCENGINE_ECS_USER=<SSH用户名，通常是root>
VOLCENGINE_ECS_PASSWORD=<SSH密码或私钥路径>
```

**具体步骤**:
```bash
# 1. SSH登录到ECS服务器
ssh root@<ECS_IP>

# 2. 更新系统包
apt update && apt upgrade -y

# 3. 安装Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt-get install -y nodejs

# 4. 验证安装
node --version  # 应该显示 v20.x.x
npm --version   # 应该显示 10.x.x

# 5. 安装PM2进程管理器
npm install -g pm2

# 6. 安装Git
apt-get install -y git

# 7. 创建应用目录
mkdir -p /var/www/jianjunai
cd /var/www/jianjunai

# 8. 配置防火墙（开放必要端口）
ufw allow 22    # SSH
ufw allow 3000  # Node.js应用
ufw allow 80    # HTTP（可选）
ufw allow 443   # HTTPS（可选）
ufw enable
```

**用户验证点**:
- [ ] 确认：成功SSH登录到ECS
- [ ] 确认：Node.js 20.x安装成功
- [ ] 确认：PM2安装成功
- [ ] 确认：防火墙规则配置正确

**Commit节点**: 记录配置信息到项目文档

#### Task 3.2: 部署代码到ECS
**目标**: 将应用代码部署到ECS服务器
**输入**: GitHub仓库
**输出**: 运行中的应用

**部署方式选择**:

**选项A：直接克隆（简单快速）**:
```bash
# 在ECS上执行
cd /var/www/jianjunai

# 1. 克隆代码（使用HTTPS，避免SSH密钥配置）
git clone https://github.com/<your-username>/JianjunAI.git .

# 2. 安装依赖
cd backend
npm install --production

# 3. 创建环境文件
nano .env
# 粘贴所有环境变量（包括火山引擎配置）

# 4. 使用PM2启动应用
pm2 start src/index.js --name jianjunai

# 5. 保存PM2配置
pm2 save
pm2 startup  # 设置开机自启
```

**选项B：CI/CD自动部署（推荐）**:
```yaml
# .github/workflows/deploy-volcengine.yml
name: Deploy to Volcengine ECS

on:
  push:
    branches: [main]
    paths:
      - 'backend/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Deploy to ECS
        uses: appleboy/ssh-action@v0.1.5
        with:
          host: ${{ secrets.VOLCENGINE_ECS_IP }}
          username: ${{ secrets.VOLCENGINE_ECS_USER }}
          key: ${{ secrets.VOLCENGINE_SSH_KEY }}
          script: |
            cd /var/www/jianjunai
            git pull origin main
            cd backend
            npm install --production
            pm2 restart jianjunai
```

**用户验证点**:
- [ ] 确认：代码成功部署到ECS
- [ ] 确认：应用在3000端口运行
- [ ] 确认：可以通过 http://<ECS_IP>:3000 访问

#### Task 3.3: 配置Nginx反向代理（可选但推荐）
**目标**: 设置Nginx处理HTTPS和负载均衡
**输出**: 通过域名访问的安全服务

**具体步骤**:
```bash
# 1. 安装Nginx
apt-get install -y nginx

# 2. 创建Nginx配置
nano /etc/nginx/sites-available/jianjunai

# 配置内容：
server {
    listen 80;
    server_name your-domain.com;  # 或使用IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# 3. 启用配置
ln -s /etc/nginx/sites-available/jianjunai /etc/nginx/sites-enabled/
nginx -t  # 测试配置
systemctl restart nginx

# 4. （可选）配置SSL证书
# 使用Let's Encrypt免费证书
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

**用户验证点**:
- [ ] 确认：Nginx配置正确
- [ ] 确认：可以通过80端口访问
- [ ] 确认：WebSocket连接正常工作

**Commit节点**: ✅ `git commit -m "docs: add Volcengine ECS deployment configuration"`

#### Task 3.4: 监控和日志配置
**目标**: 设置应用监控和日志收集
**输出**: 可监控的生产环境

**具体步骤**:
```bash
# 1. 配置PM2日志
pm2 install pm2-logrotate  # 自动轮转日志
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7

# 2. 查看日志
pm2 logs jianjunai

# 3. 监控命令
pm2 monit  # 实时监控
pm2 status  # 查看状态

# 4. 设置告警（使用PM2 Plus或自定义脚本）
# 创建健康检查脚本
nano /var/www/jianjunai/health-check.sh
#!/bin/bash
curl -f http://localhost:3000/health || pm2 restart jianjunai

# 5. 添加到crontab
crontab -e
*/5 * * * * /var/www/jianjunai/health-check.sh
```

**性能测试**:
```bash
# 本地测试火山引擎服务响应
curl -X POST http://<ECS_IP>:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "测试消息"}'

# 测试WebSocket连接
wscat -c ws://<ECS_IP>:3000
```

**用户验证点**:
- [ ] 确认：日志正常记录
- [ ] 确认：监控系统工作
- [ ] 确认：健康检查通过
- [ ] 确认：性能符合预期

**最终Commit**: ✅ `git commit -m "feat: complete Volcengine ECS deployment"`
**优点**：
- 完全控制服务器环境
- 灵活的配置和扩展
- 支持自定义部署脚本

**部署步骤**：
1. 创建火山引擎ECS实例（推荐配置：2核4G）
2. 安装Node.js 20.x环境
3. 配置PM2进程管理
4. 设置Nginx反向代理
5. 配置SSL证书
6. 实现GitHub Actions自动部署

#### 选项2：火山引擎容器服务（VKE）
**优点**：
- 容器化部署，易于管理
- 自动扩缩容
- 与现有Docker配置兼容

**部署步骤**：
1. 创建VKE集群
2. 构建Docker镜像
3. 推送到火山引擎镜像仓库
4. 部署Kubernetes配置
5. 设置负载均衡和自动扩展

#### 选项3：火山引擎函数计算（推荐用于轻量级服务）
**优点**：
- 按需付费，成本优化
- 自动扩展
- 无需管理服务器

**适用场景**：
- 语音识别结果处理
- 建议问题生成
- 用户数据同步

### 第四阶段：CI/CD配置

#### GitHub Actions工作流配置
```yaml
name: Deploy to Volcengine

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: |
          cd backend
          npm ci
          
      - name: Run tests
        run: |
          cd backend
          npm test
          
      - name: Deploy to Volcengine ECS
        env:
          VOLCENGINE_HOST: ${{ secrets.VOLCENGINE_HOST }}
          VOLCENGINE_USER: ${{ secrets.VOLCENGINE_USER }}
          VOLCENGINE_SSH_KEY: ${{ secrets.VOLCENGINE_SSH_KEY }}
        run: |
          # SSH部署脚本
          echo "$VOLCENGINE_SSH_KEY" > deploy_key
          chmod 600 deploy_key
          ssh -i deploy_key -o StrictHostKeyChecking=no $VOLCENGINE_USER@$VOLCENGINE_HOST '
            cd /var/www/jianjunai
            git pull origin main
            npm install --production
            pm2 restart jianjunai
          '
```

## 需要手动完成的任务

### 1. 火山引擎账号配置（必须）
- [ ] 注册火山引擎账号
- [ ] 开通以下服务：
  - [ ] 智能语音交互（ASR/TTS）
  - [ ] 大模型服务（LLM）
  - [ ] 云服务器（ECS）或容器服务（VKE）
- [ ] 创建访问密钥（Access Key/Secret Key）
- [ ] 获取各服务的AppId和AppKey

### 2. 服务配置（必须）
- [ ] 在火山引擎控制台配置ASR服务
  - 选择语音识别模型（推荐：大模型流式识别）
  - 配置语言（中文）
  - 获取WebSocket连接端点
- [ ] 配置TTS服务
  - 选择音色（推荐：专业女声）
  - 设置语速和音调参数
- [ ] 配置LLM服务
  - 选择模型版本
  - 设置token限制和温度参数

### 3. 部署环境准备（必须）
- [ ] 创建火山引擎ECS实例或VKE集群
- [ ] 配置安全组规则（开放3000端口）
- [ ] 绑定弹性公网IP
- [ ] 配置域名解析（可选）
- [ ] 申请SSL证书（如需HTTPS）

### 4. GitHub配置（必须）
- [ ] 在GitHub仓库设置Secrets：
  - `VOLCENGINE_ACCESS_KEY`
  - `VOLCENGINE_SECRET_KEY`
  - `VOLCENGINE_HOST`（ECS公网IP）
  - `VOLCENGINE_USER`（SSH用户名）
  - `VOLCENGINE_SSH_KEY`（SSH私钥）

### 5. 初始部署（必须）
- [ ] SSH登录到ECS服务器
- [ ] 安装必要软件：
  ```bash
  # 安装Node.js 20
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  
  # 安装PM2
  npm install -g pm2
  
  # 安装Nginx（可选）
  sudo apt-get install nginx
  ```
- [ ] 克隆代码仓库
- [ ] 配置环境变量文件
- [ ] 首次启动服务

### 6. 监控和日志（推荐）
- [ ] 配置火山引擎云监控
- [ ] 设置告警规则
- [ ] 配置日志收集
- [ ] 设置性能监控指标

## 测试计划

### 1. 单元测试
- 测试各Provider的基本功能
- 验证服务切换逻辑
- 错误处理测试

### 2. 集成测试
- Azure服务完整流程测试
- 火山引擎服务完整流程测试
- 服务切换测试
- 并发请求测试

### 3. 性能测试
- 响应时间对比
- 并发处理能力
- 资源使用情况
- 成本分析

## 预期成本

### 火山引擎服务费用（月度预估）
- **ECS服务器**：2核4G约 ¥200/月
- **ASR服务**：按使用量计费，约 ¥0.01/秒
- **TTS服务**：按字符数计费，约 ¥0.5/千字符
- **LLM服务**：按token计费，约 ¥0.1/千tokens
- **带宽费用**：按流量计费，约 ¥0.8/GB

### 对比Azure（现有方案）
- 火山引擎在国内访问延迟更低
- ASR/TTS服务价格相对Azure更有优势
- LLM服务价格与Azure相当

## 风险和缓解措施

### 1. 技术风险
- **风险**：火山引擎SDK稳定性
- **缓解**：实现重试机制和降级策略

### 2. 性能风险
- **风险**：服务响应延迟
- **缓解**：实现缓存机制和预热策略

### 3. 成本风险
- **风险**：使用量超出预算
- **缓解**：设置使用量告警和限额

## 时间线

- **第1-2周**：完成服务抽象层和Azure重构
- **第3周**：完成火山引擎服务集成
- **第4周**：部署配置和测试
- **第5周**：性能优化和文档完善

## 后续优化建议

1. **多区域部署**：在多个地区部署服务，提高可用性
2. **智能路由**：根据用户位置自动选择最近的服务
3. **混合使用**：某些功能使用Azure，某些使用火山引擎
4. **成本优化**：根据使用情况动态调整服务配置
5. **缓存策略**：对常见问题实现响应缓存

## 总结

通过实施本方案，应用将具备：
- 多云服务支持，提高系统可靠性
- 灵活的服务切换能力
- 更低的国内访问延迟
- 成本优化的可能性
- 更好的扩展性和维护性

整个实施过程预计需要4-5周时间，其中大部分开发工作可以自动化完成，但需要手动完成火山引擎账号配置、服务开通和初始部署等关键步骤。

---

# AI回复自动朗读功能实施方案

## 目标
为AI回复内容添加TTS功能，实现自动朗读和交互式语音播放控制，提升用户体验。

## 功能需求

### 1. 自动朗读
- AI回复完成后自动开始朗读
- 支持点击回复文本框取消朗读

### 2. 朗读控制按钮
在AI回复文本框底部添加交互按钮：
- **复制按钮**：复制回复内容到剪贴板
- **朗读控制按钮**：
  - 朗读中：显示动态声波效果
  - 未朗读/朗读完成：显示小喇叭图标
  - 点击重新朗读

## 模块化实施方案（PRP格式）

基于现有项目的模块化架构（WebSocketManager、MessageManager、VoiceRecorder等），TTS功能将采用相同的模块化设计模式。

### 模块化架构设计

#### 前端模块架构（简化版）
```
frontend/
├── pages/index/modules/
│   ├── tts-manager.js          # TTS核心管理模块（新增，简化版）
│   ├── audio-player.js         # 音频播放控制模块（新增，简化版）
│   ├── message-manager.js      # 消息管理模块（需扩展TTS支持）
│   └── ...其他现有模块
```

**简化说明**：
- 移除音色配置、语速设置等复杂功能
- 使用后端默认配置，无需前端配置管理
- 专注于核心的播放控制和自动朗读功能

#### 后端模块架构
```
backend/src/
├── controllers/
│   └── ttsController.js        # TTS控制器（已存在，需完善）
├── services/
│   ├── TTSService.js           # TTS统一服务接口（新增）
│   └── TTSCacheService.js      # TTS缓存服务（新增）
└── providers/                  # Provider层（已存在）
    ├── azure/AzureTTSProvider.js
    └── volcengine/VolcengineTTSProvider.js
```

### Phase 1: 后端TTS模块完善

#### Task 1.1: 创建TTS流式接口
**目标**: 为前端提供TTS流式音频接口
**责任人**: 开发者
**输入**: AI回复文本内容
**输出**: 流式音频数据接口

**具体步骤**:
```javascript
// 文件: backend/src/controllers/ttsController.js
const ProviderFactory = require('../services/ProviderFactory');
const ConfigService = require('../services/ConfigService');

// 新增TTS流式接口
exports.textToSpeechStream = async (req, res) => {
  try {
    const { text, voice, userId } = req.body;
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: '文本内容不能为空' });
    }

    const ttsProvider = ProviderFactory.getTTSProvider();
    await ttsProvider.initialize();

    // 获取当前Provider的配置（包含默认音色）
    const providerType = ConfigService.getProviderType();
    const providerConfig = ConfigService.getProviderConfig(providerType);
    const defaultVoice = providerConfig.ttsVoice;

    // 动态设置响应头（根据Provider支持的格式）
    const supportedFormats = ttsProvider.getSupportedFormats();
    const audioFormat = supportedFormats.includes('mp3') ? 'mp3' : 'wav';
    const contentType = audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Audio-Format', audioFormat); // 告知前端音频格式
    
    // 流式TTS合成
    await ttsProvider.streamTextToSpeech(text, {
      voiceType: voice || defaultVoice,
      userId: userId || 'web_user',
      encoding: audioFormat,
      onChunk: (chunk) => {
        // 将音频数据块写入响应流
        res.write(chunk.audioBuffer);
      }
    });
    
    res.end();
    
  } catch (error) {
    console.error('TTS流式合成错误:', error);
    res.status(500).json({ error: 'TTS服务异常' });
  }
};

// 获取当前Provider支持的音色列表
exports.getSupportedVoices = async (req, res) => {
  try {
    const ttsProvider = ProviderFactory.getTTSProvider();
    const voices = ttsProvider.getSupportedVoices();
    const providerType = ConfigService.getProviderType();
    
    res.json({
      provider: providerType,
      voices: voices,
      defaultVoice: voices[0]?.id
    });
  } catch (error) {
    console.error('获取音色列表失败:', error);
    res.status(500).json({ error: '获取音色列表失败' });
  }
};
```

**路由配置**:
```javascript
// 文件: backend/src/routes/speech.js
router.post('/tts/stream', ttsController.textToSpeechStream);
router.get('/tts/voices', ttsController.getSupportedVoices);
```

**验证点**:
- [ ] TTS流式接口正常工作
- [ ] 音频数据正确返回
- [ ] 错误处理完善

#### Task 1.2: 优化TTS缓存机制  
**目标**: 实现TTS结果缓存，提高性能
**输入**: 文本内容和音色配置
**输出**: 缓存的音频文件

**具体步骤**:
```javascript
// 文件: backend/src/services/TTSCacheService.js
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class TTSCacheService {
  constructor() {
    this.cacheDir = path.join(__dirname, '../../cache/tts');
    this.maxCacheSize = 100 * 1024 * 1024; // 100MB
    this.maxCacheAge = 24 * 60 * 60 * 1000; // 24小时
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  generateCacheKey(text, voice, options = {}) {
    const content = `${text}|${voice}|${JSON.stringify(options)}`;
    return crypto.createHash('md5').update(content).digest('hex');
  }

  async get(cacheKey) {
    try {
      const filePath = path.join(this.cacheDir, `${cacheKey}.wav`);
      const stats = await fs.stat(filePath);
      
      // 检查文件是否过期
      if (Date.now() - stats.mtime.getTime() > this.maxCacheAge) {
        await fs.unlink(filePath);
        return null;
      }
      
      return await fs.readFile(filePath);
    } catch (error) {
      return null;
    }
  }

  async set(cacheKey, audioBuffer) {
    try {
      const filePath = path.join(this.cacheDir, `${cacheKey}.wav`);
      await fs.writeFile(filePath, audioBuffer);
      await this.cleanupOldFiles();
    } catch (error) {
      console.error('TTS缓存写入失败:', error);
    }
  }

  async cleanupOldFiles() {
    // 定期清理过期文件
    // 实现LRU缓存清理策略
  }
}

module.exports = new TTSCacheService();
```

**验证点**:
- [ ] 缓存机制正常工作
- [ ] 相同文本快速返回缓存结果
- [ ] 缓存大小和过期时间控制正确

### Phase 2: 前端TTS模块化实现

#### Task 2.1: 创建简化版音频播放模块
**目标**: 创建简化的音频播放控制模块，专注核心播放功能
**输入**: TTS音频流数据
**输出**: AudioPlayer模块类（简化版）

**具体步骤**:
```javascript
// 文件: frontend/pages/index/modules/audio-player.js
/**
 * Audio Player Module (Simplified)
 * 音频播放控制模块，处理TTS音频的播放和停止操作
 */
class AudioPlayer {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.currentAudio = null;
    this.isPlaying = false;
    this.currentMessageId = null;
    
    // 播放状态回调
    this.callbacks = {
      onPlayStart: null,
      onPlayEnd: null,
      onPlayError: null
    };
  }

  /**
   * 设置播放状态回调
   */
  setCallbacks(callbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * 播放TTS音频流
   */
  async playTTSStream(text, messageId) {
    try {
      console.log('AudioPlayer: 开始播放TTS', { messageId, textLength: text.length });
      
      // 停止当前播放
      this.stop();
      
      // 设置当前播放消息
      this.currentMessageId = messageId;
      
      // 触发播放开始回调
      if (this.callbacks.onPlayStart) {
        this.callbacks.onPlayStart(messageId);
      }

      // 请求TTS音频
      const audioData = await this.requestTTS(text);
      
      // 播放音频
      await this.playAudioBuffer(audioData);
      
      return true;
    } catch (error) {
      console.error('AudioPlayer: 播放失败', error);
      
      // 触发错误回调
      if (this.callbacks.onPlayError) {
        this.callbacks.onPlayError(error, messageId);
      }
      
      return false;
    }
  }

  /**
   * 请求TTS音频数据（简化版 - 使用默认配置）
   */
  async requestTTS(text) {
    const config = require('../../../config/env.js');
    
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${config.API_BASE_URL}/api/speech/tts/stream`,
        method: 'POST',
        data: {
          text: text,
          userId: this.page.userId || 'miniprogram_user'
        },
        responseType: 'arraybuffer',
        timeout: 30000,
        
        success: (res) => {
          if (res.statusCode === 200 && res.data) {
            const audioFormat = res.header['X-Audio-Format'] || 'wav';
            resolve({
              buffer: res.data,
              format: audioFormat
            });
          } else {
            reject(new Error(`TTS请求失败: ${res.statusCode}`));
          }
        },
        
        fail: (error) => {
          reject(new Error(`网络请求失败: ${error.errMsg}`));
        }
      });
    });
  }

  /**
   * 播放音频缓冲区
   */
  async playAudioBuffer(audioData) {
    return new Promise((resolve, reject) => {
      // 生成临时文件路径
      const tempFilePath = `${wx.env.USER_DATA_PATH}/tts_${Date.now()}.${audioData.format}`;
      
      // 写入临时文件
      wx.getFileSystemManager().writeFile({
        filePath: tempFilePath,
        data: audioData.buffer,
        success: () => {
          // 创建音频上下文
          const audioContext = wx.createInnerAudioContext();
          audioContext.src = tempFilePath;
          audioContext.autoplay = true;
          
          // 设置当前音频
          this.currentAudio = audioContext;
          this.isPlaying = true;
          
          // 播放事件监听
          audioContext.onPlay(() => {
            this.isPlaying = true;
          });
          
          audioContext.onEnded(() => {
            this.cleanup(audioContext, tempFilePath);
            if (this.callbacks.onPlayEnd) {
              this.callbacks.onPlayEnd(this.currentMessageId);
            }
            resolve();
          });
          
          audioContext.onError((error) => {
            this.cleanup(audioContext, tempFilePath);
            if (this.callbacks.onPlayError) {
              this.callbacks.onPlayError(error, this.currentMessageId);
            }
            reject(error);
          });
          
          audioContext.onStop(() => {
            this.cleanup(audioContext, tempFilePath);
            if (this.callbacks.onPlayEnd) {
              this.callbacks.onPlayEnd(this.currentMessageId);
            }
            resolve();
          });
        },
        
        fail: (error) => {
          reject(error);
        }
      });
    });
  }

  /**
   * 停止播放
   */
  stop() {
    if (this.currentAudio && this.isPlaying) {
      this.currentAudio.stop();
    }
  }

  /**
   * 清理音频资源
   */
  cleanup(audioContext, tempFilePath) {
    // 重置状态
    this.isPlaying = false;
    this.currentMessageId = null;
    
    // 销毁音频上下文
    if (audioContext) {
      audioContext.destroy();
    }
    
    // 重置当前音频
    if (this.currentAudio === audioContext) {
      this.currentAudio = null;
    }
    
    // 删除临时文件
    if (tempFilePath) {
      wx.getFileSystemManager().unlink({
        filePath: tempFilePath,
        success: () => console.log('AudioPlayer: 临时文件已删除'),
        fail: (error) => console.warn('AudioPlayer: 临时文件删除失败', error)
      });
    }
  }

  /**
   * 获取播放状态
   */
  getPlayingStatus() {
    return {
      isPlaying: this.isPlaying,
      currentMessageId: this.currentMessageId
    };
  }

  /**
   * 检查消息是否正在播放
   */
  isMessagePlaying(messageId) {
    return this.isPlaying && this.currentMessageId === messageId;
  }
}

module.exports = AudioPlayer;
```

#### Task 2.2: 创建TTS管理模块
**目标**: 创建TTS核心管理模块，统一管理TTS功能
**输入**: 页面实例和消息数据
**输出**: TTSManager模块类

**具体步骤**:
```javascript
// 文件: frontend/pages/index/modules/tts-manager.js
/**
 * TTS Manager Module
 * TTS核心管理模块，处理TTS功能的整体协调和状态管理
 */
class TTSManager {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.audioPlayer = null;
    this.settings = {
      autoTTS: true,
      selectedVoiceIndex: 0,
      speechRate: 1.0
    };
    
    // 初始化音频播放器
    this.initializeAudioPlayer();
  }

  /**
   * 初始化音频播放器
   */
  initializeAudioPlayer() {
    const AudioPlayer = require('./audio-player.js');
    this.audioPlayer = new AudioPlayer(this.page);
    
    // 设置播放回调
    this.audioPlayer.setCallbacks({
      onPlayStart: this.onPlayStart.bind(this),
      onPlayEnd: this.onPlayEnd.bind(this),
      onPlayError: this.onPlayError.bind(this)
    });
  }

  /**
   * 初始化TTS设置
   */
  initialize() {
    console.log('TTSManager: 初始化');
    
    // 加载用户设置
    this.loadSettings();
    
    // 更新页面数据
    this.page.setData({
      autoTTS: this.settings.autoTTS
    });
  }

  /**
   * 加载TTS设置
   */
  loadSettings() {
    try {
      const savedSettings = wx.getStorageSync('tts_settings') || {};
      this.settings = {
        autoTTS: savedSettings.autoTTS !== false,
        selectedVoiceIndex: savedSettings.selectedVoiceIndex || 0,
        speechRate: savedSettings.speechRate || 1.0
      };
      console.log('TTSManager: 设置已加载', this.settings);
    } catch (error) {
      console.error('TTSManager: 设置加载失败', error);
    }
  }

  /**
   * 保存TTS设置
   */
  saveSettings() {
    try {
      wx.setStorageSync('tts_settings', this.settings);
      console.log('TTSManager: 设置已保存', this.settings);
    } catch (error) {
      console.error('TTSManager: 设置保存失败', error);
    }
  }

  /**
   * 复制消息内容
   */
  copyMessage(content) {
    if (!content) {
      wx.showToast({
        title: '没有可复制的内容',
        icon: 'none'
      });
      return;
    }
    
    wx.setClipboardData({
      data: content,
      success: () => {
        wx.showToast({
          title: '已复制到剪贴板',
          icon: 'success',
          duration: 1500
        });
      },
      fail: () => {
        wx.showToast({
          title: '复制失败',
          icon: 'none'
        });
      }
    });
  }

  /**
   * 切换TTS播放状态
   */
  async toggleTTS(messageId) {
    const message = this.findMessageById(messageId);
    if (!message) {
      console.error('TTSManager: 消息未找到', messageId);
      return;
    }

    console.log('TTSManager: 切换TTS播放', { messageId, isPlaying: message.isPlaying });

    if (message.isPlaying) {
      // 停止播放
      this.audioPlayer.stop();
    } else {
      // 开始播放
      await this.playMessageTTS(message);
    }
  }

  /**
   * 播放消息TTS
   */
  async playMessageTTS(message) {
    if (!message || !message.content) {
      console.error('TTSManager: 消息内容无效', message);
      return;
    }

    console.log('TTSManager: 开始播放消息TTS', message.id);

    // 立即更新UI状态
    this.updateMessagePlayingStatus(message.id, true);

    // 播放TTS
    const success = await this.audioPlayer.playTTSStream(message.content, {
      messageId: message.id,
      userId: this.page.userId
    });

    if (!success) {
      // 播放失败，重置状态
      this.updateMessagePlayingStatus(message.id, false);
    }
  }

  /**
   * AI消息点击处理（取消朗读）
   */
  onAIMessageTap(messageId) {
    const message = this.findMessageById(messageId);
    if (message && message.isPlaying) {
      console.log('TTSManager: 点击消息取消朗读', messageId);
      this.audioPlayer.stop();
    }
  }

  /**
   * AI回复完成后的处理
   */
  onAIResponseComplete(message) {
    console.log('TTSManager: AI回复完成', {
      messageId: message.id,
      autoTTS: this.settings.autoTTS,
      contentLength: message.content ? message.content.length : 0
    });

    // 确保消息有唯一ID
    if (!message.id) {
      message.id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // 添加TTS播放状态
    message.isPlaying = false;

    // 自动朗读（如果启用）
    if (this.settings.autoTTS && message.content && message.content.trim()) {
      console.log('TTSManager: 自动开始朗读');
      setTimeout(() => {
        this.playMessageTTS(message);
      }, 800); // 延迟800ms让用户看到完整回复
    }
  }

  /**
   * 更新消息播放状态
   */
  updateMessagePlayingStatus(messageId, isPlaying) {
    const messages = this.page.data.messages.map(msg => {
      if (msg.id === messageId) {
        return { ...msg, isPlaying };
      }
      // 确保同时只有一个消息在播放
      return { ...msg, isPlaying: false };
    });

    this.page.setData({ messages });
    console.log(`TTSManager: 更新播放状态 ${messageId} -> ${isPlaying}`);
  }

  /**
   * 根据ID查找消息
   */
  findMessageById(messageId) {
    return this.page.data.messages.find(msg => msg.id === messageId);
  }

  /**
   * 播放开始回调
   */
  onPlayStart(messageId) {
    console.log('TTSManager: 播放开始', messageId);
    this.updateMessagePlayingStatus(messageId, true);
  }

  /**
   * 播放结束回调
   */
  onPlayEnd(messageId) {
    console.log('TTSManager: 播放结束', messageId);
    this.updateMessagePlayingStatus(messageId, false);
  }

  /**
   * 播放错误回调
   */
  onPlayError(error, messageId) {
    console.error('TTSManager: 播放错误', error, messageId);
    if (messageId) {
      this.updateMessagePlayingStatus(messageId, false);
    }
    
    wx.showToast({
      title: '语音播放失败',
      icon: 'none',
      duration: 2000
    });
  }

  /**
   * 获取播放状态
   */
  getPlayingStatus() {
    return this.audioPlayer.getPlayingStatus();
  }

  /**
   * 设置自动朗读
   */
  setAutoTTS(enabled) {
    this.settings.autoTTS = enabled;
    this.saveSettings();
    this.page.setData({ autoTTS: enabled });
  }
}

module.exports = TTSManager;
```

#### Task 2.3: 创建TTS配置工具
**目标**: 创建TTS配置管理工具模块
**输入**: 用户设置和系统配置
**输出**: TTS配置工具类

**具体步骤**:
```javascript
// 文件: frontend/utils/tts-config.js
/**
 * TTS Configuration Utility
 * TTS配置管理工具，处理设置的加载、保存和API配置
 */
const envConfig = require('../config/env.js');

class TTSConfig {
  constructor() {
    this.defaultSettings = {
      autoTTS: true,
      selectedVoiceIndex: 0,
      speechRate: 1.0,
      voices: []
    };
    
    this.cachedVoices = null;
    this.lastVoiceUpdate = 0;
  }

  /**
   * 获取API基础URL
   */
  getAPIBaseURL() {
    return envConfig.API_BASE_URL || 'http://localhost:3000';
  }

  /**
   * 获取用户TTS设置
   */
  getUserSettings() {
    try {
      const settings = wx.getStorageSync('tts_settings') || {};
      return {
        ...this.defaultSettings,
        ...settings
      };
    } catch (error) {
      console.error('TTSConfig: 获取用户设置失败', error);
      return { ...this.defaultSettings };
    }
  }

  /**
   * 保存用户TTS设置
   */
  saveUserSettings(settings) {
    try {
      const currentSettings = this.getUserSettings();
      const newSettings = { ...currentSettings, ...settings };
      wx.setStorageSync('tts_settings', newSettings);
      console.log('TTSConfig: 设置已保存', newSettings);
      return true;
    } catch (error) {
      console.error('TTSConfig: 设置保存失败', error);
      return false;
    }
  }

  /**
   * 获取选中的音色ID
   */
  getSelectedVoice() {
    const settings = this.getUserSettings();
    if (settings.voices && settings.voices.length > 0) {
      const selectedVoice = settings.voices[settings.selectedVoiceIndex];
      return selectedVoice ? selectedVoice.id : undefined;
    }
    return undefined;
  }

  /**
   * 获取支持的音色列表（带缓存）
   */
  async getSupportedVoices(forceRefresh = false) {
    const now = Date.now();
    const cacheTimeout = 5 * 60 * 1000; // 5分钟缓存
    
    // 检查缓存
    if (!forceRefresh && this.cachedVoices && (now - this.lastVoiceUpdate < cacheTimeout)) {
      return this.cachedVoices;
    }

    try {
      const response = await new Promise((resolve, reject) => {
        wx.request({
          url: `${this.getAPIBaseURL()}/api/speech/tts/voices`,
          method: 'GET',
          timeout: 10000,
          success: resolve,
          fail: reject
        });
      });

      if (response.statusCode === 200) {
        this.cachedVoices = response.data;
        this.lastVoiceUpdate = now;
        
        // 保存音色列表到设置中
        const settings = this.getUserSettings();
        settings.voices = response.data.voices || [];
        this.saveUserSettings(settings);
        
        console.log('TTSConfig: 音色列表已更新', response.data);
        return response.data;
      } else {
        throw new Error(`API请求失败: ${response.statusCode}`);
      }
    } catch (error) {
      console.error('TTSConfig: 获取音色列表失败', error);
      
      // 降级：返回缓存或默认值
      if (this.cachedVoices) {
        return this.cachedVoices;
      }
      
      return {
        provider: 'unknown',
        voices: [{
          id: 'default',
          name: '默认音色',
          description: '系统默认音色'
        }],
        defaultVoice: 'default'
      };
    }
  }

  /**
   * 测试指定音色
   */
  async testVoice(voiceId, testText = '您好，我是杨院长，很高兴为您提供整形美容咨询服务。') {
    try {
      const response = await new Promise((resolve, reject) => {
        wx.request({
          url: `${this.getAPIBaseURL()}/api/speech/tts/stream`,
          method: 'POST',
          data: {
            text: testText,
            voice: voiceId,
            userId: 'voice_test'
          },
          responseType: 'arraybuffer',
          timeout: 15000,
          success: resolve,
          fail: reject
        });
      });

      return response.statusCode === 200;
    } catch (error) {
      console.error('TTSConfig: 音色测试失败', error);
      return false;
    }
  }

  /**
   * 获取TTS服务健康状态
   */
  async getHealthStatus() {
    try {
      const response = await new Promise((resolve, reject) => {
        wx.request({
          url: `${this.getAPIBaseURL()}/api/speech/tts/health`,
          method: 'GET',
          timeout: 5000,
          success: resolve,
          fail: reject
        });
      });

      if (response.statusCode === 200) {
        return response.data;
      } else {
        throw new Error(`健康检查失败: ${response.statusCode}`);
      }
    } catch (error) {
      console.error('TTSConfig: 健康检查失败', error);
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  /**
   * 重置所有设置
   */
  resetSettings() {
    try {
      wx.removeStorageSync('tts_settings');
      this.cachedVoices = null;
      this.lastVoiceUpdate = 0;
      console.log('TTSConfig: 设置已重置');
      return true;
    } catch (error) {
      console.error('TTSConfig: 重置设置失败', error);
      return false;
    }
  }
}

// 导出单例
const ttsConfig = new TTSConfig();
module.exports = ttsConfig;
```

#### Task 2.4: 集成TTS模块到主页面
**目标**: 将TTS模块集成到主页面的模块化架构中
**输入**: 现有页面架构和TTS模块
**输出**: 集成后的页面逻辑

**具体步骤**:
```javascript
// 文件: frontend/pages/index/index.js（修改部分）
// Import all modules
const WebSocketManager = require('./modules/websocket-manager.js');
const VoiceRecorder = require('./modules/voice-recorder.js');
const StreamingSpeechManager = require('./modules/streaming-speech.js');
const MessageManager = require('./modules/message-manager.js');
const ScrollController = require('./modules/scroll-controller.js');
const UIStateManager = require('./modules/ui-state-manager.js');
const TTSManager = require('./modules/tts-manager.js'); // 新增TTS模块

Page({
  // 核心数据状态 - 只保留UI渲染必需的数据
  data: {
    userInput: "", 
    isConnecting: false, 
    messages: [], 
    isVoiceMode: false,
    isRecording: false,
    showScrollToBottom: false,
    userHasScrolledUp: false,
    scrollIntoView: '',
    messageCount: 0,
    isGenerating: false,
    
    // 语音相关状态
    recordingDuration: 0,
    isRecordingCanceling: false,
    waveformData: [],
    recordingStartY: 0,
    showVoiceModal: false,
    recordingText: '按住说话',
    isInputRecording: false,
    keyboardHeight: 0,
    
    // 流式语音识别状态
    isStreamingSpeech: false,
    
    // TTS相关状态（新增）
    autoTTS: true
  },

  onLoad: function() {
    // 初始化实例属性
    this.userId = null;
    this.authToken = null;
    
    // 初始化所有模块（包括新的TTS模块）
    this.webSocketManager = new WebSocketManager(this);
    this.voiceRecorder = new VoiceRecorder(this);
    this.streamingSpeechManager = new StreamingSpeechManager(this);
    this.messageManager = new MessageManager(this);
    this.scrollController = new ScrollController(this);
    this.uiStateManager = new UIStateManager(this);
    this.ttsManager = new TTSManager(this); // 新增TTS管理器
    
    // 初始化页面
    this.uiStateManager.initialize();
    
    // 初始化TTS（新增）
    this.ttsManager.initialize();
  },

  // ... 现有方法保持不变 ...

  // ==================== TTS 方法（新增） ====================
  
  /**
   * 复制消息内容
   */
  copyMessage: function(e) {
    const content = e.currentTarget.dataset.content;
    this.ttsManager.copyMessage(content);
  },

  /**
   * 切换TTS播放状态
   */
  toggleTTS: function(e) {
    const messageId = e.currentTarget.dataset.messageId;
    this.ttsManager.toggleTTS(messageId);
  },

  /**
   * AI消息点击处理（取消朗读）
   */
  onAIMessageTap: function(e) {
    const messageId = e.currentTarget.dataset.messageId;
    this.ttsManager.onAIMessageTap(messageId);
  },

  /**
   * AI回复完成后的处理（需要在MessageManager中调用）
   */
  onAIResponseComplete: function(message) {
    this.ttsManager.onAIResponseComplete(message);
  }
});
```

#### Task 2.5: 扩展MessageManager支持TTS
**目标**: 在MessageManager中集成TTS回调
**输入**: 现有MessageManager和TTS功能
**输出**: 支持TTS的MessageManager

**具体步骤**:
```javascript
// 文件: frontend/pages/index/modules/message-manager.js（修改部分）
/**
 * Message Manager Module
 * 处理消息收发、流式渲染、本地存储
 */
class MessageManager {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.messageCount = 0;
    
    // 流式渲染控制器
    this._stream = { 
      buf: '',
      timer: null,
      targetIndex: null
    };
  }

  // ... 现有方法保持不变 ...

  /**
   * 添加AI消息到列表
   * @param {string} content - 消息内容
   * @param {Array} suggestions - 建议问题列表
   */
  addAIMessage(content, suggestions = null) {
    // 确保消息有唯一ID（TTS需要）
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const aiMessage = {
      id: messageId, // TTS需要的唯一ID
      role: 'assistant',
      content: content,
      timestamp: new Date().toISOString(),
      suggestions: suggestions,
      isPlaying: false, // TTS播放状态
      formattedDate: this.shouldShowDate() ? this.formatDate(new Date()) : null
    };

    this.page.data.messages.push(aiMessage);
    this.page.setData({ 
      messages: this.page.data.messages,
      isGenerating: false
    });

    // 滚动到底部
    this.page.scrollController.scheduleAutoScroll();

    // 通知TTS管理器AI回复完成（新增）
    if (this.page.ttsManager && content && content.trim()) {
      setTimeout(() => {
        this.page.ttsManager.onAIResponseComplete(aiMessage);
      }, 100); // 短暂延迟确保UI更新完成
    }

    return messageId;
  }

  // ... 其他现有方法保持不变 ...
}

module.exports = MessageManager;
```

**验证点**:
- [ ] TTS模块正确集成到页面架构
- [ ] 模块间通信正常工作
- [ ] AI回复完成后自动触发TTS
- [ ] 页面架构保持一致性

#### Task 2.6: UI组件和样式实现
**目标**: 为AI消息添加朗读控制UI
**输入**: AI回复消息数据
**输出**: 带朗读控制的消息组件

**具体步骤**:
```html
<!-- 文件: frontend/pages/index/index.wxml -->
<!-- AI消息模板修改 -->
<view class="message ai-message" wx:if="{{message.role === 'assistant'}}">
  <view class="message-content" bindtap="toggleTTS" data-message-id="{{message.id}}">
    <text>{{message.content}}</text>
  </view>
  
  <!-- 朗读控制按钮组 -->
  <view class="message-controls">
    <!-- 复制按钮 -->
    <view class="control-btn copy-btn" bindtap="copyMessage" data-content="{{message.content}}">
      <image src="/images/copy-icon.png" class="control-icon"></image>
    </view>
    
    <!-- 朗读控制按钮 -->
    <view class="control-btn tts-btn" bindtap="toggleTTS" data-message-id="{{message.id}}">
      <!-- 朗读中：显示动态声波 -->
      <view wx:if="{{message.isPlaying}}" class="sound-wave">
        <view class="wave-bar bar1"></view>
        <view class="wave-bar bar2"></view>
        <view class="wave-bar bar3"></view>
        <view class="wave-bar bar4"></view>
      </view>
      <!-- 未播放：显示喇叭图标 -->
      <image wx:else src="/images/speaker-icon.png" class="control-icon"></image>
    </view>
  </view>
</view>
```

**样式文件**:
```css
/* 文件: frontend/pages/index/index.wxss */
.message-controls {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
  padding: 0 8px;
}

.control-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 16px;
  transition: background 0.2s;
}

.control-btn:hover {
  background: rgba(0, 0, 0, 0.1);
}

.control-icon {
  width: 16px;
  height: 16px;
}

/* 动态声波效果 */
.sound-wave {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 16px;
}

.wave-bar {
  width: 2px;
  background: #1890ff;
  animation: wave 1s infinite ease-in-out;
}

.bar1 { animation-delay: 0s; }
.bar2 { animation-delay: 0.1s; }
.bar3 { animation-delay: 0.2s; }
.bar4 { animation-delay: 0.3s; }

@keyframes wave {
  0%, 40%, 100% {
    height: 4px;
    opacity: 0.5;
  }
  20% {
    height: 16px;
    opacity: 1;
  }
}
```

**JavaScript逻辑**:
```javascript
// 文件: frontend/pages/index/index.js
import AudioManager from '../../utils/audioManager.js';

Page({
  data: {
    messages: [],
    // ... 其他数据
  },

  // 复制消息内容
  copyMessage(e) {
    const content = e.currentTarget.dataset.content;
    wx.setClipboardData({
      data: content,
      success: () => {
        wx.showToast({
          title: '已复制到剪贴板',
          icon: 'success'
        });
      }
    });
  },

  // 切换TTS播放状态
  async toggleTTS(e) {
    const messageId = e.currentTarget.dataset.messageId;
    const message = this.data.messages.find(msg => msg.id === messageId);
    
    if (!message) return;

    if (message.isPlaying) {
      // 停止播放
      AudioManager.stop();
      this.updateMessagePlayingStatus(messageId, false);
    } else {
      // 开始播放
      this.updateMessagePlayingStatus(messageId, true);
      
      const success = await AudioManager.playTTSStream(message.content, {
        userId: this.data.userInfo.userId
      });
      
      if (success) {
        // 播放完成后更新状态
        setTimeout(() => {
          this.updateMessagePlayingStatus(messageId, false);
        }, this.estimatePlayDuration(message.content));
      } else {
        this.updateMessagePlayingStatus(messageId, false);
      }
    }
  },

  // 更新消息播放状态
  updateMessagePlayingStatus(messageId, isPlaying) {
    const messages = this.data.messages.map(msg => {
      if (msg.id === messageId) {
        return { ...msg, isPlaying };
      }
      // 停止其他消息的播放状态
      return { ...msg, isPlaying: false };
    });
    
    this.setData({ messages });
  },

  // 估算播放时长（中文约2.5字/秒）
  estimatePlayDuration(text) {
    return Math.ceil(text.length / 2.5) * 1000;
  },

  // AI回复完成后自动开始朗读
  onAIResponseComplete(message) {
    // 添加消息到列表
    const messageWithId = {
      ...message,
      id: Date.now().toString(),
      isPlaying: false
    };
    
    this.data.messages.push(messageWithId);
    this.setData({ messages: this.data.messages });

    // 自动开始朗读（可通过设置控制）
    if (this.data.autoTTS) {
      setTimeout(() => {
        this.toggleTTS({
          currentTarget: { dataset: { messageId: messageWithId.id } }
        });
      }, 500); // 延迟500ms开始朗读
    }
  },

  // 点击消息文本取消朗读
  onMessageTap(e) {
    const messageId = e.currentTarget.dataset.messageId;
    const message = this.data.messages.find(msg => msg.id === messageId);
    
    if (message && message.isPlaying) {
      AudioManager.stop();
      this.updateMessagePlayingStatus(messageId, false);
    }
  }
});
```

**验证点**:
- [ ] 朗读控制按钮正常显示
- [ ] 动态声波效果正确
- [ ] 复制功能正常工作
- [ ] 点击文本可取消朗读

#### Task 2.3: 添加TTS设置选项
**目标**: 提供TTS个性化设置
**输入**: 用户设置偏好
**输出**: TTS配置界面

**具体步骤**:
```html
<!-- 文件: frontend/pages/settings/settings.wxml -->
<view class="settings-section">
  <view class="section-title">语音设置</view>
  
  <!-- 当前Provider信息 -->
  <view class="setting-item info-item">
    <view class="setting-label">当前语音服务</view>
    <view class="setting-value">{{currentProvider || '加载中...'}}</view>
  </view>
  
  <view class="setting-item">
    <view class="setting-label">自动朗读AI回复</view>
    <switch checked="{{autoTTS}}" bindchange="toggleAutoTTS" />
  </view>
  
  <view class="setting-item">
    <view class="setting-label">语音音色</view>
    <picker wx:if="{{!loading && voiceOptions.length > 0}}" 
           range="{{voiceOptions}}" 
           range-key="name" 
           value="{{selectedVoiceIndex}}" 
           bindchange="changeVoice">
      <view class="picker-display">
        {{voiceOptions[selectedVoiceIndex].name}}
        <view class="picker-desc">{{voiceOptions[selectedVoiceIndex].description}}</view>
      </view>
    </picker>
    <view wx:else class="picker-loading">加载中...</view>
  </view>
  
  <view class="setting-item">
    <view class="setting-label">语音语速</view>
    <slider min="0.5" max="2.0" step="0.1" value="{{speechRate}}" bindchange="changeSpeechRate" show-value />
  </view>
  
  <!-- 音色测试按钮 -->
  <view class="setting-item">
    <button class="test-voice-btn" 
            bindtap="testCurrentVoice" 
            disabled="{{loading}}">
      测试当前音色
    </button>
  </view>
</view>
```

**JavaScript逻辑**:
```javascript
// 文件: frontend/pages/settings/settings.js
Page({
  data: {
    autoTTS: true,
    selectedVoiceIndex: 0,
    speechRate: 1.0,
    voiceOptions: [], // 动态加载
    currentProvider: '',
    loading: true
  },

  onLoad() {
    this.loadSettings();
    this.loadVoiceOptions();
  },

  // 动态加载音色选项
  async loadVoiceOptions() {
    try {
      wx.showLoading({ title: '加载音色选项...' });
      
      const response = await wx.request({
        url: 'http://localhost:3000/api/speech/tts/voices',
        method: 'GET'
      });

      if (response.statusCode === 200) {
        this.setData({
          voiceOptions: response.data.voices,
          currentProvider: response.data.provider,
          loading: false
        });
      }
    } catch (error) {
      console.error('加载音色选项失败:', error);
      // 降级：使用默认选项
      this.setData({
        voiceOptions: [
          {
            id: 'default',
            name: '默认音色',
            description: '系统默认音色'
          }
        ],
        loading: false
      });
    } finally {
      wx.hideLoading();
    }
  },

  loadSettings() {
    const settings = wx.getStorageSync('tts_settings') || {};
    this.setData({
      autoTTS: settings.autoTTS !== false,
      selectedVoiceIndex: settings.selectedVoiceIndex || 0,
      speechRate: settings.speechRate || 1.0
    });
  },

  saveSettings() {
    wx.setStorageSync('tts_settings', {
      autoTTS: this.data.autoTTS,
      selectedVoiceIndex: this.data.selectedVoiceIndex,
      speechRate: this.data.speechRate
    });
  },

  toggleAutoTTS(e) {
    this.setData({
      autoTTS: e.detail.value
    });
    this.saveSettings();
  },

  changeVoice(e) {
    this.setData({
      selectedVoiceIndex: parseInt(e.detail.value)
    });
    this.saveSettings();
  },

  changeSpeechRate(e) {
    this.setData({
      speechRate: e.detail.value
    });
    this.saveSettings();
  },

  // 测试当前音色
  async testCurrentVoice() {
    if (this.data.voiceOptions.length === 0) {
      wx.showToast({
        title: '音色选项未加载',
        icon: 'none'
      });
      return;
    }

    const currentVoice = this.data.voiceOptions[this.data.selectedVoiceIndex];
    const testText = '您好，我是杨院长，很高兴为您提供整形美容咨询服务。';

    try {
      // 导入音频管理器（需要适配具体项目路径）
      const AudioManager = require('../../utils/audioManager.js');
      
      wx.showLoading({ title: '生成测试语音...' });
      
      const success = await AudioManager.playTTSStream(testText, {
        voice: currentVoice.id,
        userId: 'settings_test'
      });

      if (success) {
        wx.showToast({
          title: '正在播放测试语音',
          icon: 'success'
        });
      }
    } catch (error) {
      console.error('音色测试失败:', error);
      wx.showToast({
        title: '音色测试失败',
        icon: 'none'
      });
    } finally {
      wx.hideLoading();
    }
  }
});
```

**验证点**:
- [ ] 设置界面正常显示
- [ ] 设置保存和加载正确
- [ ] 音色和语速设置生效

### Phase 3: 集成测试和优化

#### Task 3.1: 端到端功能测试
**目标**: 验证完整的TTS功能流程
**测试场景**:
1. AI回复完成后自动朗读
2. 点击朗读按钮控制播放
3. 点击文本取消朗读
4. 复制功能测试
5. 设置项生效测试

#### Task 3.2: 性能优化
**目标**: 优化TTS性能和用户体验
**优化方案**:
1. 实现TTS预加载机制
2. 音频数据压缩优化
3. 网络请求优化
4. 缓存策略优化

#### Task 3.3: 错误处理和降级方案
**目标**: 处理各种异常情况
**处理方案**:
1. 网络异常处理
2. TTS服务异常处理
3. 音频播放失败处理
4. 降级到系统TTS方案

## 验证标准

### 功能验证
- [ ] AI回复完成后自动开始朗读
- [ ] 朗读过程中显示动态声波效果
- [ ] 点击文本可以取消朗读
- [ ] 复制按钮正常工作
- [ ] 朗读控制按钮状态正确
- [ ] 设置项正常保存和应用

### 性能验证
- [ ] TTS响应时间小于2秒
- [ ] 音频播放流畅无卡顿
- [ ] 内存使用合理
- [ ] 多次播放无内存泄漏

### 兼容性验证
- [ ] **Azure TTS Provider**正常工作（音色切换、SSML支持）
- [ ] **火山引擎TTS Provider**正常工作（WebSocket流式合成）
- [ ] **Provider切换**无缝工作（通过环境变量PROVIDER_TYPE控制）
- [ ] **音色动态加载**支持不同Provider的音色列表
- [ ] **音频格式适配**支持MP3（Azure）和WAV（火山引擎）
- [ ] 微信小程序环境正常
- [ ] 不同设备音频播放正常
- [ ] 网络异常时降级处理正确

## 时间安排
- **Week 1**: 后端TTS接口优化 (Task 1.1-1.2)
- **Week 2**: 前端朗读功能实现 (Task 2.1-2.2) 
- **Week 3**: TTS设置和优化 (Task 2.3, 3.1-3.3)
- **Week 4**: 集成测试和部署

## 成功标准
1. **功能完整性**: 所有需求功能正常工作
2. **用户体验**: 操作流畅，反馈及时
3. **性能表现**: 响应快速，资源使用合理
4. **稳定性**: 异常处理完善，降级方案有效

---

# AI回复自动朗读功能 - 实施状态报告

## 实施完成情况 (2025-08-30)

### ✅ 已完成的功能模块

#### 1. 后端TTS服务集成
- **TTS路由配置**: ✅ 完成
  - 添加TTS流式接口 `/api/speech/tts/stream`
  - 添加TTS健康检查 `/api/speech/tts/health`
  - 添加音色列表接口 `/api/speech/tts/voices`
  - 所有接口已添加JWT认证中间件

#### 2. 前端模块化TTS实现
- **AudioPlayer模块**: ✅ 完成 (`frontend/pages/index/modules/audio-player.js`)
  - TTS音频请求和播放功能
  - 临时文件管理和清理
  - 完善的错误处理机制
  
- **TTSManager模块**: ✅ 完成 (`frontend/pages/index/modules/tts-manager.js`)
  - TTS核心管理和状态控制
  - 自动朗读功能集成
  - 播放状态回调处理
  
- **主页面集成**: ✅ 完成 (`frontend/pages/index/index.js`)
  - TTSManager初始化
  - 事件处理函数绑定
  - 模块化架构保持一致

#### 3. UI组件和用户交互
- **消息控制按钮**: ✅ 完成 (`frontend/pages/index/index.wxml`)
  - 复制消息按钮 📋
  - TTS播放控制按钮 🔊
  - 播放中声波动画效果
  
- **样式和动画**: ✅ 完成 (`frontend/pages/index/index.wxss`)
  - TTS控制按钮样式
  - 声波动画效果
  - 响应式交互反馈

#### 4. 自动朗读集成
- **MessageManager扩展**: ✅ 完成
  - AI回复完成时自动调用TTS功能
  - 集成到`handleStreamingComplete`方法
  - 保持现有消息处理流程

### 🔧 技术实施细节

#### 模块化架构设计
按照项目现有的模块化模式，TTS功能采用相同的架构风格：
```
frontend/pages/index/modules/
├── audio-player.js      # 音频播放控制 (新增)
├── tts-manager.js       # TTS管理器 (新增)  
├── message-manager.js   # 消息管理 (已扩展)
└── ... (其他现有模块)
```

#### 简化配置策略
根据用户需求，移除了复杂的用户配置选项：
- 使用后端默认音色和配置
- 仅保留自动朗读开关功能
- 专注核心播放控制功能

#### 错误处理机制
- **网络错误**: 显示"语音播放失败"提示
- **音频播放错误**: 自动重置播放状态
- **API超时**: 前端优雅降级处理

### ⚠️ 已知技术问题

#### 1. Volcengine TTS连接问题
- **现象**: WebSocket连接建立后立即关闭
- **状态**: 后端服务正常启动，健康检查通过
- **可能原因**: 
  - 网络访问限制
  - Volcengine API认证配置问题
  - WebSocket协议兼容性问题
- **影响**: TTS功能前端已完成，等待后端API稳定

#### 2. 当前工作状态
- **前端功能**: 100% 完成并集成
- **后端接口**: 已配置但等待Volcengine连接稳定
- **用户体验**: 错误处理完善，失败时有友好提示

### 🎯 测试验证状态

#### 前端功能测试
- ✅ TTS管理器初始化正常
- ✅ UI控制按钮显示正确
- ✅ 声波动画效果正常
- ✅ 错误处理机制完善
- ✅ 自动朗读触发机制集成

#### 集成测试
- ✅ 模块化架构集成无冲突
- ✅ 事件处理函数正确绑定
- ✅ 消息流程扩展无副作用
- ⚠️ 端到端TTS功能待后端API稳定后验证

### 📋 后续工作建议

1. **Volcengine TTS连接问题排查**
   - 检查网络连接和防火墙设置
   - 验证Volcengine API密钥和配置
   - 考虑WebSocket协议调试

2. **生产环境验证**
   - 在Volcengine API稳定后进行完整的端到端测试
   - 验证不同网络环境下的连接稳定性

3. **性能优化 (可选)**
   - 考虑添加音频缓存机制
   - 实施TTS预加载策略

## 总结

AI回复自动朗读功能的前端实现已100%完成，采用模块化架构，与现有代码完美集成。功能包括自动朗读、手动控制、错误处理等核心特性。目前唯一的阻碍是Volcengine TTS服务的网络连接问题，一旦解决后即可提供完整的TTS体验。

---

# TTS音频播放截断问题分析与解决方案 (2025-08-31)

## 问题现状

### 发现的问题
在TTS功能测试中发现音频播放不完整的问题：
- **症状**: 长文本TTS音频只播放前面几秒就停止
- **具体表现**: 155个字的文本预期播放约28秒，实际只播放6.624秒
- **影响范围**: 所有长文本的TTS播放

### 问题分析

#### 1. 后端音频生成状态
✅ **后端生成正常**: 
- 音频完整生成（229KB，64个音频块）
- 时间线完整覆盖全文（28.133秒）
- 保存的调试文件包含完整音频内容

#### 2. 前端播放问题
❌ **播放截断**: 
- HTTP请求成功返回200状态码
- 前端接收到的数据大小正确（229KB）
- 但实际播放时长仅6.624秒就触发`onEnded`事件

#### 3. 根本原因推测

**主要原因**: 微信小程序音频组件对大文件播放的限制或兼容性问题
- 音频文件可能在写入临时存储时被截断
- wx.createInnerAudioContext对长音频的支持限制
- 音频格式兼容性问题（MP3编码/解码）

**次要原因**: 
- 网络传输中的数据流处理问题
- 临时文件系统的存储限制
- 音频上下文生命周期管理问题

## 解决方案设计

### 方案1: WebSocket流式音频播放 (推荐)

**设计思路**: 将TTS音频改为WebSocket实时流式传输，分块播放

#### 技术架构
```javascript
// 后端: 流式推送音频块
class TTSWebSocketStreaming {
  async streamTextToSpeech(text, options) {
    // 1. 建立WebSocket连接
    // 2. 实时推送音频块
    // 3. 发送播放控制信号
    
    return {
      startSignal: () => ws.send({type: 'tts_start', messageId}),
      audioChunk: (chunk) => ws.send({type: 'tts_chunk', data: chunk}),
      endSignal: () => ws.send({type: 'tts_end', messageId})
    }
  }
}

// 前端: 接收并串行播放音频块
class StreamingAudioPlayer {
  async handleTTSStream(messageId) {
    // 1. 接收开始信号
    // 2. 收集音频块并串行播放
    // 3. 处理结束信号
  }
}
```

#### 实施步骤

**Phase 1: 后端流式改造**
1. **WebSocket TTS控制器**
   ```javascript
   // backend/src/controllers/ttsWebSocketController.js
   exports.handleTTSStream = async (ws, data) => {
     const { text, messageId } = data;
     
     // 发送开始信号
     ws.send(JSON.stringify({
       type: 'tts_start',
       messageId,
       totalDuration: estimatedDuration
     }));
     
     // 流式生成和推送音频块
     await ttsProvider.streamTextToSpeech(text, {
       onChunk: (chunk) => {
         ws.send(JSON.stringify({
           type: 'tts_chunk',
           messageId,
           data: chunk.audioBuffer,
           timestamp: chunk.timestamp
         }));
       }
     });
     
     // 发送结束信号
     ws.send(JSON.stringify({
       type: 'tts_end',
       messageId
     }));
   };
   ```

2. **音频块缓存管理**
   ```javascript
   class TTSChunkManager {
     constructor() {
       this.chunks = new Map(); // messageId -> chunks[]
       this.playingContexts = new Map();
     }
     
     addChunk(messageId, chunk) {
       if (!this.chunks.has(messageId)) {
         this.chunks.set(messageId, []);
       }
       this.chunks.get(messageId).push(chunk);
     }
     
     async playChunks(messageId) {
       // 串行播放所有音频块
     }
   }
   ```

**Phase 2: 前端流式播放器**
1. **WebSocket TTS监听器**
   ```javascript
   // frontend/pages/index/modules/streaming-audio-player.js
   class StreamingAudioPlayer {
     constructor(websocket) {
       this.ws = websocket;
       this.playingTasks = new Map();
       this.audioQueue = new Map();
       
       // 监听TTS相关WebSocket消息
       this.ws.onMessage = this.handleWebSocketMessage.bind(this);
     }
     
     handleWebSocketMessage(event) {
       const message = JSON.parse(event.data);
       
       switch(message.type) {
         case 'tts_start':
           this.initializeTTSPlayback(message.messageId);
           break;
         case 'tts_chunk':
           this.queueAudioChunk(message);
           break;
         case 'tts_end':
           this.finalizeTTSPlayback(message.messageId);
           break;
       }
     }
   }
   ```

2. **分块音频队列播放**
   ```javascript
   async queueAudioChunk(message) {
     const { messageId, data, timestamp } = message;
     
     // 创建音频块
     const audioChunk = {
       data: data,
       timestamp: timestamp,
       played: false
     };
     
     // 添加到播放队列
     this.audioQueue.get(messageId).push(audioChunk);
     
     // 如果是第一个块，开始播放
     if (this.audioQueue.get(messageId).length === 1) {
       this.startSequentialPlayback(messageId);
     }
   }
   ```

### 方案2: 分段文本处理 (备选)

**设计思路**: 将长文本分段，每段单独进行TTS处理和播放

#### 技术实现
```javascript
class SegmentedTTSPlayer {
  async playLongText(text, messageId) {
    // 1. 文本智能分段（按句号、问号等分割）
    const segments = this.splitTextIntoSegments(text);
    
    // 2. 逐段生成和播放TTS
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const audioData = await this.requestTTS(segment);
      await this.playAudioBuffer(audioData, `${messageId}_segment_${i}`);
    }
  }
  
  splitTextIntoSegments(text, maxLength = 50) {
    // 智能分段逻辑：优先按标点分割，保证语义完整性
    const sentences = text.split(/[。！？]/);
    const segments = [];
    let currentSegment = '';
    
    for (const sentence of sentences) {
      if (currentSegment.length + sentence.length <= maxLength) {
        currentSegment += sentence;
      } else {
        if (currentSegment) segments.push(currentSegment);
        currentSegment = sentence;
      }
    }
    if (currentSegment) segments.push(currentSegment);
    
    return segments;
  }
}
```

### 方案3: 音频格式优化 (辅助)

**改进措施**:
1. **强制使用PCM格式**: 避免MP3编码问题
2. **音频参数优化**: 降低采样率和比特率
3. **压缩算法调整**: 使用更兼容的编码方式

```javascript
// 优化音频参数配置
const AUDIO_CONFIG = {
  sampleRate: 16000,    // 降低采样率
  bitRate: 64000,       // 降低比特率
  channels: 1,          // 单声道
  format: 'pcm'         // 使用PCM避免编码问题
};
```

## 推荐实施路线

### 阶段1: 快速修复 (1-2天)
**采用方案2**: 分段文本处理
- ✅ 实施简单，风险较低
- ✅ 可以立即解决长文本播放问题
- ✅ 保持现有架构不变

### 阶段2: 长期优化 (1周)
**采用方案1**: WebSocket流式播放
- ✅ 提供最佳用户体验
- ✅ 支持真正的流式播放
- ✅ 可扩展性强，支持暂停/恢复等高级功能

### 阶段3: 性能优化
**结合方案3**: 音频格式和参数优化
- ✅ 提升播放兼容性
- ✅ 减少网络传输压力
- ✅ 优化播放启动时间

## 验收标准

### 功能验证
- [ ] 长文本(>100字)TTS完整播放无截断
- [ ] 播放进度正确显示
- [ ] 播放控制(暂停/恢复)正常工作
- [ ] 多消息TTS播放互不干扰

### 性能验证  
- [ ] 首次播放延迟<3秒
- [ ] 音频切换无明显停顿
- [ ] 内存使用稳定，无泄漏
- [ ] 网络异常时优雅降级

### 兼容性验证
- [ ] 微信开发者工具正常播放
- [ ] 不同手机设备播放正常
- [ ] 网络波动时播放稳定
- [ ] 与现有聊天功能无冲突

## 技术风险评估

### 高风险
- **WebSocket消息顺序**: 需要确保音频块按序播放
- **内存管理**: 大量音频块缓存可能导致内存压力

### 中风险  
- **网络中断处理**: 流式播放中断时的恢复机制
- **并发播放控制**: 多消息同时播放的冲突处理

### 低风险
- **分段播放衔接**: 段落间的自然过渡
- **UI状态同步**: 播放状态与界面的实时同步

---

*本分析基于2025-08-31的实际测试发现的TTS音频截断问题，建议优先采用分段处理方案快速解决，再逐步升级到流式播放架构。*