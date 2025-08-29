/**
 * 配置管理服务
 * 负责读取和验证各种Provider的配置
 */
class ConfigService {
  /**
   * 环境变量读取辅助函数（兼容 Azure App Service 的 APPSETTING_ 前缀）
   */
  static getEnvVar(name) {
    return process.env[name] || process.env[`APPSETTING_${name}`] || null;
  }

  /**
   * 获取当前选择的Provider类型
   */
  static getProviderType() {
    return this.getEnvVar('PROVIDER_TYPE') || 'azure';
  }

  /**
   * 获取是否启用Provider模式
   */
  static isProviderEnabled() {
    return this.getEnvVar('USE_PROVIDER') === 'true';
  }

  /**
   * 获取指定Provider的配置
   */
  static getProviderConfig(type) {
    if (type === 'azure') {
      return this.getAzureConfig();
    } else if (type === 'volcengine') {
      return this.getVolcengineConfig();
    }
    throw new Error(`Unknown provider type: ${type}`);
  }

  /**
   * 获取Azure配置
   */
  static getAzureConfig() {
    return {
      // LLM配置
      apiKey: this.getEnvVar('AZURE_OPENAI_API_KEY'),
      endpoint: this.getEnvVar('AZURE_OPENAI_ENDPOINT'),
      apiVersion: this.getEnvVar('OPENAI_API_VERSION'),
      deployment: this.getEnvVar('AZURE_OPENAI_DEPLOYMENT_NAME'),
      
      // 语音配置
      speechKey: this.getEnvVar('AZURE_SPEECH_KEY'),
      speechRegion: this.getEnvVar('AZURE_SPEECH_REGION'),
      speechEndpoint: this.getEnvVar('AZURE_SPEECH_ENDPOINT'),
      speechLanguage: this.getEnvVar('AZURE_SPEECH_LANGUAGE') || 'zh-CN'
    };
  }

