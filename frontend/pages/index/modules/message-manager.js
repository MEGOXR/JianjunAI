/**
 * Message Manager Module
 * 处理消息收发、流式渲染、本地存储
 */
class MessageManager {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.messageCount = 0;
    
    // 流式渲染控制器
    this._stream = { 
      buf: '',
      timer: null,
      targetIndex: null
    };
  }

  /**
   * 发送消息
   */
  sendMessage() {
    if (!this.page.data.userInput || this.page.data.isConnecting) return;
    
    this.messageCount++;
    this.page.setData({ messageCount: this.messageCount });
    
    // 重置滚动状态
    this.page.scrollController.resetSmartPause();
    this.page.setData({
      userHasScrolledUp: false,
      showScrollToBottom: false
    });

    const userMessageContent = this.page.data.userInput;
    const newUserMessage = this.createUserMessage(userMessageContent);
    const loadingMessage = this.createLoadingMessage();
    
    this.page.setData({
      messages: this.page.data.messages.concat([newUserMessage, loadingMessage]),
      userInput: "",
      isConnecting: true,
      isGenerating: true
    }, () => {
      this.page.scrollController.scrollToBottom(true);
    });
    
    this.sendToWebSocket(userMessageContent);
    this.setResponseTimeout();
  }

  /**
   * 发送语音消息
   */
  sendVoiceMessage(text) {
    // 重置滚动状态
    this.page.scrollController.resetSmartPause();
    this.page.setData({
      userHasScrolledUp: false,
      showScrollToBottom: false
    });

    const newUserMessage = this.createUserMessage(text);
    
    this.page.setData({
      messages: this.page.data.messages.concat(newUserMessage)
    }, () => {
      this.page.scrollController.scheduleAutoScroll();
    });
    
    this.sendToWebSocket(text);
  }

  /**
   * 处理流式数据
   */
  handleStreamingData(data) {
    // 清除响应超时计时器
    this.page.webSocketManager.clearResponseTimeout();
    
    // 如果是第一个分片，创建AI消息
    if (this._stream.targetIndex == null) {
      this.createAIMessage();
    }
    
    // 将数据放入缓冲区
    this._stream.buf += data.data;

    // 节流刷新UI
    if (!this._stream.timer) {
      this._stream.timer = setTimeout(() => this.flushStream(), 80);
    }
  }

  /**
   * 处理流式完成
   */
  handleStreamingComplete(data) {
    // 立即刷新剩余内容
    if (this._stream.timer) clearTimeout(this._stream.timer);
    this.flushStream();
    
    const lastIndex = this._stream.targetIndex;

    // 更新最终状态
    if (lastIndex != null) {
      const updateData = { 
        isConnecting: false,
        isGenerating: false
      };
      if (data.suggestions && data.suggestions.length > 0) {
        updateData[`messages[${lastIndex}].suggestions`] = data.suggestions;
      }
      this.page.setData(updateData);
    }
    
    // 重置流控制器
    this._stream.targetIndex = null;
    
    // 保存到本地存储
    wx.setStorageSync('messages', this.trimMessages(this.page.data.messages));
    
    console.log('消息接收完成');
    
    // 清除响应超时
    this.page.webSocketManager.clearResponseTimeout();
    
    // 智能滚动处理
    this.handleCompletionScrolling();
  }

  /**
   * 刷新流式内容到UI
   */
  flushStream() {
    if (this._stream.buf && this._stream.targetIndex != null) {
      const idx = this._stream.targetIndex;
      const mergedContent = this.page.data.messages[idx].content + this._stream.buf;
      this._stream.buf = '';
      
      this.page.setData({
        [`messages[${idx}].content`]: mergedContent
      }, () => {
        this.page.scrollController.handleStreamingScroll(idx, mergedContent);
      });
    }
    this._stream.timer = null;
  }

  /**
   * 创建用户消息
   */
  createUserMessage(content) {
    const app = getApp();
    const newUserMessage = {
      role: 'user',
      content: content,
      timestamp: Date.now()
    };

    // 计算时间显示
    const lastMessage = this.page.data.messages.length > 0 ? 
      this.page.data.messages[this.page.data.messages.length - 1] : null;
    const lastTimestamp = lastMessage ? lastMessage.timestamp : null;
    const timeDiff = lastTimestamp ? (newUserMessage.timestamp - lastTimestamp) : null;
    const shouldShowTime = !lastTimestamp || timeDiff > 5 * 60 * 1000;
    
    if (shouldShowTime) {
      this.setMessageTimeDisplay(newUserMessage);
    } else {
      newUserMessage.formattedDate = '';
    }
    newUserMessage.formattedTime = app.getFormattedTime(newUserMessage.timestamp);

    return newUserMessage;
  }

  /**
   * 创建加载消息
   */
  createLoadingMessage() {
    return {
      role: 'assistant',
      content: '',
      isLoading: true,
      timestamp: Date.now(),
      id: 'loading-' + Date.now()
    };
  }

  /**
   * 创建AI消息
   */
  createAIMessage() {
    // 移除所有加载消息
    let currentMessages = [...this.page.data.messages];
    const beforeCount = currentMessages.length;
    currentMessages = currentMessages.filter(msg => !msg.isLoading);
    const removedCount = beforeCount - currentMessages.length;
    if (removedCount > 0) {
      console.log(`已移除 ${removedCount} 个加载消息`);
    }
    
    this.page.setData({ 
      messages: currentMessages,
      isGenerating: false 
    });
    
    const app = getApp();
    const msg = { 
      role: 'assistant', 
      content: '', 
      timestamp: Date.now(), 
      suggestions: [] 
    };
    
    // 设置时间显示
    this.setMessageTimeDisplay(msg, currentMessages);
    msg.formattedTime = app.getFormattedTime(msg.timestamp);
    
    currentMessages.push(msg);
    const idx = currentMessages.length - 1;
    this.page.setData({ 
      messages: currentMessages,
      isConnecting: true 
    });
    this._stream.targetIndex = idx;
  }

  /**
   * 设置消息时间显示
   */
  setMessageTimeDisplay(message, messageList = null) {
    const app = getApp();
    const messages = messageList || this.page.data.messages;
    
    const lastMessage = messages.length > 0 ? 
      messages[messages.length - 1] : null;
    const lastTimestamp = lastMessage ? lastMessage.timestamp : null;
    
    const timeDiff = lastTimestamp ? (message.timestamp - lastTimestamp) : null;
    const shouldShowTime = !lastTimestamp || timeDiff > 5 * 60 * 1000;
    
    if (shouldShowTime) {
      const now = new Date();
      const messageDate = new Date(message.timestamp);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const messageDay = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
      const daysDiff = Math.floor((today.getTime() - messageDay.getTime()) / (24 * 60 * 60 * 1000));
      
      if (daysDiff === 0) {
        message.formattedDate = app.getFormattedTime(message.timestamp);
      } else if (daysDiff === 1) {
        message.formattedDate = `昨天 ${app.getFormattedTime(message.timestamp)}`;
      } else {
        const month = messageDate.getMonth() + 1;
        const day = messageDate.getDate();
        message.formattedDate = `${month}月${day}日 ${app.getFormattedTime(message.timestamp)}`;
      }
    } else {
      message.formattedDate = '';
    }
  }

  /**
   * 发送到WebSocket
   */
  sendToWebSocket(content) {
    const success = this.page.webSocketManager.send({
      prompt: content
    });
    
    if (!success) {
      wx.showToast({ title: "发送失败", icon: "none" });
      this.page.setData({ isConnecting: false });
    }
  }

  /**
   * 设置响应超时
   */
  setResponseTimeout() {
    this.page.webSocketManager.setResponseTimeout(() => {
      if (this.page.data.isConnecting) {
        console.log('响应超时，重置isConnecting状态');
        this.page.setData({ isConnecting: false });
        console.warn('检测到长时间响应，已重置连接状态但保持消息接收');
      }
    }, 60000);
  }

  /**
   * 处理完成时的滚动
   */
  handleCompletionScrolling() {
    if (!this.page.data.userHasScrolledUp && !this.page.scrollController.hasSmartPaused) {
      console.log('📝 AI回复完成，自动滚动到底部');
      setTimeout(() => {
        this.page.scrollController.forceScrollToBottom();
      }, 150);
    } else {
      console.log('📝 AI回复完成，保持当前位置', {
        用户已上滑: this.page.data.userHasScrolledUp,
        智能暂停: this.page.scrollController.hasSmartPaused
      });
    }
  }

  /**
   * 格式化消息列表
   */
  formatMessages(messages) {
    const app = getApp();
    const newMessages = [];
    let lastMessageTimestamp = null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const weekStart = new Date(today);
    const curDay = now.getDay() === 0 ? 7 : now.getDay();
    weekStart.setDate(today.getDate() - (curDay - 1));

    messages.forEach((msg, index) => {
      const currentTimestamp = msg.timestamp;
      const messageDate = new Date(currentTimestamp);
      const messageDay = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
      let formattedDate = '';
      const formattedTime = app.getFormattedTime(currentTimestamp);

      const timeDiff = currentTimestamp - (lastMessageTimestamp || 0);
      const shouldShowTime = !lastMessageTimestamp || timeDiff > 5 * 60 * 1000;

      if (shouldShowTime) {
        const daysDiff = Math.floor((today.getTime() - messageDay.getTime()) / (24 * 60 * 60 * 1000));
        
        if (daysDiff === 0) {
          formattedDate = formattedTime;
        } else if (daysDiff === 1) {
          formattedDate = `昨天 ${formattedTime}`;
        } else if (daysDiff <= 6 && messageDay >= weekStart) {
          const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
          formattedDate = `星期${weekDays[messageDate.getDay()]} ${formattedTime}`;
        } else if (messageDate.getFullYear() === now.getFullYear()) {
          const month = messageDate.getMonth() + 1;
          const day = messageDate.getDate();
          formattedDate = `${month}月${day}日 ${formattedTime}`;
        } else {
          const year = messageDate.getFullYear();
          const month = messageDate.getMonth() + 1;
          const day = messageDate.getDate();
          formattedDate = `${year}年${month}月${day}日 ${formattedTime}`;
        }
      }
      
      newMessages.push({
        ...msg,
        formattedDate,
        formattedTime,
      });
      
      lastMessageTimestamp = currentTimestamp;
    });
    return newMessages;
  }

  /**
   * 裁剪消息历史
   */
  trimMessages(list, limit = 100) {
    if (list.length <= limit) return list;
    return list.slice(-limit);
  }

  /**
   * 处理建议问题点击
   */
  onSuggestionTap(e) {
    const { question, msgIndex } = e.currentTarget.dataset;
    if (!question) return;
    
    console.log('用户点击建议问题:', question);
    
    // 立即隐藏建议问题
    this.page.setData({
      [`messages[${msgIndex}].suggestions`]: []
    }, () => {
      this.page.setData({
        userInput: question
      }, () => {
        this.sendMessage();
      });
    });
    
    // 更新本地存储
    const messages = this.page.data.messages;
    if (messages[msgIndex] && messages[msgIndex].suggestions) {
      messages[msgIndex].suggestions = [];
      wx.setStorageSync('messages', messages);
    }
  }

  /**
   * 加载历史消息
   */
  loadHistoryMessages() {
    let savedMessages = wx.getStorageSync('messages') || [];
    
    // 清理残留的加载消息
    const beforeCount = savedMessages.length;
    savedMessages = savedMessages.filter(msg => !msg.isLoading);
    if (beforeCount > savedMessages.length) {
      console.log(`启动时清理了 ${beforeCount - savedMessages.length} 个残留的加载消息`);
      wx.setStorageSync('messages', savedMessages);
    }
    
    return this.trimMessages(this.formatMessages(savedMessages));
  }

  /**
   * 清理资源
   */
  cleanup() {
    if (this._stream.timer) {
      clearTimeout(this._stream.timer);
      this._stream.timer = null;
    }
    
    this._stream = { 
      buf: '',
      timer: null,
      targetIndex: null
    };
  }
}

module.exports = MessageManager;