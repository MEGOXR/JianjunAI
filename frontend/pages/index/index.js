Page({
  data: {
    userInput: "", 
    isFocused: false,
    isConnecting: false, 
    socketTask: null, 
    messages: [], 
    userId: null, 
    lastMsgId: "",
    isVoiceMode: true,
    isRecording: false,
    showScrollToBottom: false,
    userScrolling: false,
    chatHistoryHeight: 0
  },

  onLoad: function() {
    // Get user ID from storage or generate new one
    const userId = wx.getStorageSync('userId');
    this.setData({ 
      userId: userId || `user_${Date.now()}`
    });
    
    // Setup WebSocket connection
    this.setupWebSocket();

    // Load messages from storage
    const messages = wx.getStorageSync('messages') || [];
    this.setData({ 
      messages: this.formatMessages(messages),
      lastMsgId: messages.length > 0 ? `msg-${messages.length - 1}` : '' 
    }, () => {
      this.scrollToBottom();
    });
  },

  // Add necessary permissions to app.json
  /* Add to app.json:
  {
    "requiredPrivateInfos": [
      "getRecorderManager"
    ],
    "permission": {
      "scope.record": {
        "desc": "需要使用您的录音功能"
      }
    }
  }
  */

  // Rest of your existing methods...
  onShow: function() {
    this.scrollToBottom();
  },

  scrollToBottom: function() {
    setTimeout(() => {
      // 只需要一个查询就够了
      wx.createSelectorQuery()
        .select('.chat-history')
        .scrollOffset((res) => {
          if (res) {
            this.setData({
              lastMsgId: `msg-${this.data.messages.length - 1}`,
              scrollTop: res.scrollHeight + 1000
            });
          }
        }).exec();
    }, 100);
  },

  // 建立 WebSocket 连接
  setupWebSocket: function () {
    if (this.data.socketTask) return;
  
    const wsUrl = `${getApp().globalData.wsBaseUrl}/api`;
    const socketTask = wx.connectSocket({
      url: wsUrl,
      header: { "User-Id": this.data.userId },
    });
  
    let reconnectCount = 0; // 重连计数
  
    const reconnect = () => {
      if (reconnectCount < 5) { // 最多重连5次
        reconnectCount++;
        setTimeout(() => this.setupWebSocket(), 3000);
      } else {
        wx.showToast({ title: "连接失败，请稍后再试", icon: "none" });
      }
    };
  
    socketTask.onOpen(() => {
      this.setData({ socketTask });
      console.log("WebSocket 连接成功");
      reconnectCount = 0; // 重置重连计数
    });
  
    socketTask.onMessage((res) => {
      const data = JSON.parse(res.data);
      let newMessages = [...this.data.messages];
    
      if (data.data) {
        if (newMessages.length === 0 || newMessages[newMessages.length - 1].role !== 'assistant') {
          // 创建新的AI消息
          const newAiMessage = {
            role: 'assistant',
            content: data.data,
            timestamp: Date.now()
          };
          newMessages.push(newAiMessage);
        } else {
          // 更新现有AI消息
          newMessages[newMessages.length - 1].content += data.data;
        }
    
        // 每次收到消息都更新本地存储
        wx.setStorageSync('messages', newMessages);
        
        this.setData({
          messages: this.formatMessages(newMessages),
          lastMsgId: `msg-${newMessages.length - 1}`
        }, () => {
          // Add immediate scroll after message update
          this.scrollToBottom();
        });

        // Add TTS for AI responses
        if (this.data.isVoiceMode) {
          this.speakAIResponse(data.data);
        }
      }
    
      if (data.done) {
        // 确保最终的消息被保存
        wx.setStorageSync('messages', newMessages);
        this.setData({ isConnecting: false });
        // Add final scroll after completion
        setTimeout(() => this.scrollToBottom(), 300);
      }
    });
  
    socketTask.onClose(() => {
      this.setData({ socketTask: null });
      reconnect();
    });
  
    socketTask.onError((error) => {
      console.error("WebSocket 错误:", error);
      this.setData({ socketTask: null });
      wx.showToast({ title: "连接错误", icon: "none" });
      reconnect();
    });
  
    this.setData({ socketTask });
  },

  // 监听输入
  bindInput: function (e) {
    this.setData({ userInput: e.detail.value });
  },

  // 发送消息
  sendMessage: function () {
    if (!this.data.userInput) {
      wx.showToast({ title: "请输入内容", icon: "none" });
      return;
    }
  
    if (this.data.isConnecting || !this.data.socketTask) {
      wx.showToast({ title: "正在连接服务器...", icon: "none" });
      return;
    }
  
    this.setData({ isConnecting: true });
  
    this.data.socketTask.send({
      data: JSON.stringify({ prompt: this.data.userInput }),
      success: () => {
        const newMessages = [...this.data.messages, {
          role: 'user',
          content: this.data.userInput,
          timestamp: Date.now() // 添加时间戳
        }];
        this.setData({
          messages: newMessages,
          lastMsgId: `msg-${newMessages.length - 1}`,
          userInput: "",
          isConnecting: false,
        });
        wx.setStorageSync('messages', newMessages); // 保存到本地缓存
      },
      fail: () => {
        wx.showToast({ title: "发送失败", icon: "none" });
        this.setData({ isConnecting: false });
      },
    });
  },

  // 页面卸载时关闭 WebSocket
  onUnload: function () {
    if (this.data.socketTask) this.data.socketTask.close();
  },

  formatMessages: function(messages) {
    const app = getApp();
    const newMessages = [];
    let lastMessageTimestamp = null;
    const now = new Date();
    // 构造当天零点
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // 构造昨天零点
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    // 构造本周起始日期（以周一为第一天）
    const weekStart = new Date(today);
    // 如果今天是星期天（getDay()为0），则按周一推算
    const curDay = now.getDay() === 0 ? 7 : now.getDay();
    weekStart.setDate(today.getDate() - (curDay - 1));
  
    messages.forEach((msg, index) => {
      const currentTimestamp = msg.timestamp;
      const messageDate = new Date(currentTimestamp);
      // 获取消息的日期部分（零点时间）
      const messageDay = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
      let formattedDate = '';
      const formattedTime = app.getFormattedTime(currentTimestamp);
  
      // 仅当首次消息或与上一条消息的间隔超过30分钟时，插入时间戳显示
      if (!lastMessageTimestamp || (currentTimestamp - lastMessageTimestamp) > 30 * 60 * 1000) {
        if (messageDay.getTime() === today.getTime()) {
          // 今天：只显示时间
          formattedDate = formattedTime;
        } else if (messageDay.getTime() === yesterday.getTime()) {
          // 昨天：显示"昨天"+时间
          formattedDate = `昨天 ${formattedTime}`;
        } else if (messageDay >= weekStart) {
          // 同一周内：显示星期几+时间
          const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
          formattedDate = `星期${weekDays[messageDate.getDay()]} ${formattedTime}`;
        } else {
          // 本周之前：显示具体日期+时间
          formattedDate = `${app.getFormattedDate(currentTimestamp)} ${formattedTime}`;
        }
      }
      
      // 如果是AI消息，处理电话号码
      if (msg.role === 'assistant') {
        // 匹配电话号码的正则表达式
        const phoneRegex = /(\d{3,4}[-\s]?\d{3,4}[-\s]?\d{4}|\d{11})/g;
        
        // 将消息分段，分离出电话号码和普通文本
        const segments = [];
        let lastIndex = 0;
        let match;
        
        while ((match = phoneRegex.exec(msg.content)) !== null) {
          // 添加电话号码前的文本
          if (match.index > lastIndex) {
            segments.push({
              type: 'text',
              content: msg.content.slice(lastIndex, match.index)
            });
          }
          // 添加电话号码
          segments.push({
            type: 'phone',
            content: match[0],
            number: match[0].replace(/[-\s]/g, '')
          });
          lastIndex = match.index + match[0].length;
        }
        
        // 添加最后一段文本
        if (lastIndex < msg.content.length) {
          segments.push({
            type: 'text',
            content: msg.content.slice(lastIndex)
          });
        }
        
        newMessages.push({
          ...msg,
          segments,
          formattedDate,
          formattedTime
        });
      } else {
        newMessages.push({
          ...msg,
          formattedDate,
          formattedTime,
        });
      }
      
      lastMessageTimestamp = currentTimestamp;
    });
    return newMessages;
  },

  handleFocus: function() {
    this.scrollToBottom();
    
  },

  switchToVoice: function() {
    this.setData({ isVoiceMode: true });
  },

  switchToText: function() {
    this.setData({ isVoiceMode: false });
  },

  startRecording: function() {
    // Request recording permission first
    wx.authorize({
      scope: 'scope.record',
      success: () => {
        const recorderManager = wx.getRecorderManager();
        
        recorderManager.onStart(() => {
          this.setData({ isRecording: true });
          wx.showToast({
            title: '正在录音...',
            icon: 'none',
            duration: 60000
          });
        });

        recorderManager.start({
          duration: 60000,
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 48000,
          format: 'mp3'
        });
      },
      fail: () => {
        wx.showModal({
          title: '提示',
          content: '请允许使用录音功能',
          success: (res) => {
            if (res.confirm) {
              wx.openSetting();
            }
          }
        });
      }
    });
  },

  stopRecording: function() {
    if (!this.data.isRecording) return;
    
    const recorderManager = wx.getRecorderManager();
    
    recorderManager.onStop((res) => {
      wx.hideToast();
      this.setData({ isRecording: false });
      
      // Upload audio file and get text
      this.uploadVoice(res.tempFilePath);
    });

    recorderManager.stop();
  },

  cancelRecording: function(e) {
    if (e.touches[0].clientY < e.currentTarget.offsetTop - 50) {
      wx.showToast({ title: '松开手指，取消发送', icon: 'none' });
      this.setData({ isRecording: false });
      wx.getRecorderManager().stop();
    }
  },

  uploadVoice: function(tempFilePath) {
    wx.showLoading({ title: '识别中...' });
    
    // Upload the voice file to your server
    wx.uploadFile({
      url: `${getApp().globalData.wsBaseUrl}/voice`,
      filePath: tempFilePath,
      name: 'file',
      success: (res) => {
        const text = JSON.parse(res.data).text;
        this.sendVoiceMessage(text);
      },
      fail: () => {
        wx.showToast({ title: '语音识别失败', icon: 'none' });
      },
      complete: () => {
        wx.hideLoading();
      }
    });
  },

  sendVoiceMessage: function(text) {
    // Send the recognized text as a message
    const newMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now()
    };
    
    const newMessages = [...this.data.messages, newMessage];
    this.setData({
      messages: this.formatMessages(newMessages),
      lastMsgId: `msg-${newMessages.length - 1}`
    });
    
    // Send to websocket
    if (this.data.socketTask) {
      this.data.socketTask.send({
        data: JSON.stringify({ prompt: text })
      });
    }
  },

  // Add text-to-speech for AI responses
  speakAIResponse: function(text) {
    const innerAudioContext = wx.createInnerAudioContext();
    
    // Get audio URL from your TTS service
    const audioUrl = `${getApp().globalData.wsBaseUrl}/tts?text=${encodeURIComponent(text)}`;
    
    innerAudioContext.src = audioUrl;
    innerAudioContext.play();
  },

  // 处理点击事件
  handleLinkTap: function(e) {
    const phoneNumber = e.currentTarget.dataset.phone;
    if (phoneNumber) {
      wx.showActionSheet({
        itemList: ['拨打电话', '复制号码'],
        success: (res) => {
          if (res.tapIndex === 0) {
            // 拨打电话
            wx.makePhoneCall({
              phoneNumber: phoneNumber,
              fail: (err) => {
                wx.showToast({
                  title: '拨号失败',
                  icon: 'none'
                });
              }
            });
          } else if (res.tapIndex === 1) {
            // 复制号码
            wx.setClipboardData({
              data: phoneNumber,
              success: () => {
                wx.showToast({
                  title: '已复制号码',
                  icon: 'success'
                });
              }
            });
          }
        }
      });
    }
  },
  onShareAppMessage: function () {
    return {
      title: '避开整容坑！与AI医美专家直接聊！',
      path: '/pages/index/index',
      //imageUrl: '/images/share.png'  // 可选，自定义分享图片
    }
  },

  onShareTimeline: function () {
    return {
      title: '避开整容坑！与AI医美专家直接聊！',
      query: '',
      imageUrl: '' // 可选，自定义分享图片
    }
  },

  // 滚动事件处理
  onScroll: function(e) {
    // 获取当前滚动位置和容器高度
    const scrollTop = e.detail.scrollTop;
    const scrollHeight = e.detail.scrollHeight;
    
    // 使用系统信息获取实际视口高度
    const systemInfo = wx.getSystemInfoSync();
    const clientHeight = systemInfo.windowHeight - 100; // 减去输入框等其他元素的高度
    
    // 判断是否滚动到距离底部超过一定距离
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    console.log("滚动信息:", {
      scrollTop,
      scrollHeight,
      clientHeight,
      distanceFromBottom
    });
    
    // 只有当距离底部超过150px时才显示按钮
    if (distanceFromBottom > 150) {
      this.setData({ showScrollToBottom: true });
      console.log("显示回到底部按钮");
    } else {
      this.setData({ showScrollToBottom: false });
      console.log("隐藏回到底部按钮");
    }
  },

  // 在页面加载时获取聊天区域的实际高度
  onReady: function() {
    // 获取聊天区域的实际高度
    wx.createSelectorQuery()
      .select('.chat-history')
      .boundingClientRect(rect => {
        if (rect) {
          this.chatHistoryHeight = rect.height;
          console.log("聊天区域高度:", this.chatHistoryHeight);
        }
      }).exec();
  }
});
