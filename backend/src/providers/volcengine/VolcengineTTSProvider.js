/**
 * 火山引擎TTS Provider实现
 * 支持流式语音合成，多种音色选择
 * API端点: https://openspeech.bytedance.com/api/v1/tts
 */
const https = require('https');
const crypto = require('crypto');
const TTSProvider = require('../base/TTSProvider');

class VolcengineTTSProvider extends TTSProvider {
  constructor(config) {
    super(config);
    this.config = {
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      appId: config.speechAppId,
      // 使用与ASR相同的认证信息
      ttsAccessToken: config.asrAccessToken,
      ttsSecretKey: config.asrSecretKey,
      cluster: 'volcano_tts',
      endpoint: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
      // TTS默认配置
      defaultVoice: 'zh_female_shuangkuai_moon_bigtts', // 爽快-月（专业女声）
      defaultEncoding: 'wav',
      defaultSpeed: 1.0,
      defaultVolume: 1.0,
      defaultPitch: 1.0,
      maxTextLength: 200, // 单次合成最大文本长度
      requestTimeout: 30000 // 请求超时时间
    };
  }

  async initialize() {
    // 验证配置
    if (!this.config.ttsAccessToken || !this.config.appId || !this.config.ttsSecretKey) {
      throw new Error('火山引擎TTS配置不完整：缺少TTS Access Token、Secret Key或App ID');
    }
    
    console.log('Volcengine TTS Provider初始化成功');
    console.log('- API端点:', this.config.endpoint);
    console.log('- App ID:', this.config.appId);
    console.log('- 默认音色:', this.config.defaultVoice);
  }

  async textToSpeech(text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error('文本内容不能为空');
    }

    if (text.length > this.config.maxTextLength) {
      console.warn(`文本长度超过${this.config.maxTextLength}字符，建议使用流式合成`);
    }

    const requestData = {
      app: {
        appid: this.config.appId,
        cluster: this.config.cluster
      },
      user: {
        uid: options.userId || 'default_user'
      },
      audio: {
        voice_type: options.voiceType || this.config.defaultVoice,
        encoding: options.encoding || this.config.defaultEncoding,
        speed_ratio: options.speed || this.config.defaultSpeed,
        volume_ratio: options.volume || this.config.defaultVolume,
        pitch_ratio: options.pitch || this.config.defaultPitch
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

    console.log(`开始TTS合成，文本长度: ${text.length}`);
    
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(requestData);
      const urlObj = new URL(this.config.endpoint);
      
      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'X-Api-App-Key': this.config.appId,
          'X-Api-Access-Key': this.config.ttsAccessToken
        },
        timeout: this.config.requestTimeout
      };

