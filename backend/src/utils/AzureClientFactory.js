const { AzureOpenAI } = require("openai");

/**
 * Azure OpenAI 客户端工厂类
 * 统一管理 Azure OpenAI 客户端的创建和配置
 * 使用单例模式避免重复创建客户端实例
 */
class AzureClientFactory {
  constructor() {
    this.client = null;
    this.config = null;
  }

  /**
   * 获取环境变量，支持 APPSETTING_ 前缀（Azure App Service）
   */
  static getEnvVar(name) {
    return process.env[name] || process.env[`APPSETTING_${name}`] || null;
  }

  /**
   * 获取 Azure OpenAI 配置
   */
  getConfig() {
    if (!this.config) {
      this.config = {
        endpoint: AzureClientFactory.getEnvVar('AZURE_OPENAI_ENDPOINT'),
        apiKey: AzureClientFactory.getEnvVar('AZURE_OPENAI_API_KEY'),
        apiVersion: AzureClientFactory.getEnvVar('OPENAI_API_VERSION'),
        deployment: AzureClientFactory.getEnvVar('AZURE_OPENAI_DEPLOYMENT_NAME'),
      };
    }
    return this.config;
  }

  /**
   * 验证配置是否完整
   * @throws {Error} 如果配置缺失
   */
  validateConfig() {
    const config = this.getConfig();
    const missing = [];

    if (!config.endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
    if (!config.apiKey) missing.push('AZURE_OPENAI_API_KEY');
    if (!config.apiVersion) missing.push('OPENAI_API_VERSION');
    if (!config.deployment) missing.push('AZURE_OPENAI_DEPLOYMENT_NAME');

    if (missing.length > 0) {
      const errorMsg = `Azure OpenAI configuration missing: ${missing.join(', ')}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    return config;
  }

  /**
   * 检查配置是否有效（不抛出异常）
   * @returns {boolean}
   */
  isConfigValid() {
    try {
      this.validateConfig();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取 Azure OpenAI 客户端（单例）
   * @returns {AzureOpenAI}
   */
  getClient() {
    if (!this.client) {
      const config = this.validateConfig();
      this.client = new AzureOpenAI({
        apiKey: config.apiKey,
        endpoint: config.endpoint,
        apiVersion: config.apiVersion,
        deployment: config.deployment,
      });
      console.log('Azure OpenAI client initialized');
    }
    return this.client;
  }

  /**
   * 创建新的客户端实例（非单例，用于特殊场景）
   * @returns {AzureOpenAI}
   */
  createNewClient() {
    const config = this.validateConfig();
    return new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      apiVersion: config.apiVersion,
      deployment: config.deployment,
    });
  }

  /**
   * 获取部署名称
   * @returns {string}
   */
  getDeploymentName() {
    return this.getConfig().deployment;
  }

  /**
   * 重置客户端（用于测试或配置更新）
   */
  reset() {
    this.client = null;
    this.config = null;
  }
}

// 导出单例实例
module.exports = new AzureClientFactory();
