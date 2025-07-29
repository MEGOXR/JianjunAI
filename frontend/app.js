App({
  globalData: {
    // 生产环境
    wsBaseUrl: "wss://mego-xr.com/api/",
    // 本地测试环境
    // wsBaseUrl: "ws://localhost:3000",
    messagesLoaded: false
  },
  onLaunch: function () {
    // 应用启动时的初始化逻辑
    console.log('App launched');
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
