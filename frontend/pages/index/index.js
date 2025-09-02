// Import all modules
const WebSocketManager = require('./modules/websocket-manager.js');
const VoiceRecorder = require('./modules/voice-recorder.js');
const StreamingSpeechManager = require('./modules/streaming-speech.js');
const MessageManager = require('./modules/message-manager.js');
const ScrollController = require('./modules/scroll-controller.js');
const UIStateManager = require('./modules/ui-state-manager.js');

Page({
  // 核心数据状态 - 只保留UI渲染必需的数据
  data: {
    userInput: "", 
    isConnecting: false, 
    messages: [], 
    isVoiceMode: false,
    isRecording: false,
    showScrollToBottom: false,
    userHasScrolledUp: false,
    scrollIntoView: '',
    messageCount: 0,
    isGenerating: false,
    
    // 语音相关状态
    recordingDuration: 0,
    isRecordingCanceling: false,
    waveformData: [],
    recordingStartY: 0,
    showVoiceModal: false,
    recordingText: '按住说话',
    isInputRecording: false,
    keyboardHeight: 0,
    currentVolume: 0,  // 当前音量用于背景动画
    
    // 流式语音识别状态
    isStreamingSpeech: false,
    
  },

  onLoad: function() {
    // 初始化实例属性
    this.userId = null;
    this.authToken = null;
    
    // 初始化所有模块
    this.webSocketManager = new WebSocketManager(this);
    this.voiceRecorder = new VoiceRecorder(this);
    this.streamingSpeechManager = new StreamingSpeechManager(this);
    this.messageManager = new MessageManager(this);
    this.scrollController = new ScrollController(this);
    this.uiStateManager = new UIStateManager(this);
    
    // 初始化页面
    this.uiStateManager.initialize();
    
  },

  // ==================== 认证方法 ====================
  
  initializeAuth: function(userId, callback) {
    this.uiStateManager.initializeAuth(userId, callback);
  },
  
  getAuthToken: function(userId, callback) {
    this.uiStateManager.getAuthToken(userId, callback);
  },

  // ==================== 消息处理方法 ====================
  
  bindInput: function(e) {
    this.uiStateManager.bindInput(e);
  },

  sendMessage: function() {
    this.messageManager.sendMessage();
  },

  sendVoiceMessage: function(text) {
    this.messageManager.sendVoiceMessage(text);
  },

  formatMessages: function(messages) {
    return this.messageManager.formatMessages(messages);
  },

  onSuggestionTap: function(e) {
    this.messageManager.onSuggestionTap(e);
  },

  // ==================== 滚动控制方法 ====================
  
  scrollToBottom: function(force = false) {
    this.scrollController.scrollToBottom(force);
  },

  forceScrollToBottom: function() {
    this.scrollController.forceScrollToBottom();
  },

  onScroll: function(e) {
    this.scrollController.onScroll(e);
  },

  onTouchStart: function(e) {
    this.scrollController.onTouchStart(e);
  },

  onTouchEnd: function(e) {
    this.scrollController.onTouchEnd(e);
  },

  handleFocus: function() {
    this.scrollController.handleFocus();
  },

  handleKeyboardHeightChange: function(res) {
    this.scrollController.handleKeyboardHeightChange(res);
  },

  // ==================== 语音模式切换 ====================
  
  switchToVoice: function() {
    this.uiStateManager.switchToVoice();
  },

  switchToText: function() {
    this.uiStateManager.switchToText();
  },

  // ==================== 语音录制方法 ====================
  
  onVoiceTouchStart: function(e) {
    this.voiceRecorder.onVoiceTouchStart(e);
  },

  onVoiceTouchMove: function(e) {
    this.voiceRecorder.onVoiceTouchMove(e);
  },

  onVoiceTouchEnd: function(e) {
    this.voiceRecorder.onVoiceTouchEnd(e);
  },

  onVoiceTouchCancel: function(e) {
    this.voiceRecorder.onVoiceTouchCancel(e);
  },

  // 输入框语音录制
  onInputTouchStart: function(e) {
    this.voiceRecorder.onInputTouchStart(e);
  },

  onInputTouchMove: function(e) {
    this.voiceRecorder.onInputTouchMove(e);
  },

  onInputTouchEnd: function(e) {
    this.voiceRecorder.onInputTouchEnd(e);
  },

  onInputTouchCancel: function(e) {
    this.voiceRecorder.onInputTouchCancel(e);
  },

  // 录制控制
  startRecording: function() {
    this.voiceRecorder.checkRecordingPermission(() => {
      this.voiceRecorder.startVoiceRecording();
    });
  },

  stopRecording: function() {
    this.voiceRecorder.stopVoiceRecording();
  },

  cancelRecording: function(e) {
    if (e.touches[0].clientY < e.currentTarget.offsetTop - 50) {
      this.voiceRecorder.cancelVoiceRecording();
    }
  },

  uploadVoice: function(tempFilePath) {
    this.voiceRecorder.uploadVoice(tempFilePath);
  },

  // ==================== WebSocket 方法 ====================
  
  setupWebSocket: function() {
    this.webSocketManager.connect();
  },

  // ==================== UI 事件处理 ====================
  
  handleLinkTap: function(e) {
    this.uiStateManager.handleLinkTap(e);
  },

  onShareAppMessage: function() {
    return this.uiStateManager.onShareAppMessage();
  },

  onShareTimeline: function() {
    return this.uiStateManager.onShareTimeline();
  },

  // ==================== 页面生命周期 ====================
  
  onReady: function() {
    this.uiStateManager.onReady();
  },

  onShow: function() {
    this.uiStateManager.onShow();
  },

  onHide: function() {
    this.uiStateManager.onHide();
  },

  onUnload: function() {
    this.uiStateManager.onUnload();
  },

  // ==================== 流式语音识别方法 ====================
  
  startStreamingSpeechSession: function() {
    this.streamingSpeechManager.startSession();
  },

  sendAudioFrame: function(frameBuffer) {
    this.streamingSpeechManager.sendAudioFrame(frameBuffer);
  },

  endStreamingSpeechSession: function() {
    this.streamingSpeechManager.endSession();
  },

  handleStreamingSpeechResult: function(data) {
    this.streamingSpeechManager.handleResult(data);
  },

  // ==================== 兼容性方法 ====================
  
  // 保留一些核心的兼容性方法，确保现有功能正常工作
  trimMessages: function(list, limit = 100) {
    return this.messageManager.trimMessages(list, limit);
  },

  scheduleAutoScroll: function() {
    this.scrollController.scheduleAutoScroll();
  },

  flushStream: function() {
    this.messageManager.flushStream();
  },

  // ==================== 消息操作方法 ====================
  
  /**
   * 复制消息内容
   */
  copyMessage: function(e) {
    const content = e.currentTarget.dataset.content;
    wx.setClipboardData({
      data: content,
      success: function () {
        wx.showToast({
          title: '已复制',
          icon: 'success',
          duration: 1500
        });
      },
      fail: function () {
        wx.showToast({
          title: '复制失败',
          icon: 'none',
          duration: 1500
        });
      }
    });
  }
  
});