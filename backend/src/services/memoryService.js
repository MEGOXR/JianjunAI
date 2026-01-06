/**
 * Memory Service
 * 统一编排 Supabase（持久化存储）和 Memobase（AI记忆）
 *
 * 这是一个门面服务，提供统一的接口来管理用户数据和记忆。
 * 它协调两个后端服务，并提供回退机制。
 */

const supabaseService = require('./supabaseService');
const memobaseService = require('./memobaseService');
const promptService = require('./promptService');

class MemoryService {
  constructor() {
    // 内存缓存（用于快速查找和回退）
    this.userCache = new Map(); // wechatOpenId -> { user, session, lastAccess }
    this.cacheTTL = 5 * 60 * 1000; // 5分钟

    // 功能开关
    this.useSupabase = false;
    this.useMemobase = false;
  }

  /**
   * 初始化服务
   */
  async initialize() {
    console.log('[MemoryService] 正在初始化...');

    // 读取功能开关
    this.useSupabase = process.env.USE_SUPABASE === 'true';
    this.useMemobase = process.env.USE_MEMOBASE === 'true';

    console.log(`[MemoryService] 功能开关: Supabase=${this.useSupabase}, Memobase=${this.useMemobase}`);

    // 初始化 Supabase
    if (this.useSupabase) {
      const supabaseOk = supabaseService.initialize();
      if (!supabaseOk) {
        console.warn('[MemoryService] Supabase 初始化失败，将使用本地存储');
        this.useSupabase = false;
      }
    }

    // 初始化 Memobase
    if (this.useMemobase) {
      const memobaseOk = await memobaseService.initialize();
      if (!memobaseOk) {
        console.warn('[MemoryService] Memobase 初始化失败，记忆功能将禁用');
        this.useMemobase = false;
      }
    }

    console.log('[MemoryService] 初始化完成');
    return true;
  }

  /**
   * 用户连接时调用
   * @param {string} wechatOpenId - 微信OpenID (格式: user_xxx)
   * @param {object} userInfo - 用户信息 { nickname }
   * @returns {object} 用户数据
   */
  async onUserConnect(wechatOpenId, userInfo = {}) {
    console.log(`[MemoryService] 用户 ${wechatOpenId} 连接`);

    let user = null;
    let session = null;

    // Supabase: 创建/更新用户和会话
    if (this.useSupabase && supabaseService.isAvailable()) {
      try {
        user = await supabaseService.upsertUser(wechatOpenId, userInfo.nickname);

        // 创建新会话
        if (user && user.uuid) {
          session = await supabaseService.createSession(user.uuid);
        }
      } catch (error) {
        console.error('[MemoryService] Supabase 用户连接处理失败:', error);
      }
    }

    // Memobase: 预加载用户
    if (this.useMemobase && memobaseService.isAvailable()) {
      try {
        await memobaseService.getOrCreateUser(wechatOpenId);
      } catch (error) {
        console.error('[MemoryService] Memobase 用户预加载失败:', error);
      }
    }

    // 更新缓存
    this.userCache.set(wechatOpenId, {
      user,
      session,
      lastAccess: Date.now()
    });

    return user;
  }

  /**
   * 用户断开连接时调用
   * @param {string} wechatOpenId - 微信OpenID
   */
  async onUserDisconnect(wechatOpenId) {
    console.log(`[MemoryService] 用户 ${wechatOpenId} 断开连接`);

    const cached = this.userCache.get(wechatOpenId);

    // 结束 Supabase 会话
    if (cached?.session?.id && this.useSupabase && supabaseService.isAvailable()) {
      try {
        await supabaseService.endSession(cached.session.id);
      } catch (error) {
        console.error('[MemoryService] 结束会话失败:', error);
      }
    }

    // 刷新 Memobase 缓冲
    if (this.useMemobase && memobaseService.isAvailable()) {
      try {
        await memobaseService.flushBuffer(wechatOpenId);
      } catch (error) {
        console.error('[MemoryService] 刷新 Memobase 缓冲失败:', error);
      }
    }

    // 不删除缓存，保留用于可能的快速重连
    if (cached) {
      cached.lastAccess = Date.now();
    }
  }