      const req = https.request(requestOptions, (res) => {
        const chunks = [];
        let totalSize = 0;
        
        res.on('data', (chunk) => {
          chunks.push(chunk);
          totalSize += chunk.length;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            const audioBuffer = Buffer.concat(chunks);
            console.log(`TTS合成成功，音频大小: ${audioBuffer.length} bytes`);
            
            resolve({
              audioBuffer,
              format: requestData.audio.encoding,
              sampleRate: 16000,
              duration: this.calculateDuration(text, options),
              voiceType: requestData.audio.voice_type,
              textLength: text.length
            });
          } else {
            const errorData = Buffer.concat(chunks).toString('utf8');
            console.error(`TTS API错误 ${res.statusCode}:`, errorData);
            reject(new Error(`TTS API error: ${res.statusCode} - ${errorData}`));
          }
        });
      });

      req.on('error', (error) => {
        console.error('TTS请求错误:', error);
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('TTS请求超时'));
      });

      req.write(postData);
      req.end();
    });
  }

  async streamTextToSpeech(text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error('文本内容不能为空');
    }

    console.log(`开始流式TTS合成，文本长度: ${text.length}`);
    
    const chunks = this.splitText(text, this.config.maxTextLength);
    const audioChunks = [];
    let totalDuration = 0;

    console.log(`文本分为${chunks.length}段进行合成`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      try {
        const result = await this.textToSpeech(chunk, {
          ...options,
          userId: options.userId || 'stream_user'
        });
        
        audioChunks.push(result.audioBuffer);
        totalDuration += result.duration;
        
        // 流式回调
        if (options.onChunk) {
          options.onChunk({
            index: i,
            total: chunks.length,
            audioBuffer: result.audioBuffer,
            text: chunk,
            duration: result.duration,
            isLast: i === chunks.length - 1,
            progress: (i + 1) / chunks.length
          });
        }
        
        // 分段之间稍微延迟，避免API限流
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`第${i + 1}段TTS合成失败:`, error);
        if (options.onError) {
          options.onError({
            index: i,
            text: chunk,
            error: error.message
          });
        }
        throw error;
      }
    }

    // 合并所有音频片段
    const combinedBuffer = Buffer.concat(audioChunks);
    console.log(`流式TTS合成完成，总音频大小: ${combinedBuffer.length} bytes`);
    
    return {
      audioBuffer: combinedBuffer,
      format: options.encoding || this.config.defaultEncoding,
      sampleRate: 16000,
      duration: totalDuration,
      chunks: audioChunks.length,
      textLength: text.length
    };
  }

  getSupportedVoices() {
    return [
      {
        id: 'zh_female_shuangkuai_moon_bigtts',
        name: '爽快-月',
        gender: 'female',
        language: 'zh-CN',
        description: '专业女声，语调清晰，适合医疗咨询',
        recommended: true
      },
      {
        id: 'zh_male_jingqiang_moon_bigtts', 
        name: '京腔-月',
        gender: 'male',
        language: 'zh-CN',
        description: '专业男声，磁性温和，权威感强'
      },
      {
        id: 'zh_female_wennuan_moon_bigtts',
        name: '温暖-月',
        gender: 'female', 
        language: 'zh-CN',
        description: '温暖女声，亲切友好，适合安抚情绪'
      },
      {
        id: 'zh_female_sweet_moon_bigtts',
        name: '甜美-月',
        gender: 'female',
        language: 'zh-CN',
        description: '甜美女声，年轻活泼'
      }
    ];
  }

  getSupportedFormats() {
    return ['wav', 'mp3', 'pcm'];
  }

  splitText(text, maxLength) {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks = [];
    let current = '';
    
    // 按句子分割，保持语义完整性
    const sentences = text.split(/([。！？；\n])/);
    
    for (let i = 0; i < sentences.length; i += 2) {
      const sentence = sentences[i] + (sentences[i + 1] || '');
      
      if ((current + sentence).length <= maxLength) {
        current += sentence;
      } else {
        if (current.trim()) {
          chunks.push(current.trim());
        }
        current = sentence;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    // 处理超长单句
    const finalChunks = [];
    for (const chunk of chunks) {
      if (chunk.length > maxLength) {
        // 强制按字符数分割
        for (let i = 0; i < chunk.length; i += maxLength) {
          finalChunks.push(chunk.slice(i, i + maxLength));
        }
      } else {
        finalChunks.push(chunk);
      }
    }

    return finalChunks.filter(chunk => chunk.length > 0);
  }

  calculateDuration(text, options = {}) {
    // 估算语音时长
    const speed = options.speed || this.config.defaultSpeed;
    const isChinese = /[\u4e00-\u9fa5]/.test(text);
    
    // 中文约2.5字/秒，英文约4个字符/秒，考虑标点停顿
    const charsPerSecond = isChinese ? 2.5 : 4;
    const baseDuration = text.length / charsPerSecond;
    
    // 根据语速调整
    return Math.ceil(baseDuration / speed);
  }

  async validateConfig() {
    try {
      const required = ['ttsAccessToken', 'appId', 'ttsSecretKey'];
      for (const field of required) {
        if (!this.config[field]) {
          console.error(`TTS配置缺失字段: ${field}`);
          return false;
        }
      }
      
      return true;
    } catch (error) {
      console.error('TTS配置验证失败:', error);
      return false;
    }
  }

  async healthCheck() {
    try {
      console.log('开始TTS健康检查...');
      
      const testText = '这是测试语音';
      const result = await this.textToSpeech(testText, { 
        userId: 'health_check',
        voiceType: this.config.defaultVoice
      });
      
      return {
        status: 'healthy',
        provider: 'Volcengine TTS',
        endpoint: this.config.endpoint,
        voiceType: this.config.defaultVoice,
        testAudioSize: result.audioBuffer.length,
        estimatedDuration: result.duration
      };
    } catch (error) {
      console.error('TTS健康检查失败:', error);
      return {
        status: 'unhealthy',
        provider: 'Volcengine TTS',
        error: error.message
      };
    }
  }

  // 辅助工具方法
  generateReqId() {
    return crypto.randomBytes(16).toString('hex');
  }

  getProviderInfo() {
    return {
      name: 'Volcengine TTS',
      version: '1.0.0',
      endpoint: this.config.endpoint,
      maxTextLength: this.config.maxTextLength,
      supportedVoices: this.getSupportedVoices().length,
      supportedFormats: this.getSupportedFormats(),
      streamingSupport: true
    };
  }
}

module.exports = VolcengineTTSProvider;