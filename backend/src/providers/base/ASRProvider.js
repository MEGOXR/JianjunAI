/**
 * ASR（语音识别）服务提供者基类
 * 定义所有ASR Provider必须实现的接口
 */
class ASRProvider {
  constructor(config) {
    this.config = config;
    this.sessions = new Map(); // sessionId -> session data
  }

  /**
   * 初始化Provider
   */
  async initialize() {
    throw new Error('initialize() method must be implemented');
  }

  /**
   * 开始流式语音识别
   * @param {string} sessionId - 会话ID
   * @param {Object} config - 识别配置
   * @param {WebSocket} ws - WebSocket连接
   */
  async startStreamingRecognition(sessionId, config, ws = null) {
    throw new Error('startStreamingRecognition() method must be implemented');
  }

  /**
   * 处理音频帧数据
   * @param {string} sessionId - 会话ID
   * @param {Buffer} audioBuffer - 音频数据
   */
  async processAudioFrame(sessionId, audioBuffer) {
    throw new Error('processAudioFrame() method must be implemented');
  }

  /**
   * 结束流式语音识别
   * @param {string} sessionId - 会话ID
   */
  async endStreamingRecognition(sessionId) {
    throw new Error('endStreamingRecognition() method must be implemented');
  }

  /**
   * 取消流式语音识别
   * @param {string} sessionId - 会话ID
   */
  async cancelStreamingRecognition(sessionId) {
    throw new Error('cancelStreamingRecognition() method must be implemented');
  }

  /**
   * 语音文件识别（非流式）
   * @param {string} audioFilePath - 音频文件路径
   * @returns {Object} 识别结果 {success, text, confidence, duration}
   */
  async speechToText(audioFilePath) {
    throw new Error('speechToText() method must be implemented');
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
   * 清理资源
   */
  cleanup() {
    // 清理所有活跃会话
    for (const [sessionId] of this.sessions) {
      try {
        this.cancelStreamingRecognition(sessionId);
      } catch (error) {
        console.error(`清理会话 ${sessionId} 失败:`, error);
      }
    }
    this.sessions.clear();
  }

  /**
   * 获取Provider名称
   * @returns {string} Provider名称
   */
  getName() {
    return this.constructor.name;
  }
}

module.exports = ASRProvider;