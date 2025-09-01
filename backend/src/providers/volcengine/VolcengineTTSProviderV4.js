/**
 * 火山引擎TTS Provider V4 - 基于官方协议实现
 * 使用正确的V3 WSS双向流式接口
 * API端点: wss://openspeech.bytedance.com/api/v3/tts/bidirection
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const TTSProvider = require('../base/TTSProvider');

// 事件类型定义
const EventType = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFinished: 52,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  TaskRequest: 200,
};

// 消息类型定义
const MsgType = {
  FullClientRequest: 0b1,
  FullServerResponse: 0b1001,
  AudioOnlyServer: 0b1011,
};

// 消息标志定义
const MsgTypeFlagBits = {
  NoSeq: 0,
  WithEvent: 0b100,
};

// 序列化方法定义
const SerializationBits = {
  Raw: 0,
  JSON: 0b1,
};

class VolcengineTTSProviderV4 extends TTSProvider {
  constructor(config) {
    super(config);
    this.config = {
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      appId: config.speechAppId,
      speechAccessToken: config.speechAccessToken,
      speechSecretKey: config.speechSecretKey,
      ttsResourceId: config.ttsResourceId,
      ttsVoice: config.ttsVoice,
      wsUrl: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
      defaultVoice: config.ttsVoice || 'zh_female_shuangkuai_moon_bigtts',
      defaultEncoding: 'wav',
      defaultSpeed: 1.0,
      defaultVolume: 1.0,
      defaultPitch: 1.0,
      requestTimeout: 60000
    };
    this.sessions = new Map();
    this.messageQueues = new Map();
    this.messageCallbacks = new Map();
  }

  async initialize() {
    if (!this.config.speechAccessToken || !this.config.appId || !this.config.speechSecretKey || !this.config.ttsResourceId) {
      throw new Error('火山引擎TTS配置不完整：缺少Speech Access Token、Secret Key、App ID或TTS Resource ID');
    }
    
    console.log('Volcengine TTS Provider V4初始化成功');
    console.log('- WebSocket端点:', this.config.wsUrl);
    console.log('- App ID:', this.config.appId);
    console.log('- 默认音色:', this.config.defaultVoice);
  }

  // 创建消息
  createMessage(msgType, flag) {
    return {
      type: msgType,
      flag: flag,
      version: 1, // Version1
      headerSize: 1, // HeaderSize4 (4 bytes)
      serialization: SerializationBits.JSON,
      compression: 0, // None
      payload: new Uint8Array(0),
    };
  }

  // 序列化消息
  marshalMessage(msg) {
    const buffers = [];

    // 构建基础头部 (4 bytes)
    const headerSize = 4 * msg.headerSize;
    const header = new Uint8Array(headerSize);

    header[0] = (msg.version << 4) | msg.headerSize;
    header[1] = (msg.type << 4) | msg.flag;
    header[2] = (msg.serialization << 4) | msg.compression;
    header[3] = 0; // 保留字节

    buffers.push(header);

    // 写入事件类型 (如果有)
    if (msg.flag === MsgTypeFlagBits.WithEvent && msg.event !== undefined) {
      const eventBuffer = new ArrayBuffer(4);
      const eventView = new DataView(eventBuffer);
      eventView.setInt32(0, msg.event, false); // 大端序
      buffers.push(new Uint8Array(eventBuffer));
    }

    // 写入会话ID (如果有)
    if (msg.sessionId && this.needsSessionId(msg.event)) {
      const sessionIdBytes = Buffer.from(msg.sessionId, 'utf8');
      const sizeBuffer = new ArrayBuffer(4);
      const sizeView = new DataView(sizeBuffer);
      sizeView.setUint32(0, sessionIdBytes.length, false);

      const sessionIdBuffer = new Uint8Array(4 + sessionIdBytes.length);
      sessionIdBuffer.set(new Uint8Array(sizeBuffer), 0);
      sessionIdBuffer.set(sessionIdBytes, 4);
      buffers.push(sessionIdBuffer);
    }

    // 写入负载大小和负载
    const payloadSizeBuffer = new ArrayBuffer(4);
    const payloadSizeView = new DataView(payloadSizeBuffer);
    payloadSizeView.setUint32(0, msg.payload.length, false);

    const payloadBuffer = new Uint8Array(4 + msg.payload.length);
    payloadBuffer.set(new Uint8Array(payloadSizeBuffer), 0);
    payloadBuffer.set(msg.payload, 4);
    buffers.push(payloadBuffer);

    // 合并所有缓冲区
    const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const buf of buffers) {
      result.set(buf, offset);
      offset += buf.length;
    }

    return result;
  }

  // 检查是否需要会话ID
  needsSessionId(event) {
    return event && ![
      EventType.StartConnection,
      EventType.FinishConnection,
      EventType.ConnectionStarted,
      EventType.ConnectionFinished
    ].includes(event);
  }

  // 反序列化消息 - 基于官方实现
  unmarshalMessage(data) {
    if (data.length < 3) {
      throw new Error(`数据太短: 期望至少3字节，实际${data.length}字节`);
    }

    let offset = 0;

    // 读取基础头部
    const versionAndHeaderSize = data[offset++];
    const typeAndFlag = data[offset++];
    const serializationAndCompression = data[offset++];

    const msg = {
      version: (versionAndHeaderSize >> 4),
      headerSize: (versionAndHeaderSize & 0b00001111),
      type: (typeAndFlag >> 4),
      flag: (typeAndFlag & 0b00001111),
      serialization: (serializationAndCompression >> 4),
      compression: (serializationAndCompression & 0b00001111),
      payload: new Uint8Array(0),
    };

    // 跳过剩余头部字节
    offset = 4 * msg.headerSize;

    // 根据消息类型和标志读取字段
    const readers = this.getReaders(msg);
    for (const reader of readers) {
      offset = reader(msg, data, offset);
    }

    return msg;
  }

  // 获取读取器列表
  getReaders(msg) {
    const readers = [];

    switch (msg.type) {
      case MsgType.AudioOnlyServer:
      case MsgType.FullServerResponse:
        if (msg.flag === 0b001 || msg.flag === 0b011) { // PositiveSeq || NegativeSeq
          readers.push(this.readSequence.bind(this));
        }
        break;
    }

    if (msg.flag === MsgTypeFlagBits.WithEvent) {
      readers.push(this.readEvent.bind(this));
      readers.push(this.readSessionId.bind(this));
      readers.push(this.readConnectId.bind(this));
    }

    readers.push(this.readPayload.bind(this));
    return readers;
  }

  // 读取器函数
  readEvent(msg, data, offset) {
    if (offset + 4 > data.length) {
      throw new Error('insufficient data for event');
    }
    const view = new DataView(data.buffer, data.byteOffset + offset, 4);
    msg.event = view.getInt32(0, false);
    return offset + 4;
  }

  readSessionId(msg, data, offset) {
    if (msg.event === undefined) return offset;

    switch (msg.event) {
      case EventType.StartConnection:
      case EventType.FinishConnection:
      case EventType.ConnectionStarted:
      case EventType.ConnectionFinished:
        return offset;
    }

    if (offset + 4 > data.length) {
      throw new Error('insufficient data for session ID size');
    }

    const view = new DataView(data.buffer, data.byteOffset + offset, 4);
    const size = view.getUint32(0, false);
    offset += 4;

    if (size > 0) {
      if (offset + size > data.length) {
        throw new Error('insufficient data for session ID');
      }
      msg.sessionId = new TextDecoder().decode(data.slice(offset, offset + size));
      offset += size;
    }

    return offset;
  }

  readConnectId(msg, data, offset) {
    if (msg.event === undefined) return offset;

    switch (msg.event) {
      case EventType.ConnectionStarted:
      case EventType.ConnectionFinished:
        break;
      default:
        return offset;
    }

    if (offset + 4 > data.length) {
      throw new Error('insufficient data for connect ID size');
    }

    const view = new DataView(data.buffer, data.byteOffset + offset, 4);
    const size = view.getUint32(0, false);
    offset += 4;

    if (size > 0) {
      if (offset + size > data.length) {
        throw new Error('insufficient data for connect ID');
      }
      msg.connectId = new TextDecoder().decode(data.slice(offset, offset + size));
      offset += size;
    }

    return offset;
  }

  readSequence(msg, data, offset) {
    if (offset + 4 > data.length) {
      throw new Error('insufficient data for sequence');
    }
    const view = new DataView(data.buffer, data.byteOffset + offset, 4);
    msg.sequence = view.getInt32(0, false);
    return offset + 4;
  }

  readPayload(msg, data, offset) {
    if (offset + 4 > data.length) {
      throw new Error('insufficient data for payload size');
    }

    const view = new DataView(data.buffer, data.byteOffset + offset, 4);
    const size = view.getUint32(0, false);
    offset += 4;

    if (size > 0) {
      if (offset + size > data.length) {
        throw new Error('insufficient data for payload');
      }
      msg.payload = data.slice(offset, offset + size);
      offset += size;
    }

    return offset;
  }

  // 设置消息处理器
  setupMessageHandler(ws) {
    if (!this.messageQueues.has(ws)) {
      this.messageQueues.set(ws, []);
      this.messageCallbacks.set(ws, []);

      ws.on('message', (data) => {
        try {
          let uint8Data = new Uint8Array(data);
          const msg = this.unmarshalMessage(uint8Data);
          
          const queue = this.messageQueues.get(ws);
          const callbacks = this.messageCallbacks.get(ws);

          if (callbacks.length > 0) {
            const callback = callbacks.shift();
            callback(msg);
          } else {
            queue.push(msg);
          }
        } catch (error) {
          console.error('处理消息时出错:', error);
        }
      });

      ws.on('close', () => {
        this.messageQueues.delete(ws);
        this.messageCallbacks.delete(ws);
      });
    }
  }

  // 接收消息
  async receiveMessage(ws) {
    this.setupMessageHandler(ws);

    return new Promise((resolve, reject) => {
      const queue = this.messageQueues.get(ws);
      const callbacks = this.messageCallbacks.get(ws);

      if (queue.length > 0) {
        resolve(queue.shift());
        return;
      }

      const errorHandler = (error) => {
        const index = callbacks.findIndex((cb) => cb === resolver);
        if (index !== -1) {
          callbacks.splice(index, 1);
        }
        reject(error);
      };

      const resolver = (msg) => {
        ws.removeListener('error', errorHandler);
        resolve(msg);
      };

      callbacks.push(resolver);
      ws.once('error', errorHandler);
    });
  }

  // 等待特定事件
  async waitForEvent(ws, msgType, eventType) {
    const msg = await this.receiveMessage(ws);
    if (msg.type !== msgType || msg.event !== eventType) {
      throw new Error(`意外消息: type=${msg.type}, event=${msg.event}`);
    }
    return msg;
  }

  // 发送消息
  async sendMessage(ws, msg) {
    const data = this.marshalMessage(msg);
    return new Promise((resolve, reject) => {
      ws.send(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  // 启动连接
  async startConnection(ws) {
    const msg = this.createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
    msg.event = EventType.StartConnection;
    msg.payload = new TextEncoder().encode('{}');
    console.log('发送StartConnection');
    await this.sendMessage(ws, msg);
  }

  // 启动会话
  async startSession(ws, sessionId, requestPayload) {
    const msg = this.createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
    msg.event = EventType.StartSession;
    msg.sessionId = sessionId;
    msg.payload = requestPayload;
    console.log('发送StartSession, sessionId:', sessionId);
    await this.sendMessage(ws, msg);
  }

  // 任务请求
  async taskRequest(ws, sessionId, requestPayload) {
    const msg = this.createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
    msg.event = EventType.TaskRequest;
    msg.sessionId = sessionId;
    msg.payload = requestPayload;
    await this.sendMessage(ws, msg);
  }

  // 完成会话
  async finishSession(ws, sessionId) {
    const msg = this.createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
    msg.event = EventType.FinishSession;
    msg.sessionId = sessionId;
    msg.payload = new TextEncoder().encode('{}');
    console.log('发送FinishSession, sessionId:', sessionId);
    await this.sendMessage(ws, msg);
  }

  // 完成连接
  async finishConnection(ws) {
    const msg = this.createMessage(MsgType.FullClientRequest, MsgTypeFlagBits.WithEvent);
    msg.event = EventType.FinishConnection;
    msg.payload = new TextEncoder().encode('{}');
    console.log('发送FinishConnection');
    await this.sendMessage(ws, msg);
  }

  async textToSpeech(text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error('文本内容不能为空');
    }

    console.log(`开始TTS合成，文本长度: ${text.length}`);

    return new Promise(async (resolve, reject) => {
      try {
        const connectId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();

        const wsOptions = {
          headers: {
            'X-Api-App-Key': this.config.appId,
            'X-Api-Access-Key': this.config.speechAccessToken,
            'X-Api-Resource-Id': this.config.ttsResourceId,
            'X-Api-Connect-Id': connectId
          },
          skipUTF8Validation: true,
        };

        const ws = new WebSocket(this.config.wsUrl, wsOptions);

        // 等待连接建立
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', reject);
        });

        console.log('WebSocket连接建立');

        try {
          // 1. 启动连接
          await this.startConnection(ws);
          await this.waitForEvent(ws, MsgType.FullServerResponse, EventType.ConnectionStarted);
          console.log('连接已启动');

          // 2. 启动会话
          const requestTemplate = {
            user: {
              uid: crypto.randomUUID(),
            },
            req_params: {
              speaker: options.voiceType || this.config.defaultVoice,
              audio_params: {
                format: options.encoding || this.config.defaultEncoding,
                sample_rate: 16000,
                enable_timestamp: true,
              },
              additions: JSON.stringify({
                disable_markdown_filter: false,
              }),
            },
            event: EventType.StartSession,
          };

          const sessionPayload = new TextEncoder().encode(JSON.stringify(requestTemplate));
          await this.startSession(ws, sessionId, sessionPayload);
          await this.waitForEvent(ws, MsgType.FullServerResponse, EventType.SessionStarted);
          console.log('会话已启动');

          // 3. 发送文本（逐字发送）
          for (const char of text) {
            const taskPayload = {
              ...requestTemplate,
              req_params: {
                ...requestTemplate.req_params,
                text: char,
              },
              event: EventType.TaskRequest,
            };

            const taskPayloadBytes = new TextEncoder().encode(JSON.stringify(taskPayload));
            await this.taskRequest(ws, sessionId, taskPayloadBytes);
          }

          console.log('文本发送完成');

          // 4. 完成会话
          await this.finishSession(ws, sessionId);

          // 5. 收集音频数据
          const audioChunks = [];
          let audioReceived = false;

          while (true) {
            const msg = await this.receiveMessage(ws);
            
            console.log(`收到消息: type=${msg.type}, event=${msg.event}, payloadSize=${msg.payload.length}`);

            if (msg.type === MsgType.FullServerResponse) {
              // JSON响应
              if (msg.payload.length > 0) {
                const response = JSON.parse(new TextDecoder().decode(msg.payload));
                console.log('JSON响应:', response);
              }
            } else if (msg.type === MsgType.AudioOnlyServer) {
              // 音频数据
              if (!audioReceived && audioChunks.length > 0) {
                audioReceived = true;
              }
              audioChunks.push(msg.payload);
              console.log(`收到音频块: ${msg.payload.length} bytes, 总块数: ${audioChunks.length}`);
            }

            if (msg.event === EventType.SessionFinished) {
              console.log('会话完成');
              break;
            }
          }

          // 6. 完成连接
          await this.finishConnection(ws);
          await this.waitForEvent(ws, MsgType.FullServerResponse, EventType.ConnectionFinished);
          console.log('连接完成');

          if (audioChunks.length === 0) {
            throw new Error('未收到音频数据');
          }

          // 合并音频数据
          const combinedAudio = Buffer.concat(audioChunks.map(chunk => Buffer.from(chunk)));
          const duration = text.length * 0.5; // 估算时长

          console.log(`TTS合成成功: 音频大小 ${combinedAudio.length} bytes`);

          resolve({
            audioBuffer: combinedAudio,
            format: options.encoding || this.config.defaultEncoding,
            sampleRate: 16000,
            duration: duration,
            chunks: audioChunks.length,
          });

        } catch (error) {
          console.error('TTS处理错误:', error);
          reject(error);
        } finally {
          ws.close();
        }

      } catch (error) {
        console.error('TTS连接错误:', error);
        reject(error);
      }
    });
  }

  async streamTextToSpeech(text, options = {}) {
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
      const required = ['speechAccessToken', 'appId', 'speechSecretKey'];
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
      
      const result = await this.textToSpeech('测试', { 
        userId: 'health_check',
        voiceType: this.config.defaultVoice
      });
      
      return {
        status: 'healthy',
        provider: 'Volcengine TTS V4',
        endpoint: this.config.wsUrl,
        voiceType: this.config.defaultVoice,
        testAudioSize: result.audioBuffer.length,
        estimatedDuration: result.duration
      };
    } catch (error) {
      console.error('TTS健康检查失败:', error);
      return {
        status: 'unhealthy',
        provider: 'Volcengine TTS V4',
        error: error.message
      };
    }
  }

  getProviderInfo() {
    return {
      name: 'Volcengine TTS V4',
      version: '4.0.0',
      endpoint: this.config.wsUrl,
      supportedVoices: this.getSupportedVoices().length,
      supportedFormats: this.getSupportedFormats(),
      streamingSupport: true
    };
  }
}

module.exports = VolcengineTTSProviderV4;