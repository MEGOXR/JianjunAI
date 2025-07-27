App({
  globalData: {
    wsBaseUrl: "wss://mego-xr.com/api",
    messagesLoaded: false
  },
  onLaunch: function () {
    wx.showModal({
      title: '欢迎',
      content: '你好，我是杨院长的AI化身。我将为你解答各种整形美容相关的问题，帮助你更好地了解手术过程，提供术前术后的专业建议。不管你有任何疑问，请随时向我咨询！',
      showCancel: false,
      confirmText: '开始交流',
      success: (res) => {
        if (res.confirm) {
          // Use nextTick to ensure DOM is updated
          wx.nextTick(() => {
            const pages = getCurrentPages();
            const currentPage = pages[pages.length - 1];
            if (currentPage && typeof currentPage.scrollToBottom === 'function') {
              currentPage.scrollToBottom();
            }
          });
        }
      }
    });
  },

   getFormattedTime: function(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  },

  getFormattedDate: function(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
});
