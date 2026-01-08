/**
 * 空闲会话检测服务
 *
 * 解决问题：ws.on('close') 在移动端不可靠
 * - 微信小程序用户直接杀进程、网络切换、App被冻结到后台时，不会触发 close 事件
 * - 这会导致会话总结丢失
 *
 * 解决方案：双重触发机制
 * 1. ws.on('close') 保留作为触发器之一
 * 2. 空闲超时检测：定期扫描，如果用户 30 分钟无消息，则判定会话结束
 */

const supabaseService = require('./supabaseService');
const sessionSummaryService = require('./sessionSummaryService');

// 配置
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 分钟空闲视为会话结束
const CHECK_INTERVAL = 5 * 60 * 1000; // 每 5 分钟检查一次
const MIN_MESSAGES_FOR_SUMMARY = 2;   // 至少 2 条消息才生成摘要

class IdleSessionService {
  constructor() {
    this.checkTimer = null;
    this.userLastActivity = new Map(); // userId -> { lastMessageTime, sessionId, messages }
    this.processedSessions = new Set(); // 已处理的会话ID，防止重复生成
  }

  /**
   * 启动空闲检测服务
   */
  start() {
    if (this.checkTimer) {
      console.warn('[IdleSession] 服务已在运行');
      return;
    }

    console.log(`[IdleSession] 空闲检测服务启动 (检查间隔: ${CHECK_INTERVAL / 60000} 分钟, 超时阈值: ${IDLE_TIMEOUT / 60000} 分钟)`);

    this.checkTimer = setInterval(() => {
      this.checkIdleSessions();
    }, CHECK_INTERVAL);

    // 立即执行一次检查
    this.checkIdleSessions();
  }

  /**
   * 停止空闲检测服务
   */
  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      console.log('[IdleSession] 空闲检测服务已停止');
    }
  }

  /**
   * 记录用户活动（每次收到消息时调用）
   * @param {string} userId - 用户ID
   * @param {string} sessionId - 会话ID
   * @param {Array} messages - 当前会话消息
   */
  recordActivity(userId, sessionId, messages) {
    this.userLastActivity.set(userId, {
      lastMessageTime: Date.now(),
      sessionId,
      messages: [...messages] // 复制消息数组
    });
  }

  /**
   * 用户主动断开时调用（标记会话已处理）
   * @param {string} userId - 用户ID
   */
  markSessionHandled(userId) {
    const activity = this.userLastActivity.get(userId);
    if (activity?.sessionId) {
      this.processedSessions.add(activity.sessionId);
    }
    this.userLastActivity.delete(userId);
  }

  /**
   * 检查空闲会话
   */
  async checkIdleSessions() {
    const now = Date.now();
    const idleUsers = [];

    for (const [userId, activity] of this.userLastActivity.entries()) {
      const idleTime = now - activity.lastMessageTime;

      // 检查是否超过空闲阈值
      if (idleTime >= IDLE_TIMEOUT) {
        // 检查是否已处理过
        if (!this.processedSessions.has(activity.sessionId)) {
          idleUsers.push({ userId, ...activity });
        }
      }
    }

    if (idleUsers.length === 0) {
      return;
    }

    console.log(`[IdleSession] 检测到 ${idleUsers.length} 个空闲会话，开始处理...`);

    for (const { userId, sessionId, messages } of idleUsers) {
      try {
        await this.handleIdleSession(userId, sessionId, messages);
      } catch (error) {
        console.error(`[IdleSession] 处理用户 ${userId} 的空闲会话失败:`, error.message);
      }
    }
  }

  /**
   * 处理空闲会话
   * @param {string} userId - 用户ID
   * @param {string} sessionId - 会话ID
   * @param {Array} messages - 消息数组
   */
  async handleIdleSession(userId, sessionId, messages) {
    console.log(`[IdleSession] 处理空闲会话: 用户=${userId}, 会话=${sessionId}, 消息数=${messages.length}`);

    // 标记为已处理
    this.processedSessions.add(sessionId);
    this.userLastActivity.delete(userId);

    // 消息太少不生成摘要
    if (messages.length < MIN_MESSAGES_FOR_SUMMARY) {
      console.log(`[IdleSession] 会话 ${sessionId} 消息太少，跳过摘要生成`);
      return;
    }

    // 结束 Supabase 会话
    if (supabaseService.isAvailable()) {
      try {
        await supabaseService.endSession(sessionId);
      } catch (error) {
        console.error(`[IdleSession] 结束会话失败:`, error.message);
      }
    }

    // 异步生成会话摘要
    sessionSummaryService.generateSessionSummaryAsync(sessionId, messages);
  }

  /**
   * 清理过期的已处理会话记录（防止内存泄漏）
   */
  cleanupProcessedSessions() {
    // 保留最近 1000 个会话记录
    if (this.processedSessions.size > 1000) {
      const toDelete = this.processedSessions.size - 500;
      const iterator = this.processedSessions.values();
      for (let i = 0; i < toDelete; i++) {
        this.processedSessions.delete(iterator.next().value);
      }
      console.log(`[IdleSession] 清理了 ${toDelete} 个过期会话记录`);
    }
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    return {
      running: !!this.checkTimer,
      activeUsers: this.userLastActivity.size,
      processedSessions: this.processedSessions.size,
      config: {
        idleTimeout: IDLE_TIMEOUT,
        checkInterval: CHECK_INTERVAL
      }
    };
  }
}

module.exports = new IdleSessionService();
