/**
 * Scroll Controller Module
 * 处理聊天区域滚动控制、智能暂停、用户交互检测
 */
class ScrollController {
  constructor(pageInstance) {
    this.page = pageInstance;
    this.scrollTimer = null;
    this.scrollEventTimer = null;
    this.hasSmartPaused = false;
    this.userIsTouching = false;
  }

  /**
   * 调度自动滚动
   */
  scheduleAutoScroll() {
    if (this.scrollTimer || this.page.data.userHasScrolledUp) {
      return;
    }

    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      if (!this.page.data.userHasScrolledUp) {
        this.page.setData({ scrollIntoView: '' }, () => {
          wx.nextTick(() => {
            this.page.setData({ scrollIntoView: 'chat-bottom-anchor' });
          });
        });
      }
    }, 50);
  }

  /**
   * 滚动到底部
   */
  scrollToBottom(force = false) {
    if (!force && this.page.data.userHasScrolledUp) {
      return;
    }
    this.scheduleAutoScroll();
  }

  /**
   * 强制滚动到底部
   */
  forceScrollToBottom() {
    this.hasSmartPaused = false;
    console.log('🔄 用户点击回到底部，重置智能暂停状态');
    this.page.setData({
      userHasScrolledUp: false,
      showScrollToBottom: false,
      scrollIntoView: ''
    }, () => {
      wx.nextTick(() => {
        this.page.setData({ scrollIntoView: 'chat-bottom-anchor' });
      });
    });
  }

  /**
   * 重置智能暂停状态
   */
  resetSmartPause() {
    this.hasSmartPaused = false;
    console.log('✅ 重置智能暂停状态');
  }

  /**
   * 处理流式内容的滚动逻辑
   */
  handleStreamingScroll(messageIndex, content) {
    console.log('🔍 handleStreamingScroll检查状态:', {
      用户上滑: this.page.data.userHasScrolledUp,
      智能暂停: this.hasSmartPaused,
      内容长度: content.length
    });
    
    if (!this.page.data.userHasScrolledUp && !this.hasSmartPaused) {
      // 当AI回复超过200字符时，检查是否需要暂停
      if (content.length > 200) {
        this.checkSmartPause(messageIndex, content);
      } else {
        // 内容较短，直接滚动
        console.log('⬇️ 内容较短，直接滚动 (内容长度: ' + content.length + ')');
        this.performScroll();
      }
    } else {
      console.log('⏹️ 停止滚动 - 状态:', {
        用户上滑: this.page.data.userHasScrolledUp,
        智能暂停: this.hasSmartPaused
      });
    }
  }

  /**
   * 检查是否需要智能暂停
   */
  checkSmartPause(messageIndex, content) {
    wx.createSelectorQuery()
      .select('.chat-history').boundingClientRect()
      .select(`#msg-${messageIndex}`).boundingClientRect()
      .exec(res => {
        if (res && res[0] && res[1]) {
          const scrollRect = res[0];
          const msgRect = res[1];
          
          const msgHeight = msgRect.height;
          const viewportHeight = scrollRect.height;
          const msgBottomRelativeToView = msgRect.bottom - scrollRect.top;
          
          // 当AI消息高度达到视口高度且接近底部时暂停
          if (msgHeight >= viewportHeight && msgBottomRelativeToView >= viewportHeight - 150) {
            console.log('🚫 智能暂停触发！', {
              AI消息高度: msgHeight + 'px',
              视口高度: viewportHeight + 'px',
              消息占比: (msgHeight / viewportHeight * 100).toFixed(1) + '%',
              消息底部位置: msgBottomRelativeToView + 'px'
            });
            this.hasSmartPaused = true;
            this.page.setData({ showScrollToBottom: true });
            return;
          }
        }
        
        // 否则继续自动滚动
        console.log('⬇️ 继续自动滚动 (内容长度: ' + content.length + ')');
        this.performScroll();
      });
  }

  /**
   * 执行滚动操作
   */
  performScroll() {
    this.page.setData({ scrollIntoView: '' }, () => {
      wx.nextTick(() => {
        this.page.setData({ scrollIntoView: 'chat-bottom-anchor' });
      });
    });
  }

  /**
   * 处理滚动事件
   */
  onScroll(e) {
    if (this.scrollEventTimer) return;
    this.scrollEventTimer = setTimeout(() => {
      this.scrollEventTimer = null;
    }, 100);

    const { scrollTop, scrollHeight } = e.detail;
    const chatViewHeight = this.page.data.chatHistoryHeight || 700;
    const atBottomThreshold = 50;
    const isAtBottom = scrollHeight - scrollTop - chatViewHeight < atBottomThreshold;
    
    console.log('🔍 onScroll事件:', {
      isAtBottom: isAtBottom,
      userIsTouching: this.userIsTouching,
      距离底部: scrollHeight - scrollTop - chatViewHeight
    });

    if (!isAtBottom && this.userIsTouching) {
      // 只有用户正在触摸时，才认为是用户主导的滚动
      if (!this.page.data.userHasScrolledUp) {
        console.log('📍 检测到用户主动上滑 (基于触摸事件)');
        this.page.setData({ userHasScrolledUp: true });
      }
      if (!this.page.data.showScrollToBottom) {
        this.page.setData({ showScrollToBottom: true });
      }
    } else if (isAtBottom) {
      // 到达底部时重置所有状态
      if (this.page.data.userHasScrolledUp || this.page.data.showScrollToBottom || this.hasSmartPaused) {
        console.log('📍 回到底部，重置所有状态');
        this.hasSmartPaused = false;
        this.page.setData({
          userHasScrolledUp: false,
          showScrollToBottom: false
        });
      }
    }
  }

  /**
   * 触摸开始事件
   */
  onTouchStart(e) {
    this.userIsTouching = true;
    console.log('👆 用户开始触摸滚动区域');
  }

  /**
   * 触摸结束事件
   */
  onTouchEnd(e) {
    this.userIsTouching = false;
    console.log('🤚 用户结束触摸');
  }

  /**
   * 处理键盘高度变化
   */
  handleKeyboardHeightChange(res) {
    console.log('键盘高度变化:', res.height);
    
    this.page.setData({
      keyboardHeight: res.height
    });

    if (!this.page.data.userHasScrolledUp) {
      setTimeout(() => {
        this.forceScrollToBottom();
      }, 100); 
    }
  }

  /**
   * 处理输入框获得焦点
   */
  handleFocus() {
    this.forceScrollToBottom();
  }

  /**
   * 获取聊天区域高度
   */
  getChatHistoryHeight() {
    wx.createSelectorQuery()
      .select('.chat-history')
      .boundingClientRect(rect => {
        if (rect) {
          this.page.setData({ chatHistoryHeight: rect.height });
          console.log("聊天区域高度:", rect.height);
        }
      }).exec();
  }

  /**
   * 清理定时器
   */
  cleanup() {
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    if (this.scrollEventTimer) {
      clearTimeout(this.scrollEventTimer);
      this.scrollEventTimer = null;
    }
  }
}

module.exports = ScrollController;