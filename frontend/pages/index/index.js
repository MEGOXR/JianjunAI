Page({
  // data 中只保留纯粹用于UI渲染的、轻量的数据
  data: {
    userInput: "", 
    isConnecting: false, 
    messages: [], 
    isVoiceMode: false, // 默认文字模式
    isRecording: false,
    showScrollToBottom: false,
    userHasScrolledUp: false,
    scrollIntoView: '', // 替代scrollTop，用于精确滚动
    messageCount: 0, // 用于统计消息数量
    isGenerating: false, // 标识AI是否正在生成回复
    
    // 语音相关状态
    recordingDuration: 0,        // 录音时长
    isRecordingCanceling: false, // 是否正在取消录音
    waveformData: [],            // 波形数据
    recordingStartY: 0,          // 触摸开始Y坐标
    showVoiceModal: false,       // 显示录音悬浮层
    recordingText: '按住说话'    // 录音按钮文字
  },

  onLoad: function() {
    // ---- 非UI数据，作为实例属性存在 ----
    this.userId = null;
    this.socketTask = null;
    this.authToken = null;
    this.hasSmartPaused = false; // 【新增】标记是否已经智能暂停
    this.userIsTouching = false; // 【新增】用户是否正在触摸屏幕
    this.messageCount = 0; // 用户发送的消息数量
    
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
      
      // 如果是取消录音，不处理
      if (this.isCancelingRecording) {
        this.isCancelingRecording = false;
        return;
      }
      
      // 上传语音进行识别
      this.uploadVoice(res.tempFilePath);
    });
    
    // 【新增】监听键盘高度变化
    wx.onKeyboardHeightChange(this.handleKeyboardHeightChange);
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
    
    this.initializeAuth(this.userId, () => {
      this.setupWebSocket();
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
        userId: userId
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
      const mergedContent = this.data.messages[idx].content + this._stream.buf;
      this._stream.buf = '';
      
      this.setData({
        [`messages[${idx}].content`]: mergedContent
      }, () => {
        // 【智能滚动】检查是否应该暂停自动滚动
        console.log('🔍 flushStream检查状态:', {
          用户上滑: this.data.userHasScrolledUp,
          智能暂停: this.hasSmartPaused,
          内容长度: this.data.messages[idx].content.length
        });
        
        if (!this.data.userHasScrolledUp && !this.hasSmartPaused) {
          const msgContent = this.data.messages[idx].content;
          
          // 简单条件：当AI回复超过200字符时，检查是否需要暂停
          if (msgContent.length > 200) {
            // 使用DOM查询检查AI消息高度是否超过视口的80%
            wx.createSelectorQuery()
              .select('.chat-history').boundingClientRect()
              .select(`#msg-${idx}`).boundingClientRect()
              .exec(res => {
                if (res && res[0] && res[1]) {
                  const scrollRect = res[0];
                  const msgRect = res[1];
                  
                  // 获取AI消息的高度和视口高度
                  const msgHeight = msgRect.height;
                  const viewportHeight = scrollRect.height;
                  
                  // 计算消息底部相对于视口的位置
                  const msgBottomRelativeToView = msgRect.bottom - scrollRect.top;
                  
                  // 当AI消息高度达到视口高度，且消息底部接近视口底部时暂停
                  // 增加缓冲距离到150px，确保顶部内容不会被滚出视口
                  if (msgHeight >= viewportHeight && msgBottomRelativeToView >= viewportHeight - 150) {
                    console.log('🚫 智能暂停触发！', {
                      AI消息高度: msgHeight + 'px',
                      视口高度: viewportHeight + 'px',
                      消息占比: (msgHeight / viewportHeight * 100).toFixed(1) + '%',
                      消息底部位置: msgBottomRelativeToView + 'px',
                      已滚动到位: msgBottomRelativeToView >= viewportHeight - 150
                    });
                    this.hasSmartPaused = true; // 标记已暂停
                    this.setData({ showScrollToBottom: true });
                    return; // 暂停滚动
                  }
                }
                
                // 否则继续自动滚动
                console.log('⬇️ 继续自动滚动 (内容长度: ' + msgContent.length + ')');
                this.setData({ scrollIntoView: '' }, () => {
                  wx.nextTick(() => {
                    this.setData({ scrollIntoView: 'chat-bottom-anchor' });
                  });
                });
              });
          } else {
            // 内容还不够长，直接滚动
            console.log('⬇️ 内容较短，直接滚动 (内容长度: ' + msgContent.length + ')');
            this.setData({ scrollIntoView: '' }, () => {
              wx.nextTick(() => {
                this.setData({ scrollIntoView: 'chat-bottom-anchor' });
              });
            });
          }
        } else {
          // 状态不允许滚动
          console.log('⏹️ 停止滚动 - 状态:', {
            用户上滑: this.data.userHasScrolledUp,
            智能暂停: this.hasSmartPaused
          });
        }
      });
    }
    this._stream.timer = null;
  },

  // 【新增】历史消息裁剪函数
  trimMessages: function(list, limit = 100) {
    if (list.length <= limit) return list;
    // 可以返回一个提示，或直接截断
    return list.slice(-limit);
  },

  // 【简化】滚动调度函数
  scheduleAutoScroll: function() {
    if (this.scrollTimer || this.data.userHasScrolledUp) {
      return;
    }

    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      if (!this.data.userHasScrolledUp) {
        this.setData({ scrollIntoView: '' }, () => {
          wx.nextTick(() => {
            this.setData({ scrollIntoView: 'chat-bottom-anchor' });
          });
        });
      }
    }, 50);
  },

  scrollToBottom: function(force = false) {
    if (!force && this.data.userHasScrolledUp) {
      return;
    }

    // 使用新的调度函数
    this.scheduleAutoScroll();
  },

  // 【简化】强制滚动逻辑
  forceScrollToBottom: function() {
    this.hasSmartPaused = false; // 重置智能暂停标记
    console.log('🔄 用户点击回到底部，重置智能暂停状态');
    this.setData({
      userHasScrolledUp: false,
      showScrollToBottom: false,
      scrollIntoView: ''
    }, () => {
      wx.nextTick(() => {
        this.setData({ scrollIntoView: 'chat-bottom-anchor' });
      });
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
            type: 'init'
          })
        });
        console.log("初始化消息发送成功");
      } catch (error) {
        console.error("发送初始化消息失败:", error);
      }
    });
  
    socketTask.onMessage((res) => {
      // console.log('接收到WebSocket消息:', res.data); // 减少日志输出
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
        this.setData({ 
          isConnecting: false,
          isGenerating: false
        });
        
        // 移除加载消息
        let messages = [...this.data.messages];
        const loadingIndex = messages.findIndex(msg => msg.isLoading);
        if (loadingIndex !== -1) {
          messages.splice(loadingIndex, 1);
          this.setData({ messages });
        }
        wx.showToast({ 
          title: "服务器错误: " + data.details, 
          icon: "none",
          duration: 3000
        });
        return;
      }
      
      // 【优化①】流式数据处理
      if (data.data) {
        // 如果是第一个分片，先移除加载消息并创建真实的AI消息
        if (this._stream.targetIndex == null) {
          // 移除加载消息
          let currentMessages = [...this.data.messages];
          const loadingIndex = currentMessages.findIndex(msg => msg.isLoading);
          if (loadingIndex !== -1) {
            currentMessages.splice(loadingIndex, 1);
          }
          
          // 设置生成状态为false
          this.setData({ 
            messages: currentMessages,
            isGenerating: false 
          });
          
          const app = getApp();
          const msg = { role: 'assistant', content: '', timestamp: Date.now(), suggestions: [] };
          
          // 获取上一条消息的时间戳
          const lastMessage = currentMessages.length > 0 ? 
            currentMessages[currentMessages.length - 1] : null;
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
          
          currentMessages.push(msg);
          const idx = currentMessages.length - 1;
          this.setData({ 
            messages: currentMessages,
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
          const updateData = { 
            isConnecting: false,
            isGenerating: false // 生成完成
          };
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
        
        // 智能滚动：AI回复完成时的处理
        // 只有在用户没有上滑且没有智能暂停的情况下才滚动到底部
        if (!this.data.userHasScrolledUp && !this.hasSmartPaused) {
          console.log('📝 AI回复完成，自动滚动到底部');
          // 延迟滚动，确保DOM完全更新
          setTimeout(() => {
            this.forceScrollToBottom();
          }, 150);
        } else {
          console.log('📝 AI回复完成，保持当前位置', {
            用户已上滑: this.data.userHasScrolledUp,
            智能暂停: this.hasSmartPaused
          });
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
    
    // 增加消息计数
    this.messageCount++;
    this.setData({ messageCount: this.messageCount });
    
    // 【简化】重置所有滚动状态，让用户消息发送后能正常自动滚动
    this.hasSmartPaused = false; // 重置智能暂停标记
    console.log('✅ 用户发送消息，重置智能暂停状态');
    this.setData({
      userHasScrolledUp: false,
      showScrollToBottom: false
    });

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

    // 添加加载消息
    const loadingMessage = {
      role: 'assistant',
      content: '',
      isLoading: true,
      timestamp: Date.now(),
      id: 'loading-' + Date.now()
    };
    
    this.setData({
      messages: this.data.messages.concat([newUserMessage, loadingMessage]),
      userInput: "",
      isConnecting: true,
      isGenerating: true
    }, () => {
      // 发送消息时立即滚动到底部
      this.setData({ scrollIntoView: '' }, () => {
        wx.nextTick(() => {
          this.setData({ scrollIntoView: 'chat-bottom-anchor' });
        });
      });
    });
    
    this.socketTask.send({
      data: JSON.stringify({
        prompt: userMessageContent
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

  /**
   * 【新增】处理键盘高度变化事件
   * @param {object} res - 事件回调参数，包含键盘高度 an `height`
   */
  handleKeyboardHeightChange: function(res) {
    console.log('键盘高度变化:', res.height);

    if (!this.data.userHasScrolledUp) {
      // 使用一个短暂的延迟，等待 scroll-view 的高度完成变化
      setTimeout(() => {
        this.forceScrollToBottom();
      }, 100); 
    }
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
    if (this._stream.timer) clearTimeout(this._stream.timer);
    if (this.recordingTimer) clearInterval(this.recordingTimer);
    if (this.waveformTimer) clearInterval(this.waveformTimer);

    // 【新增】注销键盘监听
    wx.offKeyboardHeightChange(this.handleKeyboardHeightChange);
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
    // 【简化】重置滚动状态
    this.hasSmartPaused = false; // 重置智能暂停标记
    this.setData({
      userHasScrolledUp: false,
      showScrollToBottom: false
    });

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
          prompt: text
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

  // 建议问题点击处理
  onSuggestionTap: function(e) {
    const { question, msgIndex } = e.currentTarget.dataset;
    if (!question) return;
    
    console.log('用户点击建议问题:', question);
    
    // 移除震动效果，使用更轻微的视觉反馈
    
    // 立即隐藏建议问题区域，提升用户体验
    this.setData({
      [`messages[${msgIndex}].suggestions`]: []
    }, () => {
      // 隐藏完成后再发送消息
      this.setData({
        userInput: question
      }, () => {
        this.sendMessage();
      });
    });
    
    // 更新本地存储
    const messages = this.data.messages;
    if (messages[msgIndex] && messages[msgIndex].suggestions) {
      messages[msgIndex].suggestions = [];
      wx.setStorageSync('messages', messages);
    }
    
    console.log('建议问题处理完成');
  },

  // 【简化】滚动事件处理 - 只有用户触摸时才认为是用户滚动
  onScroll: function(e) {
    if (this.scrollEventTimer) return;
    this.scrollEventTimer = setTimeout(() => {
      this.scrollEventTimer = null;
    }, 100);

    const { scrollTop, scrollHeight } = e.detail;
    const chatViewHeight = this.data.chatHistoryHeight || 700;
    const atBottomThreshold = 50;
    const isAtBottom = scrollHeight - scrollTop - chatViewHeight < atBottomThreshold;
    
    console.log('🔍 onScroll事件:', {
      isAtBottom: isAtBottom,
      userIsTouching: this.userIsTouching,
      距离底部: scrollHeight - scrollTop - chatViewHeight
    });

    if (!isAtBottom && this.userIsTouching) {
      // 【关键】只有用户正在触摸时，才认为是用户主导的滚动
      if (!this.data.userHasScrolledUp) {
        console.log('📍 检测到用户主动上滑 (基于触摸事件)');
        this.setData({ userHasScrolledUp: true });
      }
      if (!this.data.showScrollToBottom) {
        this.setData({ showScrollToBottom: true });
      }
    } else if (isAtBottom) {
      // 到达底部时重置所有状态（无论是否触摸）
      if (this.data.userHasScrolledUp || this.data.showScrollToBottom || this.hasSmartPaused) {
        console.log('📍 回到底部，重置所有状态');
        this.hasSmartPaused = false;
        this.setData({
          userHasScrolledUp: false,
          showScrollToBottom: false
        });
      }
    }
  },

  // 【新增】触摸开始 - 用户开始触摸屏幕
  onTouchStart: function(e) {
    this.userIsTouching = true;
    console.log('👆 用户开始触摸滚动区域');
  },

  // 【新增】触摸结束 - 用户停止触摸屏幕
  onTouchEnd: function(e) {
    this.userIsTouching = false;
    console.log('🤚 用户结束触摸');
  },

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
  },

  // ==================== 语音功能相关方法 ====================
  
  // 切换到语音模式
  switchToVoice: function() {
    this.setData({ isVoiceMode: true });
  },

  // 切换到文字模式  
  switchToText: function() {
    this.setData({ isVoiceMode: false });
  },

  // 语音按钮触摸开始
  onVoiceTouchStart: function(e) {
    this.recordingStartY = e.touches[0].clientY;
    this.setData({
      recordingStartY: e.touches[0].clientY,
      isRecordingCanceling: false
    });
    
    // 检查录音权限
    this.checkRecordingPermission(() => {
      this.startVoiceRecording();
    });
  },

  // 语音按钮触摸移动
  onVoiceTouchMove: function(e) {
    if (!this.data.isRecording) return;
    
    const currentY = e.touches[0].clientY;
    const deltaY = this.recordingStartY - currentY;
    const cancelThreshold = 100; // 上滑100px触发取消
    
    const shouldCancel = deltaY > cancelThreshold;
    
    if (shouldCancel !== this.data.isRecordingCanceling) {
      this.setData({
        isRecordingCanceling: shouldCancel,
        recordingText: shouldCancel ? '松开取消' : '正在录音...'
      });
      
      // 进入取消区域时震动反馈
      if (shouldCancel) {
        wx.vibrateShort();
      }
    }
  },

  // 语音按钮触摸结束
  onVoiceTouchEnd: function(e) {
    if (!this.data.isRecording) return;
    
    if (this.data.isRecordingCanceling) {
      this.cancelVoiceRecording();
    } else {
      this.stopVoiceRecording();
    }
    
    this.setData({
      isRecordingCanceling: false,
      recordingText: '按住说话'
    });
  },

  // 语音按钮触摸取消
  onVoiceTouchCancel: function(e) {
    if (this.data.isRecording) {
      this.cancelVoiceRecording();
    }
  },

  // 检查录音权限
  checkRecordingPermission: function(callback) {
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.record'] === undefined) {
          // 第一次请求权限
          this.requestRecordingPermission(callback);
        } else if (res.authSetting['scope.record'] === false) {
          // 权限被拒绝，显示设置对话框
          this.showPermissionDialog();
        } else {
          // 权限已授予
          callback && callback();
        }
      },
      fail: () => {
        wx.showToast({
          title: '权限检查失败',
          icon: 'none'
        });
      }
    });
  },

  // 请求录音权限
  requestRecordingPermission: function(callback) {
    wx.authorize({
      scope: 'scope.record',
      success: () => {
        console.log('录音权限获取成功');
        callback && callback();
      },
      fail: () => {
        console.log('用户拒绝录音权限');
        this.showPermissionDialog();
      }
    });
  },

  // 显示权限设置对话框
  showPermissionDialog: function() {
    wx.showModal({
      title: '需要录音权限',
      content: '请在设置中开启录音权限，以便使用语音输入功能',
      confirmText: '去设置',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          wx.openSetting({
            success: (settingRes) => {
              if (settingRes.authSetting['scope.record']) {
                wx.showToast({
                  title: '权限已开启',
                  icon: 'success'
                });
              }
            }
          });
        }
      }
    });
  },

  // 开始录音
  startVoiceRecording: function() {
    const recorderManager = this.recorderManager;
    
    // 配置录音选项
    const options = {
      duration: 60000,           // 最长60秒
      sampleRate: 16000,         // 16kHz采样率
      numberOfChannels: 1,       // 单声道
      encodeBitRate: 48000,      // 48kbps码率
      format: 'mp3',             // MP3格式
      frameSize: 1               // 用于实时音量监控
    };
    
    // 开始录音
    recorderManager.start(options);
    
    // 更新UI状态
    this.setData({
      isRecording: true,
      showVoiceModal: true,
      recordingDuration: 0,
      waveformData: new Array(20).fill(10), // 初始化波形
      recordingText: '正在录音...'
    });
    
    // 开始计时
    this.startRecordingTimer();
    
    // 开始波形动画
    this.startWaveformAnimation();
  },

  // 停止录音并处理
  stopVoiceRecording: function() {
    const recorderManager = this.recorderManager;
    recorderManager.stop();
    
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    this.setData({
      isRecording: false,
      showVoiceModal: false
    });
  },

  // 取消录音
  cancelVoiceRecording: function() {
    const recorderManager = this.recorderManager;
    recorderManager.stop(); // 这会触发onStop但我们会忽略
    
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    this.isCancelingRecording = true; // 标记正在取消
    
    this.setData({
      isRecording: false,
      showVoiceModal: false
    });
    
    wx.showToast({
      title: '录音已取消',
      icon: 'none',
      duration: 1500
    });
  },

  // 录音计时器
  startRecordingTimer: function() {
    this.recordingTimer = setInterval(() => {
      const duration = this.data.recordingDuration + 1;
      this.setData({ recordingDuration: duration });
      
      // 60秒自动停止
      if (duration >= 60) {
        this.stopVoiceRecording();
      }
    }, 1000);
  },

  stopRecordingTimer: function() {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
  },

  // 波形动画
  startWaveformAnimation: function() {
    this.waveformTimer = setInterval(() => {
      if (!this.data.isRecording) return;
      
      // 生成随机波形数据（模拟音频电平）
      const waveformData = Array(20).fill(0).map(() => {
        return Math.random() * 80 + 20; // 20-100%高度
      });
      
      this.setData({ waveformData });
    }, 100); // 每100ms更新一次
  },

  stopWaveformAnimation: function() {
    if (this.waveformTimer) {
      clearInterval(this.waveformTimer);
      this.waveformTimer = null;
    }
  },

  // 上传语音文件
  uploadVoice: function(tempFilePath) {
    // 验证录音时长（最少1秒）
    if (this.data.recordingDuration < 1) {
      wx.showToast({
        title: '录音时间太短',
        icon: 'none'
      });
      return;
    }
    
    wx.showLoading({
      title: '语音识别中...',
      mask: true
    });
    
    // 上传到后端进行STT处理
    wx.uploadFile({
      url: `${getApp().globalData.baseUrl}/api/speech-to-text`,
      filePath: tempFilePath,
      name: 'audio',
      header: {
        'Authorization': `Bearer ${this.authToken}`
      },
      formData: {
        userId: this.userId,
        format: 'mp3',
        sampleRate: 16000
      },
      success: (res) => {
        try {
          const result = JSON.parse(res.data);
          if (result.success && result.text) {
            this.handleSTTSuccess(result.text, result.confidence);
          } else {
            throw new Error(result.error || '识别失败');
          }
        } catch (error) {
          this.handleSTTError(error.message);
        }
      },
      fail: (error) => {
        console.error('语音上传失败:', error);
        this.handleSTTError('网络错误，请重试');
      },
      complete: () => {
        wx.hideLoading();
      }
    });
  },

  // 处理语音识别成功
  handleSTTSuccess: function(text, confidence) {
    console.log('STT结果:', text, '置信度:', confidence);
    
    // 低置信度提示
    if (confidence < 0.7) {
      wx.showToast({
        title: '识别可能不准确',
        icon: 'none',
        duration: 1500
      });
    }
    
    // 显示识别结果供确认
    this.showSTTConfirmation(text);
  },

  // 显示STT结果确认对话框
  showSTTConfirmation: function(text) {
    wx.showModal({
      title: '识别结果',
      content: `"${text}"\n\n确认发送这条消息吗？`,
      confirmText: '发送',
      cancelText: '编辑',
      success: (res) => {
        if (res.confirm) {
          // 直接发送
          this.setData({ userInput: text });
          this.sendMessage();
        } else {
          // 让用户编辑
          this.setData({ 
            userInput: text,
            isVoiceMode: false // 切换到文字模式编辑
          });
        }
      }
    });
  },

  // 处理STT错误
  handleSTTError: function(errorMessage) {
    console.error('STT错误:', errorMessage);
    
    wx.showModal({
      title: '语音识别失败',
      content: errorMessage + '\n\n请重新录音或切换到文字输入',
      showCancel: false,
      confirmText: '好的'
    });
  }
});
