const { OpenAI, AzureOpenAI } = require("openai");

/**
 * Azure OpenAI 客户端工厂类
 * 统一管理 Azure OpenAI 客户端的创建和配置
 * 使用单例模式避免重复创建客户端实例
 *
 * 支持两种模式：
 * - 新模式 (GPT-5.2+): 使用标准 OpenAI 客户端 + base_url
 * - 旧模式 (GPT-4o等): 使用 AzureOpenAI 客户端
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
   * 检测是否使用新的 OpenAI 兼容模式 (GPT-5.2+)
   * 如果 endpoint 包含 /openai/v1 或 deployment 包含 5.2/5-2，使用新模式
   */
  isNewApiMode() {
    const config = this.getConfig();
    const endpoint = config.endpoint || '';
    const deployment = config.deployment || '';

    // 检测新API模式的条件
    return endpoint.includes('/openai/v1') ||
           deployment.includes('5.2') ||
           deployment.includes('5-2') ||
           deployment.includes('gpt-5');
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
    if (!config.deployment) missing.push('AZURE_OPENAI_DEPLOYMENT_NAME');

    // 新模式不需要 apiVersion
    if (!this.isNewApiMode() && !config.apiVersion) {
      missing.push('OPENAI_API_VERSION');
    }

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
   * 构建新模式的 base_url
   * 确保 endpoint 以 /openai/v1 结尾
   */
  buildBaseUrl(endpoint) {
    let baseUrl = endpoint.replace(/\/+$/, ''); // 移除尾部斜杠
    if (!baseUrl.endsWith('/openai/v1')) {
      baseUrl = `${baseUrl}/openai/v1`;
    }
    return baseUrl;
  }

  /**
   * 获取 Azure OpenAI 客户端（单例）
   * @returns {OpenAI|AzureOpenAI}
   */
  getClient() {
    if (!this.client) {
      const config = this.validateConfig();

      if (this.isNewApiMode()) {
        // 新模式：使用标准 OpenAI 客户端 (GPT-5.2+)
        const baseUrl = this.buildBaseUrl(config.endpoint);
        this.client = new OpenAI({
          apiKey: config.apiKey,
          baseURL: baseUrl,
        });
        console.log(`Azure OpenAI client initialized (new API mode)`);
        console.log(`  base_url: ${baseUrl}`);
        console.log(`  model: ${config.deployment}`);
      } else {
        // 旧模式：使用 AzureOpenAI 客户端
        this.client = new AzureOpenAI({
          apiKey: config.apiKey,
          endpoint: config.endpoint,
          apiVersion: config.apiVersion,
          deployment: config.deployment,
        });
        console.log('Azure OpenAI client initialized (legacy mode)');
      }
    }
    return this.client;
  }

  /**
   * 创建新的客户端实例（非单例，用于特殊场景）
   * @returns {OpenAI|AzureOpenAI}
   */
  createNewClient() {
    const config = this.validateConfig();

    if (this.isNewApiMode()) {
      const baseUrl = this.buildBaseUrl(config.endpoint);
      return new OpenAI({
        apiKey: config.apiKey,
        baseURL: baseUrl,
      });
    } else {
      return new AzureOpenAI({
        apiKey: config.apiKey,
        endpoint: config.endpoint,
        apiVersion: config.apiVersion,
        deployment: config.deployment,
      });
    }
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
