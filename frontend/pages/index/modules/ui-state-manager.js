/**
 * UI State Manager Module
 * 处理UI状态管理、页面生命周期、认证管理
 */
class UIStateManager {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.isPageUnloaded = false;
    this.isPageHidden = false;
  }

  /**
   * 初始化页面状态
   */
  initialize() {
    // 初始化用户ID
    this.initializeUserId();
    
    // 加载历史消息
    const savedMessages = this.page.messageManager.loadHistoryMessages();
    this.page.setData({ 
      messages: savedMessages
    }, () => {
      if (savedMessages.length > 0) {
        setTimeout(() => this.page.scrollController.forceScrollToBottom(), 300);
      }
    });
    
    // 初始化认证并连接WebSocket
    this.page.initializeAuth(this.page.userId, () => {
      this.page.webSocketManager.connect();
    });
    
    // 监听键盘高度变化
    wx.onKeyboardHeightChange(this.page.scrollController.handleKeyboardHeightChange.bind(this.page.scrollController));
  }

  /**
   * 初始化用户ID
   */
  initializeUserId() {
    let userId = wx.getStorageSync('userId');
    const isValidUserId = (id) => id && typeof id === 'string' && /^user_[a-zA-Z0-9]{10,25}$/.test(id);
    
    if (!userId || !isValidUserId(userId)) {
      const timestamp = Date.now().toString(36).slice(-6);
      const random = Math.random().toString(36).substring(2, 10);
      userId = `user_${timestamp}${random}`;
      wx.setStorageSync('userId', userId);
    }
    this.page.userId = userId;
  }

  /**
   * 切换到语音模式
   */
  switchToVoice() {
    this.page.setData({ isVoiceMode: true });
  }

  /**
   * 切换到文字模式
   */
  switchToText() {
    this.page.setData({ isVoiceMode: false });
  }

  /**
   * 处理输入事件
   */
  bindInput(e) {
    this.page.setData({ userInput: e.detail.value });
  }

  /**
   * 处理电话链接点击
   */
  handleLinkTap(e) {
    const phoneNumber = e.currentTarget.dataset.phone;
    if (phoneNumber) {
      wx.showActionSheet({
        itemList: ['拨打电话', '复制号码'],
        success: (res) => {
          if (res.tapIndex === 0) {
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
  }

  /**
   * 分享给朋友
   */
  onShareAppMessage() {
    return {
      title: '避开整容坑！与AI医美专家直接聊！',
      path: '/pages/index/index',
    }
  }

  /**
   * 分享到朋友圈
   */
  onShareTimeline() {
    return {
      title: '避开整容坑！与AI医美专家直接聊！',
      query: '',
      imageUrl: ''
    }
  }

  /**
   * 页面隐藏处理
   */
  onHide() {
    this.isPageHidden = true;
  }

  /**
   * 页面显示处理
   */
  onShow() {
    this.isPageHidden = false;
    this.isPageUnloaded = false;
    
    if (!this.page.webSocketManager.socketTask) {
      this.page.initializeAuth(this.page.userId, () => {
        this.page.webSocketManager.connect();
      });
    }
    this.page.scrollController.scrollToBottom();
  }

  /**
   * 页面就绪处理
   */
  onReady() {
    this.page.scrollController.getChatHistoryHeight();
  }

  /**
   * 页面卸载处理
   */
  onUnload() {
    this.isPageUnloaded = true;
    
    // 断开WebSocket连接
    this.page.webSocketManager.disconnect();
    
    // 清理所有模块
    this.page.scrollController.cleanup();
    this.page.messageManager.cleanup();
    this.page.voiceRecorder.cleanup();
    
    // 注销键盘监听
    wx.offKeyboardHeightChange(this.page.scrollController.handleKeyboardHeightChange);
  }

  /**
   * 获取认证token
   */
  initializeAuth(userId, callback) {
    const storedToken = wx.getStorageSync('authToken');
    const tokenExpiry = wx.getStorageSync('tokenExpiry');
    
    if (storedToken && tokenExpiry && new Date(tokenExpiry) > new Date()) {
      this.page.authToken = storedToken;
      console.log('Using existing JWT token');
      if (callback) callback();
    } else {
      this.getAuthToken(userId, callback);
    }
  }

  /**
   * 获取新的认证token
   */
  getAuthToken(userId, callback) {
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
          wx.setStorageSync('authToken', res.data.token);
          const expiryTime = new Date(Date.now() + 23 * 60 * 60 * 1000);
          wx.setStorageSync('tokenExpiry', expiryTime.toISOString());
          
          this.page.authToken = res.data.token;
          console.log('JWT token obtained successfully');
          if (callback) callback();
        } else {
          console.error('No token received from server');
          if (callback) callback();
        }
      },
      fail: (error) => {
        console.error('Failed to get auth token:', error);
        wx.showToast({
          title: '认证失败，请重试',
          icon: 'none'
        });
        if (callback) callback();
      }
    });
  }

  /**
   * 检查页面状态
   */
  isPageActive() {
    return !this.isPageUnloaded && !this.isPageHidden;
  }

  /**
   * 设置页面数据
   */
  setData(data, callback) {
    this.page.setData(data, callback);
  }

  /**
   * 获取页面数据
   */
  getData() {
    return this.page.data;
  }
}

module.exports = UIStateManager;