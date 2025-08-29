/**
 * LLM服务提供者基类
 * 定义所有LLM Provider必须实现的接口
 */
class LLMProvider {
  constructor(config) {
    this.config = config;
    this.client = null;
  }

  /**
   * 初始化Provider
   */
  async initialize() {
    throw new Error('initialize() method must be implemented');
  }

  /**
   * 创建聊天流式响应
   * @param {Array} messages - 消息历史
   * @param {Object} options - 选项
   * @returns {AsyncIterator} 流式响应迭代器
   */
  async createChatStream(messages, options = {}) {
    throw new Error('createChatStream() method must be implemented');
  }

  /**
   * 创建单次完成
   * @param {string} prompt - 提示词
   * @param {Object} options - 选项
   * @returns {Object} 完成结果
   */
  async createCompletion(prompt, options = {}) {
    throw new Error('createCompletion() method must be implemented');
  }

  /**
   * 验证配置是否有效
   * @returns {boolean} 配置是否有效
   */
  async validateConfig() {
    throw new Error('validateConfig() method must be implemented');
  }

  /**
   * 健康检查
   * @returns {Object} 健康状态 {status, error?}
   */
  async healthCheck() {
    throw new Error('healthCheck() method must be implemented');
  }

  /**
   * 获取Provider名称
   * @returns {string} Provider名称
   */
  getName() {
    return this.constructor.name;
  }
}

module.exports = LLMProvider;