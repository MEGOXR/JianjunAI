

## 语音输入功能实现方案

### 需求描述
实现完整的语音输入功能，包括：
- 两种语音输入模式：输入框长按说话 & 专用语音模式
- 录音时的可视化反馈（波形动画）
- 上滑取消发送手势
- 语音转文字（STT）并自动显示
- 完善的权限管理和错误处理

### 功能设计

#### 1. 双模式语音输入
- **模式一：输入框长按**
  - 在默认文字输入模式下，长按输入框即可录音
  - 松开后自动转换为文字
  
- **模式二：专用语音模式**
  - 点击切换按钮进入语音模式
  - 显示专用的语音按钮界面
  - 按住录音，松开发送

#### 2. 录音交互流程
```
开始录音 → 检查权限 → 显示录音界面 → 实时波形动画
    ↓
手指移动 → 判断上滑距离 → 超过阈值显示"松开取消"
    ↓
结束录音 → 正常：上传语音 → STT转换 → 显示文字
         → 取消：清除录音 → 提示已取消
```

#### 3. UI组件结构

##### 3.1 语音模式界面
```xml
<view class="voice-input-area" wx:if="{{isVoiceMode}}">
  <button class="voice-btn {{isRecording ? 'recording' : ''}}"
          bindtouchstart="onVoiceTouchStart"
          bindtouchmove="onVoiceTouchMove"
          bindtouchend="onVoiceTouchEnd">
    <text>{{recordingText}}</text>
  </button>
  <image class="mode-switch" src="/images/keyboard.png" bindtap="switchToText"/>
</view>
```

##### 3.2 录音悬浮层
```xml
<view class="voice-modal" wx:if="{{showVoiceModal}}">
  <!-- 波形可视化 -->
  <view class="waveform-container">
    <view wx:for="{{waveformData}}" class="waveform-bar" 
          style="height:{{item}}%"></view>
  </view>
  
  <!-- 录音信息 -->
  <text class="recording-duration">{{recordingDuration}}s</text>
  <text class="recording-hint">{{isRecordingCanceling ? '松开取消' : '正在录音...'}}</text>
  
  <!-- 上滑提示 -->
  <view class="cancel-hint" wx:if="{{!isRecordingCanceling}}">
    <image src="/images/arrow-up.png"/>
    <text>上滑取消</text>
  </view>
</view>
```

#### 4. 核心功能实现

##### 4.1 录音管理器配置
```javascript
const recorderManager = wx.getRecorderManager();
const options = {
  duration: 60000,      // 最长60秒
  sampleRate: 16000,    // 16kHz采样率（语音识别标准）
  numberOfChannels: 1,  // 单声道
  encodeBitRate: 48000, // 48kbps码率
  format: 'mp3'         // MP3格式
};
```

##### 4.2 手势处理逻辑
```javascript
// 触摸开始 - 开始录音
onVoiceTouchStart(e) {
  this.recordingStartY = e.touches[0].clientY;
  this.checkPermission(() => this.startRecording());
}

// 触摸移动 - 检测上滑
onVoiceTouchMove(e) {
  const deltaY = this.recordingStartY - e.touches[0].clientY;
  const shouldCancel = deltaY > 100; // 上滑100px触发取消
  
  if (shouldCancel !== this.data.isRecordingCanceling) {
    this.setData({ isRecordingCanceling: shouldCancel });
    if (shouldCancel) wx.vibrateShort(); // 震动反馈
  }
}

// 触摸结束 - 完成或取消
onVoiceTouchEnd(e) {
  if (this.data.isRecordingCanceling) {
    this.cancelRecording();
  } else {
    this.stopRecording();
  }
}
```

##### 4.3 波形动画实现
```javascript
// 生成波形数据
startWaveformAnimation() {
  this.waveformTimer = setInterval(() => {
    const waveformData = Array(20).fill(0).map(() => 
      Math.random() * 80 + 20  // 20-100%高度
    );
    this.setData({ waveformData });
  }, 100);
}
```

