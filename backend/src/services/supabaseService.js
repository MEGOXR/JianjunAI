const { createClient } = require('@supabase/supabase-js');

class SupabaseService {
  constructor() {
    this.client = null;
    this.isEnabled = false;
  }

  /**
   * 初始化 Supabase 客户端
   */
  initialize() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.warn('[Supabase] 缺少配置，将使用本地文件存储');
      this.isEnabled = false;
      return false;
    }

    try {
      this.client = createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: false // 服务端不需要持久化session
        }
      });
      this.isEnabled = true;
      console.log('[Supabase] 客户端初始化成功');
      return true;
    } catch (error) {
      console.error('[Supabase] 初始化失败:', error);
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

  // ==================== 用户操作 ====================

  /**
   * 创建或更新用户（根据微信OpenID）
   * @param {string} wechatOpenId - 微信OpenID (格式: user_xxx)
   * @param {string} nickname - 微信昵称（可选）
   * @returns {object} 用户数据
   */
  async upsertUser(wechatOpenId, nickname = null) {
    if (!this.isAvailable()) {
      throw new Error('Supabase service not available');
    }

    const { data, error } = await this.client
      .from('users')
      .upsert({
        wechat_open_id: wechatOpenId,
        nickname: nickname,
        last_visit: new Date().toISOString()
      }, {
        onConflict: 'wechat_open_id',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) {
      console.error('[Supabase] 创建/更新用户失败:', error);
      throw error;
    }

    // 更新访问计数
    await this.client
      .from('users')
      .update({
        total_sessions: this.client.rpc ? data.total_sessions + 1 : 1
      })
      .eq('id', data.id);

    return this._transformUser(data);
  }

  /**
   * 根据微信OpenID获取用户
   * @param {string} wechatOpenId - 微信OpenID
   * @returns {object|null} 用户数据或null
   */
  async getUserByWechatId(wechatOpenId) {
    if (!this.isAvailable()) {
      return null;
    }

    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('wechat_open_id', wechatOpenId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // 用户不存在
        return null;
      }
      console.error('[Supabase] 获取用户失败:', error);
      return null;
    }

    return this._transformUser(data);
  }

  /**
   * 更新用户信息
   * @param {string} wechatOpenId - 微信OpenID
   * @param {object} updates - 更新内容
   */
  async updateUserInfo(wechatOpenId, updates) {
    if (!this.isAvailable()) {
      throw new Error('Supabase service not available');
    }

    const updateData = {};
    if (updates.extractedName !== undefined) {
      updateData.extracted_name = updates.extractedName;
    }
    if (updates.nickname !== undefined) {
      updateData.nickname = updates.nickname;
    }
    if (updates.metadata !== undefined) {
      updateData.metadata = updates.metadata;
    }

    const { data, error } = await this.client
      .from('users')
      .update(updateData)
      .eq('wechat_open_id', wechatOpenId)
      .select()
      .single();

    if (error) {
      console.error('[Supabase] 更新用户信息失败:', error);
      throw error;
    }

    return this._transformUser(data);
  }

  // ==================== 会话操作 ====================

  /**
   * 创建新会话
   * @param {string} userUuid - 用户UUID (Supabase内部ID)
   * @returns {object} 会话数据
   */
  async createSession(userUuid) {
    if (!this.isAvailable()) {
      throw new Error('Supabase service not available');
    }

    const { data, error } = await this.client
      .from('chat_sessions')
      .insert({
        user_id: userUuid,
        started_at: new Date().toISOString(),
        is_active: true
      })
      .select()
      .single();

    if (error) {
      console.error('[Supabase] 创建会话失败:', error);
      throw error;
    }

    return data;
  }

  /**
   * 结束会话
   * @param {string} sessionId - 会话ID
   */
  async endSession(sessionId) {
    if (!this.isAvailable()) return;

    const { error } = await this.client
      .from('chat_sessions')
      .update({
        ended_at: new Date().toISOString(),
        is_active: false
      })
      .eq('id', sessionId);

    if (error) {
      console.error('[Supabase] 结束会话失败:', error);
    }
  }

  /**
   * 获取用户的活跃会话
   * @param {string} userUuid - 用户UUID
   */
  async getActiveSession(userUuid) {
    if (!this.isAvailable()) return null;

    const { data, error } = await this.client
      .from('chat_sessions')
      .select('*')
      .eq('user_id', userUuid)
      .eq('is_active', true)
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      console.error('[Supabase] 获取活跃会话失败:', error);
      return null;
    }

    return data;
  }

  // ==================== 消息操作 ====================

  /**
   * 保存聊天消息
   * @param {string} sessionId - 会话ID
   * @param {string} userUuid - 用户UUID
   * @param {string} role - 角色 (user/assistant/system)
   * @param {string} content - 消息内容
   * @param {object} metadata - 元数据（可选）
   */
  async saveMessage(sessionId, userUuid, role, content, metadata = {}) {
    if (!this.isAvailable()) {
      throw new Error('Supabase service not available');
    }

    const { data, error } = await this.client
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        user_id: userUuid,
        role: role,
        content: content,
        metadata: metadata,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('[Supabase] 保存消息失败:', error);
      throw error;
    }

    // 更新会话消息计数（使用 RPC 或简单查询）
    try {
      const { data: session } = await this.client
        .from('chat_sessions')
        .select('message_count')
        .eq('id', sessionId)
        .single();

      if (session) {
        await this.client
          .from('chat_sessions')
          .update({ message_count: (session.message_count || 0) + 1 })
          .eq('id', sessionId);
      }

      // 更新用户消息总数
      const { data: user } = await this.client
        .from('users')
        .select('total_messages')
        .eq('id', userUuid)
        .single();

      if (user) {
        await this.client
          .from('users')
          .update({ total_messages: (user.total_messages || 0) + 1 })
          .eq('id', userUuid);
      }
    } catch (countError) {
      // 计数更新失败不影响消息保存
      console.warn('[Supabase] 更新计数失败:', countError.message);
    }

    return data;
  }

  /**
   * 获取用户最近的消息
   * @param {string} wechatOpenId - 微信OpenID
   * @param {number} limit - 消息数量限制
   * @returns {Array} 消息列表
   */
  async getRecentMessages(wechatOpenId, limit = 10) {
    if (!this.isAvailable()) {
      return [];
    }

    // 先获取用户ID
    const user = await this.getUserByWechatId(wechatOpenId);
    if (!user) return [];

    const { data, error } = await this.client
      .from('chat_messages')
      .select('role, content, created_at')
      .eq('user_id', user.uuid)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[Supabase] 获取消息失败:', error);
      return [];
    }

    // 反转顺序，使最早的消息在前
    return data.reverse().map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  /**
   * 获取会话的所有消息
   * @param {string} sessionId - 会话ID
   */
  async getSessionMessages(sessionId) {
    if (!this.isAvailable()) return [];

    const { data, error } = await this.client
      .from('chat_messages')
      .select('role, content, created_at, metadata')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[Supabase] 获取会话消息失败:', error);
      return [];
    }

    return data.map(msg => ({
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata
    }));
  }

  // ==================== 图片操作 ====================

  /**
   * 保存带图片的用户消息
   * @param {string} sessionId - 会话ID
   * @param {string} userUuid - 用户UUID
   * @param {string} textContent - 文本内容
   * @param {Array} imageUrls - 图片信息数组 [{ url, blobName, size, containerName }]
   * @param {string} imageAnalysis - AI 图片分析结果（可选）
   * @returns {object} 消息数据
   */
  async saveMessageWithImages(sessionId, userUuid, textContent, imageUrls, imageAnalysis = null) {
    if (!this.isAvailable()) {
      throw new Error('Supabase service not available');
    }

    const metadata = {
      images: imageUrls
    };

    if (imageAnalysis) {
      metadata.imageAnalysis = imageAnalysis;
    }

    return await this.saveMessage(sessionId, userUuid, 'user', textContent, metadata);
  }

  /**
   * 获取用户上传的图片总数
   * @param {string} wechatOpenId - 微信OpenID
   * @returns {number} 图片消息总数
   */
  async getUserImageCount(wechatOpenId) {
    if (!this.isAvailable()) return 0;

    const user = await this.getUserByWechatId(wechatOpenId);
    if (!user) return 0;

    try {
      const { data, error } = await this.client.rpc('get_user_image_count', {
        p_user_id: user.uuid
      });

      if (error) throw error;
      return data || 0;
    } catch (error) {
      console.warn('[Supabase] 获取图片数量失败，使用备选方法:', error.message);

      // 备选方法：直接查询
      const { count, error: countError } = await this.client
        .from('chat_messages')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.uuid)
        .eq('role', 'user')
        .not('metadata->images', 'is', null);

      if (countError) {
        console.error('[Supabase] 备选查询失败:', countError);
        return 0;
      }

      return count || 0;
    }
  }

  /**
   * 获取用户最近上传的图片
   * @param {string} wechatOpenId - 微信OpenID
   * @param {number} limit - 数量限制
   * @returns {Array} 图片信息列表
   */
  async getUserRecentImages(wechatOpenId, limit = 10) {
    if (!this.isAvailable()) return [];

    const user = await this.getUserByWechatId(wechatOpenId);
    if (!user) return [];

    try {
      const { data, error } = await this.client.rpc('get_user_recent_images', {
        p_user_id: user.uuid,
        p_limit: limit
      });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.warn('[Supabase] 获取最近图片失败，使用备选方法:', error.message);

      // 备选方法：直接查询
      const { data, error: queryError } = await this.client
        .from('chat_messages')
        .select('id, metadata, created_at')
        .eq('user_id', user.uuid)
        .eq('role', 'user')
        .not('metadata->images', 'is', null)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (queryError) {
        console.error('[Supabase] 备选查询失败:', queryError);
        return [];
      }

      return (data || []).map(msg => ({
        message_id: msg.id,
        image_urls: (msg.metadata?.images || []).map(img => img.url),
        created_at: msg.created_at,
        image_analysis: msg.metadata?.imageAnalysis
      }));
    }
  }

  // ==================== 用户洞察操作 ====================

  /**
   * 保存用户洞察（Memobase备份）
   * @param {string} userUuid - 用户UUID
   * @param {string} insightType - 洞察类型 (interest/concern/preference/budget)
   * @param {string} topic - 主题
   * @param {string} content - 内容
   * @param {string} sourceMessageId - 来源消息ID（可选）
   */
  async saveInsight(userUuid, insightType, topic, content, sourceMessageId = null) {
    if (!this.isAvailable()) return null;

    const { data, error } = await this.client
      .from('user_insights')
      .insert({
        user_id: userUuid,
        insight_type: insightType,
        topic: topic,
        content: content,
        source_message_id: sourceMessageId,
        extracted_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('[Supabase] 保存洞察失败:', error);
      return null;
    }

    return data;
  }

  /**
   * 获取用户所有洞察
   * @param {string} wechatOpenId - 微信OpenID
   */
  async getUserInsights(wechatOpenId) {
    if (!this.isAvailable()) return [];

    const user = await this.getUserByWechatId(wechatOpenId);
    if (!user) return [];

    const { data, error } = await this.client
      .from('user_insights')
      .select('*')
      .eq('user_id', user.uuid)
      .eq('is_active', true)
      .order('extracted_at', { ascending: false });

    if (error) {
      console.error('[Supabase] 获取洞察失败:', error);
      return [];
    }

    return data;
  }

  // ==================== 辅助方法 ====================

  /**
   * 获取用户的 Memobase 用户 ID
   * @param {string} wechatOpenId - 微信OpenID
   * @returns {string|null} Memobase 用户 ID
   */
  async getMemobaseUserId(wechatOpenId) {
    if (!this.isAvailable()) return null;

    const { data, error } = await this.client
      .from('users')
      .select('memobase_user_id')
      .eq('wechat_open_id', wechatOpenId)
      .single();

    if (error) {
      console.error('[Supabase] 获取 Memobase 用户 ID 失败:', error);
      return null;
    }

    return data?.memobase_user_id || null;
  }

  /**
   * 保存用户的 Memobase 用户 ID
   * @param {string} wechatOpenId - 微信OpenID
   * @param {string} memobaseUserId - Memobase 用户 UUID
   * @returns {boolean} 是否成功
   */
  async saveMemobaseUserId(wechatOpenId, memobaseUserId) {
    if (!this.isAvailable()) return false;

    try {
      const { error } = await this.client
        .from('users')
        .update({ memobase_user_id: memobaseUserId })
        .eq('wechat_open_id', wechatOpenId);

      if (error) {
        console.error('[Supabase] 保存 Memobase 用户 ID 失败:', error);
        return false;
      }

      console.log(`[Supabase] Memobase 用户 ID 已保存: ${wechatOpenId} -> ${memobaseUserId}`);
      return true;
    } catch (err) {
      console.error('[Supabase] 保存 Memobase 用户 ID 异常:', err);
      return false;
    }
  }

  /**
   * 转换用户数据格式（Supabase -> 应用格式）
   */
  _transformUser(dbUser) {
    if (!dbUser) return null;

    return {
      uuid: dbUser.id,
      userId: dbUser.wechat_open_id,
      nickname: dbUser.nickname,
      extractedName: dbUser.extracted_name,
      memobaseUserId: dbUser.memobase_user_id,
      createdAt: dbUser.created_at,
      lastVisit: dbUser.last_visit,
      totalSessions: dbUser.total_sessions,
      totalMessages: dbUser.total_messages,
      metadata: dbUser.metadata || {}
    };
  }

  /**
   * 转换用户数据格式（应用格式 -> 旧格式兼容）
   * 用于与现有代码兼容
   */
  transformToLegacyFormat(user, chatHistory = []) {
    if (!user) return null;

    return {
      userId: user.userId,
      createdAt: user.createdAt,
      lastVisit: user.lastVisit,
      chatHistory: chatHistory,
      userInfo: {
        extractedName: user.extractedName,
        nickname: user.nickname
      },
      lastMessage: chatHistory.length > 0
        ? chatHistory[chatHistory.length - 1].content
        : null
    };
  }
}

module.exports = new SupabaseService();
