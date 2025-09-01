/**
 * Audio Player Module (Simplified)
 * 音频播放控制模块，处理TTS音频的播放和停止操作
 */
class AudioPlayer {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.currentAudio = null;
    this.isPlaying = false;
    this.currentMessageId = null;
    
    // 播放状态回调
    this.callbacks = {
      onPlayStart: null,
      onPlayEnd: null,
      onPlayError: null
    };
  }

  /**
   * 设置播放状态回调
   */
  setCallbacks(callbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * 播放TTS音频流（使用WebSocket流式接收音频块）
   */
  async playTTSStream(text, messageId) {
    try {
      console.log('AudioPlayer: 开始WebSocket TTS播放', { messageId, textLength: text.length });
      
      // 停止当前播放
      this.stop();
      
      // 初始化删除文件追踪集合
      if (!this.deletedFiles) {
        this.deletedFiles = new Set();
      }
      
      // 注意：不再设置currentMessageId，使用currentTTSRequest来管理状态
      
      // 触发播放开始回调
      if (this.callbacks.onPlayStart) {
        this.callbacks.onPlayStart(messageId);
      }

      // 使用WebSocket流式获取和播放TTS音频
      await this.requestTTSWebSocket(text, messageId);
      
      return true;
    } catch (error) {
      console.error('AudioPlayer: WebSocket TTS播放失败', error);
      
      // 触发错误回调
      if (this.callbacks.onPlayError) {
        this.callbacks.onPlayError(error, messageId);
      }
      
      return false;
    }
  }

  /**
   * 通过WebSocket请求TTS流式音频
   */
  async requestTTSWebSocket(text, messageId) {
    return new Promise((resolve, reject) => {
      // 检查WebSocket连接状态
      if (!this.page.webSocketManager?.socketTask) {
        reject(new Error('WebSocket连接未就绪'));
        return;
      }

      console.log('AudioPlayer: 发送WebSocket TTS请求', { messageId, textLength: text.length });

      // 音频块队列和播放状态
      const audioChunks = [];
      let isReceivingComplete = false;
      let totalChunks = 0;

      // 设置当前正在处理的TTS请求
      this.currentTTSRequest = {
        messageId,
        audioChunks,
        isReceivingComplete,
        totalChunks,
        resolve,
        reject
      };

      // 发送TTS请求
      const success = this.page.webSocketManager.send({
        type: 'tts_request',
        text: text,
        messageId: messageId,
        userId: this.page.userId
      });

      if (!success) {
        delete this.currentTTSRequest;
        reject(new Error('WebSocket发送失败'));
        return;
      }

      // 设置超时
      setTimeout(() => {
        if (this.currentTTSRequest && this.currentTTSRequest.messageId === messageId) {
          delete this.currentTTSRequest;
          reject(new Error('TTS请求超时'));
        }
      }, 30000); // 30秒超时
    });
  }

  /**
   * 处理WebSocket TTS消息
   */
  handleTTSMessage(data) {
    if (!this.currentTTSRequest || this.currentTTSRequest.messageId !== data.messageId) {
      return; // 忽略不匹配的消息
    }

    console.log('AudioPlayer: 处理TTS消息', { type: data.type, messageId: data.messageId });

    const request = this.currentTTSRequest;

    switch (data.type) {
      case 'tts_start':
        console.log('AudioPlayer: TTS开始', { audioFormat: data.audioFormat, provider: data.provider });
        // 初始化流式播放状态
        request.isPlaying = false;
        request.nextChunkToPlay = 0;
        request.audioFormat = data.audioFormat;
        break;

      case 'tts_chunk':
        const chunkNum = data.chunkIndex + 1;
        const receiveTime = Date.now();
        console.log(`🎵 AudioPlayer: 收到音频块 ${chunkNum}，大小: ${data.chunkSize} bytes，时间戳: ${receiveTime}`);
        
        // 立即发送确认给后端（用于数据验证）
        if (this.page && this.page.socketTask) {
          this.page.socketTask.send({
            data: JSON.stringify({
              type: 'tts_chunk_received',
              messageId: data.messageId,
              chunkIndex: data.chunkIndex,
              validationHash: data.validationHash,
              sequenceNumber: data.sequenceNumber,
              receivedTime: receiveTime
            })
          });
        }
        
        // 验证块数据完整性
        if (!data.audioData || data.audioData.length === 0) {
          console.error(`❌ AudioPlayer: 音频块 ${chunkNum} 数据为空！`);
          return;
        }
        
        // 存储音频块（增加元数据）
        request.audioChunks[data.chunkIndex] = {
          audioData: data.audioData,
          audioFormat: data.audioFormat,
          chunkIndex: data.chunkIndex,
          receiveTime: receiveTime,
          processed: false
        };
        
        // 实时统计
        const totalReceived = Object.keys(request.audioChunks).length;
        const processed = request.concatenationState ? request.concatenationState.totalProcessedChunks : 0;
        const buffered = totalReceived - processed;
        
        console.log(`📊 AudioPlayer: 块${chunkNum}已存储 | 总计: ${totalReceived} | 已处理: ${processed} | 缓冲: ${buffered}`);
        
        // 检查块连续性
        if (data.chunkIndex > 0 && !request.audioChunks[data.chunkIndex - 1]) {
          console.warn(`⚠️  AudioPlayer: 检测到块不连续！当前: ${chunkNum}，前一块缺失`);
        }
        
        // 音频拼接策略：激进缓冲处理
        this.handleAudioChunkForConcatenation(request, data.messageId);
        break;

      case 'tts_end':
        console.log(`AudioPlayer: TTS完成，总块数: ${data.totalChunks}`);
        request.isReceivingComplete = true;
        request.totalChunks = data.totalChunks;
        
        // 启动清理监控（等所有播放完成后统一清理）
        this.startCleanupMonitoring(request, data.messageId);
        
        // 处理最后的音频块拼接和播放
        this.handleTTSComplete(request, data.messageId);
        break;

      case 'tts_error':
        console.error('AudioPlayer: TTS错误', data.error, data.details);
        const reject = request.reject;
        delete this.currentTTSRequest;
        reject(new Error(data.error));
        break;
    }
  }

  /**
   * 播放下一个音频块（多段预加载优化版）
   */
  async playNextChunk(request, messageId) {
    const chunkIndex = request.nextChunkToPlay;
    
    console.log(`AudioPlayer: 尝试播放音频块 ${chunkIndex + 1}`);
    
    // 确保预加载缓冲区存在
    if (!request.preloadBuffer) {
      request.preloadBuffer = new Map();
      request.preloadQueue = new Set();
      request.maxPreloadChunks = 25; // 简单策略：大缓冲区覆盖TTS服务商分块延迟
      request.aggressivePreload = true; // 启用激进预加载
    }
    
    // 等待当前块准备好
    while (!request.audioChunks[chunkIndex] && 
           (!request.isReceivingComplete || chunkIndex < request.totalChunks)) {
      console.log(`AudioPlayer: 等待音频块 ${chunkIndex + 1}...`);
      await this.sleep(30); // 进一步减少等待时间
    }
    
    // 检查是否有可播放的块
    if (!request.audioChunks[chunkIndex]) {
      console.log(`AudioPlayer: 音频块 ${chunkIndex + 1} 不可用，播放结束`);
      this.onStreamPlaybackComplete(messageId);
      return;
    }
    
    try {
      console.log(`AudioPlayer: 播放音频块 ${chunkIndex + 1}/${request.totalChunks || '未知'}`);
      
      // 启动多段预加载（5个块）
      this.maintainPreloadBuffer(request, chunkIndex);
      
      let audioData;
      
      // 检查是否有预加载的数据
      if (request.preloadBuffer.has(chunkIndex)) {
        console.log(`✨ AudioPlayer: 使用预加载的音频块 ${chunkIndex + 1}`);
        audioData = request.preloadBuffer.get(chunkIndex);
        request.preloadBuffer.delete(chunkIndex); // 释放内存
      } else {
        console.log(`⚡ AudioPlayer: 实时处理音频块 ${chunkIndex + 1}`);
        // 转换当前音频数据
        const audioBuffer = this.base64ToArrayBuffer(request.audioChunks[chunkIndex].audioData);
        audioData = {
          buffer: audioBuffer,
          format: request.audioChunks[chunkIndex].audioFormat
        };
      }
      
      // 播放当前音频块
      const playPromise = this.playAudioBufferOptimized(audioData, messageId, chunkIndex);
      
      await playPromise;
      
      console.log(`AudioPlayer: 音频块 ${chunkIndex + 1} 播放完成`);
      
      // 移动到下一个块
      request.nextChunkToPlay++;
      
      // 立即继续播放下一个块（因为有预加载缓冲）
      if (request.nextChunkToPlay < request.totalChunks || !request.isReceivingComplete) {
        // 使用极短延迟以确保预加载有时间完成
        setTimeout(() => this.playNextChunk(request, messageId), 10);
      } else {
        // 所有块播放完成，清理缓冲区
        this.cleanupPreloadBuffer(request);
        this.onStreamPlaybackComplete(messageId);
      }
      
    } catch (error) {
      console.error(`AudioPlayer: 音频块 ${chunkIndex + 1} 播放失败`, error);
      // 尝试播放下一个块
      request.nextChunkToPlay++;
      if (request.nextChunkToPlay < request.totalChunks || !request.isReceivingComplete) {
        setTimeout(() => this.playNextChunk(request, messageId), 30);
      } else {
        this.cleanupPreloadBuffer(request);
        this.onStreamPlaybackComplete(messageId);
      }
    }
  }

  /**
   * 维护多段预加载缓冲区（统一策略版）
   */
  async maintainPreloadBuffer(request, currentIndex) {
    const maxPreload = request.maxPreloadChunks; // 使用统一的大缓冲区策略
    
    // 激进预加载策略：立即预加载所有可用的块
    const preloadPromises = [];
    
    for (let i = 1; i <= maxPreload; i++) {
      const preloadIndex = currentIndex + i;
      
      // 检查是否需要预加载这个块
      if (this.shouldPreloadChunk(request, preloadIndex)) {
        // 如果不在预加载队列中，添加到队列
        if (!request.preloadQueue.has(preloadIndex) && !request.preloadBuffer.has(preloadIndex)) {
          request.preloadQueue.add(preloadIndex);
          
          // 创建预加载promise但不立即await
          const preloadPromise = this.preloadChunkAsync(request, preloadIndex).then(() => {
            request.preloadQueue.delete(preloadIndex);
          }).catch((error) => {
            console.warn(`AudioPlayer: 预加载块 ${preloadIndex + 1} 失败`, error);
            request.preloadQueue.delete(preloadIndex);
          });
          
          preloadPromises.push(preloadPromise);
          
          console.log(`🚀 AudioPlayer: 启动激进预加载块 ${preloadIndex + 1} (缓冲区大小: ${request.preloadBuffer.size + request.preloadQueue.size}/${maxPreload})`);
        }
      }
    }
    
    // 如果启用激进预加载，尝试预加载更多块（如果网络允许）
    if (request.aggressivePreload && preloadPromises.length < maxPreload / 2) {
      for (let i = maxPreload + 1; i <= maxPreload + 3; i++) {
        const aggressiveIndex = currentIndex + i;
        if (this.shouldPreloadChunk(request, aggressiveIndex) && 
            !request.preloadQueue.has(aggressiveIndex) && 
            !request.preloadBuffer.has(aggressiveIndex)) {
          
          request.preloadQueue.add(aggressiveIndex);
          console.log(`⚡ AudioPlayer: 激进预加载额外块 ${aggressiveIndex + 1}`);
          
          const aggressivePromise = this.preloadChunkAsync(request, aggressiveIndex).then(() => {
            request.preloadQueue.delete(aggressiveIndex);
          }).catch((error) => {
            request.preloadQueue.delete(aggressiveIndex);
          });
          
          preloadPromises.push(aggressivePromise);
        }
      }
    }
    
    // 清理过期的预加载数据（避免内存泄漏）
    this.cleanupExpiredPreloads(request, currentIndex);
  }

  /**
   * 判断是否应该预加载某个块
   */
  shouldPreloadChunk(request, chunkIndex) {
    // 块不存在或已经预加载过
    if (!request.audioChunks[chunkIndex] || request.preloadBuffer.has(chunkIndex)) {
      return false;
    }
    
    // 超出总块数
    if (request.isReceivingComplete && chunkIndex >= request.totalChunks) {
      return false;
    }
    
    return true;
  }

  /**
   * 异步预加载单个音频块（优化版）
   */
  async preloadChunkAsync(request, chunkIndex) {
    if (!request.audioChunks[chunkIndex]) {
      // 使用更短的等待周期和更长的总等待时间
      let waitTime = 0;
      const maxWait = 2000; // 增加到2秒，给网络更多时间
      const checkInterval = 25; // 减少检查间隔到25ms
      
      while (!request.audioChunks[chunkIndex] && waitTime < maxWait) {
        await this.sleep(checkInterval);
        waitTime += checkInterval;
      }
      
      if (!request.audioChunks[chunkIndex]) {
        throw new Error(`预加载超时: 块 ${chunkIndex + 1} 未到达`);
      }
    }
    
    const startTime = Date.now();
    
    // 预处理音频数据
    const preprocessed = await this.preprocessAudioChunk(request.audioChunks[chunkIndex]);
    
    const preprocessTime = Date.now() - startTime;
    
    if (preprocessed) {
      request.preloadBuffer.set(chunkIndex, preprocessed);
      console.log(`✅ AudioPlayer: 预加载完成块 ${chunkIndex + 1} (${preprocessTime}ms) (缓冲区: ${request.preloadBuffer.size}/${request.maxPreloadChunks})`);
    }
  }

  /**
   * 清理过期的预加载数据
   */
  cleanupExpiredPreloads(request, currentIndex) {
    // 移除已经播放过的块（保留1个作为安全缓冲）
    const expiredThreshold = currentIndex - 1;
    
    for (const [index] of request.preloadBuffer) {
      if (index <= expiredThreshold) {
        request.preloadBuffer.delete(index);
        console.log(`🧹 AudioPlayer: 清理过期预加载块 ${index + 1}`);
      }
    }
  }

  /**
   * 清理预加载缓冲区
   */
  cleanupPreloadBuffer(request) {
    if (request.preloadBuffer) {
      console.log(`🧹 AudioPlayer: 清理预加载缓冲区，释放 ${request.preloadBuffer.size} 个块`);
      request.preloadBuffer.clear();
      request.preloadQueue.clear();
    }
  }

  /**
   * 流式播放完成处理
   */
  onStreamPlaybackComplete(messageId) {
    console.log('AudioPlayer: 流式播放完成', messageId);
    
    // 触发播放结束回调
    if (this.callbacks.onPlayEnd) {
      this.callbacks.onPlayEnd(messageId);
    }
  }

  /**
   * 开始串行播放音频块（保留原方法以便向后兼容）
   */
  async startChunkPlayback(audioChunks, totalChunks, messageId) {
    console.log(`AudioPlayer: 开始串行播放 ${totalChunks} 个音频块`);
    
    for (let i = 0; i < totalChunks; i++) {
      // 等待音频块准备好
      while (!audioChunks[i] && this.currentMessageId === messageId) {
        await this.sleep(50); // 等待50ms
      }
      
      if (this.currentMessageId !== messageId) {
        console.log('AudioPlayer: 播放被中断');
        break;
      }
      
      if (audioChunks[i]) {
        console.log(`AudioPlayer: 播放音频块 ${i + 1}/${totalChunks}`);
        
        try {
          // 将base64音频数据转换为ArrayBuffer
          const audioBuffer = this.base64ToArrayBuffer(audioChunks[i].audioData);
          
          // 播放音频块
          await this.playAudioBuffer({
            buffer: audioBuffer,
            format: audioChunks[i].audioFormat
          });
          
          console.log(`AudioPlayer: 音频块 ${i + 1} 播放完成`);
          
        } catch (error) {
          console.error(`AudioPlayer: 音频块 ${i + 1} 播放失败`, error);
          // 继续播放下一块
        }
      }
    }
    
    console.log('AudioPlayer: 所有音频块播放完成');
    
    // 播放完成后触发回调
    if (this.callbacks.onPlayEnd) {
      this.callbacks.onPlayEnd(messageId);
    }
  }

  /**
   * 预处理音频块（并发进行以减少播放延迟）
   */
  async preprocessAudioChunk(chunkData) {
    try {
      // 预先解码base64数据
      const audioBuffer = this.base64ToArrayBuffer(chunkData.audioData);
      
      // 预先处理PCM转WAV（如果需要）
      let finalBuffer = audioBuffer;
      let fileExtension = chunkData.audioFormat;
      
      if (chunkData.audioFormat === 'pcm') {
        finalBuffer = this.convertPCMToWAV(audioBuffer, 16000, 16, 1);
        fileExtension = 'wav';
      }
      
      return {
        buffer: finalBuffer,
        format: fileExtension
      };
    } catch (error) {
      console.error('AudioPlayer: 音频块预处理失败', error);
      return null;
    }
  }

  /**
   * 优化版播放音频缓冲区（减少顿挫感）
   */
  async playAudioBufferOptimized(audioData, messageId, chunkIndex) {
    return new Promise((resolve, reject) => {
      console.log('AudioPlayer: 优化版播放音频块', { 
        chunkIndex: chunkIndex + 1,
        format: audioData.format, 
        size: audioData.buffer ? audioData.buffer.byteLength : 0
      });
      
      // 检查音频数据是否有效
      if (!audioData.buffer || audioData.buffer.byteLength === 0) {
        console.error('AudioPlayer: 音频数据为空');
        reject(new Error('音频数据为空'));
        return;
      }
      
      let finalBuffer = audioData.buffer;
      let fileExtension = audioData.format;
      
      // 如果是PCM格式，转换为WAV格式
      if (audioData.format === 'pcm') {
        console.log('AudioPlayer: PCM转WAV (块', chunkIndex + 1, ')');
        try {
          finalBuffer = this.convertPCMToWAV(audioData.buffer, 16000, 16, 1);
          fileExtension = 'wav';
        } catch (error) {
          console.error('AudioPlayer: PCM转WAV失败', error);
          reject(error);
          return;
        }
      }
      
      // 使用优化的临时文件命名 - 包含块信息
      const fs = wx.getFileSystemManager();
      const userDataPath = wx.env.USER_DATA_PATH || 'http://usr';
      const tempFilePath = `${userDataPath}/tts_chunk_${chunkIndex}_${Date.now()}.${fileExtension}`;
      
      // 写入临时文件
      wx.getFileSystemManager().writeFile({
        filePath: tempFilePath,
        data: finalBuffer,
        
        success: () => {
          console.log(`AudioPlayer: 临时文件写入成功 (块 ${chunkIndex + 1}):`, tempFilePath);
          
          // 创建音频上下文
          const audioContext = wx.createInnerAudioContext();
          audioContext.src = tempFilePath;
          audioContext.autoplay = false; // 手动控制播放
          
          // 优化: 减少事件监听器
          let hasResolved = false;
          
          audioContext.onEnded(() => {
            console.log(`AudioPlayer: 音频块 ${chunkIndex + 1} 播放结束`);
            this.cleanup(audioContext, tempFilePath);
            if (!hasResolved) {
              hasResolved = true;
              resolve();
            }
          });
          
          audioContext.onError((error) => {
            console.error(`AudioPlayer: 音频块 ${chunkIndex + 1} 播放错误`, error);
            this.cleanup(audioContext, tempFilePath);
            if (!hasResolved) {
              hasResolved = true;
              reject(error);
            }
          });
          
          audioContext.onCanplay(() => {
            console.log(`AudioPlayer: 音频块 ${chunkIndex + 1} 准备播放`);
            // 立即播放以减少延迟
            try {
              audioContext.play();
            } catch (playError) {
              console.error('AudioPlayer: 播放启动失败', playError);
              if (!hasResolved) {
                hasResolved = true;
                reject(playError);
              }
            }
          });
          
          audioContext.onStop(() => {
            console.log(`AudioPlayer: 音频块 ${chunkIndex + 1} 停止`);
            this.cleanup(audioContext, tempFilePath);
            if (!hasResolved) {
              hasResolved = true;
              resolve();
            }
          });
        },
        
        fail: (error) => {
          console.error(`AudioPlayer: 临时文件写入失败 (块 ${chunkIndex + 1})`, error);
          reject(error);
        }
      });
    });
  }

  /**
   * 睡眠函数
   */
  async sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }


  /**
   * Base64转ArrayBuffer
   */
  base64ToArrayBuffer(base64) {
    const binaryString = wx.base64ToArrayBuffer ? 
      wx.base64ToArrayBuffer(base64) : 
      Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
    return binaryString;
  }

  /**
   * 请求TTS音频数据（简化版 - 使用默认配置）
   */
  async requestTTS(text) {
    console.log('AudioPlayer: 开始TTS请求', { text, hasToken: !!this.page.authToken });
    const config = require('../../../config/env.js');
    
    // 确保有有效的认证token
    if (!this.page.authToken) {
      console.error('AudioPlayer: 没有认证token');
      throw new Error('No authentication token available');
    }
    
    return new Promise((resolve, reject) => {
      const requestUrl = `${config.baseUrl}/api/speech/tts/stream`;
      console.log('AudioPlayer: 发送TTS请求', {
        url: requestUrl,
        baseUrl: config.baseUrl,
        authToken: this.page.authToken ? 'exists' : 'missing',
        textLength: text.length
      });
      
      wx.request({
        url: requestUrl,
        method: 'POST',
        header: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.page.authToken}`
        },
        data: {
          text: text,
          userId: this.page.userId || 'miniprogram_user'
        },
        responseType: 'arraybuffer',
        timeout: 30000,
        
        success: (res) => {
          console.log('AudioPlayer: TTS响应', {
            statusCode: res.statusCode,
            dataSize: res.data ? res.data.byteLength : 0,
            headers: res.header,
            audioFormat: res.header['X-Audio-Format'] || res.header['x-audio-format']
          });
          
          if (res.statusCode === 200 && res.data && res.data.byteLength > 0) {
            const audioFormat = res.header['X-Audio-Format'] || res.header['x-audio-format'] || 'mp3';
            resolve({
              buffer: res.data,
              format: audioFormat
            });
          } else {
            console.error('AudioPlayer: TTS响应异常', {
              statusCode: res.statusCode,
              dataSize: res.data ? res.data.byteLength : 0
            });
            reject(new Error(`TTS请求失败: ${res.statusCode}, 数据大小: ${res.data ? res.data.byteLength : 0}`));
          }
        },
        
        fail: (error) => {
          console.error('AudioPlayer: TTS请求失败', error);
          reject(new Error(`网络请求失败: ${error.errMsg}`));
        }
      });
    });
  }

  /**
   * 播放音频缓冲区
   */
  async playAudioBuffer(audioData, triggerEndCallback = true) {
    return new Promise((resolve, reject) => {
      console.log('AudioPlayer: 开始处理音频数据', { 
        format: audioData.format, 
        size: audioData.buffer ? audioData.buffer.byteLength : 0
      });
      
      // 检查音频数据是否有效
      if (!audioData.buffer || audioData.buffer.byteLength === 0) {
        console.error('AudioPlayer: 音频数据为空');
        reject(new Error('音频数据为空'));
        return;
      }
      
      let finalBuffer = audioData.buffer;
      let fileExtension = audioData.format;
      
      // 如果是PCM格式，转换为WAV格式供微信小程序播放
      if (audioData.format === 'pcm') {
        console.log('AudioPlayer: 将PCM转换为WAV');
        try {
          finalBuffer = this.convertPCMToWAV(audioData.buffer, 16000, 16, 1);
          fileExtension = 'wav';
          console.log('AudioPlayer: PCM转WAV成功', { newSize: finalBuffer.byteLength });
        } catch (error) {
          console.error('AudioPlayer: PCM转WAV失败', error);
          reject(error);
          return;
        }
      }
      
      // 生成临时文件路径 - 修复路径问题
      const fs = wx.getFileSystemManager();
      // 使用正确的用户数据路径
      const userDataPath = wx.env.USER_DATA_PATH || 'http://usr';
      const tempFilePath = `${userDataPath}/tts_${Date.now()}.${fileExtension}`;
      console.log('AudioPlayer: 准备写入临时文件', { 
        tempFilePath, 
        userDataPath,
        fileSize: finalBuffer.byteLength,
        wxEnv: wx.env
      });
      
      // 写入临时文件
      wx.getFileSystemManager().writeFile({
        filePath: tempFilePath,
        data: finalBuffer,
        success: () => {
          // 保存当前messageId的本地副本，避免被改变
          const messageId = this.currentMessageId;
          console.log('AudioPlayer: 创建音频上下文', { messageId, tempFilePath });
          
          // 创建音频上下文
          const audioContext = wx.createInnerAudioContext();
          audioContext.src = tempFilePath;
          audioContext.autoplay = false; // 不自动播放，手动控制
          
          // 设置当前音频
          this.currentAudio = audioContext;
          this.isPlaying = true;
          
          // 播放事件监听 - 使用本地副本的messageId
          audioContext.onPlay(() => {
            console.log('AudioPlayer: 音频开始播放', { messageId });
            this.isPlaying = true;
          });
          
          audioContext.onEnded(() => {
            console.log('AudioPlayer: 音频播放结束', { messageId });
            this.cleanup(audioContext, tempFilePath);
            // 只有在非流式播放时才触发结束回调
            if (triggerEndCallback && this.callbacks.onPlayEnd) {
              this.callbacks.onPlayEnd(messageId); // 使用本地副本
            }
            resolve();
          });
          
          audioContext.onError((error) => {
            console.error('AudioPlayer: 音频播放错误', { error, messageId });
            this.cleanup(audioContext, tempFilePath);
            if (this.callbacks.onPlayError) {
              this.callbacks.onPlayError(error, messageId); // 使用本地副本
            }
            reject(error);
          });
          
          // 添加其他事件监听器
          audioContext.onTimeUpdate(() => {
            // 更新播放进度
            if (audioContext.currentTime > 0) {
              console.log('AudioPlayer: 播放进度', {
                currentTime: audioContext.currentTime,
                duration: audioContext.duration,
                messageId
              });
            }
          });
          
          audioContext.onCanplay(() => {
            console.log('AudioPlayer: 音频可以播放', { messageId });
            // 手动开始播放
            audioContext.play();
          });
          
          audioContext.onStop(() => {
            this.cleanup(audioContext, tempFilePath);
            // 只有在非流式播放时才触发结束回调
            if (triggerEndCallback && this.callbacks.onPlayEnd) {
              this.callbacks.onPlayEnd(messageId);
            }
            resolve();
          });
        },
        
        fail: (error) => {
          reject(error);
        }
      });
    });
  }

  /**
   * 停止播放
   */
  stop() {
    if (this.currentAudio && this.isPlaying) {
      this.currentAudio.stop();
    }
  }

  /**
   * 将PCM数据转换为WAV格式
   * @param {ArrayBuffer} pcmBuffer - PCM音频数据
   * @param {number} sampleRate - 采样率 (如 16000)
   * @param {number} bitsPerSample - 每样本位数 (如 16)
   * @param {number} channels - 声道数 (如 1)
   * @returns {ArrayBuffer} WAV格式的音频数据
   */
  convertPCMToWAV(pcmBuffer, sampleRate, bitsPerSample, channels) {
    const pcmLength = pcmBuffer.byteLength;
    const wavLength = pcmLength + 44;
    
    const wavBuffer = new ArrayBuffer(wavLength);
    const view = new DataView(wavBuffer);
    
    // WAV文件头
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    let offset = 0;
    
    // RIFF header
    writeString(offset, 'RIFF'); offset += 4;
    view.setUint32(offset, wavLength - 8, true); offset += 4; // file length - 8
    writeString(offset, 'WAVE'); offset += 4;
    
    // FMT sub-chunk
    writeString(offset, 'fmt '); offset += 4;
    view.setUint32(offset, 16, true); offset += 4; // sub-chunk size
    view.setUint16(offset, 1, true); offset += 2; // audio format (PCM)
    view.setUint16(offset, channels, true); offset += 2; // channels
    view.setUint32(offset, sampleRate, true); offset += 4; // sample rate
    view.setUint32(offset, sampleRate * channels * bitsPerSample / 8, true); offset += 4; // byte rate
    view.setUint16(offset, channels * bitsPerSample / 8, true); offset += 2; // block align
    view.setUint16(offset, bitsPerSample, true); offset += 2; // bits per sample
    
    // DATA sub-chunk
    writeString(offset, 'data'); offset += 4;
    view.setUint32(offset, pcmLength, true); offset += 4;
    
    // Copy PCM data
    const pcmView = new Uint8Array(pcmBuffer);
    const wavView = new Uint8Array(wavBuffer);
    wavView.set(pcmView, offset);
    
    return wavBuffer;
  }

  /**
   * 清理音频资源
   */
  cleanup(audioContext, tempFilePath) {
    // 重置状态（注意：不重置currentMessageId，因为流式播放还需要它）
    // this.isPlaying = false; // 也不重置这个，因为流式播放还在继续
    // this.currentMessageId = null; // 不重置，避免影响流式播放
    
    // 销毁音频上下文
    if (audioContext) {
      audioContext.destroy();
    }
    
    // 重置当前音频
    if (this.currentAudio === audioContext) {
      this.currentAudio = null;
    }
    
    // 删除临时文件
    if (tempFilePath) {
      wx.getFileSystemManager().unlink({
        filePath: tempFilePath,
        success: () => console.log('AudioPlayer: 临时文件已删除'),
        fail: (error) => console.warn('AudioPlayer: 临时文件删除失败', error)
      });
    }
  }

  /**
   * 获取播放状态
   */
  getPlayingStatus() {
    return {
      isPlaying: this.isPlaying,
      currentMessageId: this.currentMessageId
    };
  }

  /**
   * 检查消息是否正在播放
   */
  isMessagePlaying(messageId) {
    return this.isPlaying && this.currentMessageId === messageId;
  }

  /**
   * 音频拼接策略处理函数
   */
  handleAudioChunkForConcatenation(request, messageId) {
    // 初始化拼接相关状态
    if (!request.concatenationState) {
      request.concatenationState = {
        segments: [], // 拼接的音频段
        currentSegment: null, // 当前正在处理的音频段
        playingSegmentIndex: 0, // 当前播放的段索引
        totalProcessedChunks: 0, // 已处理的总块数
        audioContexts: [], // 音频实例管理
        isPlayingStarted: false,
        isPlaying: false, // 当前是否正在播放
        firstChunkTime: Date.now(), // 第一个块的时间
        averagePlaybackRate: 2, // 默认播放速率（块/秒，500ms/块）
        CHUNK_DURATION_MS: 500 // 每块约500ms播放时长（基于实测）
      };
    }

    const state = request.concatenationState;
    const receivedChunks = Object.keys(request.audioChunks).length;
    
    console.log(`AudioPlayer: 音频拼接处理 - 已收到 ${receivedChunks} 块`);

    // 检查是否需要创建新的音频段
    this.tryCreateAudioSegment(request, messageId);
    
    // 开始播放（如果尚未开始且有可播放的段）
    if (!state.isPlayingStarted && state.segments.length > 0) {
      console.log('AudioPlayer: 开始拼接音频播放');
      state.isPlayingStarted = true;
      state.isPlaying = true;
      request.isPlaying = true;
      this.playNextSegment(request, messageId);
    }
  }

  /**
   * 尝试创建音频段（增强防漏播版本）
   */
  tryCreateAudioSegment(request, messageId) {
    const state = request.concatenationState;
    const receivedChunks = Object.keys(request.audioChunks).length;
    const bufferedChunks = receivedChunks - state.totalProcessedChunks;
    
    // 详细日志记录当前状态
    console.log(`🔍 AudioPlayer: 段创建检查 - 已收到${receivedChunks}块，已处理${state.totalProcessedChunks}块，缓冲${bufferedChunks}块`);
    
    // 使用简化策略计算下一段大小
    const nextSegmentSize = this.calculateOptimalSegmentSize(state, bufferedChunks, request);
    
    if (nextSegmentSize === 0) {
      console.log(`🔄 AudioPlayer: 等待更多块，当前缓冲: ${bufferedChunks} 块`);
      return;
    }
    
    // 确保所有需要的块都已接收
    const startChunk = state.totalProcessedChunks;
    const endChunk = startChunk + nextSegmentSize - 1;
    
    // 严格验证块的连续性（修复漏播问题）
    const unavailableChunks = [];
    for (let i = startChunk; i <= endChunk; i++) {
      if (!request.audioChunks[i]) {
        unavailableChunks.push(i);
      }
    }
    
    if (unavailableChunks.length > 0) {
      console.log(`⏳ AudioPlayer: 块 [${unavailableChunks.join(', ')}] 未就绪，等待... (需要${nextSegmentSize}块)`);
      return;
    }
    
    // 在创建新段前主动清理释放存储空间
    this.performStorageCleanup(request);
    
    // 创建音频段
    console.log(`✅ AudioPlayer: 创建音频段 ${state.segments.length + 1} (块 ${startChunk + 1}-${endChunk + 1}，共${nextSegmentSize}块)`);
    
    try {
      const segment = this.createAudioSegment(request, startChunk, endChunk, messageId);
      state.segments.push(segment);
      
      // 严格记录已处理的块
      const oldProcessed = state.totalProcessedChunks;
      state.totalProcessedChunks = endChunk + 1;
      
      console.log(`📊 AudioPlayer: 已处理块数更新: ${oldProcessed} → ${state.totalProcessedChunks} (+${nextSegmentSize}块)`);
      
      // 继续尝试创建更多段（10块策略）
      const remainingBuffer = receivedChunks - state.totalProcessedChunks;
      if (remainingBuffer >= 10 || (request.isReceivingComplete && remainingBuffer > 0)) {
        console.log(`🚀 AudioPlayer: 剩余缓冲${remainingBuffer}块，立即尝试创建下一段`);
        // 立即递归调用，不用setTimeout
        this.tryCreateAudioSegment(request, messageId);
      }
    } catch (error) {
      console.error(`❌ AudioPlayer: 创建音频段失败:`, error);
    }
  }
  
  /**
   * 计算最优音频段大小（10块策略 + 清理机制）
   * 解决微信小程序存储限制和缓存清理问题
   */
  calculateOptimalSegmentSize(state, bufferedChunks, request) {
    const segmentCount = state.segments.length;
    
    // 使用10块策略，配合积极的清理机制
    
    // 第1段：快速启动 - 10块
    if (segmentCount === 0) {
      if (bufferedChunks >= 10) {
        console.log(`AudioPlayer: [段1] 快速启动 - 10块 = 5秒音频，约700ms传输`);
        return 10;
      }
      console.log(`AudioPlayer: 等待启动块 (${bufferedChunks}/10)`);
      return 0;
    }
    
    // 其他段：统一10块策略
    if (bufferedChunks >= 10) {
      const playTime = (10 * 0.5).toFixed(1);
      console.log(`AudioPlayer: [段${segmentCount + 1}] 标准段 - 10块 = ${playTime}秒音频，约700ms传输`);
      return 10;
    }
    
    // 如果TTS已完成且有剩余块，创建最终段
    if (request.isReceivingComplete && bufferedChunks > 0) {
      const finalSegmentSize = Math.min(bufferedChunks, 10);
      console.log(`AudioPlayer: [最终段] 剩余${bufferedChunks}块，创建${finalSegmentSize}块段`);
      return finalSegmentSize;
    }
    
    console.log(`AudioPlayer: 等待更多块 (${bufferedChunks}/10)`);
    return 0;
  }

  /**
   * 创建一个音频段（严格按序号拼接多个块）
   */
  createAudioSegment(request, startChunk, endChunk, messageId) {
    const expectedCount = endChunk - startChunk + 1;
    const missingChunks = [];
    const availableChunks = [];
    
    // 严格检查每个序号的块
    for (let i = startChunk; i <= endChunk; i++) {
      if (request.audioChunks[i]) {
        availableChunks.push({
          index: i,
          data: request.audioChunks[i],
          sequenceNumber: i // 明确序号
        });
      } else {
        missingChunks.push(i);
      }
    }
    
    // 如果有缺失块，报告并抛出错误（防止漏播）
    if (missingChunks.length > 0) {
      console.error(`❌ AudioPlayer: 严重错误！段 ${startChunk + 1}-${endChunk + 1} 缺失块: [${missingChunks.join(', ')}]`);
      console.error(`📊 AudioPlayer: 可用块: [${availableChunks.map(c => c.index).join(', ')}]`);
      throw new Error(`缺失音频块: ${missingChunks.join(', ')}`);
    }
    
    // 按序号排序（双重保险）
    availableChunks.sort((a, b) => a.index - b.index);
    
    console.log(`✅ AudioPlayer: 创建段 ${startChunk + 1}-${endChunk + 1}，严格按序号拼接 ${availableChunks.length} 块`);
    console.log(`🔢 AudioPlayer: 块序号: [${availableChunks.map(c => c.index + 1).join(', ')}]`);
    
    try {
      // 严格按序号拼接音频数据
      const concatenatedBuffer = this.concatenateAudioChunksBySequence(availableChunks);
      
      // 创建临时文件，文件名包含序号信息
      const tempFilePath = `${wx.env.USER_DATA_PATH}/audio_seg_${messageId}_${startChunk}-${endChunk}_${Date.now()}.wav`;
      
      wx.getFileSystemManager().writeFileSync(tempFilePath, concatenatedBuffer);
      
      console.log(`📁 AudioPlayer: 段文件创建: ${tempFilePath}`);
      
      // 标记这些块已被处理，但不立即删除数据（等播放完成后删除）
      availableChunks.forEach(chunk => {
        if (request.audioChunks[chunk.index]) {
          request.audioChunks[chunk.index].processed = true;
          request.audioChunks[chunk.index].usedInSegment = startChunk + '_' + endChunk;
          // 不立即删除，保留数据直到段播放完成
          console.log(`🏷️  AudioPlayer: 标记块${chunk.index + 1}已用于段，保留数据`);
        }
      });
      
      // 不再立即清理，保留数据直到所有播放完成
      // this.cleanupProcessedChunks(request, startChunk);
      
      return {
        filePath: tempFilePath,
        startChunk,
        endChunk,
        chunkCount: availableChunks.length,
        chunkSequence: availableChunks.map(c => c.index), // 记录实际序号
        audioContext: null
      };
      
    } catch (error) {
      console.error(`❌ AudioPlayer: 段创建失败 ${startChunk + 1}-${endChunk + 1}:`, error);
      throw error;
    }
  }

  /**
   * 主动存储清理（预防存储溢出）
   */
  performStorageCleanup(request) {
    const state = request.concatenationState;
    
    // 1. 清理已播放段的临时文件
    if (state.segments && state.playingSegmentIndex > 0) {
      for (let i = 0; i < state.playingSegmentIndex; i++) {
        const segment = state.segments[i];
        if (segment && segment.filePath) {
          this.cleanupTempFile(segment.filePath);
          console.log(`🧹 AudioPlayer: 主动清理已播放段${i + 1}的临时文件`);
        }
      }
    }
    
    // 2. 不再提前清理块数据，保留到最后统一清理
    // this.cleanupProcessedChunks(request, state.totalProcessedChunks);
    
    // 3. 强制垃圾回收（如果可用）
    if (typeof wx !== 'undefined' && wx.triggerGC) {
      wx.triggerGC();
      console.log(`🧹 AudioPlayer: 触发微信小程序垃圾回收`);
    }
  }

  /**
   * 清理已处理的音频块数据（释放内存）
   */
  cleanupProcessedChunks(request, upToIndex) {
    let cleanedCount = 0;
    for (let i = 0; i < upToIndex; i++) {
      if (request.audioChunks[i] && request.audioChunks[i].audioData) {
        delete request.audioChunks[i].audioData;
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`🧹 AudioPlayer: 清理了${cleanedCount}个已处理块的音频数据，释放内存`);
    }
  }

  /**
   * 清理特定段使用的音频块数据（播放完成后安全删除）
   */
  cleanupSegmentChunkData(request, segment) {
    if (!segment || !segment.chunkSequence) {
      return;
    }

    let cleanedCount = 0;
    segment.chunkSequence.forEach(chunkIndex => {
      if (request.audioChunks[chunkIndex] && request.audioChunks[chunkIndex].audioData) {
        delete request.audioChunks[chunkIndex].audioData;
        cleanedCount++;
        console.log(`🧹 AudioPlayer: 播放完成后清理块${chunkIndex + 1}的音频数据`);
      }
    });

    if (cleanedCount > 0) {
      console.log(`✅ AudioPlayer: 段播放完成，安全清理了${cleanedCount}个块的音频数据`);
    }
  }

  /**
   * 启动清理监控（等所有播放完成后统一清理）
   */
  startCleanupMonitoring(request, messageId) {
    const state = request.concatenationState;
    console.log('🕐 AudioPlayer: 启动清理监控，等待所有播放完成...');
    
    const cleanupInterval = setInterval(() => {
      // 检查是否所有段都播放完成
      const allCompleted = state.segments.every(segment => 
        segment.playCompleted || segment.playFailed
      );
      
      if (allCompleted) {
        clearInterval(cleanupInterval);
        console.log('🧹 AudioPlayer: 所有播放完成，开始统一清理');
        this.performFinalCleanup(request, messageId);
      }
    }, 500); // 每500ms检查一次
    
    // 设置最大等待时间，防止永远等待
    setTimeout(() => {
      clearInterval(cleanupInterval);
      console.log('⏰ AudioPlayer: 清理监控超时，强制清理');
      this.performFinalCleanup(request, messageId);
    }, 30000); // 30秒后强制清理
  }

  /**
   * 执行最终统一清理
   */
  performFinalCleanup(request, messageId) {
    const state = request.concatenationState;
    
    console.log(`🧹 AudioPlayer: 开始最终清理 - MessageID: ${messageId}`);
    
    // 1. 清理所有音频块数据
    let totalChunksCleared = 0;
    Object.keys(request.audioChunks).forEach(index => {
      if (request.audioChunks[index] && request.audioChunks[index].audioData) {
        delete request.audioChunks[index].audioData;
        totalChunksCleared++;
      }
    });
    console.log(`🧹 AudioPlayer: 清理了${totalChunksCleared}个音频块数据`);
    
    // 2. 销毁所有音频实例
    let audioContextsDestroyed = 0;
    state.segments.forEach(segment => {
      if (segment.audioContext) {
        this.destroySegmentAudioContext(segment);
        audioContextsDestroyed++;
      }
    });
    console.log(`🧹 AudioPlayer: 销毁了${audioContextsDestroyed}个音频实例`);
    
    // 3. 清理所有临时文件
    let filesCleared = 0;
    state.segments.forEach(segment => {
      if (segment.filePath) {
        this.cleanupTempFile(segment.filePath);
        filesCleared++;
      }
    });
    console.log(`🧹 AudioPlayer: 清理了${filesCleared}个临时文件`);
    
    // 4. 重置状态
    request.audioChunks = {};
    state.segments = [];
    state.audioContexts = [];
    
    // 5. 强制垃圾回收
    if (typeof wx !== 'undefined' && wx.triggerGC) {
      wx.triggerGC();
      console.log('🧹 AudioPlayer: 触发垃圾回收');
    }
    
    console.log('✅ AudioPlayer: 最终清理完成');
  }

  /**
   * 按序号严格拼接音频块
   */
  concatenateAudioChunksBySequence(orderedChunks) {
    if (orderedChunks.length === 0) {
      throw new Error('没有音频块可拼接');
    }
    
    console.log(`🔗 AudioPlayer: 开始按序号拼接 ${orderedChunks.length} 块`);
    
    // 验证序号连续性
    for (let i = 0; i < orderedChunks.length - 1; i++) {
      const currentIndex = orderedChunks[i].index;
      const nextIndex = orderedChunks[i + 1].index;
      if (nextIndex !== currentIndex + 1) {
        console.warn(`⚠️  AudioPlayer: 块序号不连续: ${currentIndex} -> ${nextIndex}`);
      }
    }
    
    // 按序号转换为ArrayBuffer
    const buffers = [];
    orderedChunks.forEach(chunk => {
      try {
        const buffer = this.base64ToArrayBuffer(chunk.data.audioData);
        buffers.push({
          index: chunk.index,
          buffer: buffer,
          size: buffer.byteLength
        });
        console.log(`🔢 AudioPlayer: 块${chunk.index + 1} -> ${buffer.byteLength} bytes`);
      } catch (error) {
        console.error(`❌ AudioPlayer: 块${chunk.index + 1}解码失败:`, error);
        throw error;
      }
    });
    
    // 计算总长度
    const totalLength = buffers.reduce((sum, item) => sum + item.size, 0);
    
    // 创建合并后的buffer
    const concatenatedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    
    buffers.forEach(item => {
      concatenatedBuffer.set(new Uint8Array(item.buffer), offset);
      console.log(`📎 AudioPlayer: 块${item.index + 1}拼接到位置${offset}，大小${item.size}`);
      offset += item.size;
    });
    
    console.log(`✅ AudioPlayer: 序号拼接完成，总大小: ${concatenatedBuffer.length} bytes`);
    console.log(`📋 AudioPlayer: 拼接顺序: [${orderedChunks.map(c => c.index + 1).join(' -> ')}]`);
    
    return concatenatedBuffer.buffer;
  }

  /**
   * 拼接音频块（兼容旧版本）
   */
  concatenateAudioChunks(chunks) {
    if (chunks.length === 0) {
      throw new Error('没有音频块可拼接');
    }
    
    // 将所有base64音频数据转换为ArrayBuffer并合并
    const buffers = chunks.map(chunk => {
      return this.base64ToArrayBuffer(chunk.audioData);
    });
    
    // 计算总长度
    const totalLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    
    // 创建合并后的buffer
    const concatenatedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    
    buffers.forEach(buffer => {
      concatenatedBuffer.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    });
    
    console.log(`AudioPlayer: 音频拼接完成，总大小: ${concatenatedBuffer.length} bytes`);
    
    return concatenatedBuffer.buffer;
  }

  /**
   * 播放下一个音频段
   */
  async playNextSegment(request, messageId) {
    const state = request.concatenationState;
    
    // 标记正在播放
    state.isPlaying = true;
    
    // 检查是否有可播放的段
    if (state.playingSegmentIndex >= state.segments.length) {
      console.log(`AudioPlayer: 当前段索引 ${state.playingSegmentIndex}/${state.segments.length}，已处理块 ${state.totalProcessedChunks}`);
      
      // 检查是否所有TTS都已完成
      if (request.isReceivingComplete && state.totalProcessedChunks >= (request.totalChunks || 0)) {
        console.log('AudioPlayer: 所有音频已播放完成');
        state.isPlaying = false;
        this.onSegmentedPlaybackComplete(request, messageId);
        return;
      }
      
      // 等待新的段
      state.isPlaying = false; // 暂时标记为未播放
      setTimeout(() => {
        if (state.playingSegmentIndex < state.segments.length) {
          console.log(`AudioPlayer: 发现新段，继续播放`);
          this.playNextSegment(request, messageId);
        } else if (request.isReceivingComplete) {
          // 再次检查是否有遗漏的段
          this.createFinalSegments(request, messageId);
          if (state.playingSegmentIndex < state.segments.length) {
            this.playNextSegment(request, messageId);
          } else {
            this.onSegmentedPlaybackComplete(request, messageId);
          }
        } else {
          // 继续等待
          console.log('AudioPlayer: 继续等待新音频段...');
          setTimeout(() => this.playNextSegment(request, messageId), 200);
        }
      }, 200);
      return;
    }
    
    const segment = state.segments[state.playingSegmentIndex];
    const segmentNumber = state.playingSegmentIndex + 1;
    
    // 验证段的完整性（防止漏播）
    if (!segment || !segment.filePath) {
      console.error(`AudioPlayer: 音频段 ${segmentNumber} 数据不完整，跳过`);
      state.playingSegmentIndex++;
      this.playNextSegment(request, messageId);
      return;
    }
    
    console.log(`AudioPlayer: 播放音频段 ${segmentNumber}/${state.segments.length} (块 ${segment.startChunk + 1}-${segment.endChunk + 1}，共${segment.chunkCount}块)`);
    
    try {
      // 创建音频上下文
      const audioContext = wx.createInnerAudioContext();
      segment.audioContext = audioContext;
      state.audioContexts.push(audioContext);
      
      audioContext.src = segment.filePath;
      
      const playPromise = new Promise((resolve, reject) => {
        let hasPlayed = false;
        
        audioContext.onPlay(() => {
          hasPlayed = true;
          console.log(`AudioPlayer: 音频段 ${segmentNumber} 开始播放`);
        });
        
        audioContext.onEnded(() => {
          if (!hasPlayed) {
            console.warn(`AudioPlayer: 音频段 ${segmentNumber} 未播放就结束了`);
          }
          console.log(`AudioPlayer: 音频段 ${segmentNumber} 播放结束`);
          
          // 标记段已播放完成，但不立即清理
          segment.playCompleted = true;
          
          resolve();
        });
        
        audioContext.onError((error) => {
          console.error(`AudioPlayer: 音频段 ${segmentNumber} 播放错误:`, error);
          
          // 标记段播放失败，但不立即清理
          segment.playFailed = true;
          
          reject(error);
        });
        
        // 设置超时保护（防止卡死）
        setTimeout(() => {
          if (!hasPlayed) {
            console.warn(`AudioPlayer: 音频段 ${segmentNumber} 播放超时`);
            reject(new Error('播放超时'));
          }
        }, 10000); // 10秒超时
        
        // 开始播放
        audioContext.play();
      });
      
      await playPromise;
      
      // 成功播放，移动到下一段
      state.playingSegmentIndex++;
      console.log(`AudioPlayer: 音频段 ${segmentNumber} 播放完成，准备播放下一段`);
      
      // 递归播放下一段
      this.playNextSegment(request, messageId);
      
    } catch (error) {
      console.error(`AudioPlayer: 播放音频段 ${segmentNumber} 失败:`, error);
      
      // 清理失败的音频实例
      if (segment.audioContext) {
        this.destroySegmentAudioContext(segment);
      }
      
      // 尝试播放下一段（跳过失败的段）
      state.playingSegmentIndex++;
      this.playNextSegment(request, messageId);
    }
  }

  /**
   * 处理TTS完成
   */
  handleTTSComplete(request, messageId) {
    console.log('AudioPlayer: TTS完成，处理剩余音频块');
    
    if (request.concatenationState) {
      // 处理最后的不完整段
      this.createFinalSegments(request, messageId);
      
      // 如果还没开始播放，现在开始
      if (!request.concatenationState.isPlayingStarted) {
        console.log('AudioPlayer: TTS完成，开始播放所有音频段');
        request.concatenationState.isPlayingStarted = true;
        request.isPlaying = true;
        this.playNextSegment(request, messageId);
      }
    } else {
      // 如果没有拼接状态，说明没有收到任何块
      console.log('AudioPlayer: TTS完成但没有收到音频块');
      const resolve = request.resolve;
      delete this.currentTTSRequest;
      resolve();
    }
  }

  /**
   * 创建最后的不完整段（增强防漏播版本）
   */
  createFinalSegments(request, messageId) {
    const state = request.concatenationState;
    const totalChunks = request.totalChunks || Object.keys(request.audioChunks).length;
    
    console.log(`🏁 AudioPlayer: 创建最终段检查 - 已处理 ${state.totalProcessedChunks} 块，总计 ${totalChunks} 块`);
    
    // 使用tryCreateAudioSegment来处理剩余块，确保按策略分段
    if (state.totalProcessedChunks < totalChunks) {
      console.log(`🔄 AudioPlayer: 使用分段策略处理剩余 ${totalChunks - state.totalProcessedChunks} 块`);
      // 强制设置TTS完成状态，让策略知道可以创建最终段
      request.isReceivingComplete = true;
      // 递归调用分段策略处理剩余块
      this.tryCreateAudioSegment(request, messageId);
    } else {
      console.log('✅ AudioPlayer: 所有块已处理完成，无需创建额外段');
    }
    
    // 最终统计
    const finalSegmentCount = state.segments.length;
    const processedChunkCount = state.totalProcessedChunks;
    const chunkProcessingRate = totalChunks > 0 ? ((processedChunkCount / totalChunks) * 100).toFixed(1) : '0.0';
    
    console.log(`📊 AudioPlayer: 最终统计 - ${finalSegmentCount}个段，处理了${processedChunkCount}/${totalChunks}块 (${chunkProcessingRate}%)`);
  }

  /**
   * 分段播放完成
   */
  onSegmentedPlaybackComplete(request, messageId) {
    console.log('AudioPlayer: 分段音频播放完成');
    
    // 清理所有音频实例
    if (request.concatenationState) {
      this.cleanupAllSegmentAudioContexts(request.concatenationState);
    }
    
    // 调用播放结束回调
    if (this.callbacks.onPlayEnd) {
      this.callbacks.onPlayEnd(messageId);
    }
    
    // 清理请求状态
    const resolve = request.resolve;
    delete this.currentTTSRequest;
    resolve();
  }

  /**
   * 销毁音频段的音频实例
   */
  destroySegmentAudioContext(segment) {
    if (segment.audioContext) {
      try {
        segment.audioContext.destroy();
        console.log(`AudioPlayer: 音频段实例已销毁`);
      } catch (error) {
        console.warn('AudioPlayer: 销毁音频实例时出错:', error);
      }
      segment.audioContext = null;
    }
  }

  /**
   * 清理所有音频段的音频实例
   */
  cleanupAllSegmentAudioContexts(concatenationState) {
    console.log(`AudioPlayer: 清理 ${concatenationState.audioContexts.length} 个音频实例`);
    
    concatenationState.audioContexts.forEach(audioContext => {
      try {
        if (audioContext) {
          audioContext.destroy();
        }
      } catch (error) {
        console.warn('AudioPlayer: 清理音频实例时出错:', error);
      }
    });
    
    concatenationState.audioContexts = [];
    
    // 清理临时文件
    concatenationState.segments.forEach(segment => {
      this.cleanupTempFile(segment.filePath);
    });
  }

  /**
   * 清理临时文件（防重复删除）
   */
  cleanupTempFile(filePath) {
    if (!filePath) return;
    if (this.deletedFiles && this.deletedFiles.has(filePath)) {
      console.log(`ℹ️  AudioPlayer: 文件已标记为删除，跳过: ${filePath}`);
      return;
    }
    
    try {
      wx.getFileSystemManager().unlinkSync(filePath);
      console.log(`✅ AudioPlayer: 临时文件已删除: ${filePath}`);
      if (this.deletedFiles) {
        this.deletedFiles.add(filePath);
      }
    } catch (error) {
      if (error.errMsg && error.errMsg.includes('no such file')) {
        console.log(`ℹ️  AudioPlayer: 文件已被删除，跳过: ${filePath}`);
        if (this.deletedFiles) {
          this.deletedFiles.add(filePath);
        }
      } else {
        console.warn('⚠️  AudioPlayer: 删除临时文件失败:', filePath, error.errMsg || error);
      }
    }
  }
}

module.exports = AudioPlayer;