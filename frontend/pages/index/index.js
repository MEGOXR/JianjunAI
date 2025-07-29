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
    let userId = wx.getStorageSync('userId');
    if (!userId) {
      userId = `user_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      wx.setStorageSync('userId', userId);
    }
    
    // 临时清理本地存储（用于调试）
    console.log('清理本地消息存储');
    wx.removeStorageSync('messages');
    
    // 恢复聊天记录
    const savedMessages = wx.getStorageSync('messages') || [];
    
    this.setData({ 
      userId,
      messages: this.formatMessages(savedMessages)
    });
    
    // 检查是否已有用户信息，没有则尝试获取
    this.checkAndGetUserInfo();
    
    // Setup WebSocket connection
    this.setupWebSocket();
  },
  
  checkAndGetUserInfo: function() {
    // 先检查本地是否已保存用户信息
    const savedUserInfo = wx.getStorageSync('userInfo');
    if (savedUserInfo && savedUserInfo.nickName) {
      this.setData({
        wxNickname: savedUserInfo.nickName,
        wxAvatarUrl: savedUserInfo.avatarUrl
      });
      console.log('已使用保存的用户信息:', savedUserInfo.nickName);
      return;
    }
    
    // 如果没有保存的信息，静默尝试获取
    this.getUserInfo();
  },

  getUserInfo: function() {
    // 尝试获取用户信息
    wx.getUserProfile({
      desc: '用于提供个性化的医美咨询服务',
      success: (res) => {
        const userInfo = {
          nickName: res.userInfo.nickName,
          avatarUrl: res.userInfo.avatarUrl
        };
        
        // 保存用户信息到本地
        wx.setStorageSync('userInfo', userInfo);
        
        this.setData({
          wxNickname: userInfo.nickName,
          wxAvatarUrl: userInfo.avatarUrl
        });
        
        console.log('获取用户信息成功:', userInfo.nickName);
        wx.showToast({
          title: `欢迎 ${userInfo.nickName}`,
          icon: 'success',
          duration: 2000
        });
      },
      fail: (error) => {
        console.log('用户拒绝授权获取用户信息:', error);
        // 显示一个温馨的提示，而不是强制要求授权
        this.showUserInfoTip();
      }
    });
  },

  // 显示用户信息授权提示
  showUserInfoTip: function() {
    wx.showModal({
      title: '个性化服务',
      content: '授权微信昵称后，我们可以为您提供更个性化的医美咨询服务。您可以随时在设置中重新授权。',
      showCancel: true,
      cancelText: '暂不授权',
      confirmText: '去授权',
      success: (res) => {
        if (res.confirm) {
          // 用户点击"去授权"，再次尝试获取
          this.getUserInfo();
        } else {
          // 用户选择暂不授权，设置默认昵称
          this.setData({
            wxNickname: '用户'
          });
        }
      }
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

  scrollToBottom: function() {
    // 防抖处理，避免频繁滚动
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
    }
    
    this.scrollTimer = setTimeout(() => {
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
    }, 200); // 增加延迟时间
  },

  // 建立 WebSocket 连接
  setupWebSocket: function () {
    // 如果已有连接，先关闭
    if (this.data.socketTask) {
      this.data.socketTask.close();
      this.setData({ socketTask: null });
    }
  
    const wsUrl = `${getApp().globalData.wsBaseUrl}`;
    console.log('尝试连接WebSocket:', wsUrl);
    console.log('User-Id:', this.data.userId);
    console.log('Wx-Nickname:', this.data.wxNickname);
    
    const socketTask = wx.connectSocket({
      url: wsUrl,
      header: { 
        "user-id": this.data.userId,
        "wx-nickname": encodeURIComponent(this.data.wxNickname || '')
      },
    });
  
    let reconnectCount = 0; // 重连计数
    let reconnectTimer = null;
  
    const reconnect = () => {
      // 如果页面已卸载或隐藏，不要重连
      if (this.isPageUnloaded || this.isPageHidden) {
        console.log('页面已卸载或隐藏，停止重连');
        return;
      }
      
      if (reconnectCount < 5) { // 最多重连5次
        reconnectCount++;
        
        // 使用指数退避算法
        const delay = Math.min(1000 * Math.pow(2, reconnectCount - 1), 30000);
        console.log(`WebSocket将在${delay}ms后重连，第${reconnectCount}次重连`);
        
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
        }
        
        reconnectTimer = setTimeout(() => {
          // 再次检查页面状态
          if (this.isPageUnloaded || this.isPageHidden) {
            console.log('重连前检查：页面已卸载或隐藏，取消重连');
            return;
          }
          console.log(`开始第${reconnectCount}次重连`);
          this.setupWebSocket();
        }, delay);
      } else {
        wx.showToast({ title: "连接失败，请稍后再试", icon: "none" });
      }
    };
  
    socketTask.onOpen(() => {
      console.log("WebSocket 连接成功，准备发送初始化消息");
      reconnectCount = 0; // 重置重连计数
      
      // 清除重连定时器
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      
      // 发送初始化消息
      try {
        socketTask.send({
          data: JSON.stringify({
            type: 'init',
            wxNickname: this.data.wxNickname || ''
          })
        });
        console.log("初始化消息发送成功");
      } catch (error) {
        console.error("发送初始化消息失败:", error);
      }
    });
  
    socketTask.onMessage((res) => {
      console.log('接收到WebSocket消息:', res.data);
      const data = JSON.parse(res.data);
      let newMessages = [...this.data.messages]; // 在顶部声明
      
      // 处理问候消息
      if (data.type === 'greeting') {
        console.log('处理问候消息:', data.data);
        console.log('当前消息数量:', newMessages.length);
        
        // 检查是否已经有相同的问候消息（避免重复）
        // 只检查最近的问候消息，避免历史问候消息干扰
        const recentGreetings = newMessages.filter(msg => msg.isGreeting);
        const hasRecentGreeting = recentGreetings.length > 0 && recentGreetings[0].content === data.data;
        console.log('是否已有相同问候消息:', hasRecentGreeting, '问候消息数量:', recentGreetings.length);
        
        if (!hasRecentGreeting) {
          const greetingMessage = {
            role: 'assistant',
            content: data.data,
            timestamp: Date.now(),
            isGreeting: true
          };
          newMessages.unshift(greetingMessage);
          console.log('添加问候消息后，消息数量:', newMessages.length);
          
          const formattedMessages = this.formatMessages(newMessages);
          console.log('格式化后消息数量:', formattedMessages.length);
          
          this.setData({
            messages: formattedMessages,
            userId: data.userId || this.data.userId
          }, () => {
            console.log('问候消息setData完成');
            this.scrollToBottom();
          });
          
          // 保存到本地存储
          wx.setStorageSync('messages', newMessages);
        }
        return;
      }
      
      // 处理初始化消息
      if (data.type === 'init') {
        console.log('收到init消息，忽略');
        return;
      }
      
      // 处理错误消息
      if (data.error) {
        console.error('收到服务器错误:', data.error, data.details);
        this.setData({ isConnecting: false });
        wx.showToast({ 
          title: "服务器错误: " + data.details, 
          icon: "none",
          duration: 3000
        });
        return;
      }
      
      if (data.data) {
        console.log('接收到消息片段:', data.data);
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
        });

        // TTS will be handled when message is complete
        // Removed per-chunk TTS to avoid fragmented audio
      }
    
      if (data.done) {
        console.log('收到done标记，消息总数:', newMessages.length);
        // 确保最终的消息被保存
        wx.setStorageSync('messages', newMessages);
        this.setData({ isConnecting: false });
        console.log('消息接收完成，isConnecting已重置为false');
        
        // Play TTS for complete AI response if in voice mode
        if (this.data.isVoiceMode && newMessages.length > 0) {
          const lastMessage = newMessages[newMessages.length - 1];
          if (lastMessage.role === 'assistant') {
            // 暂时禁用 TTS，因为没有 TTS 服务端点
            // this.speakAIResponse(lastMessage.content);
            console.log('TTS 功能暂时禁用');
          }
        }
        
        // Add final scroll after completion only if user is near bottom
        if (!this.data.showScrollToBottom) {
          setTimeout(() => this.scrollToBottom(), 300);
        }
      }
    });
  
    socketTask.onClose((res) => {
      console.log("WebSocket 连接关闭 - 关闭码:", res.code, "关闭原因:", res.reason, "详细信息:", res);
      this.setData({ 
        socketTask: null,
        isConnecting: false // 重置连接状态
      });
      
      // 根据关闭码决定是否重连
      if (res.code === 1000) {
        console.log("正常关闭，不重连");
      } else {
        console.log(`异常关闭码 ${res.code}，延迟后重连`);
        // 增加延迟，给后端一些时间处理
        setTimeout(() => {
          if (!this.isPageUnloaded && !this.isPageHidden) {
            reconnect();
          }
        }, 2000);
      }
    });
  
    socketTask.onError((error) => {
      console.error("WebSocket 错误详情:", error);
      this.setData({ 
        socketTask: null,
        isConnecting: false // 重置连接状态
      });
      wx.showToast({ title: "连接错误", icon: "none" });
      
      // 延迟重连，避免立即重连
      console.log("发生错误，延迟后重连");
      setTimeout(() => {
        if (!this.isPageUnloaded && !this.isPageHidden) {
          reconnect();
        }
      }, 3000);
    });
  
    // 连接成功后再设置socketTask
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
  
    const userMessage = this.data.userInput; // 保存输入内容
    
    this.data.socketTask.send({
      data: JSON.stringify({ 
        prompt: userMessage,
        wxNickname: this.data.wxNickname || ''
      }),
      success: () => {
        const newMessages = [...this.data.messages, {
          role: 'user',
          content: userMessage,
          timestamp: Date.now() // 添加时间戳
        }];
        this.setData({
          messages: newMessages,
          lastMsgId: `msg-${newMessages.length - 1}`,
          userInput: "",
          isConnecting: true, // 发送成功后才设置为连接中
        });
        console.log('消息发送成功，isConnecting设置为true');
        wx.setStorageSync('messages', newMessages); // 保存到本地缓存
        
        // 添加超时机制，30秒后自动重置状态
        setTimeout(() => {
          if (this.data.isConnecting) {
            console.log('响应超时，重置isConnecting状态');
            this.setData({ isConnecting: false });
            wx.showToast({ title: "响应超时，请重试", icon: "none" });
          }
        }, 30000);
      },
      fail: () => {
        wx.showToast({ title: "发送失败", icon: "none" });
        this.setData({ isConnecting: false });
      },
    });
  },

  // 页面卸载时关闭 WebSocket
  onUnload: function () {
    this.isPageUnloaded = true; // 标记页面已卸载
    if (this.data.socketTask) {
      this.data.socketTask.close();
      this.setData({ socketTask: null });
    }
    // 清理定时器
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
    }
  },

  // 页面隐藏时也应该停止重连
  onHide: function () {
    this.isPageHidden = true;
  },

  // 页面显示时恢复连接
  onShow: function() {
    this.isPageHidden = false;
    this.isPageUnloaded = false;
    if (!this.data.socketTask) {
      this.setupWebSocket();
    }
    this.scrollToBottom();
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
        data: JSON.stringify({ 
          prompt: text,
          wxNickname: this.data.wxNickname || ''
        })
      });
    }
  },

  // Add text-to-speech for AI responses
  // TTS 功能暂时禁用，因为后端没有实现 TTS 端点
  // speakAIResponse: function(text) {
  //   const innerAudioContext = wx.createInnerAudioContext();
  //   
  //   // Get audio URL from your TTS service
  //   const audioUrl = `${getApp().globalData.wsBaseUrl}/tts?text=${encodeURIComponent(text)}`;
  //   
  //   innerAudioContext.src = audioUrl;
  //   innerAudioContext.play();
  // },

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
    
    // 使用新的API获取窗口信息
    const windowInfo = wx.getWindowInfo();
    const clientHeight = windowInfo.windowHeight - 100; // 减去输入框等其他元素的高度
    
    // 判断是否滚动到距离底部超过一定距离
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    
    // 只有当距离底部超过150px时才显示按钮
    if (distanceFromBottom > 150) {
      if (!this.data.showScrollToBottom) {
        this.setData({ showScrollToBottom: true });
      }
    } else {
      if (this.data.showScrollToBottom) {
        this.setData({ showScrollToBottom: false });
      }
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
