/**
 * TTS Manager Module (Simplified)
 * TTS核心管理模块，专注于核心播放控制和自动朗读功能
 */
class TTSManager {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.audioPlayer = null;
    this.autoTTS = true; // 默认启用自动朗读
    
    // 初始化音频播放器
    this.initializeAudioPlayer();
  }

  /**
   * 初始化音频播放器
   */
  initializeAudioPlayer() {
    const AudioPlayer = require('./audio-player.js');
    this.audioPlayer = new AudioPlayer(this.page);
    
    // 设置播放回调
    this.audioPlayer.setCallbacks({
      onPlayStart: this.onPlayStart.bind(this),
      onPlayEnd: this.onPlayEnd.bind(this),
      onPlayError: this.onPlayError.bind(this)
    });
    
    // 将audioPlayer实例也赋值给page，便于WebSocketManager访问
    this.page.audioPlayer = this.audioPlayer;
  }

  /**
   * 初始化TTS设置
   */
  initialize() {
    console.log('TTSManager: 初始化简化版TTS功能');
    
    // 加载自动朗读设置
    try {
      const savedSettings = wx.getStorageSync('tts_auto_play') || true;
      this.autoTTS = savedSettings;
    } catch (error) {
      console.warn('TTSManager: 加载设置失败，使用默认值', error);
    }
    
    // 更新页面数据
    this.page.setData({
      autoTTS: this.autoTTS
    });
  }

  /**
   * 复制消息内容
   */
  copyMessage(content) {
    if (!content) {
      wx.showToast({
        title: '没有可复制的内容',
        icon: 'none'
      });
      return;
    }
    
    wx.setClipboardData({
      data: content,
      success: () => {
        wx.showToast({
          title: '已复制到剪贴板',
          icon: 'success',
          duration: 1500
        });
      },
      fail: () => {
        wx.showToast({
          title: '复制失败',
          icon: 'none'
        });
      }
    });
  }

  /**
   * 切换TTS播放状态
   */
  async toggleTTS(messageId) {
    const message = this.findMessageById(messageId);
    if (!message) {
      console.error('TTSManager: 消息未找到', messageId);
      return;
    }

    console.log('TTSManager: 切换TTS播放', { messageId, isPlaying: message.isPlaying, messageContent: message.content?.substring(0, 50) });

    if (message.isPlaying) {
      // 停止播放
      console.log('TTSManager: 停止播放');
      this.audioPlayer.stop();
    } else {
      // 开始播放
      console.log('TTSManager: 准备开始播放');
      await this.playMessageTTS(message);
    }
  }

  /**
   * 播放消息TTS
   */
  async playMessageTTS(message) {
    if (!message || !message.content) {
      console.error('TTSManager: 消息内容无效', message);
      return;
    }

    console.log('TTSManager: 开始播放消息TTS', message.id);

    // 立即更新UI状态
    this.updateMessagePlayingStatus(message.id, true);

    // 播放TTS
    const success = await this.audioPlayer.playTTSStream(message.content, message.id);

    if (!success) {
      // 播放失败，重置状态
      this.updateMessagePlayingStatus(message.id, false);
    }
  }

  /**
   * AI消息点击处理（取消朗读）
   */
  onAIMessageTap(messageId) {
    const message = this.findMessageById(messageId);
    if (message && message.isPlaying) {
      console.log('TTSManager: 点击消息取消朗读', messageId);
      this.audioPlayer.stop();
    }
  }

  /**
   * AI回复完成后的处理
   */
  onAIResponseComplete(message) {
    console.log('TTSManager: AI回复完成', {
      messageId: message.id,
      autoTTS: this.autoTTS,
      contentLength: message.content ? message.content.length : 0
    });

    // 确保消息有唯一ID
    if (!message.id) {
      message.id = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // 添加TTS播放状态
    message.isPlaying = false;

    // 自动朗读（如果启用）
    if (this.autoTTS && message.content && message.content.trim()) {
      console.log('TTSManager: 自动开始朗读');
      setTimeout(() => {
        this.playMessageTTS(message);
      }, 800); // 延迟800ms让用户看到完整回复
    }
  }

  /**
   * 更新消息播放状态
   */
  updateMessagePlayingStatus(messageId, isPlaying) {
    const messages = this.page.data.messages.map(msg => {
      if (msg.id === messageId) {
        return { ...msg, isPlaying };
      }
      // 确保同时只有一个消息在播放
      return { ...msg, isPlaying: false };
    });

    this.page.setData({ messages });
    console.log(`TTSManager: 更新播放状态 ${messageId} -> ${isPlaying}`);
  }

  /**
   * 根据ID查找消息
   */
  findMessageById(messageId) {
    return this.page.data.messages.find(msg => msg.id === messageId);
  }

  /**
   * 播放开始回调
   */
  onPlayStart(messageId) {
    console.log('TTSManager: 播放开始', messageId);
    this.updateMessagePlayingStatus(messageId, true);
  }

  /**
   * 播放结束回调
   */
  onPlayEnd(messageId) {
    console.log('TTSManager: 播放结束', messageId);
    this.updateMessagePlayingStatus(messageId, false);
  }

  /**
   * 播放错误回调
   */
  onPlayError(error, messageId) {
    console.error('TTSManager: 播放错误', error, messageId);
    if (messageId) {
      this.updateMessagePlayingStatus(messageId, false);
    }
    
    wx.showToast({
      title: '语音播放失败',
      icon: 'none',
      duration: 2000
    });
  }

  /**
   * 获取播放状态
   */
  getPlayingStatus() {
    return this.audioPlayer.getPlayingStatus();
  }

  /**
   * 设置自动朗读
   */
  setAutoTTS(enabled) {
    this.autoTTS = enabled;
    
    // 保存设置
    try {
      wx.setStorageSync('tts_auto_play', enabled);
    } catch (error) {
      console.error('TTSManager: 保存设置失败', error);
    }
    
    this.page.setData({ autoTTS: enabled });
    console.log('TTSManager: 自动朗读设置已更新', enabled);
  }
}

module.exports = TTSManager;