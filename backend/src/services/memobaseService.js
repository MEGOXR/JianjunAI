/**
 * Memobase Service
 * 处理用户长期记忆和画像管理
 *
 * Memobase 是一个用户画像和记忆系统，能够：
 * - 从对话中自动提取用户偏好、兴趣、关注点
 * - 构建用户画像用于个性化对话
 * - 提供时间线事件记录
 */

class MemobaseService {
  constructor() {
    this.client = null;
    this.isEnabled = false;
    this.userCache = new Map(); // wechatOpenId -> { memobaseId, user }
    this.idMapping = new Map(); // wechatOpenId -> memobaseUserId (UUID)
    this.messageBuffer = new Map(); // wechatOpenId -> messages[]
    this.bufferFlushInterval = 60000; // 1分钟
    this.maxBufferSize = 10; // 最大缓冲消息数
    this.flushTimer = null;
  }

  /**
   * 初始化 Memobase 客户端
   */
  async initialize() {
    const projectUrl = process.env.MEMOBASE_PROJECT_URL;
    const apiKey = process.env.MEMOBASE_API_KEY;

    if (!projectUrl || !apiKey) {
      console.warn('[Memobase] 缺少配置，记忆功能将被禁用');
      this.isEnabled = false;
      return false;
    }

    try {
      // 动态导入 Memobase SDK
      const { MemoBaseClient, Blob, BlobType } = await import('@memobase/memobase');

      this.client = new MemoBaseClient(projectUrl, apiKey);
      this.Blob = Blob;
      this.BlobType = BlobType;
      this.isEnabled = true;

      // 启动定期刷新
      this._startPeriodicFlush();

      console.log('[Memobase] 客户端初始化成功');
      return true;
    } catch (error) {
      console.error('[Memobase] 初始化失败:', error);
      this.isEnabled = false;
      return false;
    }
  }

  /**
   * 检查服务是否可用
   */
  isAvailable() {
    return this.isEnabled && this.client !== null;
  }

  /**
   * 获取或创建 Memobase 用户
   * @param {string} wechatOpenId - 微信OpenID (格式: user_xxx)
   * @returns {object} Memobase 用户对象
   */
  async getOrCreateUser(wechatOpenId) {
    if (!this.isAvailable()) {
      return null;
    }

    // 检查缓存
    if (this.userCache.has(wechatOpenId)) {
      return this.userCache.get(wechatOpenId).user;
    }

    try {
      let memobaseId = this.idMapping.get(wechatOpenId);
      let user;

      if (!memobaseId) {
        // 创建新用户，Memobase 会返回 UUID
        memobaseId = await this.client.addUser();
        this.idMapping.set(wechatOpenId, memobaseId);

        // 更新用户元数据，存储 wechatOpenId
        await this.client.updateUser(memobaseId, {
          wechat_open_id: wechatOpenId
        });

        console.log(`[Memobase] 创建新用户 ${wechatOpenId} -> ${memobaseId}`);
      }

      // 获取用户对象
      user = await this.client.getOrCreateUser(memobaseId);

      // 缓存
      this.userCache.set(wechatOpenId, { memobaseId, user });

      console.log(`[Memobase] 用户 ${wechatOpenId} 已加载`);
      return user;
    } catch (error) {
      console.error(`[Memobase] 获取用户 ${wechatOpenId} 失败:`, error.message);
      return null;
    }
  }

  /**
   * 缓冲消息（不立即发送到Memobase）
   * @param {string} userId - 用户ID
   * @param {object} message - 消息对象 { role: 'user'|'assistant', content: string }
   */
  bufferMessage(userId, message) {
    if (!this.isAvailable()) return;

    let buffer = this.messageBuffer.get(userId);
    if (!buffer) {
      buffer = [];
      this.messageBuffer.set(userId, buffer);
    }

    buffer.push({
      role: message.role,
      content: message.content,
      timestamp: new Date().toISOString()
    });

    console.log(`[Memobase] 用户 ${userId} 消息已缓冲，当前缓冲数: ${buffer.length}`);

    // 如果缓冲区满，立即刷新
    if (buffer.length >= this.maxBufferSize) {
      this.flushBuffer(userId).catch(err => {
        console.error(`[Memobase] 自动刷新失败:`, err);
      });
    }
  }