##### 4.4 语音转文字(STT)
```javascript
uploadVoice(tempFilePath) {
  wx.uploadFile({
    url: `${baseUrl}/api/speech-to-text`,
    filePath: tempFilePath,
    name: 'audio',
    header: { 'Authorization': `Bearer ${token}` },
    success: (res) => {
      const result = JSON.parse(res.data);
      if (result.text) {
        this.handleSTTSuccess(result.text);
      }
    }
  });
}

handleSTTSuccess(text) {
  // 显示识别结果供确认
  wx.showModal({
    title: '识别结果',
    content: text,
    confirmText: '发送',
    cancelText: '编辑',
    success: (res) => {
      if (res.confirm) {
        this.setData({ userInput: text });
        this.sendMessage();
      }
    }
  });
}
```

#### 5. 样式设计

```css
/* 录音按钮动画 */
.voice-btn.recording {
  animation: recordingPulse 1.5s infinite;
  background: linear-gradient(45deg, #FF6B6B, #FF8E53);
}

@keyframes recordingPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}

/* 波形条动画 */
.waveform-bar {
  background: linear-gradient(to top, #007AFF, #40A9FF);
  transition: height 0.1s ease;
  animation: waveformGlow 0.5s ease-in-out infinite alternate;
}

@keyframes waveformGlow {
  from { opacity: 0.7; }
  to { opacity: 1; }
}

/* 取消状态样式 */
.voice-modal-content.canceling {
  background: #FF6B6B;
  animation: cancelShake 0.3s;
}

@keyframes cancelShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}
```

#### 6. 权限管理

```javascript
checkRecordingPermission(callback) {
  wx.getSetting({
    success: (res) => {
      if (!res.authSetting['scope.record']) {
        wx.authorize({
          scope: 'scope.record',
          success: callback,
          fail: () => this.showPermissionDialog()
        });
      } else {
        callback();
      }
    }
  });
}

showPermissionDialog() {
  wx.showModal({
    title: '需要录音权限',
    content: '请在设置中开启录音权限',
    confirmText: '去设置',
    success: (res) => {
      if (res.confirm) wx.openSetting();
    }
  });
}
```

#### 7. 错误处理

- 录音时长限制：最短1秒，最长60秒
- 网络错误：重试机制和离线缓存
- 权限拒绝：引导用户开启权限
- STT失败：提供手动输入选项
- 系统中断：自动保存和恢复

### 实施步骤

1. **第一阶段：基础录音功能**
   - 实现录音权限检查
   - 添加按住录音按钮
   - 实现基本的录音开始/结束

2. **第二阶段：交互优化**
   - 添加上滑取消手势
   - 实现录音时长显示
   - 添加震动反馈

3. **第三阶段：视觉效果**
   - 实现波形动画
   - 添加录音悬浮层
   - 优化过渡动画

4. **第四阶段：语音转文字**
   - 对接STT服务接口
   - 实现识别结果确认
   - 添加编辑功能

5. **第五阶段：完善体验**
   - 优化错误处理
   - 添加使用引导
   - 性能优化

### 后端实现方案

#### 1. 技术选型

**语音识别服务选择**：
- **Azure Cognitive Services Speech SDK** - 与现有Azure OpenAI集成良好
- 支持中文识别，准确率高
- 提供实时流式识别和批量识别两种模式

**依赖安装**：
```bash
cd backend
npm install --save microsoft-cognitiveservices-speech-sdk
npm install --save multer  # 文件上传处理
npm install --save uuid     # 生成唯一文件名
```

#### 2. 环境配置

在 `.env` 文件中添加 Azure Speech Service 配置：
```env
# 现有配置
AZURE_OPENAI_ENDPOINT=xxx
AZURE_OPENAI_API_KEY=xxx
OPENAI_API_VERSION=xxx
AZURE_OPENAI_DEPLOYMENT_NAME=xxx

# 新增 Speech Service 配置
AZURE_SPEECH_KEY=your-speech-service-key
AZURE_SPEECH_REGION=eastasia
AZURE_SPEECH_LANGUAGE=zh-CN
```

#### 3. 文件结构

```
backend/
├── src/
│   ├── controllers/
│   │   └── speechController.js     # 新增：语音识别控制器
│   ├── services/
│   │   └── speechService.js        # 新增：语音识别服务
│   ├── middleware/
│   │   └── upload.js               # 新增：文件上传中间件
│   ├── routes/
│   │   └── speechRoutes.js         # 新增：语音路由
│   └── temp/                       # 新增：临时音频文件目录
```