  /**
   * 获取火山引擎配置
   */
  static getVolcengineConfig() {
    const modelType = this.getEnvVar('VOLCENGINE_MODEL_TYPE') || 'standard';
    const standardModel = this.getEnvVar('VOLCENGINE_ARK_MODEL');
    const flashModel = this.getEnvVar('VOLCENGINE_ARK_MODEL_FLASH');
    
    // 根据模型类型选择实际使用的模型
    const selectedModel = modelType === 'flash' ? flashModel : standardModel;
    
    return {
      // 基础认证
      accessKey: this.getEnvVar('VOLCENGINE_ACCESS_KEY'),
      secretKey: this.getEnvVar('VOLCENGINE_SECRET_KEY'),
      region: this.getEnvVar('VOLCENGINE_REGION') || 'cn-north-1',
      
      // LLM配置（豆包）
      apiKey: this.getEnvVar('VOLCENGINE_ARK_API_KEY') || this.getEnvVar('ARK_API_KEY'),
      model: selectedModel, // 动态选择的模型
      modelStandard: standardModel,
      modelFlash: flashModel,
      modelType: modelType,
      baseURL: this.getEnvVar('VOLCENGINE_ARK_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3',
      
      // 语音配置
      speechAppId: this.getEnvVar('VOLCENGINE_SPEECH_APP_ID'),
      asrEndpoint: this.getEnvVar('VOLCENGINE_ASR_ENDPOINT') || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
      ttsEndpoint: this.getEnvVar('VOLCENGINE_TTS_ENDPOINT') || 'https://openspeech.bytedance.com/api/v1/tts',
      
      // 语音服务统一认证（ASR和TTS共用）
      speechAccessToken: this.getEnvVar('VOLCENGINE_SPEECH_ACCESS_TOKEN'),
      speechSecretKey: this.getEnvVar('VOLCENGINE_SPEECH_SECRET_KEY'),
      
      // TTS资源ID配置
      ttsResourceId: this.getEnvVar('VOLCENGINE_TTS_RESOURCE_ID'),
      // TTS音色配置
      ttsVoice: this.getEnvVar('VOLCENGINE_TTS_VOICE')
    };
  }

  /**
   * 获取火山引擎Flash模型配置
   */
  static getVolcengineFlashConfig() {
    const config = this.getVolcengineConfig();
    return {
      ...config,
      model: config.modelFlash || config.model // 使用Flash模型，如果没有则回退到普通模型
    };
  }

  /**
   * 获取可用的火山引擎模型列表
   */
  static getVolcengineModels() {
    const config = this.getVolcengineConfig();
    const models = [];
    
    if (config.modelStandard) {
      models.push({
        name: 'standard',
        endpoint: config.modelStandard,
        description: 'doubao-seed-1-6-250615 (标准版)',
        selected: config.modelType === 'standard'
      });
    }
    
    if (config.modelFlash) {
      models.push({
        name: 'flash',
        endpoint: config.modelFlash,
        description: 'doubao-seed-1-6-flash-250715 (Flash版)',
        selected: config.modelType === 'flash'
      });
    }
    
    return models;
  }

  /**
   * 验证指定Provider的配置
   */
  static validateConfig(type, config = null) {
    if (!config) {
      config = this.getProviderConfig(type);
    }

    if (type === 'azure') {
      return this.validateAzureConfig(config);
    } else if (type === 'volcengine') {
      return this.validateVolcengineConfig(config);
    }
    
    return false;
  }

  /**
   * 验证Azure配置
   */
  static validateAzureConfig(config) {
    const llmValid = !!(config.apiKey && config.endpoint && config.apiVersion && config.deployment);
    const speechValid = !!(config.speechKey && config.speechRegion);
    
    return {
      llm: llmValid,
      speech: speechValid,
      overall: llmValid && speechValid,
      missing: this.getMissingFields(config, [
        'apiKey', 'endpoint', 'apiVersion', 'deployment',
        'speechKey', 'speechRegion'
      ])
    };
  }

  /**
   * 验证火山引擎配置
   */
  static validateVolcengineConfig(config) {
    const llmValid = !!(config.apiKey && config.model && config.baseURL);
    const speechValid = !!(config.speechAppId && config.speechAccessToken && config.speechSecretKey);
    
    return {
      llm: llmValid,
      speech: speechValid,
      overall: llmValid && speechValid,
      missing: this.getMissingFields(config, [
        'apiKey', 'model', 'baseURL',
        'speechAppId', 'speechAccessToken', 'speechSecretKey'
      ])
    };
  }

  /**
   * 获取缺失的配置字段
   */
  static getMissingFields(config, requiredFields) {
    return requiredFields.filter(field => !config[field]);
  }

  /**
   * 打印配置状态
   */
  static logConfigStatus() {
    const providerType = this.getProviderType();
    const isEnabled = this.isProviderEnabled();
    
    console.log('=== Provider Configuration Status ===');
    console.log(`Provider Type: ${providerType}`);
    console.log(`Provider Mode: ${isEnabled ? 'Enabled' : 'Disabled'}`);
    
    try {
      const config = this.getProviderConfig(providerType);
      const validation = this.validateConfig(providerType, config);
      
      console.log(`LLM Config: ${validation.llm ? '✓' : '✗'}`);
      console.log(`Speech Config: ${validation.speech ? '✓' : '✗'}`);
      
      if (validation.missing.length > 0) {
        console.log(`Missing fields: ${validation.missing.join(', ')}`);
      }
    } catch (error) {
      console.error(`Config error: ${error.message}`);
    }
  }

  /**
   * 获取当前Provider的LLM配置（便捷方法）
   */
  static getCurrentLLMConfig() {
    const type = this.getProviderType();
    const config = this.getProviderConfig(type);
    
    if (type === 'azure') {
      return {
        apiKey: config.apiKey,
        endpoint: config.endpoint,
        apiVersion: config.apiVersion,
        deployment: config.deployment
      };
    } else if (type === 'volcengine') {
      return {
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
        region: config.region
      };
    }
  }
}

module.exports = ConfigService;