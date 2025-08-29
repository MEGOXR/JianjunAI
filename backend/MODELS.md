# 火山引擎服务配置说明

## 服务概览

本项目已集成火山引擎的三个核心服务：
- **LLM服务**：豆包大语言模型（支持标准版和Flash版）
- **ASR服务**：双向流式语音识别（优化版本）
- **TTS服务**：智能语音合成（多音色支持）

## 模型配置

## 可用模型

本项目已配置两个火山引擎豆包模型：

### 1. 标准版模型
- **模型名称**: doubao-seed-1-6-250615
- **Endpoint**: `ep-m-20250812174627-s8gbl`
- **特点**: 平衡的性能和响应质量

### 2. Flash版模型  
- **模型名称**: doubao-seed-1-6-flash-250715
- **Endpoint**: `ep-m-20250812213437-zbtzk`
- **特点**: 更快的响应速度，优化的推理性能

## 模型切换方法

### 1. 环境变量切换
在 `.env` 文件中修改 `VOLCENGINE_MODEL_TYPE`：

```bash
# 使用标准版模型
VOLCENGINE_MODEL_TYPE=standard

# 使用Flash版模型  
VOLCENGINE_MODEL_TYPE=flash
```

### 2. 重启服务
修改配置后需要重启后端服务以生效：

```bash
cd backend
npm start
```

## 配置验证

可以通过以下方式验证当前使用的模型：

1. **查看启动日志**: 服务启动时会显示当前Provider配置
2. **WebSocket测试**: 使用 `test-websocket.js` 测试时，AI会在回复中标识使用的服务
3. **健康检查**: 访问 `/health` 端点查看服务状态

## 环境变量说明

```bash
# 基础配置
PROVIDER_TYPE=volcengine
USE_PROVIDER=true
ARK_API_KEY=your-api-key
VOLCENGINE_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3

# 模型配置
VOLCENGINE_ARK_MODEL=ep-m-20250812174627-s8gbl          # 标准版endpoint
VOLCENGINE_ARK_MODEL_FLASH=ep-m-20250812213437-zbtzk    # Flash版endpoint
VOLCENGINE_MODEL_TYPE=standard                           # 当前选择: standard | flash
```

## 使用建议

- **开发测试**: 建议使用Flash版本获得更快的响应
- **生产环境**: 根据具体需求选择，标准版通常更稳定
- **A/B测试**: 可以通过切换模型对比不同版本的表现

## 语音服务配置

### ASR（语音识别）服务
- **服务模式**：双向流式（优化版本）
- **API端点**：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
- **特性**：RTF和首字、尾字时延优化，只在结果变化时返回数据包
- **音频格式**：WAV (16kHz, 16bit, 单声道)
- **最佳性能**：200ms音频包（3200字节）

### TTS（语音合成）服务  
- **API端点**：`https://openspeech.bytedance.com/api/v1/tts`
- **支持音色**：
  - 爽快-月（专业女声）⭐ 推荐
  - 京腔-月（专业男声）
  - 温暖-月（温暖女声）
  - 甜美-月（年轻女声）
- **流式合成**：支持长文本自动分段合成
- **音频格式**：WAV, MP3, PCM

## 服务配置要求

### 必需的环境变量

```bash
# 基础认证（ASR和TTS服务需要）
VOLCENGINE_ACCESS_KEY=<您的Access Key>
VOLCENGINE_SECRET_KEY=<您的Secret Key>
VOLCENGINE_REGION=cn-north-1

# 语音服务配置
VOLCENGINE_SPEECH_APP_ID=<您的语音服务App ID>

# LLM服务配置  
ARK_API_KEY=<您的ARK API Key>
VOLCENGINE_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3

# 流式语音识别专用认证（已配置）
VOLCENGINE_ASR_ACCESS_TOKEN=1S1ytpziyHoBscoULan0qADv1bUhA5Ht
VOLCENGINE_ASR_SECRET_KEY=nWefobbkUkFouIzpykq9RsfiBVUr_srl
```

### 火山引擎控制台配置步骤

1. **开通服务**：
   - 登录火山引擎控制台
   - 开通"智能语音交互"服务
   - 开通"火山方舟"（豆包大模型）服务

2. **获取密钥**：
   - 在"访问控制"中创建Access Key和Secret Key
   - 在语音服务中获取App ID
   - 在火山方舟中获取API Key和模型端点

3. **配置权限**：
   - 为Access Key配置语音服务权限
   - 确保API Key有模型访问权限

## 当前实现状态

### ✅ 已完成的服务
- **LLM服务**：🟢 完全可用
  - 豆包标准版和Flash版模型
  - 支持流式对话和上下文管理
  - 完整的健康检查和错误处理

- **ASR服务**：🟢 完全可用
  - 双向流式（优化版本）语音识别
  - RTF和延迟优化，性能卓越
  - 支持实时音频流处理
  - 完整的会话管理和错误处理

### ⚠️ 语音服务状态（需要完善配置）
- **TTS服务**：🔴 引擎配置需要完善  
  - 已实现流式合成和多音色支持
  - 使用正确的HTTP Header认证方式
  - 需要在火山引擎控制台配置TTS引擎

## 服务测试

### 测试连接状态
```bash
cd backend
node -e "
const factory = require('./src/services/ProviderFactory');
factory.getHealthStatus().then(console.log);
"
```

### 测试单个服务
```javascript
// TTS测试
const tts = ProviderFactory.getTTSProvider();
await tts.initialize();
const result = await tts.textToSpeech('测试语音');

// ASR健康检查
const asr = ProviderFactory.getASRProvider(); 
await asr.initialize();
const health = await asr.healthCheck();
```

## 注意事项

1. **认证配置**：
   - LLM服务：使用ARK API Key（✅ 已配置完成）
   - 语音服务：使用Access Key和App ID进行HTTP Header认证（⚠️ 需要控制台权限配置）

2. **服务状态**：
   - LLM：🟢 完全可用，支持标准版和Flash版模型切换
   - ASR：🟢 完全可用，双向流式语音识别功能正常
   - TTS：🔴 代码实现完成，需要在火山引擎控制台配置引擎

3. **技术实现**：
   - ASR使用双向流式（优化版本）接口，性能最优
   - TTS支持流式合成和智能文本分段
   - 完整的错误处理和健康检查机制

4. **部署建议**：
   - 🟢 LLM和ASR服务已完全就绪，可以实现完整的语音对话功能
   - ⚠️ TTS服务需要联系火山引擎技术支持完善控制台引擎配置
   - 所有服务保持"杨院长"医美顾问人设一致性