#### 4. 核心代码实现

##### 4.1 文件上传中间件 (`src/middleware/upload.js`)

```javascript
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;

// 确保临时目录存在
const tempDir = path.join(__dirname, '../../temp');
fs.mkdir(tempDir, { recursive: true }).catch(console.error);

// 配置 multer 存储
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${Date.now()}.mp3`;
    cb(null, uniqueName);
  }
});

// 文件过滤器
const fileFilter = (req, file, cb) => {
  // 只接受音频文件
  const allowedMimeTypes = [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-m4a',
    'audio/webm'
  ];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('只支持音频文件格式'), false);
  }
};

// 创建 multer 实例
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 限制 10MB
    files: 1
  }
});

module.exports = upload;
```

##### 4.2 语音识别服务 (`src/services/speechService.js`)

```javascript
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const fs = require('fs').promises;
const path = require('path');

class SpeechService {
  constructor() {
    this.speechKey = process.env.AZURE_SPEECH_KEY;
    this.speechRegion = process.env.AZURE_SPEECH_REGION || 'eastasia';
    this.language = process.env.AZURE_SPEECH_LANGUAGE || 'zh-CN';
    
    if (!this.speechKey) {
      console.error('警告: AZURE_SPEECH_KEY 未配置');
    }
  }

  /**
   * 将音频文件转换为文本
   * @param {string} audioFilePath - 音频文件路径
   * @returns {Promise<{success: boolean, text: string, confidence: number, duration: number}>}
   */
  async speechToText(audioFilePath) {
    try {
      // 检查文件是否存在
      await fs.access(audioFilePath);
      
      // 配置语音识别
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        this.speechKey,
        this.speechRegion
      );
      speechConfig.speechRecognitionLanguage = this.language;
      
      // 设置识别参数以提高准确性
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
        "5000"
      );
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
        "1000"
      );
      
      // 从文件创建音频配置
      const audioConfig = sdk.AudioConfig.fromWavFileInput(
        await fs.readFile(audioFilePath)
      );
      
      // 创建识别器
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      
      // 返回 Promise 包装的识别结果
      return new Promise((resolve, reject) => {
        let startTime = Date.now();
        
        recognizer.recognizeOnceAsync(
          (result) => {
            const duration = (Date.now() - startTime) / 1000;
            
            if (result.reason === sdk.ResultReason.RecognizedSpeech) {
              // 计算置信度（基于识别结果的属性）
              const confidence = this.calculateConfidence(result);
              
              resolve({
                success: true,
                text: result.text,
                confidence: confidence,
                duration: duration,
                language: this.language
              });
            } else if (result.reason === sdk.ResultReason.NoMatch) {
              resolve({
                success: false,
                text: '',
                confidence: 0,
                duration: duration,
                error: '无法识别语音内容'
              });
            } else {
              reject(new Error('语音识别被取消或出错'));
            }
            
            recognizer.close();
          },
          (error) => {
            recognizer.close();
            reject(error);
          }
        );
      });
    } catch (error) {
      console.error('语音识别错误:', error);
      throw error;
    } finally {
      // 清理临时文件
      try {
        await fs.unlink(audioFilePath);
      } catch (err) {
        console.error('清理临时文件失败:', err);
      }
    }
  }

  /**
   * 计算识别置信度
   * @private
   */
  calculateConfidence(result) {
    // Azure 不直接提供置信度分数，我们基于一些因素估算
    let confidence = 0.7; // 基础置信度
    
    // 根据识别文本长度调整
    if (result.text.length > 10) confidence += 0.1;
    if (result.text.length > 20) confidence += 0.1;
    
    // 检查是否包含标点符号（通常表示更完整的识别）
    if (/[，。！？]/.test(result.text)) confidence += 0.05;
    
    return Math.min(confidence, 0.95);
  }

  /**
   * 验证语音时长
   * @param {string} audioFilePath - 音频文件路径
   * @returns {Promise<number>} 音频时长（秒）
   */
  async getAudioDuration(audioFilePath) {
    // 简单实现：基于文件大小估算
    // 实际项目中应使用专门的音频处理库
    const stats = await fs.stat(audioFilePath);
    const fileSizeInBytes = stats.size;
    const bitRate = 48000; // 48kbps
    const duration = (fileSizeInBytes * 8) / bitRate;
    return duration;
  }
}

