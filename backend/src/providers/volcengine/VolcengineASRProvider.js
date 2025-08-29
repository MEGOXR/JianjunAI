/**
 * 火山引擎ASR Provider实现
 * 使用双向流式模式（优化版本）
 * API端点: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
 * 特点：性能优化，只在结果变化时返回数据包，RTF和延迟均有提升
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const ASRProvider = require('../base/ASRProvider');

class VolcengineASRProvider extends ASRProvider {
  constructor(config) {
    super(config);
    this.config = {
      accessKey: config.accessKey,
      secretKey: config.secretKey, 
      appId: config.speechAppId,
      // 语音服务统一认证信息
      speechAccessToken: config.speechAccessToken,
      speechSecretKey: config.speechSecretKey,
      cluster: 'volcengine_streaming_common',
      wsUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      // 双向流式优化配置
      audioFormat: 'wav',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      chunkSize: 3200, // 200ms音频数据，获得最佳性能
      language: 'zh-CN'
    };
    this.sessions = new Map(); // 管理多个会话
  }

  async initialize() {
    // 验证配置
    if (!this.config.asrAccessToken || !this.config.appId || !this.config.asrSecretKey) {
      throw new Error('火山引擎ASR配置不完整：缺少ASR Access Token、Secret Key或App ID');
    }
    
    console.log('Volcengine ASR Provider初始化成功');
    console.log('- WebSocket端点:', this.config.wsUrl);
    console.log('- App ID:', this.config.appId);
    console.log('- 双向流式模式（优化版本）已启用 - RTF和延迟优化');
  }

  async startStreamingRecognition(sessionId, options = {}) {
    console.log(`启动火山引擎ASR会话: ${sessionId}`);
    
    // 生成连接ID（UUID格式）
    const connectId = this.generateConnectId();
    
    // 设置WebSocket连接的HTTP请求头进行认证
    const wsOptions = {
      headers: {
        'X-Api-App-Key': this.config.appId,
        'X-Api-Access-Key': this.config.speechAccessToken, // 使用专用的ASR access token
        'X-Api-Resource-Id': 'volc.bigasr.sauc.duration', // 小时版
        'X-Api-Connect-Id': connectId
      }
    };
    
    const ws = new WebSocket(this.config.wsUrl, wsOptions);
    const session = {
      ws,
      sessionId,
      state: 'connecting',
      buffer: [],
      sequence: 0,
      startTime: Date.now(),
      onResult: options.onResult || (() => {}),
      onFinal: options.onFinal || (() => {}),
      onError: options.onError || (() => {}),
      onStateChange: options.onStateChange || (() => {})
    };
    
    this.sessions.set(sessionId, session);
    
    return new Promise((resolve, reject) => {
      ws.on('open', () => {
        console.log(`ASR WebSocket连接已建立: ${sessionId}`);
        
        // 发送Full Client Request（首包）
        const payload = {
          app: {
            appid: this.config.appId,
            cluster: this.config.cluster
          },
          user: {
            uid: sessionId
          },
          audio: {
            format: this.config.audioFormat,
            rate: this.config.sampleRate,
            channel: this.config.channels,
            bits: this.config.bitsPerSample,
            language: this.config.language
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
        session.onStateChange('connected');
        resolve(session);
      });
      
      ws.on('message', (data) => {
        this.handleMessage(session, data);
      });
      
      ws.on('error', (error) => {
        console.error(`ASR WebSocket错误 ${sessionId}:`, error);
        session.onError(error);
        this.sessions.delete(sessionId);
        reject(error);
      });
      
      ws.on('close', () => {
        console.log(`ASR WebSocket连接已关闭: ${sessionId}`);
        session.state = 'closed';
        session.onStateChange('closed');
        this.sessions.delete(sessionId);
      });
      
      // 连接超时处理
      setTimeout(() => {
        if (session.state === 'connecting') {
          console.error(`ASR连接超时: ${sessionId}`);
          ws.close();
          reject(new Error('ASR连接超时'));
        }
      }, 10000);
    });
  }

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
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else {
      console.warn('WebSocket不在开放状态，消息未发送');
    }
  }

  async processAudioFrame(sessionId, audioBuffer) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'connected') {
      throw new Error(`会话 ${sessionId} 未连接或不存在`);
    }
    
    // 将音频数据分包，每包约200ms（3200字节 for 16kHz 16bit mono）
    let offset = 0;
    
    while (offset < audioBuffer.length) {
      const chunk = audioBuffer.slice(offset, offset + this.config.chunkSize);
      const payload = {
        audio: chunk.toString('base64'),
        sequence: ++session.sequence
      };
      
      this.sendMessage(session.ws, payload, 'audio');
      offset += this.config.chunkSize;
      
      // 避免发送过快，保持合适的发送频率
      if (offset < audioBuffer.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

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
          // 实时识别结果
          session.onResult({
            text: response.result.text || '',
            confidence: response.result.confidence || 0.9,
            isFinal: false,
            timestamp: Date.now(),
            sessionId: session.sessionId
          });
        } else {
          // 最终识别结果
          session.onFinal({
            text: response.result.text || '',
            confidence: response.result.confidence || 0.9,
            isFinal: true,
            duration: response.result.duration || 0,
            sessionId: session.sessionId
          });
        }
      }
      
      if (response.error) {
        console.error(`ASR识别错误:`, response.error);
        session.onError(new Error(response.error.message || '识别失败'));
      }
    } catch (error) {
      console.error('解析ASR响应失败:', error);
      session.onError(error);
    }
  }

  async endStreamingRecognition(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`会话 ${sessionId} 不存在，无需结束`);
      return;
    }
    
    console.log(`结束ASR会话: ${sessionId}`);
    
    try {
      // 发送结束标记（负包）
      const endPayload = {
        sequence: -1 // 负包标记会话结束
      };
      
      this.sendMessage(session.ws, endPayload, 'audio');
      
      // 等待最终结果，然后关闭连接
      setTimeout(() => {
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.close();
        }
        this.sessions.delete(sessionId);
      }, 1000);
    } catch (error) {
      console.error(`结束ASR会话失败 ${sessionId}:`, error);
    }
  }

  async cancelStreamingRecognition(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    
    console.log(`取消ASR会话: ${sessionId}`);
    
    try {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.close();
      }
      this.sessions.delete(sessionId);
    } catch (error) {
      console.error(`取消ASR会话失败 ${sessionId}:`, error);
    }
  }

  async speechToText(audioFilePath) {
    // 简化实现，可以扩展为支持文件上传的方式
    throw new Error('文件识别功能需要扩展实现，建议使用流式识别');
  }

  async validateConfig() {
    try {
      const required = ['asrAccessToken', 'appId', 'asrSecretKey'];
      for (const field of required) {
        if (!this.config[field]) {
          console.error(`ASR配置缺失字段: ${field}`);
          return false;
        }
      }
      
      // 验证连接ID生成
      const connectId = this.generateConnectId();
      return connectId && connectId.length > 0;
    } catch (error) {
      console.error('ASR配置验证失败:', error);
      return false;
    }
  }

  async healthCheck() {
    try {
      // 简单的连接测试
      const connectId = this.generateConnectId();
      const wsOptions = {
        headers: {
          'X-Api-App-Key': this.config.appId,
          'X-Api-Access-Key': this.config.speechAccessToken,
          'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
          'X-Api-Connect-Id': connectId
        }
      };
      
      const testWs = new WebSocket(this.config.wsUrl, wsOptions);
      
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          testWs.close();
          resolve({
            status: 'unhealthy',
            provider: 'Volcengine ASR',
            error: '连接超时'
          });
        }, 5000);
        
        testWs.on('open', () => {
          clearTimeout(timeout);
          testWs.close();
          resolve({
            status: 'healthy',
            provider: 'Volcengine ASR',
            endpoint: this.config.wsUrl,
            mode: '双向流式'
          });
        });
        
        testWs.on('error', (error) => {
          clearTimeout(timeout);
          resolve({
            status: 'unhealthy',
            provider: 'Volcengine ASR',
            error: error.message
          });
        });
      });
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: 'Volcengine ASR',
        error: error.message
      };
    }
  }

  // 辅助方法
  generateConnectId() {
    // 生成UUID格式的连接ID
    return crypto.randomUUID();
  }
  
  generateReqId() {
    return crypto.randomBytes(16).toString('hex');
  }

  getProviderInfo() {
    return {
      name: 'Volcengine ASR',
      version: '1.0.0',
      mode: '双向流式（优化版本）',
      endpoint: this.config.wsUrl,
      optimalChunkSize: this.config.chunkSize,
      supportedFormats: [this.config.audioFormat],
      language: this.config.language
    };
  }
}

module.exports = VolcengineASRProvider;