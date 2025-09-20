/**
 * Streaming Speech Module
 * 处理实时语音识别功能
 */
class StreamingSpeechManager {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.streamingSpeech = {
      isActive: false,
      sessionId: null,
      buffer: new ArrayBuffer(0),
      partialResult: '',
      finalResult: '',
      isCanceled: false
    };
  }

  /**
   * 开始流式语音识别会话
   */
  startSession() {
    if (!this.page.webSocketManager.socketTask) {
      console.error('WebSocket未连接，无法开始流式识别');
      return;
    }
    
    const sessionId = 'speech_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    this.streamingSpeech = {
      isActive: true,
      sessionId: sessionId,
      buffer: new ArrayBuffer(0),
      partialResult: '',
      finalResult: '',
      isCanceled: false
    };
    
    // 发送开始识别信号
    this.page.webSocketManager.send({
      type: 'speech_start',
      sessionId: sessionId,
      config: {
        language: 'zh-CN',
        sampleRate: 16000,
        channels: 1,
        format: 'pcm'
      }
    });
    
    this.page.setData({
      isStreamingSpeech: true
    });
    
    console.log('🎤 开始流式语音识别会话:', sessionId);
  }
  
  /**
   * 发送音频数据帧到后端
   */
  sendAudioFrame(frameBuffer) {
    if (!this.streamingSpeech.isActive || !this.page.webSocketManager.socketTask) {
      return;
    }
    
    try {
      const base64Data = wx.arrayBufferToBase64(frameBuffer);
      
      this.page.webSocketManager.send({
        type: 'speech_frame',
        sessionId: this.streamingSpeech.sessionId,
        audio: base64Data,
        size: frameBuffer.byteLength
      });
      
      console.log(`🔊 发送音频帧: ${frameBuffer.byteLength} 字节`);
    } catch (error) {
      console.error('发送音频帧失败:', error);
    }
  }
  
  /**
   * 结束流式语音识别会话
   */
  endSession() {
    if (!this.streamingSpeech.isActive) {
      return;
    }
    
    // 发送结束识别信号（如果不是取消的情况）
    if (this.page.webSocketManager.socketTask && !this.streamingSpeech.isCanceled) {
      this.page.webSocketManager.send({
        type: 'speech_end',
        sessionId: this.streamingSpeech.sessionId
      });
    }
    
    console.log('🛑 结束流式语音识别会话:', this.streamingSpeech.sessionId, 
                '是否取消:', this.streamingSpeech.isCanceled);
    
    // 重置状态
    this.streamingSpeech = {
      isActive: false,
      sessionId: null,
      buffer: new ArrayBuffer(0),
      partialResult: '',
      finalResult: '',
      isCanceled: false
    };
    
    this.page.setData({
      isStreamingSpeech: false,
      // 关闭录音界面
      showVoiceModal: false,
      isInputRecording: false,
      isRecording: false,
      isRecordingCanceling: false
    });
  }
  
  /**
   * 处理流式语音识别结果
   */
  handleResult(data) {
    // 检查是否已取消
    if (this.streamingSpeech.isCanceled) {
      console.log('🚫 忽略已取消会话的识别结果:', data.sessionId, data.resultType);
      return;
    }
    
    // 检查sessionId匹配性
    if (this.streamingSpeech.sessionId && data.sessionId !== this.streamingSpeech.sessionId) {
      console.warn('收到不匹配的语音识别结果:', data.sessionId, '当前:', this.streamingSpeech.sessionId);
      return;
    }
    
    // 处理延迟到达的最终结果
    if (data.resultType === 'final' && !this.streamingSpeech.sessionId) {
      console.log('✅ 收到延迟的最终识别结果:', data.text);
    }
    
    if (data.resultType === 'partial') {
      // 实时识别结果（不确定）
      this.streamingSpeech.partialResult = data.text;
      console.log('🔄 实时识别:', data.text);
      
    } else if (data.resultType === 'final') {
      // 最终识别结果（确定）
      this.streamingSpeech.finalResult = data.text;
      console.log('✅ 最终识别:', data.text);

      // 💡 不再自动发送消息，因为后端会处理语音消息的显示和发送
      console.log('🤖 后端将处理语音消息显示和LLM调用');

      // 只需要关闭录音界面
      setTimeout(() => {
        this.page.setData({
          isStreamingSpeech: false,
          // 关闭录音界面
          showVoiceModal: false,
          isInputRecording: false,
          isRecording: false,
          isRecordingCanceling: false
        });
      }, data.text && data.text.trim() ? 300 : 1000);
      
    } else if (data.resultType === 'canceled') {
      // 识别被取消
      console.log('❌ 语音识别已取消');
      
      setTimeout(() => {
        this.page.setData({
          isStreamingSpeech: false,
          // 关闭录音界面
          showVoiceModal: false,
          isInputRecording: false,
          isRecording: false,
          isRecordingCanceling: false
        });
      }, 500);
      
    } else if (data.resultType === 'error') {
      // 识别错误
      console.error('❌ 语音识别错误:', data.error);
      
      setTimeout(() => {
        this.page.setData({
          isStreamingSpeech: false,
          // 关闭录音界面
          showVoiceModal: false,
          isInputRecording: false,
          isRecording: false,
          isRecordingCanceling: false
        });
      }, 2000);
    }
  }

  /**
   * 取消流式语音识别会话
   */
  cancelSession() {
    if (!this.streamingSpeech.isActive) {
      return;
    }
    
    // 标记为已取消
    this.streamingSpeech.isCanceled = true;
    
    // 发送取消信号到后端
    if (this.page.webSocketManager.socketTask) {
      this.page.webSocketManager.send({
        type: 'speech_cancel',
        sessionId: this.streamingSpeech.sessionId
      });
    }
    
    console.log('❌ 取消流式语音识别会话:', this.streamingSpeech.sessionId);
    
    // 重置状态
    this.streamingSpeech = {
      isActive: false,
      sessionId: null,
      buffer: new ArrayBuffer(0),
      partialResult: '',
      finalResult: '',
      isCanceled: false
    };
    
    this.page.setData({
      isStreamingSpeech: false,
      // 关闭录音界面
      showVoiceModal: false,
      isInputRecording: false,
      isRecording: false,
      isRecordingCanceling: false
    });
  }
  
  /**
   * 标记会话为已取消
   */
  markAsCanceled() {
    this.streamingSpeech.isCanceled = true;
  }

  /**
   * 获取当前会话ID
   */
  getSessionId() {
    return this.streamingSpeech.sessionId;
  }

  /**
   * 检查是否处于活跃状态
   */
  isActive() {
    return this.streamingSpeech.isActive;
  }

  /**
   * 获取当前识别结果
   */
  getCurrentResult() {
    return {
      partial: this.streamingSpeech.partialResult,
      final: this.streamingSpeech.finalResult
    };
  }

  /**
   * 重置状态
   */
  reset() {
    this.streamingSpeech = {
      isActive: false,
      sessionId: null,
      buffer: new ArrayBuffer(0),
      partialResult: '',
      finalResult: '',
      isCanceled: false
    };
    
    this.page.setData({
      isStreamingSpeech: false
    });
  }
}

module.exports = StreamingSpeechManager;