module.exports = new SpeechService();
```

##### 4.3 语音控制器 (`src/controllers/speechController.js`)

```javascript
const speechService = require('../services/speechService');
const userDataService = require('../services/userDataService');

class SpeechController {
  /**
   * 处理语音转文字请求
   */
  async speechToText(req, res) {
    try {
      // 验证请求
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: '未接收到音频文件'
        });
      }

      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({
          success: false,
          error: '缺少用户ID'
        });
      }

      console.log(`[STT] 用户 ${userId} 上传音频文件: ${req.file.filename}`);

      // 获取音频时长
      const duration = await speechService.getAudioDuration(req.file.path);
      
      // 验证音频时长（1-60秒）
      if (duration < 1) {
        return res.status(400).json({
          success: false,
          error: '录音时间太短，请至少录制1秒'
        });
      }
      
      if (duration > 60) {
        return res.status(400).json({
          success: false,
          error: '录音时间太长，请不要超过60秒'
        });
      }

      // 执行语音识别
      const result = await speechService.speechToText(req.file.path);
      
      // 记录用户语音使用情况（可选）
      const userData = await userDataService.getUserData(userId);
      if (userData) {
        userData.voiceUsageCount = (userData.voiceUsageCount || 0) + 1;
        userData.lastVoiceUse = new Date().toISOString();
        await userDataService.saveUserData(userId, userData);
      }

      // 返回识别结果
      res.json({
        success: result.success,
        text: result.text || '',
        confidence: result.confidence || 0,
        duration: duration,
        language: result.language,
        error: result.error
      });

    } catch (error) {
      console.error('[STT] 语音识别错误:', error);
      
      // 根据错误类型返回适当的错误信息
      let errorMessage = '语音识别失败';
      let statusCode = 500;
      
      if (error.message.includes('AZURE_SPEECH_KEY')) {
        errorMessage = '语音服务未配置';
        statusCode = 503;
      } else if (error.message.includes('网络')) {
        errorMessage = '网络连接错误';
        statusCode = 503;
      } else if (error.message.includes('文件')) {
        errorMessage = '音频文件处理失败';
        statusCode = 400;
      }
      
      res.status(statusCode).json({
        success: false,
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * 获取语音服务状态
   */
  async getServiceStatus(req, res) {
    const isConfigured = !!process.env.AZURE_SPEECH_KEY;
    
    res.json({
      available: isConfigured,
      language: process.env.AZURE_SPEECH_LANGUAGE || 'zh-CN',
      region: process.env.AZURE_SPEECH_REGION || 'eastasia',
      maxDuration: 60,
      minDuration: 1,
      supportedFormats: ['mp3', 'wav', 'm4a', 'webm']
    });
  }
}

module.exports = new SpeechController();
```

##### 4.4 语音路由 (`src/routes/speechRoutes.js`)

```javascript
const express = require('express');
const router = express.Router();
const speechController = require('../controllers/speechController');
const upload = require('../middleware/upload');
const { authenticateToken } = require('../middleware/auth');

// 语音转文字接口
router.post(
  '/speech-to-text',
  authenticateToken, // JWT 验证
  upload.single('audio'), // 处理单个音频文件上传
  speechController.speechToText
);

// 获取语音服务状态
router.get(
  '/speech/status',
  authenticateToken,
  speechController.getServiceStatus
);

module.exports = router;
```

##### 4.5 主文件更新 (`src/index.js`)

在主文件中注册新的路由：

```javascript
// 在现有的导入后添加
const speechRoutes = require('./routes/speechRoutes');

// 在现有的路由注册后添加
app.use('/api', speechRoutes);

// 清理临时文件（可选）
const cleanupTempFiles = require('./utils/cleanup');
setInterval(() => {
  cleanupTempFiles.cleanOldFiles('./temp', 60 * 60 * 1000); // 清理1小时前的文件
}, 30 * 60 * 1000); // 每30分钟执行一次
```

#### 5. 错误处理与优化

##### 5.1 临时文件清理工具 (`src/utils/cleanup.js`)

```javascript
const fs = require('fs').promises;
const path = require('path');

class CleanupUtil {
  /**
   * 清理指定目录中的旧文件
   * @param {string} directory - 目录路径
   * @param {number} maxAge - 最大文件年龄（毫秒）
   */
  async cleanOldFiles(directory, maxAge) {
    try {
      const files = await fs.readdir(directory);
      const now = Date.now();
      
      for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
          console.log(`[Cleanup] 删除过期文件: ${file}`);
        }
      }
    } catch (error) {
      console.error('[Cleanup] 清理失败:', error);
    }
  }
}

