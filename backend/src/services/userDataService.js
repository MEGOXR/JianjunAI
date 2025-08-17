const fs = require('fs').promises;
const path = require('path');

class UserDataService {
  constructor() {
    this.dataDir = path.join(__dirname, '../../data');
    this.userDataFile = path.join(this.dataDir, 'users.json');
    this.cache = new Map(); // 内存缓存
    this.cacheTimeout = 5 * 60 * 1000; // 5分钟缓存过期
    this.lastCacheUpdate = 0;
    this.pendingWrites = new Map(); // 防止并发写入
    this.initializeDataStore();
  }
  
  // 验证userId格式，防止路径遍历攻击
  validateUserId(userId) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Invalid userId: must be a non-empty string');
    }
    
    // 检查userId格式：必须以'user_'开头，后面只能包含字母数字和下划线
    if (!userId.match(/^user_[a-zA-Z0-9_]+$/)) {
      throw new Error('Invalid userId format: must match pattern user_[a-zA-Z0-9_]+');
    }
    
    // 限制长度
    if (userId.length > 50) {
      throw new Error('Invalid userId: too long');
    }
    
    return true;
  }

  async initializeDataStore() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      
      try {
        await fs.access(this.userDataFile);
      } catch {
        await fs.writeFile(this.userDataFile, JSON.stringify({}), 'utf8');
      }
    } catch (error) {
      console.error('Failed to initialize data store:', error);
    }
  }

  async loadUserData() {
    // 检查缓存是否有效
    const now = Date.now();
    if (this.cache.size > 0 && (now - this.lastCacheUpdate) < this.cacheTimeout) {
      const result = {};
      for (const [key, value] of this.cache.entries()) {
        result[key] = value;
      }
      return result;
    }
    
    try {
      const data = await fs.readFile(this.userDataFile, 'utf8');
      const parsed = JSON.parse(data);
      // 确保返回的是对象
      if (typeof parsed !== 'object' || parsed === null) {
        console.warn('用户数据不是有效对象，重置为空对象');
        return {};
      }
      
      // 更新缓存
      this.cache.clear();
      for (const [key, value] of Object.entries(parsed)) {
        this.cache.set(key, value);
      }
      this.lastCacheUpdate = now;
      
      return parsed;
    } catch (error) {
      console.error('Failed to load user data:', error);
      return {};
    }
  }

  async saveUserData(userData) {
    try {
      await fs.writeFile(this.userDataFile, JSON.stringify(userData, null, 2), 'utf8');
      
      // 更新缓存
      this.cache.clear();
      for (const [key, value] of Object.entries(userData)) {
        this.cache.set(key, value);
      }
      this.lastCacheUpdate = Date.now();
      
    } catch (error) {
      console.error('Failed to save user data:', error);
    }
  }

  async getUserData(userId) {
    this.validateUserId(userId);
    
    // 首先尝试从缓存获取
    if (this.cache.has(userId) && (Date.now() - this.lastCacheUpdate) < this.cacheTimeout) {
      return this.cache.get(userId) || null;
    }
    
    const allUsers = await this.loadUserData();
    return allUsers[userId] || null;
  }

  async updateUserData(userId, data) {
    this.validateUserId(userId);
    let allUsers = await this.loadUserData();
    
    // 额外的安全检查，确保 allUsers 是对象
    if (typeof allUsers !== 'object' || allUsers === null || Array.isArray(allUsers)) {
      console.warn(`用户数据格式异常，重置为空对象。当前类型: ${typeof allUsers}, 值: ${allUsers}`);
      allUsers = {};
    }
    
    if (!allUsers[userId]) {
      allUsers[userId] = {
        userId,
        createdAt: new Date().toISOString(),
        lastVisit: new Date().toISOString(),
        chatHistory: [],
        userInfo: {}
      };
    }
    
    allUsers[userId] = {
      ...allUsers[userId],
      ...data,
      lastVisit: new Date().toISOString()
    };
    
    await this.saveUserData(allUsers);
    return allUsers[userId];
  }

  async updateChatHistory(userId, chatHistory) {
    this.validateUserId(userId);
    const userData = await this.getUserData(userId) || {
      userId,
      createdAt: new Date().toISOString(),
      lastVisit: new Date().toISOString(),
      userInfo: {}
    };
    
    userData.chatHistory = chatHistory;
    userData.lastMessage = chatHistory.length > 0 ? 
      chatHistory[chatHistory.length - 1].content : null;
    
    return await this.updateUserData(userId, userData);
  }

  async updateUserInfo(userId, userInfo) {
    this.validateUserId(userId);
    const userData = await this.getUserData(userId) || {
      userId,
      createdAt: new Date().toISOString(),
      lastVisit: new Date().toISOString(),
      chatHistory: []
    };
    
    userData.userInfo = {
      ...userData.userInfo,
      ...userInfo
    };
    
    return await this.updateUserData(userId, userData);
  }


  calculateTimeSinceLastVisit(lastVisit) {
    if (!lastVisit) return null;
    
    const now = new Date();
    const last = new Date(lastVisit);
    const diffMs = now - last;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    
    if (diffDays > 0) {
      return { value: diffDays, unit: 'days' };
    } else if (diffHours > 0) {
      return { value: diffHours, unit: 'hours' };
    } else if (diffMinutes > 0) {
      return { value: diffMinutes, unit: 'minutes' };
    } else {
      return { value: 0, unit: 'just_now' };
    }
  }
}

module.exports = new UserDataService();