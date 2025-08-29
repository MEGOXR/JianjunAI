const { OpenAI } = require("openai");
const LLMProvider = require('../base/LLMProvider');

/**
 * 火山引擎 LLM Provider
 * 基于火山引擎豆包大模型，兼容OpenAI SDK
 */
class VolcengineLLMProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.client = null;
  }

  /**
   * 初始化火山引擎客户端
   */
  async initialize() {
    if (!this.validateConfigSync()) {
      throw new Error('Volcengine LLM configuration is invalid');
    }

    // 使用OpenAI客户端，但指向火山引擎的端点
    this.client = new OpenAI({
      baseURL: this.config.baseURL || "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: this.config.apiKey
    });

    console.log('Volcengine LLM Provider initialized with model:', this.config.model);
  }

  /**
   * 创建聊天流式响应
   */
  async createChatStream(messages, options = {}) {
    if (!this.client) {
      await this.initialize();
    }

    const streamOptions = {
      model: this.config.model, // 使用 ep-m-20250812174627-s8gbl
      messages: messages,
      stream: true,
      max_tokens: options.maxTokens || 2000,
      temperature: options.temperature || 0.5,
      ...options
    };

    console.log('Volcengine LLM: Creating chat stream with', messages.length, 'messages');
    console.log('Using model:', this.config.model);
    
    return await this.client.chat.completions.create(streamOptions);
  }

  /**
   * 创建单次完成
   */
  async createCompletion(prompt, options = {}) {
    if (!this.client) {
      await this.initialize();
    }

    const messages = [{ role: 'user', content: prompt }];
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: messages,
      stream: false,
      max_tokens: options.maxTokens || 2000,
      temperature: options.temperature || 0.5,
      ...options
    });

    return response.choices[0].message.content;
  }

  /**
   * 验证配置（异步版本，用于健康检查）
   */
  async validateConfig() {
    try {
      if (!this.validateConfigSync()) {
        return false;
      }

      // 尝试创建客户端并发送测试请求
      if (!this.client) {
        await this.initialize();
      }

      return true;
    } catch (error) {
      console.error('Volcengine LLM config validation failed:', error);
      return false;
    }
  }

  /**
   * 同步配置验证
   */
  validateConfigSync() {
    return !!(
      this.config.apiKey && 
      this.config.model &&
      this.config.baseURL
    );
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      if (!this.client) {
        await this.initialize();
      }

      // 发送简单的测试请求
      const testMessages = [{ role: 'user', content: 'ping' }];
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: testMessages,
        max_tokens: 1,
        stream: false
      });

      if (response.choices && response.choices.length > 0) {
        return { 
          status: 'healthy', 
          provider: 'Volcengine',
          model: this.config.model,
          baseURL: this.config.baseURL
        };
      } else {
        return { 
          status: 'unhealthy', 
          error: 'No response from Volcengine ARK'
        };
      }
    } catch (error) {
      return { 
        status: 'unhealthy', 
        error: error.message,
        provider: 'Volcengine'
      };
    }
  }

  /**
   * 获取模型信息
   */
  getModelInfo() {
    return {
      provider: 'Volcengine',
      model: this.config.model,
      baseURL: this.config.baseURL,
      region: this.config.region || 'cn-beijing'
    };
  }
}

module.exports = VolcengineLLMProvider;