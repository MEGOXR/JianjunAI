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
    
    // 手指持续按住检测
    this.isFingerOnButton = false;
    this.touchCheckTimer = null;
    this.lastTouchTime = 0;
    
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
    
    if (this.page.streamingSpeechManager.getSessionId()) {
      this.page.streamingSpeechManager.markAsCanceled();
    }
    this.page.streamingSpeechManager.endSession();
  }

  /**
   * 开始持续检测手指是否还在按钮上
   */
  startTouchCheck() {
    this.lastTouchTime = Date.now();
    this.touchCheckTimer = setInterval(() => {
      const timeSinceLastTouch = Date.now() - this.lastTouchTime;
      // 如果超过100ms没有触摸事件，认为手指已离开
      if (timeSinceLastTouch > 100) {
        console.log('检测到手指离开，自动停止录音');
        this.stopTouchCheck();
        if (this.page.data.isRecording) {
          this.stopVoiceRecording();
        }
        if (this.page.data.isInputRecording) {
          this.stopInputRecording();
        }
      }
    }, 50); // 每50ms检查一次
  }

  /**
   * 停止持续检测
   */
  stopTouchCheck() {
    if (this.touchCheckTimer) {
      clearInterval(this.touchCheckTimer);
      this.touchCheckTimer = null;
    }
    this.isFingerOnButton = false;
  }

  /**
   * 更新触摸时间（在move事件中调用）
   */
  updateTouchTime() {
    this.lastTouchTime = Date.now();
  }

  // ==================== 语音模式录音 ====================

  /**
   * 语音按钮触摸开始
   */
  onVoiceTouchStart(e) {
    this.recordingStartY = e.touches[0].clientY;
    this.voiceTouchStartTime = Date.now();
    this.isFingerOnButton = true;
    this.page.setData({
      recordingStartY: e.touches[0].clientY,
      isRecordingCanceling: false
    });
    
    // 恢复50ms快速响应
    this.voiceLongPressTimer = setTimeout(() => {
      // 检查手指是否还在按钮上
      if (this.isFingerOnButton) {
        this.checkRecordingPermission(() => {
          this.startVoiceRecording();
          this.startTouchCheck(); // 开始持续检测
        });
      }
    }, 50);
  }

  /**
   * 语音按钮触摸移动
   */
  onVoiceTouchMove(e) {
    // 更新触摸时间，表示手指还在按钮上
    this.updateTouchTime();
    
    if (!this.page.data.isRecording) return;
    
    const currentY = e.touches[0].clientY;
    const deltaY = this.recordingStartY - currentY;
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
   * 语音按钮触摸结束
   */
  onVoiceTouchEnd(e) {
    // 标记手指离开按钮
    this.isFingerOnButton = false;
    this.stopTouchCheck();
    
    // 清除长按定时器
    if (this.voiceLongPressTimer) {
      clearTimeout(this.voiceLongPressTimer);
      this.voiceLongPressTimer = null;
    }
    
    // 如果正在录音，停止录音
    if (this.page.data.isRecording) {
      if (this.page.data.isRecordingCanceling) {
        this.cancelVoiceRecording();
      } else {
        this.stopVoiceRecording();
        this.page.setData({
          isRecordingCanceling: false
        });
      }
    }
  }

  /**
   * 语音按钮触摸取消
   */
  onVoiceTouchCancel(e) {
    // 标记手指离开按钮
    this.isFingerOnButton = false;
    this.stopTouchCheck();
    
    // 清除长按定时器
    if (this.voiceLongPressTimer) {
      clearTimeout(this.voiceLongPressTimer);
      this.voiceLongPressTimer = null;
    }
    
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
    if (this.page.data.userInput || this.page.data.keyboardHeight > 0) {
      return;
    }
    
    this.inputTouchStartTime = Date.now();
    this.inputTouchStartY = e.touches[0].clientY;
    this.isFingerOnButton = true;
    
    // 恢复50ms快速响应
    this.inputLongPressTimer = setTimeout(() => {
      // 检查手指是否还在按钮上
      if (this.isFingerOnButton) {
        this.startInputRecording();
        this.startTouchCheck(); // 开始持续检测
      }
    }, 50);
  }

  /**
   * 输入框触摸移动
   */
  onInputTouchMove(e) {
    // 更新触摸时间，表示手指还在按钮上
    this.updateTouchTime();
    
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
    // 标记手指离开按钮
    this.isFingerOnButton = false;
    this.stopTouchCheck();
    
    // 清除长按定时器
    if (this.inputLongPressTimer) {
      clearTimeout(this.inputLongPressTimer);
      this.inputLongPressTimer = null;
    }
    
    // 如果正在录音，停止录音
    if (this.page.data.isInputRecording) {
      if (this.page.data.isRecordingCanceling) {
        this.cancelInputRecording();
      } else {
        this.stopInputRecording();
      }
    }
  }

  /**
   * 输入框触摸取消
   */
  onInputTouchCancel(e) {
    // 标记手指离开按钮
    this.isFingerOnButton = false;
    this.stopTouchCheck();
    
    // 清除长按定时器
    if (this.inputLongPressTimer) {
      clearTimeout(this.inputLongPressTimer);
      this.inputLongPressTimer = null;
    }
    
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
      frameSize: 2
    };
    
    this.recorderManager.start(options);
    
    this.page.setData({
      isRecording: true,
      showVoiceModal: true,
      recordingDuration: 0,
      waveformData: new Array(10).fill(30)
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
    this.recorderManager.stop();
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    this.isCancelingRecording = true;
    
    if (this.page.streamingSpeechManager.getSessionId()) {
      this.page.streamingSpeechManager.markAsCanceled();
    }
    
    this.page.setData({
      isRecording: false,
      showVoiceModal: false
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
    this.checkRecordingPermission(() => {
      this.page.setData({
        isInputRecording: true,
        showVoiceModal: true,
        recordingDuration: 0,
        waveformData: new Array(10).fill(30)
      });
      
      this.recorderManager.start({
        duration: 60000,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'pcm',
        frameSize: 2
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
    this.recorderManager.stop();
    this.stopRecordingTimer();
    this.stopWaveformAnimation();
    
    this.isCancelingRecording = true;
    
    if (this.page.streamingSpeechManager.getSessionId()) {
      this.page.streamingSpeechManager.markAsCanceled();
    }
    
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
    this.waveformTimer = setInterval(() => {
      if (!this.page.data.isRecording) return;
      
      const waveformData = Array(10).fill(0).map(() => {
        return Math.random() * 60 + 30;
      });
      
      this.page.setData({ waveformData });
    }, 120);
  }

  /**
   * 停止波形动画
   */
  stopWaveformAnimation() {
    if (this.waveformTimer) {
      clearInterval(this.waveformTimer);
      this.waveformTimer = null;
    }
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
    this.stopTouchCheck(); // 清理触摸检测定时器
    
    if (this.voiceLongPressTimer) {
      clearTimeout(this.voiceLongPressTimer);
    }
    if (this.inputLongPressTimer) {
      clearTimeout(this.inputLongPressTimer);
    }
  }
}

module.exports = VoiceRecorder;