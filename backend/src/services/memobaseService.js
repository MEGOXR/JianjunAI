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
    this.projectUrl = null; // 存储项目URL用于REST API调用
    this.apiKey = null; // 存储API Key
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
      this.projectUrl = projectUrl;
      this.apiKey = apiKey;
      this.isEnabled = true;

      console.log(`[Memobase] 客户端已创建`);
      console.log(`[Memobase] Project URL: ${projectUrl}`);
      // 不要打印完整的 API Key
      console.log(`[Memobase] API Key: ${apiKey ? apiKey.substring(0, 8) + '...' : 'undefined'}`);

      // 从服务器恢复用户ID映射
      await this._loadUserIdMappings();

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
   * 从Memobase服务器加载已有的用户ID映射
   * @private
   */
  async _loadUserIdMappings() {
    try {
      const response = await fetch(`${this.projectUrl}/api/v1/project/users?limit=1000`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.warn('[Memobase] 无法加载用户映射:', response.status);
        return;
      }

      const result = await response.json();
      const users = result.data?.users || [];

      let loadedCount = 0;
      for (const user of users) {
        // 从 additional_fields 中获取 wechat_open_id
        const wechatOpenId = user.additional_fields?.data?.wechat_open_id;
        if (wechatOpenId && user.id) {
          // 检查是否已有更新的记录（取最新的）
          const existing = this.idMapping.get(wechatOpenId);
          if (!existing) {
            // 保存映射，优先使用profile_count和event_count最多的用户
            this.idMapping.set(wechatOpenId, {
              memobaseId: user.id,
              profileCount: user.profile_count || 0,
              eventCount: user.event_count || 0,
              updatedAt: user.updated_at
            });
            loadedCount++;
          } else {
            // 如果已有记录，选择数据更多的那个
            const existingTotal = existing.profileCount + existing.eventCount;
            const newTotal = (user.profile_count || 0) + (user.event_count || 0);
            if (newTotal > existingTotal) {
              this.idMapping.set(wechatOpenId, {
                memobaseId: user.id,
                profileCount: user.profile_count || 0,
                eventCount: user.event_count || 0,
                updatedAt: user.updated_at
              });
            }
          }
        }
      }

      console.log(`[Memobase] 从服务器恢复了 ${loadedCount} 个用户映射`);
    } catch (error) {
      console.error('[Memobase] 加载用户映射失败:', error);
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
      // 从映射中获取（新结构包含 memobaseId 和统计信息）
      const mapping = this.idMapping.get(wechatOpenId);
      let memobaseId = mapping?.memobaseId || mapping; // 兼容旧格式
      let user;

      if (!memobaseId || typeof memobaseId === 'object') {
        // 需要重新获取有效的 memobaseId
        memobaseId = mapping?.memobaseId;
      }

      if (!memobaseId) {
        // 创建新用户，Memobase 会返回 UUID
        memobaseId = await this.client.addUser();
        this.idMapping.set(wechatOpenId, {
          memobaseId,
          profileCount: 0,
          eventCount: 0,
          updatedAt: new Date().toISOString()
        });

        // 更新用户元数据，存储 wechatOpenId
        await this.client.updateUser(memobaseId, {
          wechat_open_id: wechatOpenId
        });

        console.log(`[Memobase] 创建新用户 ${wechatOpenId} -> ${memobaseId}`);
      } else {
        console.log(`[Memobase] 复用已有用户 ${wechatOpenId} -> ${memobaseId}`);
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
   * 搜索用户历史事件（使用语义搜索）
   * @param {string} userId - 用户ID
   * @param {string} query - 搜索关键词/问题
   * @param {number} limit - 返回结果数量
   * @param {number} similarityThreshold - 相似度阈值 (0-1)
   * @param {number} timeRangeInDays - 搜索时间范围（天数）
   * @returns {Array} 搜索结果列表
   */
  async searchEvents(userId, query, limit = 5, similarityThreshold = 0.2, timeRangeInDays = 365) {
    if (!this.isAvailable()) return [];

    try {
      const user = await this.getOrCreateUser(userId);
      if (!user) return [];

      console.log(`[Memobase]正在搜索用户 ${userId} 的记忆: "${query}"`);

      let results = [];

      // 使用SDK的语义搜索API（向量搜索）
      try {
        const events = await user.searchEvent(query, limit, similarityThreshold, timeRangeInDays);

        if (events && events.length > 0) {
          results = events.map(event => ({
            source: 'event',
            eventId: event.id,
            content: event.event_data?.event_tip || '',
            profileDelta: event.event_data?.profile_delta || [],
            similarity: event.similarity,
            timestamp: event.created_at || new Date().toISOString()
          }));
        }
      } catch (searchError) {
        console.warn(`[Memobase] searchEvent失败，尝试备用方法:`, searchError.message);
        // 备用方法：获取profile直接匹配
        try {
          const profiles = await user.profile(2000);
          if (profiles && profiles.length > 0) {
            // 简单关键词匹配作为备用
            const queryLower = query.toLowerCase();
            const matchedProfiles = profiles.filter(p =>
              p.content?.toLowerCase().includes(queryLower) ||
              p.topic?.toLowerCase().includes(queryLower) ||
              p.sub_topic?.toLowerCase().includes(queryLower)
            );

            results = matchedProfiles.map(p => ({
              source: 'profile',
              content: `${p.topic}::${p.sub_topic}: ${p.content}`,
              timestamp: p.updated_at || p.created_at || new Date().toISOString()
            }));
          }
        } catch (profileError) {
          console.error(`[Memobase] 备用profile搜索也失败:`, profileError.message);
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
   * 搜索用户Profile（语义搜索）
   * @param {string} userId - 用户ID
   * @param {string} query - 搜索关键词/问题
   * @param {number} limit - 返回结果数量
   * @returns {Array} Profile搜索结果
   */
  async searchProfile(userId, query, limit = 5) {
    if (!this.isAvailable()) return [];

    try {
      const user = await this.getOrCreateUser(userId);
      if (!user) return [];

      console.log(`[Memobase] 正在搜索用户 ${userId} 的Profile: "${query}"`);

      // 获取用户所有profile，然后做关键词匹配
      // （Memobase JS SDK目前没有profile语义搜索，但events搜索会包含profile_delta）
      const profiles = await user.profile(2000);

      if (!profiles || profiles.length === 0) {
        return [];
      }

      // 简单关键词匹配
      const queryLower = query.toLowerCase();
      const results = profiles.filter(p =>
        p.content?.toLowerCase().includes(queryLower) ||
        p.topic?.toLowerCase().includes(queryLower) ||
        p.sub_topic?.toLowerCase().includes(queryLower)
      ).slice(0, limit).map(p => ({
        source: 'profile',
        topic: p.topic,
        subTopic: p.sub_topic,
        content: p.content,
        timestamp: p.updated_at || p.created_at
      }));

      console.log(`[Memobase] Profile搜索完成，找到 ${results.length} 条`);
      return results;
    } catch (error) {
      console.error(`[Memobase] 搜索Profile失败:`, error);
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