  /**
   * 处理用户消息
   * @param {string} wechatOpenId - 微信OpenID
   * @param {string} content - 消息内容
   */
  async processUserMessage(wechatOpenId, content) {
    const cached = this.userCache.get(wechatOpenId);

    // Supabase: 保存消息
    if (this.useSupabase && supabaseService.isAvailable() && cached?.user?.uuid && cached?.session?.id) {
      try {
        await supabaseService.saveMessage(
          cached.session.id,
          cached.user.uuid,
          'user',
          content
        );
      } catch (error) {
        console.error('[MemoryService] 保存用户消息到 Supabase 失败:', error);
      }
    }

    // Memobase: 缓冲消息
    if (this.useMemobase && memobaseService.isAvailable()) {
      memobaseService.bufferMessage(wechatOpenId, {
        role: 'user',
        content
      });
    }
  }

  /**
   * 处理助手消息
   * @param {string} wechatOpenId - 微信OpenID
   * @param {string} content - 消息内容
   */
  async processAssistantMessage(wechatOpenId, content) {
    const cached = this.userCache.get(wechatOpenId);

    // Supabase: 保存消息
    if (this.useSupabase && supabaseService.isAvailable() && cached?.user?.uuid && cached?.session?.id) {
      try {
        await supabaseService.saveMessage(
          cached.session.id,
          cached.user.uuid,
          'assistant',
          content
        );
      } catch (error) {
        console.error('[MemoryService] 保存助手消息到 Supabase 失败:', error);
      }
    }

    // Memobase: 缓冲消息
    if (this.useMemobase && memobaseService.isAvailable()) {
      memobaseService.bufferMessage(wechatOpenId, {
        role: 'assistant',
        content
      });
    }
  }

  /**
   * 获取聊天上下文（用于构建LLM请求）
   * @param {string} wechatOpenId - 微信OpenID
   * @param {number} limit - 最大消息数
   * @returns {Array} 消息列表
   */
  async getChatContext(wechatOpenId, limit = 10) {
    // 优先从 Supabase 获取
    if (this.useSupabase && supabaseService.isAvailable()) {
      try {
        const messages = await supabaseService.getRecentMessages(wechatOpenId, limit);
        if (messages && messages.length > 0) {
          return messages;
        }
      } catch (error) {
        console.error('[MemoryService] 从 Supabase 获取上下文失败:', error);
      }
    }

    // 回退到缓存
    return [];
  }

  /**
   * 获取增强的系统提示词（包含用户记忆）
   * @param {string} wechatOpenId - 微信OpenID
   * @returns {string} 增强后的系统提示词
   */
  async getEnhancedSystemPrompt(wechatOpenId) {
    // 获取基础提示词
    const basePrompt = promptService.getSystemPrompt();

    // 如果启用 Memobase，添加用户记忆上下文
    if (this.useMemobase && memobaseService.isAvailable()) {
      try {
        const enhancedPrompt = await memobaseService.buildEnhancedSystemPrompt(
          basePrompt,
          wechatOpenId
        );
        return enhancedPrompt;
      } catch (error) {
        console.error('[MemoryService] 获取增强提示词失败:', error);
      }
    }

    return basePrompt;
  }

  /**
   * 搜索记忆事件 (Active Recall)
   * @param {string} wechatOpenId - 微信OpenID
   * @param {string} query - 搜索关键词
   * @param {number} limit - 最大返回数量
   * @returns {Array} 相关的记忆事件列表
   */
  async searchEvents(wechatOpenId, query, limit = 5) {
    if (this.useMemobase && memobaseService.isAvailable()) {
      try {
        return await memobaseService.searchEvents(wechatOpenId, query, limit);
      } catch (error) {
        console.error('[MemoryService] 搜索记忆失败:', error);
      }
    }
    return [];
  }

