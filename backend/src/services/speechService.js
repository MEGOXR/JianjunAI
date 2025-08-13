const fs = require('fs').promises;
const path = require('path');

// 动态导入 Azure Speech SDK（如果配置了密钥）
let sdk = null;
if (process.env.AZURE_SPEECH_KEY) {
  try {
    sdk = require('microsoft-cognitiveservices-speech-sdk');
    console.log('Azure Speech SDK 加载成功');
  } catch (error) {
    console.warn('Azure Speech SDK 加载失败，将使用模拟识别:', error.message);
  }
}

class SpeechService {
  constructor() {
    // Azure Speech Service 配置
    this.speechKey = process.env.AZURE_SPEECH_KEY;
    this.speechRegion = process.env.AZURE_SPEECH_REGION || 'koreacentral';
    this.language = process.env.AZURE_SPEECH_LANGUAGE || 'zh-CN';
    
    if (!this.speechKey) {
      console.warn('警告: AZURE_SPEECH_KEY 未配置，使用模拟语音识别');
    } else if (sdk) {
      console.log(`Azure Speech Service 已配置: 区域=${this.speechRegion}, 语言=${this.language}`);
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
      
      // 获取文件信息
      const stats = await fs.stat(audioFilePath);
      const duration = await this.getAudioDuration(audioFilePath);
      
      // 如果配置了 Azure Speech Key 且 SDK 加载成功，使用真实服务
      if (this.speechKey && sdk) {
        try {
          return await this.azureSpeechToText(audioFilePath, duration);
        } catch (error) {
          console.error('Azure Speech Service 失败，降级到模拟识别:', error.message);
          return this.simulateSpeechRecognition(duration);
        }
      } else {
        // 使用模拟识别
        return this.simulateSpeechRecognition(duration);
      }
    } catch (error) {
      console.error('语音识别错误:', error);
      throw error;
    } finally {
      // 清理临时文件
      try {
        await fs.unlink(audioFilePath);
        console.log(`[STT] 已清理临时文件: ${audioFilePath}`);
      } catch (err) {
        console.error('清理临时文件失败:', err);
      }
    }
  }

  /**
   * 模拟语音识别（用于开发测试）
   * @private
   */
  async simulateSpeechRecognition(duration) {
    // 模拟处理延迟
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 生成模拟识别文本
    const sampleTexts = [
      '我想咨询一下双眼皮手术',
      '请问隆鼻手术需要多长时间恢复',
      '医生，我想了解一下面部填充的效果',
      '请介绍一下你们医院的资质',
      '手术后需要注意什么',
      '费用大概是多少'
    ];
    
    const randomText = sampleTexts[Math.floor(Math.random() * sampleTexts.length)];
    
    return {
      success: true,
      text: randomText,
      confidence: 0.85 + Math.random() * 0.1, // 0.85-0.95
      duration: duration,
      language: this.language,
      isSimulated: true // 标记为模拟结果
    };
  }

  /**
   * 计算识别置信度
   * @private
   */
  calculateConfidence(result) {
    // Azure 不直接提供置信度分数，我们基于一些因素估算
    let confidence = 0.7; // 基础置信度
    
    // 根据识别文本长度调整
    if (result.text && result.text.length > 10) confidence += 0.1;
    if (result.text && result.text.length > 20) confidence += 0.1;
    
    // 检查是否包含标点符号（通常表示更完整的识别）
    if (result.text && /[，。！？]/.test(result.text)) confidence += 0.05;
    
    return Math.min(confidence, 0.95);
  }

  /**
   * 验证语音时长
   * @param {string} audioFilePath - 音频文件路径
   * @returns {Promise<number>} 音频时长（秒）
   */
  async getAudioDuration(audioFilePath) {
    // 简单实现：基于文件大小估算
    // MP3 文件约 48kbps 码率
    const stats = await fs.stat(audioFilePath);
    const fileSizeInBytes = stats.size;
    const bitRate = 48000 / 8; // 48kbps 转换为 bytes per second
    const duration = fileSizeInBytes / bitRate;
    
    // 返回合理范围内的时长（1-60秒）
    return Math.max(1, Math.min(60, Math.round(duration)));
  }

  /**
   * 集成真实的 Azure Speech Service
   * @param {string} audioFilePath - 音频文件路径
   * @param {number} duration - 音频时长
   * @returns {Promise<Object>} 识别结果
   */
  async azureSpeechToText(audioFilePath, duration) {
    if (!sdk) {
      throw new Error('Azure Speech SDK 未加载');
    }

    return new Promise(async (resolve, reject) => {
      try {
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
        
        // 读取音频文件
        const audioData = await fs.readFile(audioFilePath);
        
        // 创建推送流和音频配置
        const pushStream = sdk.AudioInputStream.createPushStream();
        pushStream.write(audioData);
        pushStream.close();
        
        const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
        
        // 创建识别器
        const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
        
        console.log('[STT] 开始 Azure 语音识别...');
        const startTime = Date.now();
        
        // 执行识别
        recognizer.recognizeOnceAsync(
          (result) => {
            const processingTime = Date.now() - startTime;
            console.log(`[STT] Azure 识别完成，耗时: ${processingTime}ms`);
            
            if (result.reason === sdk.ResultReason.RecognizedSpeech) {
              // 识别成功
              const confidence = this.calculateConfidence(result);
              console.log(`[STT] 识别成功: "${result.text}", 置信度: ${confidence}`);
              
              resolve({
                success: true,
                text: result.text,
                confidence: confidence,
                duration: duration,
                language: this.language,
                isSimulated: false
              });
            } else if (result.reason === sdk.ResultReason.NoMatch) {
              // 无法识别
              console.log('[STT] 无法识别语音内容');
              resolve({
                success: false,
                text: '',
                confidence: 0,
                duration: duration,
                error: '无法识别语音内容，请说话清晰一些',
                isSimulated: false
              });
            } else {
              // 其他错误
              console.error('[STT] 识别失败:', result.reason);
              reject(new Error(`语音识别失败: ${result.reason}`));
            }
            
            recognizer.close();
          },
          (error) => {
            console.error('[STT] Azure 识别错误:', error);
            recognizer.close();
            reject(error);
          }
        );
      } catch (error) {
        console.error('[STT] Azure Speech Service 错误:', error);
        reject(error);
      }
    });
  }
}

module.exports = new SpeechService();