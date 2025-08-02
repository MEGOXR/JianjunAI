Page({
  // data 中只保留纯粹用于UI渲染的、轻量的数据
  data: {
    userInput: "", 
    isConnecting: false, 
    messages: [], 
    isVoiceMode: true,
    isRecording: false,
    showScrollToBottom: false,
    userHasScrolledUp: false,
    scrollIntoView: '', // 替代scrollTop，用于精确滚动
    wxNickname: '',
    wxAvatarUrl: ''
  },

  onLoad: function() {
    // ---- 非UI数据，作为实例属性存在 ----
    this.userId = null;
    this.socketTask = null;
    this.authToken = null;
    
    // 定时器句柄
    this.reconnectTimer = null;
    this.scrollTimer = null; // 用于滚动节流
    this.scrollEventTimer = null; // 用于onScroll事件节流

    // 流式渲染的缓冲和节流控制器
    this._stream = { 
      buf: '',             // 缓冲区
      timer: null,           // 节流定时器
      targetIndex: null      // 当前正在接收流的message索引
    };

    // 【优化③】一次性初始化录音管理器并注册监听
    this.recorderManager = wx.getRecorderManager();
    this.recorderManager.onStart(() => {
      this.setData({ isRecording: true });
      wx.showToast({ title: '正在录音...', icon: 'none', duration: 60000 });
    });
    this.recorderManager.onStop((res) => {
      wx.hideToast();
      this.setData({ isRecording: false });
      this.uploadVoice(res.tempFilePath);
    });
    // ---- End: 非UI数据 ----

    // 【优化：userId Bug修复】
    let userId = wx.getStorageSync('userId');
    const isValidUserId = (id) => id && typeof id === 'string' && /^user_[a-zA-Z0-9]{10,25}$/.test(id);
    
    if (!userId || !isValidUserId(userId)) {
      const timestamp = Date.now().toString(36).slice(-6); // 使用 slice(-6) 修正
      const random = Math.random().toString(36).substring(2, 10);
      userId = `user_${timestamp}${random}`;
      wx.setStorageSync('userId', userId);
    }
    this.userId = userId; // 存到实例属性

    // 【优化：历史消息裁剪】
    const savedMessages = wx.getStorageSync('messages') || [];
    this.setData({ 
      messages: this.trimMessages(this.formatMessages(savedMessages))
    }, () => {
      if (savedMessages.length > 0) {
        setTimeout(() => this.forceScrollToBottom(), 300);
      }
    });
    
    this.checkAndGetUserInfo(() => {
      this.initializeAuth(this.userId, () => {
        this.setupWebSocket();
      });
    });
  },
  
  checkAndGetUserInfo: function(callback) {
    // 先检查本地是否已保存用户信息
    const savedUserInfo = wx.getStorageSync('userInfo');
    if (savedUserInfo && savedUserInfo.nickName) {
      this.setData({
        wxNickname: savedUserInfo.nickName,
        wxAvatarUrl: savedUserInfo.avatarUrl
      });
      console.log('已使用保存的用户信息:', savedUserInfo.nickName);
      if (callback) callback();
      return;
    }
    
    // 如果没有保存的信息，设置默认值并执行回调
    this.setData({
      wxNickname: '微信用户'
    });
    if (callback) callback();
    
    // 异步尝试获取用户信息
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

  // Get JWT token for authentication
  initializeAuth: function(userId, callback) {
    const storedToken = wx.getStorageSync('authToken');
    const tokenExpiry = wx.getStorageSync('tokenExpiry');
    
    // Check if token exists and is still valid
    if (storedToken && tokenExpiry && new Date(tokenExpiry) > new Date()) {
      this.authToken = storedToken;
      console.log('Using existing JWT token');
      if (callback) callback();
    } else {
      // Get new token
      this.getAuthToken(userId, callback);
    }
  },
  
  getAuthToken: function(userId, callback) {
    const baseUrl = getApp().globalData.baseUrl;
    wx.request({
      url: `${baseUrl}/auth/token`,
      method: 'POST',
      header: {
        'content-type': 'application/json'
      },
      data: {
        userId: userId,
        wxNickname: this.data.wxNickname || ''
      },
      success: (res) => {
        if (res.data.token) {
          // Store token and expiry time
          wx.setStorageSync('authToken', res.data.token);
          // Set expiry to 23 hours from now (1 hour before actual expiry)
          const expiryTime = new Date(Date.now() + 23 * 60 * 60 * 1000);
          wx.setStorageSync('tokenExpiry', expiryTime.toISOString());
          
          this.authToken = res.data.token;
          console.log('JWT token obtained successfully');
          if (callback) callback();
        } else {
          console.error('No token received from server');
          if (callback) callback(); // Continue even without token for fallback
        }
      },
      fail: (error) => {
        console.error('Failed to get auth token:', error);
        wx.showToast({
          title: '认证失败，请重试',
          icon: 'none'
        });
        if (callback) callback(); // Continue even with error for fallback
      }
    });
  },
  
  // 【新增】一个用于将缓冲区内容刷新到UI的函数
  flushStream: function() {
    if (this._stream.buf && this._stream.targetIndex != null) {
      const idx = this._stream.targetIndex;
      // 拼接缓冲区内容到已有内容
      const mergedContent = this.data.messages[idx].content + this._stream.buf;
      // 清空缓冲区
      this._stream.buf = '';
      
      this.setData({
        [`messages[${idx}].content`]: mergedContent
      }, () => {
        // 流式消息更新时也确保滚动到底部
        if (!this.data.userHasScrolledUp) {
          this.scheduleAutoScroll();
        }
      });
    }
    // 清除定时器句柄
    this._stream.timer = null;
  },

  // 【新增】历史消息裁剪函数
  trimMessages: function(list, limit = 100) {
    if (list.length <= limit) return list;
    // 可以返回一个提示，或直接截断
    return list.slice(-limit);
  },

  // 【修正】一个节流的滚动调度函数
  scheduleAutoScroll: function() {
    if (this.scrollTimer) return;

    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      if (!this.data.userHasScrolledUp) {
        // 【关键修正】先清空然后重新设置，确保滚动生效
        this.setData({ scrollIntoView: '' }, () => {
          // 短暂延迟后设置滚动锚点
          setTimeout(() => {
            this.setData({ scrollIntoView: 'chat-bottom-anchor' });
          }, 50);
        });
      }
    }, 100);
  },

  scrollToBottom: function(force = false) {
    if (!force && this.data.userHasScrolledUp) {
      return;
    }

    // 使用新的调度函数
    this.scheduleAutoScroll();
  },

  // 【修正】强制滚动逻辑
  forceScrollToBottom: function() {
    this.setData({
      userHasScrolledUp: false,
      showScrollToBottom: false,
      scrollIntoView: '' // 先清空
    }, () => {
      // 立即设置滚动锚点，不使用节流
      setTimeout(() => {
        this.setData({ scrollIntoView: 'chat-bottom-anchor' });
      }, 50);
    });
  },

  // 建立 WebSocket 连接
  setupWebSocket: function () {
    // 如果已有连接，先关闭
    if (this.socketTask) {
      this.socketTask.close();
      this.socketTask = null;
    }
  
    const wsUrl = `${getApp().globalData.wsBaseUrl}`;
    console.log('尝试连接WebSocket:', wsUrl);
    console.log('User-Id:', this.userId);
    console.log('Wx-Nickname:', this.data.wxNickname);
    
    // Use JWT authentication
    const headers = {};
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
      console.log('Using JWT authentication');
    } else {
      console.error('No JWT token available. Authentication may fail.');
      // Try to get token before connecting
      this.initializeAuth(this.userId, () => {
        // Retry connection with token
        if (this.authToken) {
          this.setupWebSocket();
        }
      });
      return;
    }
    
    const socketTask = wx.connectSocket({
      url: wsUrl,
      header: headers,
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
          newMessages.push(greetingMessage);
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
      
      // 处理心跳消息
      if (data.type === 'ping') {
        console.log('收到服务器ping，发送pong响应');
        socketTask.send({
          data: JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          })
        });
        return;
      }
      
      if (data.type === 'pong') {
        console.log('收到服务器pong响应');
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
      
      // 【优化①】流式数据处理
      if (data.data) {
        // 如果是第一个分片，先创建一条空的AI消息占位
        if (this._stream.targetIndex == null) {
          const app = getApp();
          const msg = { role: 'assistant', content: '', timestamp: Date.now(), suggestions: [] };
          
          // 获取上一条消息的时间戳
          const lastMessage = this.data.messages.length > 0 ? 
            this.data.messages[this.data.messages.length - 1] : null;
          const lastTimestamp = lastMessage ? lastMessage.timestamp : null;
          
          // 计算是否应该显示时间
          const timeDiff = lastTimestamp ? (msg.timestamp - lastTimestamp) : null;
          const shouldShowTime = !lastTimestamp || timeDiff > 5 * 60 * 1000;
          
          // 设置时间显示
          if (shouldShowTime) {
            const now = new Date();
            const messageDate = new Date(msg.timestamp);
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const messageDay = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
            const daysDiff = Math.floor((today.getTime() - messageDay.getTime()) / (24 * 60 * 60 * 1000));
            
            if (daysDiff === 0) {
              msg.formattedDate = app.getFormattedTime(msg.timestamp);
            } else if (daysDiff === 1) {
              msg.formattedDate = `昨天 ${app.getFormattedTime(msg.timestamp)}`;
            } else {
              const month = messageDate.getMonth() + 1;
              const day = messageDate.getDate();
              msg.formattedDate = `${month}月${day}日 ${app.getFormattedTime(msg.timestamp)}`;
            }
          } else {
            msg.formattedDate = '';
          }
          msg.formattedTime = app.getFormattedTime(msg.timestamp);
          
          const idx = this.data.messages.length;
          this.setData({ 
            [`messages[${idx}]`]: msg, 
            isConnecting: true 
          });
          this._stream.targetIndex = idx;
        }
        
        // 将数据放入缓冲区
        this._stream.buf += data.data;

        // 如果当前没有刷新计划，则安排一次（节流）
        if (!this._stream.timer) {
          this._stream.timer = setTimeout(() => this.flushStream(), 80); // 80ms刷新一次UI
        }
      }
    
      if (data.done) {
        // 流结束，立即执行最后一次刷新，确保所有内容都上屏
        if (this._stream.timer) clearTimeout(this._stream.timer);
        this.flushStream();
        
        const lastIndex = this._stream.targetIndex;

        // 更新最终状态和可能的建议
        if (lastIndex != null) {
          const updateData = { isConnecting: false };
          if (data.suggestions && data.suggestions.length > 0) {
            updateData[`messages[${lastIndex}].suggestions`] = data.suggestions;
          }
          this.setData(updateData);
        }
        
        // 重置流控制器
        this._stream.targetIndex = null;
        
        // 【优化：存储频率】只在结束时写入一次，并裁剪历史记录
        wx.setStorageSync('messages', this.trimMessages(this.data.messages));
        
        console.log('消息接收完成，isConnecting已重置为false');
        
        // Play TTS for complete AI response if in voice mode
        const messages = this.data.messages; // 先获取当前消息列表
        if (this.data.isVoiceMode && messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage.role === 'assistant') {
            // 暂时禁用 TTS，因为没有 TTS 服务端点
            // this.speakAIResponse(lastMessage.content);
            console.log('TTS 功能暂时禁用');
          }
        }
        
        // 智能滚动：AI回复完成时强制滚动到底部，确保完整显示
        if (!this.data.userHasScrolledUp) {
          // 延迟滚动，确保DOM完全更新
          setTimeout(() => {
            this.forceScrollToBottom();
          }, 150);
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
    this.socketTask = socketTask;
  },

  // 监听输入
  bindInput: function (e) {
    this.setData({ userInput: e.detail.value });
  },

  // 【修正】发送逻辑
  sendMessage: function() {
    if (!this.data.userInput || this.data.isConnecting) return;

    const app = getApp();
    const userMessageContent = this.data.userInput;
    
    const newUserMessage = {
      role: 'user',
      content: userMessageContent,
      timestamp: Date.now()
    };

    // 获取上一条消息的时间戳
    const lastMessage = this.data.messages.length > 0 ? 
      this.data.messages[this.data.messages.length - 1] : null;
    const lastTimestamp = lastMessage ? lastMessage.timestamp : null;
    
    // 计算是否应该显示时间
    const timeDiff = lastTimestamp ? (newUserMessage.timestamp - lastTimestamp) : null;
    const shouldShowTime = !lastTimestamp || timeDiff > 5 * 60 * 1000;
    
    // 手动设置时间显示
    if (shouldShowTime) {
      const app = getApp();
      const now = new Date();
      const messageDate = new Date(newUserMessage.timestamp);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const messageDay = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
      const daysDiff = Math.floor((today.getTime() - messageDay.getTime()) / (24 * 60 * 60 * 1000));
      
      if (daysDiff === 0) {
        // 今天：仅显示时间
        newUserMessage.formattedDate = app.getFormattedTime(newUserMessage.timestamp);
      } else if (daysDiff === 1) {
        // 昨天
        newUserMessage.formattedDate = `昨天 ${app.getFormattedTime(newUserMessage.timestamp)}`;
      } else {
        // 更早的日期
        const month = messageDate.getMonth() + 1;
        const day = messageDate.getDate();
        newUserMessage.formattedDate = `${month}月${day}日 ${app.getFormattedTime(newUserMessage.timestamp)}`;
      }
    } else {
      newUserMessage.formattedDate = '';
    }
    newUserMessage.formattedTime = app.getFormattedTime(newUserMessage.timestamp);

    this.setData({
      messages: this.data.messages.concat(newUserMessage),
      userInput: "",
      isConnecting: true,
    }, () => {
      // 发送消息时强制滚动到底部
      this.forceScrollToBottom();
    });
    
    this.socketTask.send({
      data: JSON.stringify({
        prompt: userMessageContent,
        wxNickname: this.data.wxNickname || ''
      }),
      fail: () => {
        wx.showToast({ title: "发送失败", icon: "none" });
        this.setData({ isConnecting: false });
      },
    });

    // 添加超时机制，30秒后自动重置状态
    setTimeout(() => {
      if (this.data.isConnecting) {
        console.log('响应超时，重置isConnecting状态');
        this.setData({ isConnecting: false });
        wx.showToast({ title: "响应超时，请重试", icon: "none" });
      }
    }, 30000);
  },

  // 【修正】onUnload
  onUnload: function () {
    this.isPageUnloaded = true;
    if (this.socketTask) {
      this.socketTask.close();
      this.socketTask = null;
    }
    // 清理所有定时器
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    if (this.scrollEventTimer) clearTimeout(this.scrollEventTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this._stream.timer) clearTimeout(this._stream.timer); // <--- 补充清理流定时器
  },

  // 页面隐藏时也应该停止重连
  onHide: function () {
    this.isPageHidden = true;
  },

  // 页面显示时恢复连接
  onShow: function() {
    this.isPageHidden = false;
    this.isPageUnloaded = false;
    if (!this.socketTask) {
      // Ensure we have valid authentication before reconnecting
      this.initializeAuth(this.userId, () => {
        this.setupWebSocket();
      });
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
  
      // 微信规则：5分钟内的消息不显示时间，超过5分钟才显示
      const timeDiff = currentTimestamp - (lastMessageTimestamp || 0);
      const shouldShowTime = !lastMessageTimestamp || timeDiff > 5 * 60 * 1000;

      if (shouldShowTime) {
        const daysDiff = Math.floor((today.getTime() - messageDay.getTime()) / (24 * 60 * 60 * 1000));
        
        if (daysDiff === 0) {
          // 今天：仅显示时间
          formattedDate = formattedTime;
        } else if (daysDiff === 1) {
          // 昨天：昨天 + 时间
          formattedDate = `昨天 ${formattedTime}`;
        } else if (daysDiff <= 6 && messageDay >= weekStart) {
          // 本周内（2-6天前）：星期几 + 时间
          const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
          formattedDate = `星期${weekDays[messageDate.getDay()]} ${formattedTime}`;
        } else if (messageDate.getFullYear() === now.getFullYear()) {
          // 今年：月/日 + 时间
          const month = messageDate.getMonth() + 1;
          const day = messageDate.getDate();
          formattedDate = `${month}月${day}日 ${formattedTime}`;
        } else {
          // 往年：年/月/日 + 时间
          const year = messageDate.getFullYear();
          const month = messageDate.getMonth() + 1;
          const day = messageDate.getDate();
          formattedDate = `${year}年${month}月${day}日 ${formattedTime}`;
        }
        
      }
      
      // 【关键简化】不再处理segments，直接返回消息
      newMessages.push({
        ...msg,
        formattedDate,
        formattedTime,
      });
      
      // 无论是否显示时间，都要更新lastMessageTimestamp以便下次比较
      lastMessageTimestamp = currentTimestamp;
    });
    return newMessages;
  },


  handleFocus: function() {
    // 点击输入框时强制滚动到底部
    this.forceScrollToBottom();
  },

  switchToVoice: function() {
    this.setData({ isVoiceMode: true });
  },

  switchToText: function() {
    this.setData({ isVoiceMode: false });
  },

  // 【修正】录音逻辑
  startRecording: function() {
    wx.authorize({
      scope: 'scope.record',
      success: () => {
        // 不再注册监听，直接启动
        this.recorderManager.start({
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
    // 直接停止
    this.recorderManager.stop();
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

  // 【修正】sendVoiceMessage 函数
  sendVoiceMessage: function(text) {
    const app = getApp();
    const newUserMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now()
    };

    // 获取上一条消息的时间戳
    const lastMessage = this.data.messages.length > 0 ? 
      this.data.messages[this.data.messages.length - 1] : null;
    const lastTimestamp = lastMessage ? lastMessage.timestamp : null;
    
    // 计算是否应该显示时间
    const timeDiff = lastTimestamp ? (newUserMessage.timestamp - lastTimestamp) : null;
    const shouldShowTime = !lastTimestamp || timeDiff > 5 * 60 * 1000;
    
    // 设置时间显示
    if (shouldShowTime) {
      const now = new Date();
      const messageDate = new Date(newUserMessage.timestamp);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const messageDay = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());
      const daysDiff = Math.floor((today.getTime() - messageDay.getTime()) / (24 * 60 * 60 * 1000));
      
      if (daysDiff === 0) {
        newUserMessage.formattedDate = app.getFormattedTime(newUserMessage.timestamp);
      } else if (daysDiff === 1) {
        newUserMessage.formattedDate = `昨天 ${app.getFormattedTime(newUserMessage.timestamp)}`;
      } else {
        const month = messageDate.getMonth() + 1;
        const day = messageDate.getDate();
        newUserMessage.formattedDate = `${month}月${day}日 ${app.getFormattedTime(newUserMessage.timestamp)}`;
      }
    } else {
      newUserMessage.formattedDate = '';
    }
    newUserMessage.formattedTime = app.getFormattedTime(newUserMessage.timestamp);

    // 使用 concat 增量更新
    this.setData({
      messages: this.data.messages.concat(newUserMessage)
    }, () => {
      // 立即调度滚动
      this.scheduleAutoScroll();
    });
    
    if (this.socketTask) {
      this.socketTask.send({
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

  // 滚动事件处理 - 智能滚动核心逻辑（节流优化）
  onScroll: function(e) {
    // 节流处理：减少滚动事件的处理频率
    if (this.scrollEventTimer) {
      return; // 如果上一次事件还在处理中，跳过这次事件
    }
    
    this.scrollEventTimer = setTimeout(() => {
      this.scrollEventTimer = null;
    }, 50); // 50ms内最多处理一次滚动事件

    const { scrollTop, scrollHeight } = e.detail;
    const chatViewHeight = this.data.chatHistoryHeight || 700; // 使用 onReady 中获取的高度，提供一个备用值

    // 定义一个阈值，比如距离底部100px以内都算作"在底部"
    const atBottomThreshold = 100;
    const isAtBottom = scrollHeight - scrollTop - chatViewHeight < atBottomThreshold;

    // 如果用户当前不在底部
    if (!isAtBottom) {
      // 并且之前的状态是"在底部"，那么说明是用户刚刚向上滚动
      if (!this.data.userHasScrolledUp) {
        this.setData({ userHasScrolledUp: true });
      }
      // 向上滚动超过一定距离后，显示"回到底部"按钮
      if (!this.data.showScrollToBottom) {
        this.setData({ showScrollToBottom: true });
      }
    } else {
      // 如果用户当前在底部
      // 并且之前的状态是"已向上滚动"，那么说明是用户自己滚回来了
      if (this.data.userHasScrolledUp) {
        this.setData({ userHasScrolledUp: false });
      }
      // 在底部时，隐藏"回到底部"按钮
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
          this.setData({ chatHistoryHeight: rect.height });
          console.log("聊天区域高度:", rect.height);
        }
      }).exec();
  }
});