module.exports = new CleanupUtil();
```

##### 5.2 速率限制

在 `src/middleware/security.js` 中添加语音接口的速率限制：

```javascript
// 语音接口速率限制
const speechLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 10, // 每分钟最多10次语音识别请求
  message: '语音识别请求过于频繁，请稍后再试',
  standardHeaders: true,
  legacyHeaders: false,
});

// 导出供路由使用
module.exports.speechLimiter = speechLimiter;
```

#### 6. 部署注意事项

##### 6.1 Azure App Service 配置

在 Azure Portal 中添加应用设置：
- `AZURE_SPEECH_KEY`: Speech Service 密钥
- `AZURE_SPEECH_REGION`: 服务区域
- `AZURE_SPEECH_LANGUAGE`: 识别语言

##### 6.2 文件大小限制

确保 Azure App Service 的请求大小限制足够：
```xml
<!-- web.config -->
<system.webServer>
  <security>
    <requestFiltering>
      <requestLimits maxAllowedContentLength="10485760" />
    </requestFiltering>
  </security>
</system.webServer>
```

##### 6.3 临时文件目录权限

确保应用有权限写入临时目录：
```javascript
// 使用 Azure 的临时目录
const tempDir = process.env.TEMP || path.join(__dirname, '../../temp');
```

#### 7. 测试方案

##### 7.1 单元测试示例

```javascript
// test/speech.test.js
const request = require('supertest');
const app = require('../src/index');
const path = require('path');

describe('Speech API', () => {
  it('should convert speech to text', async () => {
    const response = await request(app)
      .post('/api/speech-to-text')
      .set('Authorization', 'Bearer ' + validToken)
      .field('userId', 'test_user')
      .attach('audio', path.join(__dirname, 'fixtures/test-audio.mp3'));
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.text).toBeTruthy();
  });
  
  it('should reject files that are too short', async () => {
    const response = await request(app)
      .post('/api/speech-to-text')
      .set('Authorization', 'Bearer ' + validToken)
      .field('userId', 'test_user')
      .attach('audio', path.join(__dirname, 'fixtures/short-audio.mp3'));
    
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('太短');
  });
});
```

##### 7.2 压力测试

```bash
# 使用 Apache Bench 进行压力测试
ab -n 100 -c 10 -T "multipart/form-data" \
   -H "Authorization: Bearer TOKEN" \
   http://localhost:3000/api/speech-to-text
```

#### 8. 监控与日志

##### 8.1 添加详细日志

```javascript
// 在 speechController.js 中
console.log(`[STT] 请求详情:`, {
  userId,
  fileName: req.file.filename,
  fileSize: req.file.size,
  mimeType: req.file.mimetype,
  timestamp: new Date().toISOString()
});

// 记录识别结果
console.log(`[STT] 识别结果:`, {
  userId,
  textLength: result.text.length,
  confidence: result.confidence,
  duration: duration,
  success: result.success
});
```

##### 8.2 性能监控

```javascript
// 添加性能监控
const startTime = Date.now();
const result = await speechService.speechToText(req.file.path);
const processingTime = Date.now() - startTime;

console.log(`[STT] 处理耗时: ${processingTime}ms`);
```

### 预期效果

- **流畅的录音体验**：按住即录，松开即发，操作直观
- **实时视觉反馈**：波形动画让用户清楚看到录音状态
- **智能手势控制**：上滑取消避免误发送
- **准确的语音识别**：高质量STT转换，支持中文识别
- **完善的错误处理**：各种异常情况都有合理的提示和处理