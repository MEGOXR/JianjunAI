/**
 * Voice Recorder Module
 * 处理语音录制、权限管理、录音控制
 */
class VoiceRecorder {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.recorderManager = wx.getRecorderManager();
    this.recordingTimer = null;
    this.waveformTimer = null;
    this.voiceLongPressTimer = null;
    this.inputLongPressTimer = null;
    this.isCancelingRecording = false;
    this.recordingStartY = 0;
    this.voiceTouchStartTime = 0; // 语音按钮触摸开始时间
    this.inputTouchStartTime = 0;
    this.inputTouchStartY = 0;
    this.isInputRecordingCanceled = false; // 标记输入框录音是否被取消
    
    // 音频分析相关
    this.frameBuffer = [];
    this.volumeHistory = [];
    this.maxVolumeHistory = 10;
    
    this.setupRecorderEvents();
  }

  /**
   * 初始化录音管理器事件监听
   */
  setupRecorderEvents() {
    this.recorderManager.onStart(() => {
      console.log('📱 录音开始');
      this.page.setData({ isRecording: true });
      this.page.streamingSpeechManager.startSession();
    });
    
    this.recorderManager.onFrameRecorded((res) => {
      if (this.page.streamingSpeechManager.isActive() && res.frameBuffer) {
        this.page.streamingSpeechManager.sendAudioFrame(res.frameBuffer);
      }
      
      // 分析音频帧数据获取音量
      if ((this.page.data.isRecording || this.page.data.isInputRecording) && res.frameBuffer) {
        const volume = this.analyzeAudioVolume(res.frameBuffer);
        
        // 更新音量历史
        this.volumeHistory.push(volume);
        if (this.volumeHistory.length > this.maxVolumeHistory) {
          this.volumeHistory.shift();
        }
        
        // 计算平均音量用于平滑动画
        const avgVolume = this.volumeHistory.reduce((a, b) => a + b, 0) / this.volumeHistory.length;
        
        // 根据音量生成波形数据
        this.updateWaveformDisplay(avgVolume);
      }
    });
    
    this.recorderManager.onStop((res) => {
      console.log('📱 录音结束');
      this.page.setData({ isRecording: false });
      
      if (this.page.data.isRecordingCanceling || this.isCancelingRecording) {
        this.handleRecordingCancel();
        return;
      }
      
      this.page.streamingSpeechManager.endSession();
    });
  }

  /**
   * 处理录音取消
   */
  handleRecordingCancel() {
    this.isCancelingRecording = false;
    this.page.setData({
      isRecordingCanceling: false
    });
    
    // 直接取消会话
    this.page.streamingSpeechManager.cancelSession();
  }


  // ==================== 语音模式录音 ====================

  /**
   * 语音按钮触摸开始
   */
  onVoiceTouchStart(e) {
    this.recordingStartY = e.touches[0].clientY;
    this.voiceTouchStartTime = Date.now();
    this.page.setData({
      recordingStartY: e.touches[0].clientY,
      isRecordingCanceling: false
    });
    
    // 保持语音按钮快速响应
    this.voiceLongPressTimer = setTimeout(() => {
      this.checkRecordingPermission(() => {
        this.startVoiceRecording();
      });
    }, 50);
  }

  /**
   * 语音按钮触摸移动
   */
  onVoiceTouchMove(e) {
    if (!this.page.data.isRecording) return;
    
    const currentY = e.touches[0].clientY;
    const deltaY = this.recordingStartY - currentY;
    const cancelThreshold = 100;
    
    const shouldCancel = deltaY > cancelThreshold;
    
    console.log('📍 触摸移动:', {
      startY: this.recordingStartY,
      currentY: currentY,
      deltaY: deltaY,
      shouldCancel: shouldCancel
    });
    
    if (shouldCancel !== this.page.data.isRecordingCanceling) {
      this.page.setData({
        isRecordingCanceling: shouldCancel
      });
      
      if (shouldCancel) {
        console.log('🚫 进入取消区域');
        wx.vibrateShort();
      }
    }
  }

  /**
   * 语音按钮触摸结束
   */
  onVoiceTouchEnd(e) {
    // 清除长按定时器，防止触发录音
    if (this.voiceLongPressTimer) {
      clearTimeout(this.voiceLongPressTimer);
      this.voiceLongPressTimer = null;
    }
    
    // 计算触摸持续时间
    const touchDuration = Date.now() - this.voiceTouchStartTime;
    
    console.log('👆 触摸结束:', {
      duration: touchDuration,
      isRecording: this.page.data.isRecording,
      isRecordingCanceling: this.page.data.isRecordingCanceling
    });
    
    // 如果没有开始录音，直接返回（说明是短触摸）
    if (!this.page.data.isRecording) {
      console.log('⏱️ 短触摸，未触发录音:', touchDuration + 'ms');
      return;
    }
    
    // 如果触摸时间少于300ms，认为是误触，取消录音
    if (touchDuration < 300) {
      console.log('⏱️ 触摸时间过短，取消录音:', touchDuration + 'ms');
      this.cancelVoiceRecording();
      return;
    }
    
    // 正在录音，根据取消状态决定操作
    if (this.page.data.isRecordingCanceling) {
      console.log('↑ 用户上滑取消录音');
      this.cancelVoiceRecording();
    } else {
      console.log('✅ 正常结束录音');
      this.stopVoiceRecording();
      this.page.setData({
        isRecordingCanceling: false
      });
    }
  }

  /**
   * 语音按钮触摸取消
   */
  onVoiceTouchCancel(e) {
    // 清除长按定时器
    if (this.voiceLongPressTimer) {
      clearTimeout(this.voiceLongPressTimer);
      this.voiceLongPressTimer = null;
    }
    
    console.log('触摸被系统取消');
    
    // 如果正在录音，取消录音
    if (this.page.data.isRecording) {
      this.cancelVoiceRecording();
    }
    
    // 重置UI状态，防止界面卡住
    this.page.setData({
      showVoiceModal: false,
      isRecording: false,
      isRecordingCanceling: false
    });
  }

  // ==================== 输入框语音录音 ====================

  /**
   * 输入框触摸开始
   */
  onInputTouchStart(e) {
    console.log('🔥 输入框触摸开始', {
      hasUserInput: !!this.page.data.userInput,
      keyboardHeight: this.page.data.keyboardHeight,
      currentTime: Date.now()
    });
    
    if (this.page.data.userInput || this.page.data.keyboardHeight > 0) {
      console.log('❌ 跳过触摸开始（有输入内容或键盘弹起）');
      return;
    }
    
    this.inputTouchStartTime = Date.now();
    this.inputTouchStartY = e.touches[0].clientY;
    this.isInputRecordingCanceled = false; // 重置取消标记
    
    console.log('⏱️ 设置60ms长按定时器');
    // 长按60ms触发录音
    this.inputLongPressTimer = setTimeout(() => {
      console.log('⏰ 长按定时器触发，检查是否已取消');
      if (!this.isInputRecordingCanceled) {
        console.log('✅ 未被取消，开始录音');
        this.startInputRecording();
      } else {
        console.log('❌ 已被取消，跳过录音');
      }
    }, 60);
  }

  /**
   * 输入框触摸移动
   */
  onInputTouchMove(e) {
    if (!this.page.data.isInputRecording || this.page.data.userInput || this.page.data.keyboardHeight > 0) return;
    
    const currentY = e.touches[0].clientY;
    const deltaY = this.inputTouchStartY - currentY;
    const cancelThreshold = 100;
    
    const shouldCancel = deltaY > cancelThreshold;
    
    if (shouldCancel !== this.page.data.isRecordingCanceling) {
      this.page.setData({
        isRecordingCanceling: shouldCancel
      });
      
      if (shouldCancel) {
        wx.vibrateShort();
      }
    }
  }

  /**
   * 输入框触摸结束
   */
  onInputTouchEnd(e) {
    const touchDuration = Date.now() - this.inputTouchStartTime;
    console.log('🛑 输入框触摸结束', {
      touchDuration: touchDuration + 'ms',
      hasLongPressTimer: !!this.inputLongPressTimer,
      isInputRecording: this.page.data.isInputRecording,
      showVoiceModal: this.page.data.showVoiceModal,
      currentTime: Date.now()
    });
    
    // 标记录音已被取消，防止异步的权限检查完成后仍然启动录音
    this.isInputRecordingCanceled = true;
    console.log('🚫 标记录音已被取消');
    
    // 清除长按定时器，防止触发录音
    if (this.inputLongPressTimer) {
      console.log('⏱️ 清除长按定时器');
      clearTimeout(this.inputLongPressTimer);
      this.inputLongPressTimer = null;
    } else {
      console.log('⚠️ 长按定时器已经不存在');
    }
    
    // 如果没有开始录音，直接返回（说明是短触摸）
    if (!this.page.data.isInputRecording) {
      console.log('✅ 输入框短触摸，未触发录音:', touchDuration + 'ms');
      
      // 强制确保UI状态正确
      this.page.setData({
        showVoiceModal: false,
        isInputRecording: false,
        isRecording: false,
        isRecordingCanceling: false
      });
      console.log('🔧 强制重置UI状态');
      return;
    }
    
    // 如果触摸时间少于300ms，认为是误触，取消录音
    if (touchDuration < 300) {
      console.log('⏰ 输入框触摸时间过短，取消录音:', touchDuration + 'ms');
      this.cancelInputRecording();
      return;
    }
    
    // 正在录音，根据取消状态决定操作
    if (this.page.data.isRecordingCanceling) {
      console.log('↑ 输入框用户上滑取消录音');
      this.cancelInputRecording();
    } else {
      console.log('✅ 输入框正常结束录音');
      this.stopInputRecording();
    }
  }

  /**
   * 输入框触摸取消
   */
  onInputTouchCancel(e) {
    // 清除长按定时器
    if (this.inputLongPressTimer) {
      clearTimeout(this.inputLongPressTimer);
      this.inputLongPressTimer = null;
    }
    
    console.log('输入框触摸被系统取消');
    
    // 如果正在录音，取消录音
    if (this.page.data.isInputRecording) {
      this.cancelInputRecording();
    }
    
    // 重置UI状态，防止界面卡住
    this.page.setData({
      showVoiceModal: false,
      isInputRecording: false,
      isRecordingCanceling: false
    });
  }

  // ==================== 录音控制方法 ====================

  /**
   * 开始语音模式录音
   */
  startVoiceRecording() {
    const options = {
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'pcm',
      frameSize: 5  // 增加frameSize以获得更频繁的帧回调
    };
    
    this.recorderManager.start(options);
    
    this.page.setData({
      isRecording: true,
      showVoiceModal: true,
      recordingDuration: 0,
      waveformData: new Array(10).fill(30),
      currentVolume: 0
    });
    
    this.startRecordingTimer();
    this.startWaveformAnimation();
  }

  /**
   * 停止语音模式录音
   */
  stopVoiceRecording() {
    this.recorderManager.stop();
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    this.page.setData({
      isRecording: false,
      showVoiceModal: false
    });
  }

  /**
   * 取消语音模式录音
   */
  cancelVoiceRecording() {
    console.log('🚫 取消语音录音');
    
    // 先标记为取消状态
    this.isCancelingRecording = true;
    
    // 停止录音
    this.recorderManager.stop();
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    this.page.setData({
      isRecording: false,
      showVoiceModal: false,
      isRecordingCanceling: false // 重置取消状态
    });
    
    wx.showToast({
      title: '录音已取消',
      icon: 'none',
      duration: 1500
    });
  }

  /**
   * 开始输入框录音
   */
  startInputRecording() {
    console.log('🎤 开始输入框录音');
    this.checkRecordingPermission(() => {
      // 在异步回调中再次检查是否已被取消
      if (this.isInputRecordingCanceled) {
        console.log('❌ 录音已被取消，不设置UI状态');
        return;
      }
      
      console.log('🔑 录音权限检查通过，设置录音UI状态');
      this.page.setData({
        isInputRecording: true,
        showVoiceModal: true,
        recordingDuration: 0,
        waveformData: new Array(10).fill(30),
        currentVolume: 0
      });
      console.log('📺 录音UI状态已设置:', {
        isInputRecording: true,
        showVoiceModal: true
      });
      
      // 启动录音前再次检查是否已被取消
      if (this.isInputRecordingCanceled) {
        console.log('❌ 录音已被取消，不启动录音管理器');
        return;
      }
      
      this.recorderManager.start({
        duration: 60000,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'pcm',
        frameSize: 5  // 增加frameSize以获得更频繁的帧回调
      });
      
      this.startRecordingTimer();
      this.startWaveformAnimation();
    });
  }

  /**
   * 停止输入框录音
   */
  stopInputRecording() {
    this.recorderManager.stop();
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    this.page.setData({
      isInputRecording: false,
      showVoiceModal: false,
      isRecordingCanceling: false
    });
  }

  /**
   * 取消输入框录音
   */
  cancelInputRecording() {
    console.log('🚫 取消输入框录音');
    
    // 先标记为取消状态
    this.isCancelingRecording = true;
    
    // 停止录音
    this.recorderManager.stop();
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    this.page.setData({
      isInputRecording: false,
      showVoiceModal: false,
      isRecordingCanceling: false
    });
    
    wx.showToast({
      title: '录音已取消',
      icon: 'none',
      duration: 1500
    });
  }

  // ==================== 权限管理 ====================

  /**
   * 检查录音权限
   */
  checkRecordingPermission(callback) {
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.record'] === undefined) {
          this.requestRecordingPermission(callback);
        } else if (res.authSetting['scope.record'] === false) {
          this.showPermissionDialog();
        } else {
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
  }

  /**
   * 请求录音权限
   */
  requestRecordingPermission(callback) {
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
  }

  /**
   * 显示权限设置对话框
   */
  showPermissionDialog() {
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
  }

  // ==================== 定时器控制 ====================

  /**
   * 开始录音计时器
   */
  startRecordingTimer() {
    this.recordingTimer = setInterval(() => {
      const duration = this.page.data.recordingDuration + 1;
      this.page.setData({ recordingDuration: duration });
      
      if (duration >= 60) {
        this.stopVoiceRecording();
      }
    }, 1000);
  }

  /**
   * 停止录音计时器
   */
  stopRecordingTimer() {
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
  }

  /**
   * 开始波形动画
   */
  startWaveformAnimation() {
    // 初始化音频分析
    this.frameBuffer = [];
    this.volumeHistory = [];
    
    // 备用: 如果没有帧数据，使用随机动画
    this.waveformTimer = setInterval(() => {
      if (!this.page.data.isRecording && !this.page.data.isInputRecording) return;
      
      // 如果2秒内没有收到帧数据，使用随机动画
      if (this.volumeHistory.length === 0) {
        const waveformData = Array(10).fill(0).map(() => {
          return Math.random() * 40 + 20;
        });
        this.page.setData({ waveformData });
      }
    }, 2000);
  }

  /**
   * 停止波形动画
   */
  stopWaveformAnimation() {
    if (this.waveformTimer) {
      clearInterval(this.waveformTimer);
      this.waveformTimer = null;
    }
    
    // 清理音频分析相关数据
    this.frameBuffer = [];
    this.volumeHistory = [];
    
    // 重置音量
    this.page.setData({ currentVolume: 0 });
  }
  
  /**
   * 分析音频帧数据获取音量
   */
  analyzeAudioVolume(frameBuffer) {
    if (!frameBuffer || frameBuffer.byteLength === 0) return 0;
    
    // 将ArrayBuffer转换为Int16Array（PCM格式）
    const dataView = new Int16Array(frameBuffer);
    let sum = 0;
    
    // 计算RMS（均方根）音量
    for (let i = 0; i < dataView.length; i++) {
      sum += dataView[i] * dataView[i];
    }
    
    const rms = Math.sqrt(sum / dataView.length);
    
    // 归一化到0-100的范围
    const maxValue = 32768; // 16位音频的最大值
    const volume = (rms / maxValue) * 100;
    
    return Math.min(100, volume * 2); // 放大2倍以获得更好的视觉效果
  }
  
  /**
   * 根据音量更新波形显示
   */
  updateWaveformDisplay(volume) {
    // 生成10个波形条的高度
    const waveformData = [];
    const baseHeight = 20; // 基础高度
    const maxHeight = 90; // 最大高度
    
    // 中间的条形应该更高
    for (let i = 0; i < 10; i++) {
      // 计算每个条的基础高度（中间高，两边低）
      const centerDistance = Math.abs(i - 4.5);
      const heightMultiplier = 1 - (centerDistance / 5) * 0.3;
      
      // 根据音量调整高度
      const volumeEffect = (volume / 100) * (maxHeight - baseHeight);
      
      // 添加一些随机性让动画更自然
      const randomFactor = 0.8 + Math.random() * 0.4;
      
      const height = baseHeight + volumeEffect * heightMultiplier * randomFactor;
      waveformData.push(Math.min(maxHeight, Math.max(baseHeight, height)));
    }
    
    // 更新波形数据和背景动画强度
    this.page.setData({ 
      waveformData,
      // 添加音量数据用于背景动画
      currentVolume: volume
    });
  }

  /**
   * 上传语音文件进行识别
   */
  uploadVoice(tempFilePath) {
    if (this.page.data.recordingDuration < 1) {
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
    
    wx.uploadFile({
      url: `${getApp().globalData.baseUrl}/api/speech-to-text`,
      filePath: tempFilePath,
      name: 'audio',
      header: {
        'Authorization': `Bearer ${this.page.authToken}`
      },
      formData: {
        userId: this.page.userId,
        format: 'pcm',
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
  }

  /**
   * 处理语音识别成功
   */
  handleSTTSuccess(text, confidence) {
    console.log('STT结果:', text, '置信度:', confidence);
    
    if (confidence < 0.7) {
      wx.showToast({
        title: '识别可能不准确',
        icon: 'none',
        duration: 1000
      });
    }
    
    this.page.messageManager.sendVoiceMessage(text);
  }

  /**
   * 处理STT错误
   */
  handleSTTError(errorMessage) {
    console.error('STT错误:', errorMessage);
    
    wx.showToast({
      title: '语音识别失败',
      icon: 'none',
      duration: 2000
    });
  }

  /**
   * 清理资源
   */
  cleanup() {
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    if (this.voiceLongPressTimer) {
      clearTimeout(this.voiceLongPressTimer);
    }
    if (this.inputLongPressTimer) {
      clearTimeout(this.inputLongPressTimer);
    }
  }
}

module.exports = VoiceRecorder;