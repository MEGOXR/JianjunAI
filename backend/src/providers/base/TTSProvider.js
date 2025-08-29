/**
 * TTS（语音合成）服务提供者基类
 * 定义所有TTS Provider必须实现的接口
 */
class TTSProvider {
  constructor(config) {
    this.config = config;
  }

  /**
   * 初始化Provider
   */
  async initialize() {
    throw new Error('initialize() method must be implemented');
  }

  /**
   * 文本转语音
   * @param {string} text - 要合成的文本
   * @param {Object} options - 合成选项
   * @returns {Buffer} 音频数据
   */
  async textToSpeech(text, options = {}) {
    throw new Error('textToSpeech() method must be implemented');
  }

  /**
   * 流式文本转语音
   * @param {string} text - 要合成的文本
   * @param {Object} options - 合成选项
   * @returns {AsyncIterator} 音频数据流
   */
  async streamTextToSpeech(text, options = {}) {
    throw new Error('streamTextToSpeech() method must be implemented');
  }

  /**
   * 获取支持的音色列表
   * @returns {Array} 音色列表
   */
  getSupportedVoices() {
    throw new Error('getSupportedVoices() method must be implemented');
  }

  /**
   * 获取支持的音频格式
   * @returns {Array} 格式列表
   */
  getSupportedFormats() {
    return ['mp3', 'wav', 'pcm'];
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
   * 估算音频时长
   * @param {string} text - 文本内容
   * @param {Object} options - 合成选项
   * @returns {number} 预估时长（秒）
   */
  estimateAudioDuration(text, options = {}) {
    // 简单估算：中文约2个字符/秒，英文约4个字符/秒
    const speed = options.speed || 1.0;
    const isChinese = /[\u4e00-\u9fa5]/.test(text);
    const charsPerSecond = isChinese ? 2 : 4;
    return (text.length / charsPerSecond) / speed;
  }

  /**
   * 获取Provider名称
   * @returns {string} Provider名称
   */
  getName() {
    return this.constructor.name;
  }
}

module.exports = TTSProvider;