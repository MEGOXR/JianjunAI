const fs = require('fs').promises;
const path = require('path');

// 环境变量读取辅助函数（处理 Azure App Service 的 APPSETTING_ 前缀）
function getEnvVar(name) {
  return process.env[name] || process.env[`APPSETTING_${name}`] || null;
}

// 动态导入 Azure Speech SDK（如果配置了密钥）
let sdk = null;
if (getEnvVar('AZURE_SPEECH_KEY')) {
  try {
    sdk = require('microsoft-cognitiveservices-speech-sdk');
    console.log('Azure Speech SDK 加载成功');
  } catch (error) {
    console.warn('Azure Speech SDK 加载失败:', error.message);
  }
}

class SpeechService {
  constructor() {
    // Azure Speech Service 配置
    this.speechKey = getEnvVar('AZURE_SPEECH_KEY');
    this.speechRegion = getEnvVar('AZURE_SPEECH_REGION') || 'koreacentral';
    this.speechEndpoint = getEnvVar('AZURE_SPEECH_ENDPOINT');
    this.language = getEnvVar('AZURE_SPEECH_LANGUAGE') || 'zh-CN';
    
    if (!this.speechKey) {
      console.warn('警告: AZURE_SPEECH_KEY 未配置');
    } else if (sdk) {
      console.log(`Azure Speech Service 已配置: 区域=${this.speechRegion}, 语言=${this.language}`);
    }
  }

  /**
   * 使用 PushAudioInputStream 处理音频文件
   * 支持 MP3 格式通过推送流的方式
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
      
      // 使用 Azure Speech Service 进行识别
      if (!this.speechKey) {
        throw new Error('Azure Speech Service 未配置');
      }
      
      if (!sdk) {
        throw new Error('Azure Speech SDK 未加载');
      }
      
      return await this.azureSpeechToText(audioFilePath, duration);
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
    // MP3 文件约 128kbps 码率
    const stats = await fs.stat(audioFilePath);
    const fileSizeInBytes = stats.size;
    const bitRate = 128000 / 8; // 128kbps 转换为 bytes per second
    const duration = fileSizeInBytes / bitRate;
    
    // 返回合理范围内的时长（1-60秒）
    return Math.max(1, Math.min(60, Math.round(duration)));
  }

  /**
   * 使用 Azure Speech Service 进行语音识别
   * 使用 PushAudioInputStream 支持各种音频格式
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
        console.log(`[STT] 配置信息: Region=${this.speechRegion}, Language=${this.language}`);
        const speechConfig = sdk.SpeechConfig.fromSubscription(
          this.speechKey,
          this.speechRegion
        );
        speechConfig.speechRecognitionLanguage = this.language;
        
        // 设置识别参数以提高准确性
        speechConfig.setProperty(
          sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
          "30000"  // 增加初始静默超时到30秒
        );
        speechConfig.setProperty(
          sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
          "5000"   // 增加结束静默超时到5秒
        );
        
        // 读取音频文件数据
        const audioData = await fs.readFile(audioFilePath);
        console.log(`[STT] 音频文件信息: 大小=${audioData.length}字节, 估算时长=${duration}秒`);
        
        // 创建 PushAudioInputStream 用于处理各种格式
        let audioFormat;
        
        // 判断文件格式并设置相应的音频格式
        if (audioFilePath.toLowerCase().endsWith('.wav')) {
          // WAV 格式：默认 PCM 16kHz
          audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
        } else if (audioFilePath.toLowerCase().endsWith('.pcm')) {
          // PCM 格式：原始音频数据，16kHz, 16-bit, 单声道
          audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
          console.log('[STT] 使用 PCM 格式: 16kHz, 16-bit, 单声道');
        } else {
          // MP3 或其他格式：使用默认格式
          audioFormat = sdk.AudioStreamFormat.getDefaultInputFormat();
        }
        
        const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
        
        // 将音频数据推送到流中
        pushStream.write(audioData);
        pushStream.close();
        
        // 创建音频配置
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
              console.log('[STT] NoMatch详细信息:', result.properties ? result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult) : 'N/A');
              resolve({
                success: false,
                text: '',
                confidence: 0,
                duration: duration,
                error: '无法识别语音内容，请说话清晰一些或尝试更长的录音',
                isSimulated: false
              });
            } else {
              // 其他错误
              console.error('[STT] 识别失败，原因:', result.reason);
              console.error('[STT] 错误详情:', result.errorDetails || 'N/A');
              reject(new Error(`语音识别失败: ${result.reason} - ${result.errorDetails}`));
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