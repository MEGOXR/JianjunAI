/**
 * 火山引擎TTS Provider Final - 基于工作的协议实现
 * 使用V3 WSS双向流式接口
 * API端点: wss://openspeech.bytedance.com/api/v3/tts/bidirection
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const TTSProvider = require('../base/TTSProvider');

// 事件类型
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

// 消息类型
const MsgType = {
  FullClientRequest: 1,
  FullServerResponse: 9,
  AudioOnlyServer: 11,
  Error: 15,
};

class VolcengineTTSProviderFinal extends TTSProvider {
  constructor(config) {
    super(config);
    this.config = {
      appId: config.speechAppId,
      speechAccessToken: config.speechAccessToken,
      speechSecretKey: config.speechSecretKey,
      ttsResourceId: config.ttsResourceId,
      ttsVoice: config.ttsVoice,
      wsUrl: process.env.VOLCENGINE_TTS_WEBSOCKET_URL || 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
      defaultVoice: config.ttsVoice || 'zh_female_shuangkuai_moon_bigtts',
      defaultEncoding: 'pcm',
      requestTimeout: 60000
    };
  }

  async initialize() {
    if (!this.config.speechAccessToken || !this.config.appId || !this.config.speechSecretKey || !this.config.ttsResourceId) {
      throw new Error('火山引擎TTS配置不完整：缺少Speech Access Token、Secret Key、App ID或TTS Resource ID');
    }
    
    console.log('Volcengine TTS Provider Final初始化成功');
    console.log('- WebSocket端点:', this.config.wsUrl);
    console.log('- App ID:', this.config.appId);
    console.log('- 默认音色:', this.config.defaultVoice);
  }

  // 消息序列化
  marshalMessage(msg) {
    const buffers = [];

    // 4字节头部
    const header = new Uint8Array(4);
    header[0] = (msg.version << 4) | msg.headerSize;
    header[1] = (msg.type << 4) | msg.flag;
    header[2] = (msg.serialization << 4) | msg.compression;
    header[3] = 0;
    buffers.push(header);

    // 事件类型（如果有）
    if (msg.flag === 4 && msg.event !== undefined) { // WithEvent
      const eventBuffer = new ArrayBuffer(4);
      const eventView = new DataView(eventBuffer);
      eventView.setInt32(0, msg.event, false);
      buffers.push(new Uint8Array(eventBuffer));
    }

    // 会话ID（如果需要）
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

    // 负载大小和负载
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

  needsSessionId(event) {
    return event && ![
      EventType.StartConnection,
      EventType.FinishConnection,
      EventType.ConnectionStarted,
      EventType.ConnectionFinished
    ].includes(event);
  }

  // 消息反序列化
  unmarshalMessage(data) {
    if (data.length < 3) {
      throw new Error(`数据太短: ${data.length}`);
    }

    let offset = 0;

    const versionAndHeaderSize = data[offset++];
    const typeAndFlag = data[offset++];
    const serializationAndCompression = data[offset++];

    const msg = {
      version: versionAndHeaderSize >> 4,
      headerSize: versionAndHeaderSize & 0x0F,
      type: typeAndFlag >> 4,
      flag: typeAndFlag & 0x0F,
      serialization: serializationAndCompression >> 4,
      compression: serializationAndCompression & 0x0F,
      payload: new Uint8Array(0),
    };

    offset = 4 * msg.headerSize;

    // 读取事件
    if (msg.flag === 4) { // WithEvent
      const eventView = new DataView(data.buffer, data.byteOffset + offset, 4);
      msg.event = eventView.getInt32(0, false);
      offset += 4;
    }

    // 读取会话ID
    if (msg.event && this.needsSessionId(msg.event)) {
      const sizeView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const size = sizeView.getUint32(0, false);
      offset += 4;

      if (size > 0) {
        msg.sessionId = new TextDecoder().decode(data.slice(offset, offset + size));
        offset += size;
      }
    }

    // 读取连接ID（如果需要）
    if (msg.event && [EventType.ConnectionStarted, EventType.ConnectionFinished].includes(msg.event)) {
      const sizeView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const size = sizeView.getUint32(0, false);
      offset += 4;

      if (size > 0) {
        msg.connectId = new TextDecoder().decode(data.slice(offset, offset + size));
        offset += size;
      }
    }

    // 读取负载
    if (offset + 4 <= data.length) {
      const payloadSizeView = new DataView(data.buffer, data.byteOffset + offset, 4);
      const payloadSize = payloadSizeView.getUint32(0, false);
      offset += 4;

      if (payloadSize > 0 && offset + payloadSize <= data.length) {
        msg.payload = data.slice(offset, offset + payloadSize);
      }
    }

    return msg;
  }

  // 消息处理
  setupMessageHandler(ws) {
    if (!ws._messageQueue) {
      ws._messageQueue = [];
      ws._messageCallbacks = [];

      ws.on('message', (data) => {
        try {
          const msg = this.unmarshalMessage(new Uint8Array(data));
          
          if (ws._messageCallbacks.length > 0) {
            const callback = ws._messageCallbacks.shift();
            callback(msg);
          } else {
            ws._messageQueue.push(msg);
          }
        } catch (error) {
          console.error('处理消息时出错:', error);
        }
      });
    }
  }

  async receiveMessage(ws) {
    this.setupMessageHandler(ws);

    return new Promise((resolve) => {
      if (ws._messageQueue.length > 0) {
        resolve(ws._messageQueue.shift());
        return;
      }

      ws._messageCallbacks.push(resolve);
    });
  }

  async textToSpeech(text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error('文本内容不能为空');
    }

    console.log(`开始TTS合成，文本: "${text}"`);

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TTS合成超时'));
      }, this.config.requestTimeout);

      try {
        const connectId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();

        const headers = {
          'X-Api-App-Key': this.config.appId,
          'X-Api-Access-Key': this.config.speechAccessToken,
          'X-Api-Resource-Id': this.config.ttsResourceId,
          'X-Api-Connect-Id': connectId,
        };

        const ws = new WebSocket(this.config.wsUrl, {
          headers,
          skipUTF8Validation: true,
        });

        // 等待连接建立
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', reject);
        });
        console.log('WebSocket连接建立');

        try {
          // 1. 启动连接
          const startConnMsg = {
            version: 1,
            headerSize: 1,
            type: MsgType.FullClientRequest,
            flag: 4, // WithEvent
            serialization: 1, // JSON
            compression: 0,
            event: EventType.StartConnection,
            payload: new TextEncoder().encode('{}')
          };

          ws.send(this.marshalMessage(startConnMsg));
          console.log('发送StartConnection');

          const connStartedMsg = await this.receiveMessage(ws);
          if (connStartedMsg.event !== EventType.ConnectionStarted) {
            throw new Error(`期望ConnectionStarted，收到: ${connStartedMsg.event}`);
          }
          console.log('收到ConnectionStarted');

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

          const startSessionMsg = {
            version: 1,
            headerSize: 1,
            type: MsgType.FullClientRequest,
            flag: 4, // WithEvent
            serialization: 1, // JSON
            compression: 0,
            event: EventType.StartSession,
            sessionId: sessionId,
            payload: new TextEncoder().encode(JSON.stringify(requestTemplate))
          };

          ws.send(this.marshalMessage(startSessionMsg));
          console.log('发送StartSession');

          const sessionStartedMsg = await this.receiveMessage(ws);
          if (sessionStartedMsg.event !== EventType.SessionStarted) {
            throw new Error(`期望SessionStarted，收到: ${sessionStartedMsg.event}`);
          }
          console.log('收到SessionStarted');

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

            const taskMsg = {
              version: 1,
              headerSize: 1,
              type: MsgType.FullClientRequest,
              flag: 4, // WithEvent
              serialization: 1, // JSON
              compression: 0,
              event: EventType.TaskRequest,
              sessionId: sessionId,
              payload: new TextEncoder().encode(JSON.stringify(taskPayload))
            };

            ws.send(this.marshalMessage(taskMsg));
          }
          console.log('文本发送完成');

          // 4. 完成会话
          const finishSessionMsg = {
            version: 1,
            headerSize: 1,
            type: MsgType.FullClientRequest,
            flag: 4, // WithEvent
            serialization: 1, // JSON
            compression: 0,
            event: EventType.FinishSession,
            sessionId: sessionId,
            payload: new TextEncoder().encode('{}')
          };

          ws.send(this.marshalMessage(finishSessionMsg));
          console.log('发送FinishSession');

          // 5. 收集音频数据
          const audioChunks = [];

          while (true) {
            const msg = await this.receiveMessage(ws);
            console.log(`收到消息: type=${msg.type}, event=${msg.event || 'undefined'}, payloadSize=${msg.payload.length}`);

            if (msg.type === MsgType.FullServerResponse) {
              // JSON响应
              if (msg.payload && msg.payload.length > 0) {
                try {
                  const response = JSON.parse(new TextDecoder().decode(msg.payload));
                  console.log('JSON响应:', response);
                } catch (e) {
                  console.log('无法解析JSON响应');
                }
              }
            } else if (msg.type === MsgType.AudioOnlyServer) {
              // 音频数据
              audioChunks.push(msg.payload);
              console.log(`收到音频块: ${msg.payload.length} bytes, 总块数: ${audioChunks.length}`);
            } else if (msg.type === MsgType.Error) {
              // 错误消息
              if (msg.payload && msg.payload.length > 0) {
                const errorMsg = new TextDecoder().decode(msg.payload);
                console.error('服务器错误:', errorMsg);
                throw new Error(`服务器错误: ${errorMsg}`);
              }
            }

            if (msg.event === EventType.SessionFinished) {
              console.log('会话完成');
              break;
            }
          }

          // 6. 完成连接
          const finishConnMsg = {
            version: 1,
            headerSize: 1,
            type: MsgType.FullClientRequest,
            flag: 4, // WithEvent
            serialization: 1, // JSON
            compression: 0,
            event: EventType.FinishConnection,
            payload: new TextEncoder().encode('{}')
          };

          ws.send(this.marshalMessage(finishConnMsg));
          console.log('发送FinishConnection');

          const connFinishedMsg = await this.receiveMessage(ws);
          if (connFinishedMsg.event === EventType.ConnectionFinished) {
            console.log('连接完成');
          }

          if (audioChunks.length === 0) {
            throw new Error('未收到音频数据');
          }

          // 合并音频数据
          const combinedAudio = Buffer.concat(audioChunks.map(chunk => Buffer.from(chunk)));
          const duration = text.length * 0.5;

          console.log(`TTS合成成功: 音频大小 ${combinedAudio.length} bytes`);

          clearTimeout(timeout);
          resolve({
            audioBuffer: combinedAudio,
            format: options.encoding || this.config.defaultEncoding,
            sampleRate: 16000,
            duration: duration,
            chunks: audioChunks.length,
          });

        } catch (error) {
          console.error('TTS处理错误:', error);
          clearTimeout(timeout);
          reject(error);
        } finally {
          ws.close();
        }

      } catch (error) {
        console.error('TTS连接错误:', error);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async streamTextToSpeech(text, options = {}) {
    // 获取完整的音频数据
    const result = await this.textToSpeech(text, options);
    
    // 如果有onChunk回调，将整个音频作为一个块发送
    if (options.onChunk && typeof options.onChunk === 'function') {
      options.onChunk({
        audioBuffer: result.audioBuffer,
        format: result.format
      });
    }
    
    return result;
  }

  async streamTextToSpeechReal(text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error('文本内容不能为空');
    }

    console.log(`开始真正的流式TTS合成，文本: "${text}"`);

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('TTS合成超时'));
      }, this.config.requestTimeout);

      try {
        const connectId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();

        const headers = {
          'X-Api-App-Key': this.config.appId,
          'X-Api-Access-Key': this.config.speechAccessToken,
          'X-Api-Resource-Id': this.config.ttsResourceId,
          'X-Api-Connect-Id': connectId,
        };

        const ws = new WebSocket(this.config.wsUrl, {
          headers,
          skipUTF8Validation: true,
        });

        // 等待连接建立
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', reject);
        });
        console.log('WebSocket连接建立');

        try {
          // 1. 启动连接
          const startConnMsg = {
            version: 1,
            headerSize: 1,
            type: MsgType.FullClientRequest,
            flag: 4, // WithEvent
            serialization: 1, // JSON
            compression: 0,
            event: EventType.StartConnection,
            payload: new TextEncoder().encode('{}')
          };

          ws.send(this.marshalMessage(startConnMsg));
          console.log('发送StartConnection');

          const connStartedMsg = await this.receiveMessage(ws);
          if (connStartedMsg.event !== EventType.ConnectionStarted) {
            throw new Error(`期望ConnectionStarted，收到: ${connStartedMsg.event}`);
          }
          console.log('收到ConnectionStarted');

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

          const startSessionMsg = {
            version: 1,
            headerSize: 1,
            type: MsgType.FullClientRequest,
            flag: 4, // WithEvent
            serialization: 1, // JSON
            compression: 0,
            event: EventType.StartSession,
            sessionId: sessionId,
            payload: new TextEncoder().encode(JSON.stringify(requestTemplate))
          };

          ws.send(this.marshalMessage(startSessionMsg));
          console.log('发送StartSession');

          const sessionStartedMsg = await this.receiveMessage(ws);
          if (sessionStartedMsg.event !== EventType.SessionStarted) {
            throw new Error(`期望SessionStarted，收到: ${sessionStartedMsg.event}`);
          }
          console.log('收到SessionStarted');

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

            const taskMsg = {
              version: 1,
              headerSize: 1,
              type: MsgType.FullClientRequest,
              flag: 4, // WithEvent
              serialization: 1, // JSON
              compression: 0,
              event: EventType.TaskRequest,
              sessionId: sessionId,
              payload: new TextEncoder().encode(JSON.stringify(taskPayload))
            };

            ws.send(this.marshalMessage(taskMsg));
          }
          console.log('文本发送完成');

          // 4. 完成会话
          const finishSessionMsg = {
            version: 1,
            headerSize: 1,
            type: MsgType.FullClientRequest,
            flag: 4, // WithEvent
            serialization: 1, // JSON
            compression: 0,
            event: EventType.FinishSession,
            sessionId: sessionId,
            payload: new TextEncoder().encode('{}')
          };

          ws.send(this.marshalMessage(finishSessionMsg));
          console.log('发送FinishSession');

          // 5. 收集音频数据并实时回调
          const audioChunks = [];
          let chunkIndex = 0;

          while (true) {
            const msg = await this.receiveMessage(ws);
            console.log(`收到消息: type=${msg.type}, event=${msg.event || 'undefined'}, payloadSize=${msg.payload.length}`);

            if (msg.type === MsgType.FullServerResponse) {
              // JSON响应
              if (msg.payload && msg.payload.length > 0) {
                try {
                  const response = JSON.parse(new TextDecoder().decode(msg.payload));
                  console.log('JSON响应:', response);
                } catch (e) {
                  console.log('无法解析JSON响应');
                }
              }
            } else if (msg.type === MsgType.AudioOnlyServer) {
              // 音频数据 - 立即回调
              const audioBuffer = Buffer.from(msg.payload);
              audioChunks.push(audioBuffer);
              
              console.log(`收到音频块: ${audioBuffer.length} bytes, 块编号: ${chunkIndex + 1}`);
              
              // 立即调用回调函数
              if (options.onChunk && typeof options.onChunk === 'function') {
                options.onChunk({
                  audioBuffer: audioBuffer,
                  format: options.encoding || this.config.defaultEncoding
                }, chunkIndex);
              }
              
              chunkIndex++;
            } else if (msg.type === MsgType.Error) {
              // 错误消息
              if (msg.payload && msg.payload.length > 0) {
                const errorMsg = new TextDecoder().decode(msg.payload);
                console.error('服务器错误:', errorMsg);
                throw new Error(`服务器错误: ${errorMsg}`);
              }
            }

            if (msg.event === EventType.SessionFinished) {
              console.log('会话完成');
              break;
            }
          }

          // 6. 完成连接
          const finishConnMsg = {
            version: 1,
            headerSize: 1,
            type: MsgType.FullClientRequest,
            flag: 4, // WithEvent
            serialization: 1, // JSON
            compression: 0,
            event: EventType.FinishConnection,
            payload: new TextEncoder().encode('{}')
          };

          ws.send(this.marshalMessage(finishConnMsg));
          console.log('发送FinishConnection');

          const connFinishedMsg = await this.receiveMessage(ws);
          if (connFinishedMsg.event === EventType.ConnectionFinished) {
            console.log('连接完成');
          }

          if (audioChunks.length === 0) {
            throw new Error('未收到音频数据');
          }

          // 合并音频数据
          const combinedAudio = Buffer.concat(audioChunks);
          const duration = text.length * 0.5;

          console.log(`流式TTS合成成功: 总音频块数 ${audioChunks.length}, 总大小 ${combinedAudio.length} bytes`);

          clearTimeout(timeout);
          resolve({
            audioBuffer: combinedAudio,
            format: options.encoding || this.config.defaultEncoding,
            sampleRate: 16000,
            duration: duration,
            chunks: audioChunks.length,
          });

        } catch (error) {
          console.error('TTS处理错误:', error);
          clearTimeout(timeout);
          reject(error);
        } finally {
          ws.close();
        }

      } catch (error) {
        console.error('TTS连接错误:', error);
        clearTimeout(timeout);
        reject(error);
      }
    });
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
    return ['pcm', 'wav', 'mp3'];
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
        provider: 'Volcengine TTS Final',
        endpoint: this.config.wsUrl,
        voiceType: this.config.defaultVoice,
        testAudioSize: result.audioBuffer.length,
        estimatedDuration: result.duration
      };
    } catch (error) {
      console.error('TTS健康检查失败:', error);
      return {
        status: 'unhealthy',
        provider: 'Volcengine TTS Final',
        error: error.message
      };
    }
  }

  getProviderInfo() {
    return {
      name: 'Volcengine TTS Final',
      version: 'Final-1.0.0',
      endpoint: this.config.wsUrl,
      supportedVoices: this.getSupportedVoices().length,
      supportedFormats: this.getSupportedFormats(),
      streamingSupport: true
    };
  }
}

module.exports = VolcengineTTSProviderFinal;