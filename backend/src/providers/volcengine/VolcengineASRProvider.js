/**
 * 火山引擎ASR Provider实现
 * 使用双向流式模式（优化版本）Binary Protocol
 * API端点: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
 * 特点：性能优化，只在结果变化时返回数据包，RTF和延迟均有提升
 * 协议：Binary WebSocket Protocol with 4-byte headers
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const zlib = require('zlib');
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
      wsUrl: config.asrEndpoint || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      // Binary protocol 配置 - 修正为实际发送的格式
      audioFormat: 'pcm', // 前端发送的是原始PCM数据，不是WAV文件
      codec: 'raw', // pcm
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      chunkSize: 3200, // 200ms音频数据，获得最佳性能
      language: 'zh-CN',
      // Binary protocol constants
      PROTOCOL_VERSION: 0b0001,
      HEADER_SIZE: 0b0001, // 4 bytes
      MSG_FULL_CLIENT_REQUEST: 0b0001,
      MSG_AUDIO_ONLY_REQUEST: 0b0010,
      MSG_FULL_SERVER_RESPONSE: 0b1001,
      MSG_ERROR_RESPONSE: 0b1111,
      SERIALIZATION_JSON: 0b0001,
      SERIALIZATION_NONE: 0b0000,
      COMPRESSION_NONE: 0b0000,
      COMPRESSION_GZIP: 0b0001
    };
    
    console.log('火山引擎ASR Binary Protocol配置:', {
      appId: this.config.appId,
      wsUrl: this.config.wsUrl,
      hasAccessToken: !!this.config.speechAccessToken,
      hasSecretKey: !!this.config.speechSecretKey,
      protocol: 'Binary WebSocket'
    });
    this.sessions = new Map(); // 管理多个会话
  }

  async initialize() {
    // 验证配置 - 使用正确的字段名
    if (!this.config.speechAccessToken || !this.config.appId || !this.config.speechSecretKey) {
      throw new Error('火山引擎ASR配置不完整：缺少Speech Access Token、Secret Key或App ID');
    }
    
    console.log('Volcengine ASR Provider初始化成功');
    console.log('- WebSocket端点:', this.config.wsUrl);
    console.log('- App ID:', this.config.appId);
    console.log('- 双向流式模式（优化版本）已启用 - RTF和延迟优化');
  }

  // Binary protocol helper methods
  buildBinaryHeader(messageType, flags = 0b0000, serialization = this.config.SERIALIZATION_JSON, compression = this.config.COMPRESSION_NONE) {
    const header = Buffer.alloc(4);
    
    // Byte 0: Protocol version (4 bits) + Header size (4 bits)
    header[0] = (this.config.PROTOCOL_VERSION << 4) | this.config.HEADER_SIZE;
    
    // Byte 1: Message type (4 bits) + Message type specific flags (4 bits)  
    header[1] = (messageType << 4) | flags;
    
    // Byte 2: Message serialization (4 bits) + Message compression (4 bits)
    header[2] = (serialization << 4) | compression;
    
    // Byte 3: Reserved
    header[3] = 0x00;
    
    return header;
  }

  async buildFullClientRequest(sessionId, useCompression = false) {
    // 构建符合文档要求的payload
    const payload = {
      user: {
        uid: sessionId
      },
      audio: {
        format: this.config.audioFormat,
        codec: this.config.codec,
        rate: this.config.sampleRate,
        bits: this.config.bitsPerSample,
        channel: this.config.channels
        // language参数只在bigmodel_nostream模式支持，我们使用bigmodel_async不需要这个参数
      },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        enable_ddc: false,
        result_type: "full"
      }
    };

    console.log('构建的payload内容:', JSON.stringify(payload, null, 2));

    let payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
    let compression = this.config.COMPRESSION_NONE;
    
    if (useCompression) {
      payloadBuffer = zlib.gzipSync(payloadBuffer);
      compression = this.config.COMPRESSION_GZIP;
    }

    // Full Client Request不应该包含sequence number，flags应该是0b0000
    const header = this.buildBinaryHeader(
      this.config.MSG_FULL_CLIENT_REQUEST,
      0b0000, // 不包含sequence number
      this.config.SERIALIZATION_JSON,
      compression
    );

    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(payloadBuffer.length, 0);

    console.log('构建Full Client Request:', {
      headerHex: header.toString('hex'),
      payloadSizeHex: payloadSize.toString('hex'),
      payloadSize: payloadBuffer.length,
      totalSize: 4 + 4 + payloadBuffer.length
    });

    return Buffer.concat([header, payloadSize, payloadBuffer]);
  }

  buildAudioOnlyRequest(audioData, sequence, isLastPacket = false, useCompression = false) {
    let payloadBuffer = Buffer.from(audioData);
    let compression = this.config.COMPRESSION_NONE;
    
    if (useCompression) {
      payloadBuffer = zlib.gzipSync(payloadBuffer);
      compression = this.config.COMPRESSION_GZIP;
    }

    // 先尝试不包含sequence number，让服务器自动分配
    let flags = 0b0000; // 不包含sequence number
    if (isLastPacket) {
      flags = 0b0010; // 最后一包标记，但不包含sequence number
    }

    const header = this.buildBinaryHeader(
      this.config.MSG_AUDIO_ONLY_REQUEST,
      flags,
      this.config.SERIALIZATION_NONE,
      compression
    );
    
    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(payloadBuffer.length, 0);

    console.log('构建Audio Only Request:', {
      sequence: sequence,
      isLastPacket: isLastPacket,
      flags: flags.toString(2).padStart(4, '0'),
      headerHex: header.toString('hex'),
      payloadSizeHex: payloadSize.toString('hex'),
      payloadSize: payloadBuffer.length,
      audioDataFirst16: audioData.slice(0, 16).toString('hex')
    });

    // 使用简化格式: Header + Payload Size + Payload (不包含sequence number)
    return Buffer.concat([header, payloadSize, payloadBuffer]);
  }

  async startStreamingRecognition(sessionId, options = {}) {
    console.log(`启动火山引擎ASR会话 (Binary Protocol): ${sessionId}`);
    
    // 生成连接ID（UUID格式）
    const connectId = this.generateConnectId();
    
    // 设置WebSocket连接的HTTP请求头进行认证（Binary Protocol）
    const wsOptions = {
      headers: {
        'X-Api-App-Key': this.config.appId,
        'X-Api-Access-Key': this.config.speechAccessToken,
        'X-Api-Resource-Id': 'volc.bigasr.sauc.duration', // 小时版资源ID
        'X-Api-Connect-Id': connectId
      }
    };
    
    console.log('WebSocket连接选项:', wsOptions);
    
    const ws = new WebSocket(this.config.wsUrl, wsOptions);
    const session = {
      ws,
      sessionId,
      state: 'connecting',
      buffer: [],
      sequence: 1, // 开始序号为1，因为Full Client Request算作第一个消息
      startTime: Date.now(),
      onResult: options.onResult || (() => {}),
      onFinal: options.onFinal || (() => {}),
      onError: options.onError || (() => {}),
      onStateChange: options.onStateChange || (() => {})
    };
    
    this.sessions.set(sessionId, session);
    console.log(`✅ 创建ASR会话: ${sessionId}, 当前会话数: ${this.sessions.size}`);
    
    return new Promise((resolve, reject) => {
      ws.on('open', async () => {
        console.log(`ASR WebSocket连接已建立 (Binary Protocol): ${sessionId}`);
        console.log('发送Binary Full Client Request，App ID:', this.config.appId);
        
        try {
          // 构建并发送Full Client Request (Binary Protocol)
          const fullClientRequest = await this.buildFullClientRequest(sessionId, false);
          
          console.log('发送Binary首包:', {
            totalSize: fullClientRequest.length,
            headerSize: 4,
            payloadSizeBytes: 4,
            sessionId: sessionId
          });
          
          // 详细分析我们发送的数据
          const ourHeader = fullClientRequest.slice(0, 4);
          const ourPayloadSize = fullClientRequest.readUInt32BE(4);
          const ourPayload = fullClientRequest.slice(8);
          
          console.log('我们发送的协议头 (hex):', ourHeader.toString('hex'));
          console.log('我们发送的协议头 (binary):', Array.from(ourHeader).map(b => b.toString(2).padStart(8, '0')).join(' '));
          console.log('我们发送的Payload大小:', ourPayloadSize);
          console.log('我们发送的Payload (前100字符):', ourPayload.toString('utf8').substring(0, 100));
          console.log('完整的Binary数据 (hex前64字节):', fullClientRequest.slice(0, 64).toString('hex'));
          
          ws.send(fullClientRequest);
          session.state = 'connected';
          session.onStateChange('connected');
          resolve(session);
        } catch (error) {
          console.error('构建Full Client Request失败:', error);
          session.onError(error);
          reject(error);
        }
      });
      
      ws.on('message', (data) => {
        this.handleMessage(session, data);
      });
      
      ws.on('error', (error) => {
        console.error(`❌ ASR WebSocket错误 ${sessionId}:`, error.message);
        console.error('错误详情:', error);
        console.error('连接状态:', {
          readyState: ws.readyState,
          url: ws.url,
          headers: wsOptions.headers
        });
        session.onError(error);
        this.sessions.delete(sessionId);
        reject(error);
      });
      
      ws.on('close', (code, reason) => {
        console.log(`🔌 ASR WebSocket连接已关闭: ${sessionId}, 代码: ${code}, 原因: ${reason}`);
        console.log('关闭前连接状态:', {
          readyState: ws.readyState,
          bufferedAmount: ws.bufferedAmount,
          extensions: ws.extensions,
          protocol: ws.protocol
        });
        
        // 详细的错误代码分析
        if (code !== 1000) {
          console.error(`❌ WebSocket异常关闭，代码: ${code}, 原因: ${reason.toString()}`);
          let errorMsg = '';
          switch (code) {
            case 1002:
              errorMsg = '协议错误';
              break;
            case 1003:
              errorMsg = '不支持的数据';
              break;
            case 1008:
              errorMsg = '策略违反（可能是认证问题）';
              break;
            case 1011:
              errorMsg = '服务器错误';
              break;
            case 4000:
              errorMsg = '火山引擎：参数错误';
              break;
            case 4001:
              errorMsg = '火山引擎：认证失败';
              break;
            case 4002:
              errorMsg = '火山引擎：权限不足';
              break;
            default:
              errorMsg = `未知错误代码: ${code}`;
          }
          console.error(`错误分析: ${errorMsg}`);
        }
        
        session.state = 'closed';
        session.onStateChange('closed');
        console.log(`🗑️ 清理ASR会话: ${sessionId}`);
        this.sessions.delete(sessionId);
        
        // 同时清理global会话映射
        if (global.asrSessions) {
          global.asrSessions.delete(sessionId);
          console.log(`🗑️ 清理global ASR会话: ${sessionId}`);
        }
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

  // This method is now replaced by buildFullClientRequest and buildAudioOnlyRequest
  // Keeping for compatibility but should not be used with binary protocol
  sendMessage(ws, payload, messageType = 'audio') {
    console.warn('sendMessage方法已弃用，请使用Binary Protocol方法');
  }

  async processAudioFrame(sessionId, audioBuffer) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'connected') {
      throw new Error(`会话 ${sessionId} 未连接或不存在`);
    }
    
    // 检查会话是否已经结束
    if (session.ending) {
      console.log(`⏰ 跳过音频帧，会话正在结束: ${sessionId}`);
      return;
    }
    
    console.log(`处理音频帧 (Binary Protocol): ${sessionId}, 大小: ${audioBuffer.length}`);
    
    // 将音频数据分包，每包约200ms（3200字节 for 16kHz 16bit mono）
    let offset = 0;
    
    while (offset < audioBuffer.length) {
      const chunk = audioBuffer.slice(offset, offset + this.config.chunkSize);
      const isLastChunk = (offset + this.config.chunkSize) >= audioBuffer.length;
      
      // 构建Binary Audio Only Request
      const audioRequest = this.buildAudioOnlyRequest(
        chunk, 
        ++session.sequence, 
        false, // 不是最后一包（结束时单独发送）
        false  // 不压缩音频数据
      );
      
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(audioRequest);
        console.log(`发送音频包: sequence=${session.sequence}, size=${chunk.length}`);
      } else {
        console.warn(`WebSocket未开放，跳过音频包: ${sessionId}`);
        break;
      }
      
      offset += this.config.chunkSize;
      
      // 避免发送过快，保持合适的发送频率
      if (offset < audioBuffer.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  handleMessage(session, rawData) {
    try {
      console.log(`收到Binary响应: ${session.sessionId}, 数据长度: ${rawData.length}`);
      console.log('完整二进制数据 (前100字节):', rawData.slice(0, 100).toString('hex'));
      
      // Binary Protocol解析：检查数据是否足够（至少4字节头）
      if (!rawData || rawData.length < 4) {
        console.error('ASR Binary响应数据太短:', rawData?.length);
        return;
      }
      
      // 解析Binary协议头（4字节）
      const header = rawData.slice(0, 4);
      
      // 显示原始头部字节
      console.log('原始协议头 (hex):', header.toString('hex'));
      console.log('原始协议头 (binary):', Array.from(header).map(b => b.toString(2).padStart(8, '0')).join(' '));
      
      // Byte 0: Protocol version (4 bits) + Header size (4 bits)
      const protocolVersion = (header[0] >> 4) & 0x0F;
      const headerSize = header[0] & 0x0F;
      
      // Byte 1: Message type (4 bits) + Message type specific flags (4 bits)
      const messageType = (header[1] >> 4) & 0x0F;
      const messageFlags = header[1] & 0x0F;
      
      // Byte 2: Message serialization (4 bits) + Message compression (4 bits)
      const serialization = (header[2] >> 4) & 0x0F;
      const compression = header[2] & 0x0F;
      
      console.log('Binary协议头解析:', {
        protocolVersion: protocolVersion + ' (' + protocolVersion.toString(2).padStart(4, '0') + ')',
        headerSize: headerSize + ' (实际大小: ' + (headerSize * 4) + ' 字节)',
        messageType: messageType + ' (' + messageType.toString(2).padStart(4, '0') + ') - ' + this.getMessageTypeName(messageType),
        messageFlags: messageFlags + ' (' + messageFlags.toString(2).padStart(4, '0') + ')',
        serialization: serialization + ' (' + (serialization === 1 ? 'JSON' : serialization === 0 ? 'None' : 'Unknown') + ')',
        compression: compression + ' (' + (compression === 1 ? 'Gzip' : compression === 0 ? 'None' : 'Unknown') + ')'
      });
      
      // 根据协议，可能有sequence number (4字节)
      let sequenceOffset = 4;
      let sequence = null;
      if (messageFlags === 0b0001 || messageFlags === 0b0011) {
        if (rawData.length < 12) { // header(4) + sequence(4) + payload_size(4)
          console.error('数据不足以包含sequence number:', rawData.length);
          return;
        }
        sequence = rawData.readUInt32BE(4);
        sequenceOffset = 8;
        console.log('包含sequence number:', sequence);
      }
      
      // 确保有足够数据读取payload大小
      if (rawData.length < sequenceOffset + 4) {
        console.error('数据不足以包含payload大小:', rawData.length, 'need:', sequenceOffset + 4);
        return;
      }
      
      // 读取payload大小（大端序）
      const payloadSize = rawData.readUInt32BE(sequenceOffset);
      console.log('Payload大小 (raw):', payloadSize, 'hex:', payloadSize.toString(16));
      console.log('Payload大小:', payloadSize);
      
      // 检查数据完整性 - 但允许部分数据处理
      const expectedTotalSize = sequenceOffset + 4 + payloadSize;
      if (rawData.length < expectedTotalSize) {
        console.warn('Binary响应数据可能不完整:', {
          received: rawData.length,
          expected: expectedTotalSize,
          payloadSize,
          availablePayload: Math.max(0, rawData.length - sequenceOffset - 4)
        });
        
        // 如果payload为0或数据完全不够，跳过
        if (payloadSize === 0 || rawData.length <= sequenceOffset + 4) {
          console.log('跳过空payload或数据不足的响应');
          return;
        }
        
        // 尝试处理可用的部分数据
        const availablePayloadSize = rawData.length - sequenceOffset - 4;
        if (availablePayloadSize > 0) {
          console.log('尝试处理部分payload数据:', availablePayloadSize, '字节');
        }
      }
      
      // 提取payload - 使用实际可用的数据长度
      const actualPayloadSize = Math.min(payloadSize, rawData.length - sequenceOffset - 4);
      let payload = rawData.slice(sequenceOffset + 4, sequenceOffset + 4 + actualPayloadSize);
      
      if (actualPayloadSize !== payloadSize) {
        console.log(`使用截断的payload: 期望 ${payloadSize}, 实际 ${actualPayloadSize}`);
      }
      
      // 处理压缩
      if (compression === this.config.COMPRESSION_GZIP) {
        try {
          payload = zlib.gunzipSync(payload);
          console.log('Gzip解压成功');
        } catch (error) {
          console.error('Gzip解压失败:', error);
          return;
        }
      }
      
      // 处理不同消息类型
      if (messageType === this.config.MSG_FULL_SERVER_RESPONSE) {
        this.handleFullServerResponse(session, payload, serialization);
      } else if (messageType === this.config.MSG_ERROR_RESPONSE) {
        this.handleErrorResponse(session, payload);
      } else {
        console.warn('未知消息类型:', messageType);
      }
      
    } catch (error) {
      console.error('解析ASR Binary响应失败:', error);
      session.onError(error);
    }
  }

  handleFullServerResponse(session, payload, serialization) {
    try {
      console.log('处理Full Server Response:', {
        payloadSize: payload.length,
        serialization,
        hexDump: payload.slice(0, 50).toString('hex'),
        stringPreview: payload.slice(0, 100).toString('utf8').replace(/[^\x20-\x7E]/g, '.')
      });
      
      if (serialization !== this.config.SERIALIZATION_JSON) {
        console.error('不支持的序列化格式:', serialization);
        return;
      }
      
      // 尝试检测是否为压缩数据
      if (payload[0] === 0x1f && payload[1] === 0x8b) {
        console.log('检测到Gzip压缩数据，尝试解压...');
        try {
          payload = zlib.gunzipSync(payload);
          console.log('Gzip解压成功，新大小:', payload.length);
        } catch (gzipError) {
          console.error('Gzip解压失败:', gzipError.message);
          return;
        }
      }
      
      const response = JSON.parse(payload.toString('utf8'));
      console.log('ASR识别结果:', response);
      
      if (response.result) {
        const resultText = response.result.text || '';
        const utterances = response.result.utterances || [];
        
        // 处理utterances中的分句结果
        for (const utterance of utterances) {
          if (utterance.definite === true) {
            // 最终结果
            session.onFinal({
              text: utterance.text || '',
              confidence: 0.9,
              isFinal: true,
              duration: utterance.end_time - utterance.start_time,
              sessionId: session.sessionId
            });
          } else {
            // 实时结果
            session.onResult({
              text: utterance.text || '',
              confidence: 0.9,
              isFinal: false,
              timestamp: Date.now(),
              sessionId: session.sessionId
            });
          }
        }
        
        // 如果没有utterances但有整体结果，直接返回
        if (utterances.length === 0 && resultText) {
          session.onResult({
            text: resultText,
            confidence: 0.9,
            isFinal: false,
            timestamp: Date.now(),
            sessionId: session.sessionId
          });
        }
      }
      
      if (response.error) {
        console.error('ASR服务错误:', response.error);
        session.onError(new Error(response.error.message || '识别失败'));
      }
    } catch (error) {
      console.error('解析Full Server Response失败:', error);
      session.onError(error);
    }
  }

  handleErrorResponse(session, payload) {
    try {
      console.log('处理Error Response:', {
        payloadSize: payload.length,
        hexDump: payload.slice(0, 50).toString('hex'),
        stringPreview: payload.slice(0, 100).toString('utf8').replace(/[^\x20-\x7E]/g, '.')
      });
      
      const errorResponse = JSON.parse(payload.toString('utf8'));
      console.error('ASR Error Response:', errorResponse);
      session.onError(new Error(errorResponse.message || 'ASR服务错误'));
    } catch (error) {
      console.error('解析Error Response失败:', error);
      console.error('原始错误响应 (hex):', payload.toString('hex'));
      session.onError(new Error('ASR服务返回无效错误响应'));
    }
  }

  async endStreamingRecognition(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`会话 ${sessionId} 不存在，无需结束`);
      return;
    }
    
    console.log(`结束ASR会话 (Binary Protocol): ${sessionId}`);
    
    try {
      // 标记会话正在结束，防止处理更多音频帧
      session.ending = true;
      
      // 等待一小段时间，确保正在处理的音频帧完成
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 发送最后一包标记（Binary Protocol）
      const lastPacketRequest = this.buildAudioOnlyRequest(
        Buffer.alloc(0), // 空音频数据
        session.sequence, // 不递增序号，因为服务器自动分配
        true, // 标记为最后一包
        false // 不压缩
      );
      
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(lastPacketRequest);
        console.log(`发送最后一包标记: sequence=${session.sequence}`);
      }
      
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
      const required = ['speechAccessToken', 'appId', 'speechSecretKey'];
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
  getMessageTypeName(messageType) {
    switch (messageType) {
      case 0b0001: return 'Full Client Request';
      case 0b0010: return 'Audio Only Request';  
      case 0b1001: return 'Full Server Response';
      case 0b1111: return 'Error Response';
      default: return 'Unknown (' + messageType + ')';
    }
  }

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