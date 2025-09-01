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
          
          // 发送TTS请求 - 基于BytePlus文档格式
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
              operation: 'submit', // BytePlus文档要求使用'submit'
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
        
        ws.on('close', (code, reason) => {
          console.log(`TTS WebSocket连接已关闭: ${sessionId}, code: ${code}, reason: ${reason || '无'}`);
          
          // 检查是否已经收到完整音频数据
          if (session.audioChunks && session.audioChunks.length > 0) {
            console.log(`连接关闭但已收到${session.audioChunks.length}个音频块，尝试完成合成`);
            
            const combinedAudio = Buffer.concat(session.audioChunks);
            const duration = (Date.now() - session.startTime) / 1000;
            
            console.log(`TTS合成完成（连接关闭）: ${sessionId}, 音频大小: ${combinedAudio.length} bytes`);
            
            if (combinedAudio.length > 0) {
              session.resolve({
                audioBuffer: combinedAudio,
                format: this.config.defaultEncoding,
                sampleRate: 16000,
                duration: duration,
                chunks: session.audioChunks.length
              });
              
              this.sessions.delete(sessionId);
              return;
            }
          }
          
          this.sessions.delete(sessionId);
          
          // 如果连接异常关闭且还没有完成，则reject Promise
          if (code !== 1000) {
            const closeCodeMeanings = {
              1001: '端点离开',
              1002: '协议错误',
              1003: '不支持的数据类型',
              1006: '异常关闭（未发送关闭帧）',
              1007: '无效的有效载荷数据',
              1008: '违反策略',
              1009: '消息太大',
              1010: '客户端期望服务器协商扩展',
              1011: '服务器遇到意外情况'
            };
            
            const meaning = closeCodeMeanings[code] || '未知';
            console.error(`WebSocket异常关闭: ${meaning} (${code})`);
            
            reject(new Error(`WebSocket连接异常关闭: ${meaning} (${code})`));
          }
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
    
    // 4字节头部
    const header = Buffer.alloc(4);
    
    // 协议头：基于BytePlus文档的正确格式
    // 协议版本(4bits) + 头部大小(4bits)
    const protocolVersion = 0b0001; // 版本1
    const headerSize = 0b0001; // 4字节头部
    const versionAndSize = (protocolVersion << 4) | headerSize;
    header.writeUInt8(versionAndSize, 0); // 第1字节：版本和头部大小
    
    // 消息类型：Full Client Request = 0b0001 (1)
    header.writeUInt8(0b0001, 1); // 第2字节：消息类型
    
    // 消息类型特定标志 + 序列化方法
    // 标志(4bits) + JSON序列化(4bits: 0b0001)
    const flags = 0b0000; // 无特殊标志
    const serialization = 0b0001; // JSON序列化
    const flagsAndSerialization = (flags << 4) | serialization;
    header.writeUInt8(flagsAndSerialization, 2); // 第3字节：标志和序列化
    
    // 保留字节
    header.writeUInt8(0x00, 3); // 第4字节：保留
    
    // 4字节负载大小（大端序）
    const payloadSizeBuffer = Buffer.alloc(4);
    payloadSizeBuffer.writeUInt32BE(payloadBytes.length, 0);
    
    // 完整消息：Header + Payload Size + Payload
    const message = Buffer.concat([header, payloadSizeBuffer, payloadBytes]);
    
    console.log(`发送TTS消息 - 头部: ${header.toString('hex')}, 负载大小: ${payloadBytes.length}, 总大小: ${message.length}`);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else {
      console.warn('TTS WebSocket不在开放状态，消息未发送');
    }
  }

  handleMessage(session, rawData) {
    try {
      // 初始化缓冲区如果不存在
      if (!session.messageBuffer) {
        session.messageBuffer = Buffer.alloc(0);
        session.expectedSize = null;
        session.headerParsed = false;
      }
      
      // 将新数据添加到缓冲区
      session.messageBuffer = Buffer.concat([session.messageBuffer, rawData]);
      
      console.log(`接收数据: ${rawData.length} bytes, 缓冲区总大小: ${session.messageBuffer.length} bytes`);
      
      // 解析协议头（如果还没解析）
      if (!session.headerParsed && session.messageBuffer.length >= 8) {
        const header = session.messageBuffer.slice(0, 4);
        const payloadSizeBuffer = session.messageBuffer.slice(4, 8);
        
        // 解析头部字节
        const versionAndSize = header.readUInt8(0);
        const protocolVersion = (versionAndSize >> 4) & 0x0F;
        const headerSize = versionAndSize & 0x0F;
        const messageType = header.readUInt8(1);
        const flagsAndSerialization = header.readUInt8(2);
        const flags = (flagsAndSerialization >> 4) & 0x0F;
        const serialization = flagsAndSerialization & 0x0F;
        
        // 读取负载大小（大端序）
        session.expectedSize = payloadSizeBuffer.readUInt32BE(0);
        session.headerParsed = true;
        session.messageType = messageType;
        session.serialization = serialization;
        
        console.log(`TTS消息解析:`);
        console.log(`- 协议版本: ${protocolVersion}`);
        console.log(`- 消息类型: 0x${messageType.toString(16)} (${messageType})`);
        console.log(`- 序列化方法: ${serialization}`);
        console.log(`- 期望负载大小: ${session.expectedSize}`);
      }
      
      // 检查是否接收到完整消息
      if (session.headerParsed && session.messageBuffer.length >= 8 + session.expectedSize) {
        const payload = session.messageBuffer.slice(8, 8 + session.expectedSize);
        
        console.log(`接收到完整消息，负载大小: ${payload.length} bytes`);
        
        // 根据消息类型和序列化方法处理
        if (session.messageType === 11) { // Audio-only Server Response (0b1011)
          if (session.serialization === 0) { // 无序列化，原始字节
            console.log('接收到音频数据（二进制）');
            session.audioChunks.push(payload);
            console.log(`添加音频数据: ${payload.length} bytes, 总块数: ${session.audioChunks.length}`);
          }
        } else if (session.serialization === 1) { // JSON序列化
          try {
            const response = JSON.parse(payload.toString('utf8'));
            console.log('JSON响应:', JSON.stringify(response, null, 2));
            
            if (response.audio) {
              // 接收到音频数据（base64）
              const audioData = Buffer.from(response.audio, 'base64');
              session.audioChunks.push(audioData);
              console.log(`添加音频数据: ${audioData.length} bytes, 总块数: ${session.audioChunks.length}`);
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
              return;
            }
            
            if (response.error) {
              console.error(`TTS合成错误:`, response.error);
              session.reject(new Error(response.error.message || '合成失败'));
              session.ws.close();
              this.sessions.delete(session.sessionId);
              return;
            }
          } catch (jsonError) {
            console.log('无法解析为JSON，但期望JSON格式');
            console.log('负载内容:', payload.toString('utf8').substring(0, 200));
          }
        } else {
          console.log(`未知的序列化方法: ${session.serialization}`);
        }
        
        // 重置缓冲区以处理下一条消息
        const remainingData = session.messageBuffer.slice(8 + session.expectedSize);
        session.messageBuffer = remainingData;
        session.headerParsed = false;
        session.expectedSize = null;
        session.messageType = null;
        session.serialization = null;
        
        // 如果还有剩余数据，递归处理
        if (remainingData.length > 0) {
          console.log(`处理剩余数据: ${remainingData.length} bytes`);
          this.handleMessage(session, Buffer.alloc(0)); // 触发处理剩余数据
        }
      } else if (session.headerParsed) {
        console.log(`等待更多数据，当前: ${session.messageBuffer.length}, 需要: ${8 + session.expectedSize}`);
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