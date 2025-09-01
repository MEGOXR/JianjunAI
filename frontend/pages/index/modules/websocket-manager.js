/**
 * WebSocket Manager Module
 * 处理 WebSocket 连接、消息收发、重连逻辑
 */
class WebSocketManager {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.socketTask = null;
    this.reconnectTimer = null;
    this.reconnectCount = 0;
    this.maxReconnects = 5;
    this.responseTimeoutId = null;
  }

  /**
   * 建立 WebSocket 连接
   */
  connect() {
    // 如果已有连接，先关闭
    if (this.socketTask) {
      this.socketTask.close();
      this.socketTask = null;
    }

    const wsUrl = `${getApp().globalData.wsBaseUrl}`;
    console.log('尝试连接WebSocket:', wsUrl);
    console.log('User-Id:', this.page.userId);
    
    // JWT 认证
    const headers = {};
    if (this.page.authToken) {
      headers['Authorization'] = `Bearer ${this.page.authToken}`;
      console.log('Using JWT authentication');
    } else {
      console.error('No JWT token available. Authentication may fail.');
      this.page.initializeAuth(this.page.userId, () => {
        if (this.page.authToken) {
          this.connect();
        }
      });
      return;
    }
    
    const socketTask = wx.connectSocket({
      url: wsUrl,
      header: headers,
    });

    this.setupSocketEvents(socketTask);
    this.socketTask = socketTask;
  }

  /**
   * 设置 WebSocket 事件监听
   */
  setupSocketEvents(socketTask) {
    socketTask.onOpen(() => {
      console.log("WebSocket 连接成功，准备发送初始化消息");
      this.reconnectCount = 0;
      
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      
      try {
        socketTask.send({
          data: JSON.stringify({
            type: 'init'
          })
        });
        console.log("初始化消息发送成功");
      } catch (error) {
        console.error("发送初始化消息失败:", error);
      }
    });

    socketTask.onMessage((res) => {
      this.handleMessage(JSON.parse(res.data));
    });

    socketTask.onClose((res) => {
      console.log("WebSocket 连接关闭 - 关闭码:", res.code, "关闭原因:", res.reason);
      
      // 清理所有语音相关状态，防止界面卡住
      this.page.setData({ 
        socketTask: null,
        isConnecting: false,
        // 强制关闭所有录音相关状态
        showVoiceModal: false,
        isInputRecording: false,
        isRecording: false,
        isRecordingCanceling: false,
        isStreamingSpeech: false,
        isGenerating: false
      });
      
      // 取消流式语音识别会话
      if (this.page.streamingSpeechManager) {
        this.page.streamingSpeechManager.cancelSession();
      }
      
      if (res.code === 1000) {
        console.log("正常关闭，不重连");
      } else {
        console.log(`异常关闭码 ${res.code}，延迟后重连`);
        setTimeout(() => {
          if (!this.page.isPageUnloaded && !this.page.isPageHidden) {
            this.reconnect();
          }
        }, 2000);
      }
    });

    socketTask.onError((error) => {
      console.error("WebSocket 错误详情:", error);
      
      // 清理所有语音相关状态，防止界面卡住
      this.page.setData({ 
        socketTask: null,
        isConnecting: false,
        // 强制关闭所有录音相关状态
        showVoiceModal: false,
        isInputRecording: false,
        isRecording: false,
        isRecordingCanceling: false,
        isStreamingSpeech: false,
        isGenerating: false
      });
      
      // 取消流式语音识别会话
      if (this.page.streamingSpeechManager) {
        this.page.streamingSpeechManager.cancelSession();
      }
      
      wx.showToast({ title: "连接错误", icon: "none" });
      
      setTimeout(() => {
        if (!this.page.isPageUnloaded && !this.page.isPageHidden) {
          this.reconnect();
        }
      }, 3000);
    });
  }

  /**
   * 处理接收到的消息
   */
  handleMessage(data) {
    let newMessages = [...this.page.data.messages];
    
    // 处理问候消息
    if (data.type === 'greeting') {
      console.log('处理问候消息:', data.data);
      
      const recentGreetings = newMessages.filter(msg => msg.isGreeting);
      const hasRecentGreeting = recentGreetings.length > 0 && recentGreetings[0].content === data.data;
      
      if (!hasRecentGreeting) {
        const greetingMessage = {
          role: 'assistant',
          content: data.data,
          timestamp: Date.now(),
          isGreeting: true
        };
        newMessages.push(greetingMessage);
        
        const formattedMessages = this.page.formatMessages(newMessages);
        
        this.page.setData({
          messages: formattedMessages,
          userId: data.userId || this.page.data.userId
        }, () => {
          this.page.scrollController.scrollToBottom();
        });
        
        wx.setStorageSync('messages', newMessages);
      }
      return;
    }
    
    // 处理初始化消息
    if (data.type === 'init') {
      console.log('收到init消息，忽略');
      return;
    }
    
    // 处理心跳消息
    if (data.type === 'ping') {
      console.log('收到服务器ping，发送pong响应');
      this.send({
        type: 'pong',
        timestamp: Date.now()
      });
      return;
    }
    
    if (data.type === 'pong') {
      console.log('收到服务器pong响应');
      return;
    }
    
    // 处理流式语音识别消息
    if (data.type === 'speech_result') {
      this.page.streamingSpeechManager.handleResult(data);
      return;
    }
    
    // 处理建议问题消息
    if (data.type === 'suggestions') {
      console.log('🎯 收到建议问题消息:', data.suggestions);
      this.page.messageManager.handleSuggestions(data.suggestions);
      return;
    }
    
    // 处理TTS流式音频消息
    if (data.type === 'tts_start' || data.type === 'tts_chunk' || data.type === 'tts_end' || data.type === 'tts_error') {
      console.log('🔊 收到TTS消息:', data.type, data.messageId);
      // 通知AudioPlayer处理TTS消息
      if (this.page.audioPlayer && this.page.audioPlayer.handleTTSMessage) {
        this.page.audioPlayer.handleTTSMessage(data);
      }
      return;
    }
    
    // 处理预热完成消息
    if (data.type === 'warmup_complete') {
      console.log('🔥 收到预热完成消息:', {
        userId: data.userId,
        hasGreeting: data.hasGreeting,
        hasSuggestions: data.hasSuggestions,
        errors: data.errors
      });
      
      if (data.errors && data.errors.length > 0) {
        console.warn('预热过程中发生错误:', data.errors);
      }
      
      // 可以在这里添加预热完成的UI反馈
      return;
    }
    
    // 处理连接确认消息
    if (data.type === 'connected') {
      console.log('✅ 收到连接确认:', data);
      this.page.setData({ isConnecting: false });
      return;
    }
    
    // 处理错误消息
    if (data.error) {
      this.handleError(data);
      return;
    }
    
    // 处理流式数据
    if (data.data) {
      this.page.messageManager.handleStreamingData(data);
    }

    if (data.done) {
      console.log('🎯 收到完成信号:', {
        suggestions: data.suggestions,
        hasData: !!data,
        suggestionsLength: data.suggestions ? data.suggestions.length : 0
      });
      this.page.messageManager.handleStreamingComplete(data);
    }
  }

  /**
   * 处理错误消息
   */
  handleError(data) {
    const errorMsg = data.error || 'Server Error';
    const details = data.details || data.message || '未知错误';
    console.error('收到服务器错误:', errorMsg, details);
    
    this.page.setData({ 
      isConnecting: false,
      isGenerating: false
    });
    
    let messages = [...this.page.data.messages];
    const beforeCount = messages.length;
    messages = messages.filter(msg => !msg.isLoading);
    const removedCount = beforeCount - messages.length;
    if (removedCount > 0) {
      console.log(`错误处理：已移除 ${removedCount} 个加载消息`);
      this.page.setData({ messages });
    }
    
    wx.showToast({ 
      title: "服务器错误: " + data.details, 
      icon: "none",
      duration: 3000
    });
  }

  /**
   * 发送消息
   */
  send(data) {
    if (!this.socketTask) {
      console.error('WebSocket 未连接');
      return false;
    }

    try {
      this.socketTask.send({
        data: JSON.stringify(data)
      });
      return true;
    } catch (error) {
      console.error('发送消息失败:', error);
      return false;
    }
  }

  /**
   * 重连逻辑
   */
  reconnect() {
    if (this.page.isPageUnloaded || this.page.isPageHidden) {
      console.log('页面已卸载或隐藏，停止重连');
      return;
    }
    
    if (this.reconnectCount < this.maxReconnects) {
      this.reconnectCount++;
      
      const delay = Math.min(1000 * Math.pow(2, this.reconnectCount - 1), 30000);
      console.log(`WebSocket将在${delay}ms后重连，第${this.reconnectCount}次重连`);
      
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }
      
      this.reconnectTimer = setTimeout(() => {
        if (this.page.isPageUnloaded || this.page.isPageHidden) {
          console.log('重连前检查：页面已卸载或隐藏，取消重连');
          return;
        }
        console.log(`开始第${this.reconnectCount}次重连`);
        this.connect();
      }, delay);
    } else {
      wx.showToast({ title: "连接失败，请稍后再试", icon: "none" });
    }
  }

  /**
   * 设置响应超时
   */
  setResponseTimeout(callback, timeout = 60000) {
    if (this.responseTimeoutId) {
      clearTimeout(this.responseTimeoutId);
    }
    
    this.responseTimeoutId = setTimeout(callback, timeout);
  }

  /**
   * 清除响应超时
   */
  clearResponseTimeout() {
    if (this.responseTimeoutId) {
      clearTimeout(this.responseTimeoutId);
      this.responseTimeoutId = null;
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    // 强制清理所有录音相关状态
    this.page.setData({ 
      socketTask: null,
      isConnecting: false,
      // 强制关闭所有录音相关状态
      showVoiceModal: false,
      isInputRecording: false,
      isRecording: false,
      isRecordingCanceling: false,
      isStreamingSpeech: false,
      isGenerating: false
    });
    
    // 取消流式语音识别会话
    if (this.page.streamingSpeechManager) {
      this.page.streamingSpeechManager.cancelSession();
    }
    
    if (this.socketTask) {
      this.socketTask.close();
      this.socketTask = null;
    }
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.clearResponseTimeout();
  }
}

module.exports = WebSocketManager;