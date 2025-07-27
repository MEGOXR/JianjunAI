const fs = require('fs').promises;
const path = require('path');

class UserDataService {
  constructor() {
    this.dataDir = path.join(__dirname, '../../data');
    this.userDataFile = path.join(this.dataDir, 'users.json');
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
    try {
      const data = await fs.readFile(this.userDataFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Failed to load user data:', error);
      return {};
    }
  }

  async saveUserData(userData) {
    try {
      await fs.writeFile(this.userDataFile, JSON.stringify(userData, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to save user data:', error);
    }
  }

  async getUserData(userId) {
    this.validateUserId(userId);
    const allUsers = await this.loadUserData();
    return allUsers[userId] || null;
  }

  async updateUserData(userId, data) {
    this.validateUserId(userId);
    const allUsers = await this.loadUserData();
    
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