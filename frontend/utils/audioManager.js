/**
 * 音频播放管理器
 * 用于处理TTS音频播放、控制和状态管理
 */

const config = require('../config/env.js');

class AudioManager {
  constructor() {
    this.currentAudio = null;
    this.isPlaying = false;
    this.currentMessageId = null;
    this.playQueue = [];
    
    // 音频播放回调
    this.onPlayStart = null;
    this.onPlayEnd = null;
    this.onPlayError = null;
  }

  /**
   * 播放TTS语音流
   * @param {string} text - 要转换的文本
   * @param {Object} options - 播放选项
   * @param {string} options.messageId - 消息ID
   * @param {string} options.voice - 音色
   * @param {string} options.userId - 用户ID
   * @returns {Promise<boolean>} 播放成功返回true
   */
  async playTTSStream(text, options = {}) {
    try {
      console.log('开始TTS播放:', { text: text.substring(0, 50) + '...', options });
      
      // 停止当前播放
      this.stop();
      
      // 设置当前消息ID
      this.currentMessageId = options.messageId;
      
      // 调用播放开始回调
      if (this.onPlayStart) {
        this.onPlayStart(options.messageId);
      }

      // 发起TTS请求
      const response = await this.requestTTS(text, options);
      
      if (!response.tempFilePath) {
        throw new Error('TTS请求失败：无音频数据');
      }

      // 播放音频
      await this.playAudioFile(response.tempFilePath, options.messageId);
      return true;
      
    } catch (error) {
      console.error('TTS播放失败:', error);
      
      // 播放失败，触发错误回调
      if (this.onPlayError) {
        this.onPlayError(error, options.messageId);
      }
      
      // 显示错误提示
      wx.showToast({
        title: '语音播放失败',
        icon: 'none',
        duration: 2000
      });
      
      return false;
    }
  }

  /**
   * 请求TTS服务
   * @param {string} text - 文本内容
   * @param {Object} options - 请求选项
   * @returns {Promise<Object>} 返回音频文件信息
   */
  async requestTTS(text, options = {}) {
    return new Promise((resolve, reject) => {
      // 获取用户TTS设置
      const ttsSettings = wx.getStorageSync('tts_settings') || {};
      
      wx.request({
        url: `${config.API_BASE_URL}/api/speech/tts/stream`,
        method: 'POST',
        data: {
          text: text,
          voice: options.voice || this.getSelectedVoice(ttsSettings),
          userId: options.userId || 'miniprogram_user'
        },
        responseType: 'arraybuffer',
        timeout: 30000,
        
        success: (res) => {
          console.log('TTS请求成功:', { 
            statusCode: res.statusCode, 
            dataSize: res.data ? res.data.byteLength : 0,
            provider: res.header['X-TTS-Provider'],
            format: res.header['X-Audio-Format']
          });
          
          if (res.statusCode === 200 && res.data) {
            // 确定音频格式
            const audioFormat = res.header['X-Audio-Format'] || 'wav';
            const tempFilePath = `${wx.env.USER_DATA_PATH}/tts_${Date.now()}.${audioFormat}`;
            
            // 写入临时文件
            wx.getFileSystemManager().writeFile({
              filePath: tempFilePath,
              data: res.data,
              success: () => {
                resolve({
                  tempFilePath: tempFilePath,
                  format: audioFormat,
                  size: res.data.byteLength,
                  provider: res.header['X-TTS-Provider']
                });
              },
              fail: (error) => {
                console.error('音频文件写入失败:', error);
                reject(new Error('音频文件保存失败'));
              }
            });
          } else {
            reject(new Error(`TTS请求失败: ${res.statusCode}`));
          }
        },
        
        fail: (error) => {
          console.error('TTS请求失败:', error);
          reject(new Error(`网络请求失败: ${error.errMsg || 'Unknown error'}`));
        }
      });
    });
  }

  /**
   * 播放音频文件
   * @param {string} filePath - 音频文件路径
   * @param {string} messageId - 消息ID
   * @returns {Promise<void>}
   */
  async playAudioFile(filePath, messageId) {
    return new Promise((resolve, reject) => {
      // 创建音频上下文
      const audioContext = wx.createInnerAudioContext();
      audioContext.src = filePath;
      audioContext.autoplay = true;
      
      // 设置当前音频对象
      this.currentAudio = audioContext;
      this.isPlaying = true;
      
      // 播放开始事件
      audioContext.onPlay(() => {
        console.log('音频开始播放:', { messageId, filePath });
        this.isPlaying = true;
      });
      
      // 播放结束事件
      audioContext.onEnded(() => {
        console.log('音频播放结束:', { messageId });
        this.cleanup(audioContext, filePath);
        
        // 调用播放结束回调
        if (this.onPlayEnd) {
          this.onPlayEnd(messageId);
        }
        
        resolve();
      });
      
      // 播放错误事件
      audioContext.onError((error) => {
        console.error('音频播放错误:', error, { messageId, filePath });
        this.cleanup(audioContext, filePath);
        
        // 调用播放错误回调
        if (this.onPlayError) {
          this.onPlayError(error, messageId);
        }
        
        reject(new Error(`音频播放失败: ${error.errMsg || 'Unknown error'}`));
      });
      
      // 播放停止事件（用户主动停止）
      audioContext.onStop(() => {
        console.log('音频播放停止:', { messageId });
        this.cleanup(audioContext, filePath);
        
        // 调用播放结束回调
        if (this.onPlayEnd) {
          this.onPlayEnd(messageId);
        }
        
        resolve();
      });
    });
  }

