const ConfigService = require('./ConfigService');

/**
 * Provider工厂
 * 负责创建和管理各种Provider实例（单例模式）
 */
class ProviderFactory {
  static instances = {};

  /**
   * 获取LLM Provider实例
   */
  static getLLMProvider() {
    const type = ConfigService.getProviderType();
    const key = `llm_${type}`;
    
    if (!this.instances[key]) {
      const config = ConfigService.getCurrentLLMConfig();
      
      if (type === 'azure') {
        const AzureLLMProvider = require('../providers/azure/AzureLLMProvider');
        this.instances[key] = new AzureLLMProvider(config);
      } else if (type === 'volcengine') {
        const VolcengineLLMProvider = require('../providers/volcengine/VolcengineLLMProvider');
        this.instances[key] = new VolcengineLLMProvider(config);
      } else {
        throw new Error(`Unsupported LLM provider: ${type}`);
      }
      
      console.log(`Created ${type} LLM provider instance`);
    }
    
    return this.instances[key];
  }

  /**
   * 获取ASR Provider实例
   */
  static getASRProvider() {
    const type = ConfigService.getProviderType();
    const key = `asr_${type}`;
    
    if (!this.instances[key]) {
      const config = ConfigService.getProviderConfig(type);
      
      if (type === 'azure') {
        const AzureASRProvider = require('../providers/azure/AzureASRProvider');
        this.instances[key] = new AzureASRProvider(config);
      } else if (type === 'volcengine') {
        const VolcengineASRProvider = require('../providers/volcengine/VolcengineASRProvider');
        this.instances[key] = new VolcengineASRProvider(config);
      } else {
        throw new Error(`Unsupported ASR provider: ${type}`);
      }
      
      console.log(`Created ${type} ASR provider instance`);
    }
    
    return this.instances[key];
  }

  /**
   * 获取TTS Provider实例
   */
  static getTTSProvider() {
    const type = ConfigService.getProviderType();
    const key = `tts_${type}`;
    
    if (!this.instances[key]) {
      const config = ConfigService.getProviderConfig(type);
      
      if (type === 'azure') {
        const AzureTTSProvider = require('../providers/azure/AzureTTSProvider');
        this.instances[key] = new AzureTTSProvider(config);
      } else if (type === 'volcengine') {
        const VolcengineTTSProvider = require('../providers/volcengine/VolcengineTTSProvider');
        this.instances[key] = new VolcengineTTSProvider(config);
      } else {
        throw new Error(`Unsupported TTS provider: ${type}`);
      }
      
      console.log(`Created ${type} TTS provider instance`);
    }
    
    return this.instances[key];
  }

  /**
   * 获取所有Provider的健康状态
   */
  static async getHealthStatus() {
    const results = {};
    const type = ConfigService.getProviderType();
    
    try {
      // 检查LLM Provider
      const llmProvider = this.getLLMProvider();
      results.llm = await llmProvider.healthCheck();
    } catch (error) {
      results.llm = { status: 'error', error: error.message };
    }

    // TODO: 添加ASR和TTS健康检查
    // try {
    //   const asrProvider = this.getASRProvider();
    //   results.asr = await asrProvider.healthCheck();
    // } catch (error) {
    //   results.asr = { status: 'error', error: error.message };
    // }

    return {
      provider: type,
      timestamp: new Date().toISOString(),
      services: results
    };
  }

  /**
   * 清理所有Provider实例
   */
  static cleanup() {
    console.log('Cleaning up provider instances...');
    
    for (const [key, instance] of Object.entries(this.instances)) {
      try {
        if (typeof instance.cleanup === 'function') {
          instance.cleanup();
        }
      } catch (error) {
        console.error(`Error cleaning up ${key}:`, error);
      }
    }
    
    this.instances = {};
    console.log('Provider instances cleaned up');
  }

  /**
   * 重新初始化指定类型的Provider（用于配置更新后）
   */
  static async reinitialize(providerType = null) {
    const types = providerType ? [providerType] : ['llm', 'asr', 'tts'];
    const currentProviderType = ConfigService.getProviderType();
    
    for (const type of types) {
      const key = `${type}_${currentProviderType}`;
      if (this.instances[key]) {
        console.log(`Reinitializing ${key} provider...`);
        delete this.instances[key];
      }
    }
    
    // 预初始化LLM Provider（最常用）
    if (types.includes('llm')) {
      const llmProvider = this.getLLMProvider();
      await llmProvider.initialize();
    }
  }

  /**
   * 获取Provider实例信息
   */
  static getInstanceInfo() {
    const info = {
      currentProvider: ConfigService.getProviderType(),
      providerModeEnabled: ConfigService.isProviderEnabled(),
      activeInstances: Object.keys(this.instances),
      instanceCount: Object.keys(this.instances).length
    };
    
    return info;
  }
}

// 优雅关闭处理
process.on('SIGTERM', () => {
  ProviderFactory.cleanup();
});

process.on('SIGINT', () => {
  ProviderFactory.cleanup();
});

module.exports = ProviderFactory;