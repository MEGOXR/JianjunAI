/**
 * Azure ASR Provider实现
 * 使用Azure Speech Service进行语音识别
 */
const ASRProvider = require('../base/ASRProvider');

class AzureASRProvider extends ASRProvider {
  constructor(config) {
    super(config);
    this.config = {
      speechKey: config.speechKey,
      speechRegion: config.speechRegion || 'koreacentral',
      speechEndpoint: config.speechEndpoint,
      language: config.language || 'zh-CN'
    };
    
    // 动态导入 Azure Speech SDK
    this.sdk = null;
    this.sessions = new Map();
    
    if (this.config.speechKey) {
      try {
        this.sdk = require('microsoft-cognitiveservices-speech-sdk');
        console.log('Azure Speech SDK 加载成功');
      } catch (error) {
        console.warn('Azure Speech SDK 未安装:', error.message);
      }
    }
  }

  async initialize() {
    if (!this.config.speechKey) {
      throw new Error('Azure Speech Service 未配置：缺少 AZURE_SPEECH_KEY');
    }
    
    if (!this.sdk) {
      throw new Error('Azure Speech SDK 未安装，请运行: npm install microsoft-cognitiveservices-speech-sdk');
    }
    
    console.log('Azure ASR Provider初始化成功');
    console.log(`- 区域: ${this.config.speechRegion}`);
    console.log(`- 语言: ${this.config.language}`);
  }

  async startStreamingRecognition(sessionId, options = {}) {
    if (!this.sdk) {
      throw new Error('Azure Speech SDK 未加载');
    }
    
    console.log(`启动Azure ASR会话: ${sessionId}`);
    
    try {
      // 配置语音识别
      const speechConfig = this.sdk.SpeechConfig.fromSubscription(
        this.config.speechKey,
        this.config.speechRegion
      );
      speechConfig.speechRecognitionLanguage = this.config.language;
      
      // 设置识别参数
      speechConfig.setProperty(
        this.sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
        "60000"  // 初始静默超时60秒
      );
      speechConfig.setProperty(
        this.sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
        "2000"   // 结束静默超时2秒
      );
      
      // 创建推送流
      const pushStream = this.sdk.AudioInputStream.createPushStream(
        this.sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1)
      );
      
      // 创建音频配置
      const audioConfig = this.sdk.AudioConfig.fromStreamInput(pushStream);
      
      // 创建识别器
      const recognizer = new this.sdk.SpeechRecognizer(speechConfig, audioConfig);
      
      // 设置事件处理
      recognizer.recognizing = (s, e) => {
        if (e.result.reason === this.sdk.ResultReason.RecognizingSpeech) {
          if (options.onResult) {
            options.onResult({
              text: e.result.text,
              confidence: 0.8,
              isFinal: false,
              timestamp: Date.now(),
              sessionId: sessionId
            });
          }
        }
      };
      
      recognizer.recognized = (s, e) => {
        if (e.result.reason === this.sdk.ResultReason.RecognizedSpeech) {
          if (options.onFinal) {
            options.onFinal({
              text: e.result.text,
              confidence: 0.95,
              isFinal: true,
              timestamp: Date.now(),
              sessionId: sessionId
            });
          }
        } else if (e.result.reason === this.sdk.ResultReason.NoMatch) {
          console.log('未识别到语音');
        }
      };
      
      recognizer.sessionStopped = (s, e) => {
        console.log(`Azure ASR会话已停止: ${sessionId}`);
        if (options.onStateChange) {
          options.onStateChange('stopped');
        }
        recognizer.close();
        this.sessions.delete(sessionId);
      };
      
      recognizer.canceled = (s, e) => {
        console.error(`Azure ASR取消: ${e.errorDetails}`);
        if (options.onError) {
          options.onError(new Error(e.errorDetails));
        }
        recognizer.close();
        this.sessions.delete(sessionId);
      };
      
      // 开始连续识别
      await new Promise((resolve, reject) => {
        recognizer.startContinuousRecognitionAsync(
          () => {
            console.log(`Azure ASR开始识别: ${sessionId}`);
            if (options.onStateChange) {
              options.onStateChange('connected');
            }
            resolve();
          },
          (error) => {
            console.error(`启动Azure ASR失败: ${error}`);
            reject(new Error(error));
          }
        );
      });
      
      // 保存会话
      const session = {
        recognizer,
        pushStream,
        sessionId,
        state: 'connected'
      };
      
      this.sessions.set(sessionId, session);
      return session;
      
    } catch (error) {
      console.error(`创建Azure ASR会话失败:`, error);
      throw error;
    }
  }

  async processAudioFrame(sessionId, audioBuffer) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'connected') {
      throw new Error(`会话 ${sessionId} 未连接或不存在`);
    }
    
    try {
      // 将音频数据推送到流
      session.pushStream.write(audioBuffer);
    } catch (error) {
      console.error(`推送音频数据失败:`, error);
      throw error;
    }
  }

  async endStreamingRecognition(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`会话 ${sessionId} 不存在，无需结束`);
      return;
    }
    
    console.log(`结束Azure ASR会话: ${sessionId}`);
    
    try {
      // 关闭推送流
      session.pushStream.close();
      
      // 停止识别
      await new Promise((resolve, reject) => {
        session.recognizer.stopContinuousRecognitionAsync(
          () => {
            console.log(`Azure ASR已停止: ${sessionId}`);
            resolve();
          },
          (error) => {
            console.error(`停止Azure ASR失败: ${error}`);
            reject(new Error(error));
          }
        );
      });
      
      // 清理资源
      session.recognizer.close();
      this.sessions.delete(sessionId);
      
    } catch (error) {
      console.error(`结束Azure ASR会话失败:`, error);
      // 确保清理
      this.sessions.delete(sessionId);
    }
  }

  async cancelStreamingRecognition(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    
    console.log(`取消Azure ASR会话: ${sessionId}`);
    
    try {
      // 关闭推送流
      if (session.pushStream) {
        session.pushStream.close();
      }
      
      // 关闭识别器
      if (session.recognizer) {
        session.recognizer.close();
      }
      
      this.sessions.delete(sessionId);
    } catch (error) {
      console.error(`取消Azure ASR会话失败:`, error);
      this.sessions.delete(sessionId);
    }
  }

  async speechToText(audioFilePath) {
    // 可以实现文件识别功能
    throw new Error('文件识别功能未实现，请使用流式识别');
  }

  async validateConfig() {
    try {
      if (!this.config.speechKey) {
        console.error('Azure ASR配置缺失: speechKey');
        return false;
      }
      
      if (!this.sdk) {
        console.error('Azure Speech SDK未加载');
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('Azure ASR配置验证失败:', error);
      return false;
    }
  }

  async healthCheck() {
    try {
      if (!this.sdk) {
        return {
          status: 'unhealthy',
          provider: 'Azure ASR',
          error: 'SDK未加载'
        };
      }
      
      // 简单检查配置是否有效
      const isValid = await this.validateConfig();
      
      if (isValid) {
        return {
          status: 'healthy',
          provider: 'Azure ASR',
          region: this.config.speechRegion,
          language: this.config.language
        };
      } else {
        return {
          status: 'unhealthy',
          provider: 'Azure ASR',
          error: '配置无效'
        };
      }
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: 'Azure ASR',
        error: error.message
      };
    }
  }

  getProviderInfo() {
    return {
      name: 'Azure ASR',
      version: '1.0.0',
      mode: '连续流式识别',
      region: this.config.speechRegion,
      language: this.config.language,
      supportedFormats: ['PCM 16kHz 16bit mono']
    };
  }
}

module.exports = AzureASRProvider;