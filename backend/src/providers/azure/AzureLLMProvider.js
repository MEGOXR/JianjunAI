const { AzureOpenAI } = require("openai");
const LLMProvider = require('../base/LLMProvider');

/**
 * Azure LLM Provider
 * 封装Azure OpenAI服务，保持与现有代码的兼容性
 */
class AzureLLMProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.client = null;
  }

  /**
   * 初始化Azure OpenAI客户端
   */
  async initialize() {
    if (!this.validateConfigSync()) {
      throw new Error('Azure LLM configuration is invalid');
    }

    this.client = new AzureOpenAI({
      apiKey: this.config.apiKey,
      endpoint: this.config.endpoint,
      apiVersion: this.config.apiVersion,
      deployment: this.config.deployment
    });

    console.log('Azure LLM Provider initialized');
  }

  /**
   * 创建聊天流式响应
   */
  async createChatStream(messages, options = {}) {
    if (!this.client) {
      await this.initialize();
    }

    const streamOptions = {
      model: this.config.deployment,
      messages: messages,
      stream: true,
      max_tokens: options.maxTokens || 2000,
      temperature: options.temperature || 0.5,
      presence_penalty: options.presencePenalty || 0.1,
      frequency_penalty: options.frequencyPenalty || 0.2,
      stop: options.stop || null,
      ...options
    };

    console.log('Azure LLM: Creating chat stream with', messages.length, 'messages');
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
      model: this.config.deployment,
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
      console.error('Azure LLM config validation failed:', error);
      return false;
    }
  }

  /**
   * 同步配置验证
   */
  validateConfigSync() {
    return !!(
      this.config.apiKey && 
      this.config.endpoint && 
      this.config.apiVersion && 
      this.config.deployment
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
        model: this.config.deployment,
        messages: testMessages,
        max_tokens: 1,
        stream: false
      });

      if (response.choices && response.choices.length > 0) {
        return { 
          status: 'healthy', 
          provider: 'Azure',
          model: this.config.deployment
        };
      } else {
        return { 
          status: 'unhealthy', 
          error: 'No response from Azure OpenAI'
        };
      }
    } catch (error) {
      return { 
        status: 'unhealthy', 
        error: error.message,
        provider: 'Azure'
      };
    }
  }

  /**
   * 获取模型信息
   */
  getModelInfo() {
    return {
      provider: 'Azure',
      deployment: this.config.deployment,
      endpoint: this.config.endpoint,
      apiVersion: this.config.apiVersion
    };
  }
}

module.exports = AzureLLMProvider;