  /**
   * 停止当前播放
   */
  stop() {
    if (this.currentAudio && this.isPlaying) {
      console.log('停止音频播放:', { messageId: this.currentMessageId });
      this.currentAudio.stop();
      
      // cleanup会在onStop事件中自动调用
    }
  }

  /**
   * 清理音频资源
   * @param {Object} audioContext - 音频上下文
   * @param {string} filePath - 临时文件路径
   */
  cleanup(audioContext, filePath) {
    // 重置播放状态
    this.isPlaying = false;
    this.currentMessageId = null;
    
    // 销毁音频上下文
    if (audioContext) {
      audioContext.destroy();
    }
    
    // 设置当前音频为null
    if (this.currentAudio === audioContext) {
      this.currentAudio = null;
    }
    
    // 删除临时文件
    if (filePath) {
      wx.getFileSystemManager().unlink({
        filePath: filePath,
        success: () => {
          console.log('临时音频文件删除成功:', filePath);
        },
        fail: (error) => {
          console.warn('临时音频文件删除失败:', error, filePath);
        }
      });
    }
  }

  /**
   * 获取播放状态
   * @returns {Object} 播放状态信息
   */
  getPlayingStatus() {
    return {
      isPlaying: this.isPlaying,
      currentMessageId: this.currentMessageId,
      hasCurrentAudio: !!this.currentAudio
    };
  }

  /**
   * 检查指定消息是否正在播放
   * @param {string} messageId - 消息ID
   * @returns {boolean}
   */
  isMessagePlaying(messageId) {
    return this.isPlaying && this.currentMessageId === messageId;
  }

  /**
   * 获取选中的音色
   * @param {Object} ttsSettings - TTS设置
   * @returns {string} 音色ID
   */
  getSelectedVoice(ttsSettings) {
    // 如果有保存的音色设置，返回选中的音色
    if (ttsSettings.selectedVoiceIndex !== undefined && ttsSettings.voices) {
      const selectedVoice = ttsSettings.voices[ttsSettings.selectedVoiceIndex];
      if (selectedVoice && selectedVoice.id) {
        return selectedVoice.id;
      }
    }
    
    // 返回空值，让后端使用默认音色
    return undefined;
  }

  /**
   * 设置播放事件回调
   * @param {Object} callbacks - 回调函数
   * @param {Function} callbacks.onPlayStart - 播放开始回调
   * @param {Function} callbacks.onPlayEnd - 播放结束回调  
   * @param {Function} callbacks.onPlayError - 播放错误回调
   */
  setCallbacks(callbacks = {}) {
    this.onPlayStart = callbacks.onPlayStart;
    this.onPlayEnd = callbacks.onPlayEnd;
    this.onPlayError = callbacks.onPlayError;
  }

  /**
   * 获取支持的音色列表
   * @returns {Promise<Object>} 音色列表和Provider信息
   */
  async getSupportedVoices() {
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${config.API_BASE_URL}/api/speech/tts/voices`,
        method: 'GET',
        timeout: 10000,
        
        success: (res) => {
          if (res.statusCode === 200) {
            console.log('获取音色列表成功:', res.data);
            resolve(res.data);
          } else {
            reject(new Error(`获取音色列表失败: ${res.statusCode}`));
          }
        },
        
        fail: (error) => {
          console.error('获取音色列表失败:', error);
          reject(new Error(`网络请求失败: ${error.errMsg}`));
        }
      });
    });
  }

  /**
   * 测试指定音色
   * @param {string} voiceId - 音色ID
   * @returns {Promise<boolean>}
   */
  async testVoice(voiceId) {
    const testText = '您好，我是杨院长，很高兴为您提供整形美容咨询服务。';
    
    try {
      const success = await this.playTTSStream(testText, {
        voice: voiceId,
        userId: 'voice_test',
        messageId: 'test_' + Date.now()
      });
      
      return success;
    } catch (error) {
      console.error('音色测试失败:', error);
      return false;
    }
  }
}

// 导出单例实例
const audioManager = new AudioManager();

module.exports = audioManager;