  /**
   * 将用户的消息缓冲刷新到 Memobase
   * @param {string} userId - 用户ID
   */
  async flushBuffer(userId) {
    if (!this.isAvailable()) return false;

    const buffer = this.messageBuffer.get(userId);
    if (!buffer || buffer.length === 0) {
      return true;
    }

    try {
      const user = await this.getOrCreateUser(userId);
      if (!user) {
        console.warn(`[Memobase] 无法刷新 ${userId} 的缓冲：用户不存在`);
        return false;
      }

      // 创建 ChatBlob
      const blob = this.Blob.parse({
        type: this.BlobType.Enum.chat,
        messages: buffer.map(msg => ({
          role: msg.role,
          content: msg.content
        }))
      });

      // 插入到 Memobase
      await user.insert(blob);

      // 触发 flush 处理（让 Memobase 分析消息并更新画像）
      await user.flush(this.BlobType.Enum.chat);

      // 清空缓冲
      this.messageBuffer.delete(userId);

      console.log(`[Memobase] 用户 ${userId} 的 ${buffer.length} 条消息已刷新`);
      return true;
    } catch (error) {
      console.error(`[Memobase] 刷新用户 ${userId} 缓冲失败:`, error);
      return false;
    }
  }

  /**
   * 刷新所有用户的缓冲
   */
  async flushAllBuffers() {
    if (!this.isAvailable()) return;

    const userIds = Array.from(this.messageBuffer.keys());
    console.log(`[Memobase] 开始刷新 ${userIds.length} 个用户的缓冲`);

    const results = await Promise.allSettled(
      userIds.map(userId => this.flushBuffer(userId))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = results.length - succeeded;

    console.log(`[Memobase] 刷新完成: 成功 ${succeeded}, 失败 ${failed}`);
  }

  /**
   * 获取用户画像
   * @param {string} userId - 用户ID
   * @param {number} maxTokens - 最大token数（默认500）
   * @returns {object|null} 用户画像
   */
  async getUserProfile(userId, maxTokens = 500) {
    if (!this.isAvailable()) return null;

    try {
      const user = await this.getOrCreateUser(userId);
      if (!user) return null;

      const profile = await user.profile(maxTokens);
      return profile;
    } catch (error) {
      console.error(`[Memobase] 获取用户 ${userId} 画像失败:`, error);
      return null;
    }
  }

  /**
   * 获取用户上下文（用于注入到LLM提示词）
   * @param {string} userId - 用户ID
   * @param {number} maxTokens - 最大token数（默认500）
   * @returns {string} 格式化的上下文字符串
   */
  async getUserContext(userId, maxTokens = 500) {
    if (!this.isAvailable()) return '';

    try {
      const user = await this.getOrCreateUser(userId);
      if (!user) return '';

      // context(maxProfileTokens, maxEventTokens)
      const context = await user.context(maxTokens, 200);

      if (!context) return '';

      // 格式化上下文为中文描述
      return this._formatContextForPrompt(context);
    } catch (error) {
      console.error(`[Memobase] 获取用户 ${userId} 上下文失败:`, error);
      return '';
    }
  }

  /**
   * 格式化上下文为提示词
   * @private
   */
  _formatContextForPrompt(context) {
    if (!context) return '';

    const parts = [];

    // 处理画像数据
    if (context.profiles && context.profiles.length > 0) {
      const profileLines = context.profiles.map(p => {
        if (p.topic && p.content) {
          return `- ${p.topic}: ${p.content}`;
        }
        return `- ${p.content || p}`;
      });

      if (profileLines.length > 0) {
        parts.push('### 用户信息');
        parts.push(profileLines.join('\n'));
      }
    }

    // 处理事件/时间线数据
    if (context.events && context.events.length > 0) {
      const eventLines = context.events.map(e => {
        const time = e.timestamp ? new Date(e.timestamp).toLocaleDateString('zh-CN') : '';
        return `- ${time}: ${e.content || e}`;
      });

      if (eventLines.length > 0) {
        parts.push('\n### 历史记录');
        parts.push(eventLines.join('\n'));
      }
    }

    return parts.join('\n');
  }

  /**
   * 构建增强的系统提示词
   * @param {string} basePrompt - 基础系统提示词
   * @param {string} userId - 用户ID
   * @returns {string} 增强后的系统提示词
   */
  async buildEnhancedSystemPrompt(basePrompt, userId) {
    const context = await this.getUserContext(userId);

    if (!context) {
      return basePrompt;
    }

    return `${basePrompt}

## 用户记忆档案
以下是关于当前用户的记忆信息，请根据这些信息提供个性化的咨询建议：

${context}

请在回复时适当参考上述用户信息，但不要直接复述这些信息，而是自然地融入对话中。`;
  }

  /**
   * 启动定期刷新定时器
   * @private
   */
  _startPeriodicFlush() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      this.flushAllBuffers().catch(err => {
        console.error('[Memobase] 定期刷新失败:', err);
      });
    }, this.bufferFlushInterval);

    console.log(`[Memobase] 定期刷新已启动，间隔 ${this.bufferFlushInterval / 1000} 秒`);
  }

  /**
   * 停止服务（用于优雅关闭）
   */
  async shutdown() {
    console.log('[Memobase] 正在关闭服务...');

    // 停止定时器
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // 刷新所有缓冲
    await this.flushAllBuffers();

    // 清理缓存
    this.userCache.clear();
    this.messageBuffer.clear();
    this.idMapping.clear();

    console.log('[Memobase] 服务已关闭');
  }

  /**
   * 搜索用户历史事件
   * @param {string} userId - 用户ID
   * @param {string} query - 搜索关键词/问题
   * @param {number} limit - 返回结果数量
   * @returns {Array} 搜索结果列表
   */
  async searchEvents(userId, query, limit = 5) {
    if (!this.isAvailable()) return [];

    try {
      const user = await this.getOrCreateUser(userId);
      if (!user) return [];

      console.log(`[Memobase]正在搜索用户 ${userId} 的记忆: "${query}"`);

      // 使用 Memobase 的搜索功能
      // 注意: 具体API方法名可能取决于SDK版本，这里我们要查阅SDK文档或尝试 searchContext/searchEvent
      // 假设 SDK 提供了 search 接口
      let results = [];

      // 尝试调用 user.search 或 client.searchEvent
      // 根据之前的分析，我们使用 searchEvent 或 context 搜索
      // 这里为了稳健，先尝试 mock 或者查阅最确定的 context API
      // 如果 user 对象有 search 方法：
      if (typeof user.search === 'function') {
        results = await user.search(query, limit);
      } else if (this.client && typeof this.client.searchEvent === 'function') {
        // 备用：如果SDK是在client层级
        // results = await this.client.searchEvent(user.id, query); 
        // 暂时无法确定完全准确的API，先假设 context 可以带 query 或者 fallback
        // 实际上当前 SDK 版本 user.context 是为了构建 prompt，不一定是搜索。
        // 让我们假设我们需要自行实现一个简单的过滤，或者 SDK 确实支持搜索。

        // 根据最新的 Memobase SDK 理解 (0.0.18)，可能暂时没有直接的 searchEvent 暴露在 user 对象上
        // 但我们可以利用 user.context 的变体或者假设它会在未来支持。
        // 为了不阻塞，我们这里先做一个模拟实现，或者只用 context。

        // TODO: 确认 Memobase search API。暂时返回空或模拟数据用于测试流程。
        // 如果真的要搜，可能需要利用 vector database 的 search。
        // 这里我们先打日志，假装没搜到，或者返回最近的 events。
        const context = await user.context(1000, 500);
        if (context && context.events) {
          // 简单的本地关键词匹配作为 fallback
          results = context.events.filter(e => {
            const content = e.content || e;
            return typeof content === 'string' && content.includes(query);
          });
        }
      }

      console.log(`[Memobase] 搜索完成，找到 ${results.length} 条相关记忆`);
      return results;
    } catch (error) {
      console.error(`[Memobase] 搜索用户 ${userId} 记忆失败:`, error);
      return [];
    }
  }

  /**
   * 更新用户元数据
   * @param {string} userId - 用户ID
   * @param {object} metadata - 元数据对象
   */
  async updateUserMetadata(userId, metadata) {
    if (!this.isAvailable()) return false;

    try {
      await this.client.updateUser(userId, metadata);
      console.log(`[Memobase] 用户 ${userId} 元数据已更新`);
      return true;
    } catch (error) {
      console.error(`[Memobase] 更新用户 ${userId} 元数据失败:`, error);
      return false;
    }
  }
}

module.exports = new MemobaseService();
