/**
 * Message Manager Module
 * 处理消息收发、流式渲染、本地存储
 */

// 加载文案轮播列表
const LOADING_TEXTS = [
  "杨院长正在分析您的问题...",
  "正在查阅专业资料...",
  "正在整理思路...",
  "准备详细回复中...",
  "马上就好...",
  "正在组织语言..."
];

const markdown = require('../../../utils/markdown.js');

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

    // 文案轮播控制器
    this._loadingTextRotation = {
      timer: null,           // 轮播计时器
      currentIndex: 0,       // 当前文案索引
      messageIndex: null     // 当前加载消息的索引
    };
  }

  /**
   * 发送消息
   */
  async sendMessage() {
    const hasText = this.page.data.userInput && this.page.data.userInput.trim();
    const hasImages = this.page.data.selectedImages.length > 0;

    // 必须有文本或图片才能发送
    if (!hasText && !hasImages) return;
    if (this.page.data.isConnecting) return;

    this.messageCount++;
    this.page.setData({ messageCount: this.messageCount });

    // 重置滚动状态
    this.page.scrollController.resetSmartPause();
    this.page.setData({
      userHasScrolledUp: false,
      showScrollToBottom: false
    });

    const userMessageContent = this.page.data.userInput || '';
    const selectedImages = [...this.page.data.selectedImages];

    // 创建用户消息，传入图片路径
    const newUserMessage = this.createUserMessage(userMessageContent, selectedImages);
    const loadingMessage = this.createLoadingMessage();

    this.page.setData({
      messages: this.page.data.messages.concat([newUserMessage, loadingMessage]),
      userInput: "",
      selectedImages: [],  // 清空已选图片
      uploadingImages: [],  // 清空上传中图片
      isConnecting: true,
      isGenerating: true
    }, () => {
      this.page.scrollController.scrollToBottom(true);
    });

    // 启动加载文案轮播（加载消息是最后一个消息）
    const loadingMessageIndex = this.page.data.messages.length - 1;
    this.startLoadingTextRotation(loadingMessageIndex);

    // 如果有图片，转换为 base64 后发送
    if (selectedImages.length > 0) {
      await this.sendMessageWithImages(userMessageContent, selectedImages);
    } else {
      this.sendToWebSocket(userMessageContent);
    }

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
      // 停止文案轮播
      this.stopLoadingTextRotation();

      this.createAIMessage();
    }

    // 将数据放入缓冲区
    this._stream.buf += data.data;

    // 优化：如果是首个数据包，立即刷新，减少首字等待感
    if (this._stream.targetIndex != null && this.page.data.messages[this.page.data.messages.length - 1].content === '') {
      if (this._stream.timer) clearTimeout(this._stream.timer);
      this.flushStream();
      return;
    }

    // 节流刷新UI (从40ms增加到100ms，减少setData频率，避免界面卡顿)
    // 后端已经有了 StreamSmoother，前端不需要过度频繁刷新
    if (!this._stream.timer) {
      this._stream.timer = setTimeout(() => this.flushStream(), 100);
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
        console.log('🎯 收到建议问题:', data.suggestions);
        updateData[`messages[${lastIndex}].suggestions`] = data.suggestions;
      } else {
        console.log('❌ 没有收到建议问题或建议问题为空');
      }
      this.page.setData(updateData);
    }

    // 重置流控制器
    this._stream.targetIndex = null;

    // 保存到本地存储
    wx.setStorageSync('messages', this.trimMessages(this.page.data.messages));

    console.log('消息接收完成');

    // 触发AI回复完成的TTS处理
    if (lastIndex != null) {
      const completedMessage = this.page.data.messages[lastIndex];
      if (completedMessage && completedMessage.type === 'ai') {
        this.page.onAIResponseComplete(completedMessage);
      }
    }

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

      // 解析 Markdown
      const parsedContent = markdown.parse(mergedContent);

      this.page.setData({
        [`messages[${idx}].content`]: mergedContent,
        [`messages[${idx}].parsedContent`]: parsedContent
      }, () => {
        this.page.scrollController.handleStreamingScroll(idx, mergedContent);
      });
    }
    this._stream.timer = null;
  }

  /**
   * 创建用户消息
   * @param {string} content - 文本内容
   * @param {Array} images - 图片路径数组（可选）
   */
  createUserMessage(content, images = []) {
    const app = getApp();
    const newUserMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: 'user',
      content: content,
      timestamp: Date.now(),
      images: images  // 保存图片路径
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
      loadingText: LOADING_TEXTS[0], // 初始显示第一条文案
      timestamp: Date.now(),
      id: 'loading-' + Date.now()
    };
  }

  /**
   * 创建AI消息
   */
  createAIMessage() {
    // 停止文案轮播（如果还在运行）
    this.stopLoadingTextRotation();

    const app = getApp();
    const currentMessages = this.page.data.messages;

    // 寻找最后的加载消息索引
    const loadingIndex = currentMessages.findIndex(msg => msg.isLoading && msg.role === 'assistant');

    if (loadingIndex !== -1) {
      // ✅ 找到了加载消息，直接原地变身
      console.log(`♻️ 复用加载消息作为AI消息 (Index: ${loadingIndex})`);

      const msg = currentMessages[loadingIndex];

      // 更新该消息属性
      const updates = {
        [`messages[${loadingIndex}].isLoading`]: false,
        [`messages[${loadingIndex}].content`]: '',
        [`messages[${loadingIndex}].loadingText`]: null, // 清除轮播文案
        [`messages[${loadingIndex}].timestamp`]: Date.now(), // 更新为生成时间
        [`messages[${loadingIndex}].suggestions`]: [],
        isGenerating: false,
        isConnecting: true
      };

      // 重新计算时间显示（虽然通常还是接着上一条，但为了严谨）
      this.setMessageTimeDisplay(msg, currentMessages);
      updates[`messages[${loadingIndex}].formattedTime`] = app.getFormattedTime(msg.timestamp);
      updates[`messages[${loadingIndex}].formattedDate`] = msg.formattedDate;

      // 执行因地更新
      this.page.setData(updates);

      // 设置流式目标索引
      this._stream.targetIndex = loadingIndex;
    } else {
      // ⚠️ 没找到加载消息（罕见情况），降级为追加新消息
      console.warn('⚠️ 未找到加载消息，创建新AI消息');

      const msg = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        suggestions: []
      };

      this.setMessageTimeDisplay(msg, currentMessages);
      msg.formattedTime = app.getFormattedTime(msg.timestamp);

      const newMessages = [...currentMessages, msg];
      this.page.setData({
        messages: newMessages,
        isGenerating: false,
        isConnecting: true
      });

      this._stream.targetIndex = newMessages.length - 1;
    }
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
   * 发送带图片的消息
   */
  async sendMessageWithImages(content, imagePaths) {
    try {
      wx.showLoading({ title: '处理图片中...' });

      // 将图片转换为 base64
      const base64Images = await this.page.imageManager.convertImagesToBase64(imagePaths);

      wx.hideLoading();
      console.log('图片转换完成，共', base64Images.length, '张');

      // 发送包含图片的消息
      const success = this.page.webSocketManager.send({
        prompt: content,
        images: base64Images
      });

      if (!success) {
        wx.showToast({ title: "发送失败", icon: "none" });
        this.page.setData({ isConnecting: false });
      }
    } catch (error) {
      wx.hideLoading();
      console.error('处理图片失败:', error);
      wx.showToast({ title: "处理图片失败", icon: "none" });
      this.page.setData({ isConnecting: false });
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
        parsedContent: msg.role === 'assistant' ? markdown.parse(msg.content) : null,
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
   * 处理建议问题消息
   */
  handleSuggestions(suggestions) {
    if (!suggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
      console.log('❌ 建议问题为空或无效:', suggestions);
      return;
    }

    // 前端防御性过滤：排除可能是格式说明或系统指令的内容
    const blacklist = ['需要生成', '不需要生成', '无需生成', 'suggestions', 'questions', '问题1', '问题2'];
    const validSuggestions = suggestions.filter(s =>
      typeof s === 'string' &&
      s.length >= 4 &&
      s.length <= 20 &&
      !blacklist.some(word => s.includes(word))
    );

    if (validSuggestions.length === 0) {
      console.log('❌ 过滤后建议问题为空:', suggestions);
      return;
    }

    console.log('✅ 处理建议问题:', validSuggestions);

    // 找到最后一条AI消息
    const messages = this.page.data.messages;
    let lastAiMessageIndex = -1;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && !messages[i].isLoading) {
        lastAiMessageIndex = i;
        break;
      }
    }

    if (lastAiMessageIndex >= 0) {
      console.log(`📍 在消息索引 ${lastAiMessageIndex} 添加建议问题:`, validSuggestions);
      this.page.setData({
        [`messages[${lastAiMessageIndex}].suggestions`]: validSuggestions
      });

      // 更新本地存储
      const updatedMessages = [...messages];
      updatedMessages[lastAiMessageIndex].suggestions = validSuggestions;
      wx.setStorageSync('messages', updatedMessages);
    } else {
      console.log('❌ 没有找到适合添加建议问题的AI消息');
    }
  }

  /**
   * 处理建议问题点击
   */
  onSuggestionTap(e) {
    const { question, msgIndex } = e.currentTarget.dataset;
    if (!question) return;

    console.log('用户点击建议问题:', question);

    // 优化：合并 setData，减少渲染次数
    this.page.setData({
      [`messages[${msgIndex}].suggestions`]: [], // 立即隐藏
      userInput: question // 设置输入
    }, () => {
      // 这里的回调表示 UI 已经更新（建议消失，输入框有字）
      // 立即发送
      this.sendMessage();
    });

    // 更新本地存储 (异步)
    setTimeout(() => {
      const messages = this.page.data.messages;
      if (messages[msgIndex] && messages[msgIndex].suggestions) {
        messages[msgIndex].suggestions = [];
        wx.setStorageSync('messages', messages);
      }
    }, 0);
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

    // 清理文案轮播定时器
    this.stopLoadingTextRotation();
  }

  /**
   * 启动加载文案轮播
   */
  startLoadingTextRotation(messageIndex) {
    // 先停止之前的轮播（如果有）
    this.stopLoadingTextRotation();

    this._loadingTextRotation.messageIndex = messageIndex;
    this._loadingTextRotation.currentIndex = 0;

    // 每 2 秒切换一次文案
    this._loadingTextRotation.timer = setInterval(() => {
      this._loadingTextRotation.currentIndex =
        (this._loadingTextRotation.currentIndex + 1) % LOADING_TEXTS.length;

      const newText = LOADING_TEXTS[this._loadingTextRotation.currentIndex];

      this.page.setData({
        [`messages[${messageIndex}].loadingText`]: newText
      });
    }, 2000); // 2秒间隔
  }

  /**
   * 停止加载文案轮播
   */
  stopLoadingTextRotation() {
    if (this._loadingTextRotation.timer) {
      clearInterval(this._loadingTextRotation.timer);
      this._loadingTextRotation.timer = null;
      this._loadingTextRotation.messageIndex = null;
      this._loadingTextRotation.currentIndex = 0;
    }
  }
}

module.exports = MessageManager;