  /**
   * 获取用户画像（用于问候语等）
   * @param {string} wechatOpenId - 微信OpenID
   * @returns {object|null} 用户画像
   */
  async getUserProfile(wechatOpenId) {
    if (this.useMemobase && memobaseService.isAvailable()) {
      try {
        return await memobaseService.getUserProfile(wechatOpenId);
      } catch (error) {
        console.error('[MemoryService] 获取用户画像失败:', error);
      }
    }
    return null;
  }

  /**
   * 获取用户数据（兼容旧格式）
   * @param {string} wechatOpenId - 微信OpenID
   * @returns {object|null} 旧格式用户数据
   */
  async getUserData(wechatOpenId) {
    // 尝试从 Supabase 获取
    if (this.useSupabase && supabaseService.isAvailable()) {
      try {
        const user = await supabaseService.getUserByWechatId(wechatOpenId);
        if (user) {
          const messages = await supabaseService.getRecentMessages(wechatOpenId, 10);
          return supabaseService.transformToLegacyFormat(user, messages);
        }
      } catch (error) {
        console.error('[MemoryService] 获取用户数据失败:', error);
      }
    }

    return null;
  }

  /**
   * 更新用户信息
   * @param {string} wechatOpenId - 微信OpenID
   * @param {object} updates - 更新内容
   */
  async updateUserInfo(wechatOpenId, updates) {
    // 更新 Supabase
    if (this.useSupabase && supabaseService.isAvailable()) {
      try {
        await supabaseService.updateUserInfo(wechatOpenId, updates);
      } catch (error) {
        console.error('[MemoryService] 更新 Supabase 用户信息失败:', error);
      }
    }

    // 更新 Memobase 元数据
    if (this.useMemobase && memobaseService.isAvailable() && updates.extractedName) {
      try {
        await memobaseService.updateUserMetadata(wechatOpenId, {
          name: updates.extractedName
        });
      } catch (error) {
        console.error('[MemoryService] 更新 Memobase 用户元数据失败:', error);
      }
    }
  }

  /**
   * 获取问候语所需的数据
   * @param {string} wechatOpenId - 微信OpenID
   * @returns {object} 问候语数据
   */
  async getGreetingData(wechatOpenId) {
    const result = {
      isNewUser: true,
      userName: null,
      lastVisit: null,
      lastTopics: [],
      profile: null
    };

    // 从 Supabase 获取基础数据
    if (this.useSupabase && supabaseService.isAvailable()) {
      try {
        const user = await supabaseService.getUserByWechatId(wechatOpenId);
        if (user) {
          result.isNewUser = user.totalSessions <= 1;
          result.userName = user.extractedName || user.nickname;
          result.lastVisit = user.lastVisit;
        }
      } catch (error) {
        console.error('[MemoryService] 获取问候语数据失败:', error);
      }
    }

    // 从 Memobase 获取画像
    if (this.useMemobase && memobaseService.isAvailable()) {
      try {
        result.profile = await memobaseService.getUserProfile(wechatOpenId, 200);
      } catch (error) {
        console.error('[MemoryService] 获取用户画像失败:', error);
      }
    }

    return result;
  }

  /**
   * 清理过期缓存
   */
  cleanupCache() {
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, data] of this.userCache.entries()) {
      if (now - data.lastAccess > this.cacheTTL) {
        this.userCache.delete(userId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[MemoryService] 清理了 ${cleaned} 个过期缓存`);
    }
  }

  /**
   * 优雅关闭
   */
  async shutdown() {
    console.log('[MemoryService] 正在关闭...');

    // 关闭 Memobase（会刷新所有缓冲）
    if (this.useMemobase) {
      await memobaseService.shutdown();
    }

    // 清理缓存
    this.userCache.clear();

    console.log('[MemoryService] 已关闭');
  }

  /**
   * 检查服务状态
   */
  getStatus() {
    return {
      supabase: {
        enabled: this.useSupabase,
        available: supabaseService.isAvailable()
      },
      memobase: {
        enabled: this.useMemobase,
        available: memobaseService.isAvailable()
      },
      cache: {
        size: this.userCache.size
      }
    };
  }
}

module.exports = new MemoryService();
