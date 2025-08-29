/**
 * 火山引擎TTS Provider V3实现
 * 使用V3 WSS双向流式接口
 * API端点: wss://openspeech.bytedance.com/api/v3/tts/bidirection
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const TTSProvider = require('../base/TTSProvider');

class VolcengineTTSProviderV3 extends TTSProvider {
  constructor(config) {
    super(config);
    this.config = {
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      appId: config.speechAppId,
      // 语音服务统一认证信息
      speechAccessToken: config.speechAccessToken,
      speechSecretKey: config.speechSecretKey,
      // TTS资源ID
      ttsResourceId: config.ttsResourceId,
      // TTS音色配置
      ttsVoice: config.ttsVoice,
      cluster: 'volcano_tts',
      wsUrl: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
      // TTS默认配置
      defaultVoice: config.ttsVoice || 'zh_female_shuangkuai_moon_bigtts',
      defaultEncoding: 'wav',
      defaultSpeed: 1.0,
      defaultVolume: 1.0,
      defaultPitch: 1.0,
      requestTimeout: 30000
    };
    this.sessions = new Map(); // 管理TTS会话
  }

  async initialize() {
    // 验证配置
    if (!this.config.speechAccessToken || !this.config.appId || !this.config.speechSecretKey || !this.config.ttsResourceId) {
      throw new Error('火山引擎TTS配置不完整：缺少Speech Access Token、Secret Key、App ID或TTS Resource ID');
    }
    
    console.log('Volcengine TTS Provider V3初始化成功');
    console.log('- WebSocket端点:', this.config.wsUrl);
    console.log('- App ID:', this.config.appId);
    console.log('- 默认音色:', this.config.defaultVoice);
  }

  async textToSpeech(text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error('文本内容不能为空');
    }

    console.log(`开始TTS合成，文本长度: ${text.length}`);
    
    const sessionId = this.generateSessionId();
    
    return new Promise(async (resolve, reject) => {
      try {
        // 建立WebSocket连接
        const connectId = this.generateConnectId();
        const wsOptions = {
          headers: {
            'X-Api-App-Key': this.config.appId,
            'X-Api-Access-Key': this.config.speechAccessToken,
            'X-Api-Resource-Id': this.config.ttsResourceId,
            'X-Api-Connect-Id': connectId
          }
        };
        
        const ws = new WebSocket(this.config.wsUrl, wsOptions);
        const audioChunks = [];
        
        const session = {
          ws,
          sessionId,
          audioChunks,
          resolve,
          reject,
          startTime: Date.now()
        };
        
        this.sessions.set(sessionId, session);
        
        ws.on('open', () => {
          console.log(`TTS WebSocket连接建立: ${sessionId}`);
          
          // 发送初始化请求
          const initPayload = {
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
              sequence: 1
            }
          };
          
          this.sendMessage(ws, initPayload, 'init');
        });
        
        ws.on('message', (data) => {
          this.handleMessage(session, data);
        });
        
        ws.on('error', (error) => {
          console.error(`TTS WebSocket错误 ${sessionId}:`, error);
          this.sessions.delete(sessionId);
          reject(error);
        });
        
        ws.on('close', () => {
          console.log(`TTS WebSocket连接已关闭: ${sessionId}`);
          this.sessions.delete(sessionId);
        });
        
        // 超时处理
        setTimeout(() => {
          if (this.sessions.has(sessionId)) {
            console.error(`TTS合成超时: ${sessionId}`);
            ws.close();
            this.sessions.delete(sessionId);
            reject(new Error('TTS合成超时'));
          }
        }, this.config.requestTimeout);
        
      } catch (error) {
        reject(error);
      }
    });
  }

  sendMessage(ws, payload, messageType = 'data') {
    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(4);
    
    // 协议头：类似ASR的格式
    if (messageType === 'init') {
      header.writeUInt8(0x11, 0); // 初始化请求
    } else {
      header.writeUInt8(0x10, 0); // 数据请求
    }
    
    // 写入负载大小（小端序）
    header.writeUIntLE(payloadBytes.length, 1, 3);
    
    const message = Buffer.concat([header, payloadBytes]);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else {
      console.warn('TTS WebSocket不在开放状态，消息未发送');
    }
  }

  handleMessage(session, rawData) {
    try {
      // 解析协议头
      const header = rawData.slice(0, 4);
      const messageType = header.readUInt8(0);
      const payloadSize = header.readUIntLE(1, 3);
      
      if (payloadSize > 0) {
        const payload = rawData.slice(4, 4 + payloadSize);
        
        try {
          const response = JSON.parse(payload.toString('utf8'));
          
          if (response.audio) {
            // 接收到音频数据
            const audioData = Buffer.from(response.audio, 'base64');
            session.audioChunks.push(audioData);
          }
          
          if (response.done || response.sequence === -1) {
            // 合成完成
            const combinedAudio = Buffer.concat(session.audioChunks);
            const duration = (Date.now() - session.startTime) / 1000;
            
            console.log(`TTS合成完成: ${session.sessionId}, 音频大小: ${combinedAudio.length} bytes`);
            
            session.resolve({
              audioBuffer: combinedAudio,
              format: this.config.defaultEncoding,
              sampleRate: 16000,
              duration: duration,
              chunks: session.audioChunks.length
            });
            
            session.ws.close();
            this.sessions.delete(session.sessionId);
          }
          
          if (response.error) {
            console.error(`TTS合成错误:`, response.error);
            session.reject(new Error(response.error.message || '合成失败'));
            session.ws.close();
            this.sessions.delete(session.sessionId);
          }
        } catch (jsonError) {
          // 可能是二进制音频数据
          if (payloadSize > 100) { // 假设是音频数据
            session.audioChunks.push(payload);
          }
        }
      } else {
        // 处理可能的结束标记
        if (messageType === 0x20) { // 假设的结束标记
          const combinedAudio = Buffer.concat(session.audioChunks);
          const duration = (Date.now() - session.startTime) / 1000;
          
          session.resolve({
            audioBuffer: combinedAudio,
            format: this.config.defaultEncoding,
            sampleRate: 16000,
            duration: duration,
            chunks: session.audioChunks.length
          });
          
          session.ws.close();
          this.sessions.delete(session.sessionId);
        }
      }
    } catch (error) {
      console.error('解析TTS响应失败:', error);
      session.reject(error);
    }
  }

  async streamTextToSpeech(text, options = {}) {
    // 对于WebSocket版本，可以直接使用textToSpeech
    return await this.textToSpeech(text, options);
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
      }
    ];
  }

  getSupportedFormats() {
    return ['wav', 'mp3', 'pcm'];
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
      console.log('开始TTS WebSocket健康检查...');
      
      const connectId = this.generateConnectId();
      const wsOptions = {
        headers: {
          'X-Api-App-Key': this.config.appId,
          'X-Api-Access-Key': this.config.speechAccessToken,
          'X-Api-Resource-Id': this.config.ttsResourceId,
          'X-Api-Connect-Id': connectId
        }
      };
      
      const testWs = new WebSocket(this.config.wsUrl, wsOptions);
      
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          testWs.close();
          resolve({
            status: 'unhealthy',
            provider: 'Volcengine TTS V3',
            error: '连接超时'
          });
        }, 5000);
        
        testWs.on('open', () => {
          clearTimeout(timeout);
          testWs.close();
          resolve({
            status: 'healthy',
            provider: 'Volcengine TTS V3',
            endpoint: this.config.wsUrl,
            mode: 'V3双向流式'
          });
        });
        
        testWs.on('error', (error) => {
          clearTimeout(timeout);
          resolve({
            status: 'unhealthy',
            provider: 'Volcengine TTS V3',
            error: error.message
          });
        });
      });
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: 'Volcengine TTS V3',
        error: error.message
      };
    }
  }

  // 辅助工具方法
  generateConnectId() {
    return crypto.randomUUID();
  }
  
  generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
  }
  
  generateReqId() {
    return crypto.randomBytes(16).toString('hex');
  }

  getProviderInfo() {
    return {
      name: 'Volcengine TTS V3',
      version: '3.0.0',
      endpoint: this.config.wsUrl,
      mode: 'V3双向流式',
      supportedVoices: this.getSupportedVoices().length,
      supportedFormats: this.getSupportedFormats(),
      streamingSupport: true
    };
  }
}

module.exports = VolcengineTTSProviderV3;