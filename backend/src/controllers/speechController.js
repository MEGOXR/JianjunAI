const ProviderFactory = require('../services/ProviderFactory');
const userDataService = require('../services/userDataService');
const fs = require('fs').promises;

class SpeechController {
  /**
   * 处理语音转文字请求
   */
  async speechToText(req, res) {
    try {
      // 验证请求
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: '未接收到音频文件'
        });
      }

      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({
          success: false,
          error: '缺少用户ID'
        });
      }

      console.log(`[STT] 用户 ${userId} 上传音频文件: ${req.file.filename}`);
      console.log(`[STT] 文件详情:`, {
        size: req.file.size,
        mimetype: req.file.mimetype,
        path: req.file.path
      });

      // 获取ASR Provider
      const asrProvider = ProviderFactory.getASRProvider();
      
      // 简单的音频文件大小检查（代替时长检查）
      const stats = await fs.stat(req.file.path);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      if (stats.size < 1000) {
        // 清理文件
        try {
          await fs.unlink(req.file.path);
        } catch (err) {
          console.error('清理文件失败:', err);
        }
        
        return res.status(400).json({
          success: false,
          error: '录音时间太短，请至少录制1秒'
        });
      }
      
      if (fileSizeMB > 10) { // 10MB限制
        // 清理文件
        try {
          await fs.unlink(req.file.path);
        } catch (err) {
          console.error('清理文件失败:', err);
        }
        
        return res.status(400).json({
          success: false,
          error: '音频文件太大，请不要超过10MB'
        });
      }

      // 执行语音识别
      const startTime = Date.now();
      const result = await asrProvider.speechToText(req.file.path);
      const processingTime = Date.now() - startTime;
      
      console.log(`[STT] 处理完成，耗时: ${processingTime}ms`);
      console.log(`[STT] 识别结果:`, {
        success: result.success,
        textLength: result.text ? result.text.length : 0,
        confidence: result.confidence,
        isSimulated: result.isSimulated
      });
      
      // 记录用户语音使用情况（可选）
      try {
        const userData = await userDataService.getUserData(userId);
        if (userData) {
          userData.voiceUsageCount = (userData.voiceUsageCount || 0) + 1;
          userData.lastVoiceUse = new Date().toISOString();
          await userDataService.saveUserData(userId, userData);
        }
      } catch (err) {
        console.error('[STT] 更新用户数据失败:', err);
        // 不影响主流程
      }

      // 返回识别结果
      res.json({
        success: result.success,
        text: result.text || '',
        confidence: result.confidence || 0,
        duration: result.duration || 0,
        language: result.language,
        error: result.error,
        isSimulated: result.isSimulated // 开发阶段标记
      });

    } catch (error) {
      console.error('[STT] 语音识别错误:', error);
      
      // 尝试清理文件
      if (req.file && req.file.path) {
        try {
          await fs.unlink(req.file.path);
        } catch (err) {
          console.error('清理文件失败:', err);
        }
      }
      
      // 根据错误类型返回适当的错误信息
      let errorMessage = '语音识别失败';
      let statusCode = 500;
      
      if (error.message && error.message.includes('AZURE_SPEECH_KEY')) {
        errorMessage = '语音服务未配置';
        statusCode = 503;
      } else if (error.message && error.message.includes('网络')) {
        errorMessage = '网络连接错误';
        statusCode = 503;
      } else if (error.message && error.message.includes('文件')) {
        errorMessage = '音频文件处理失败';
        statusCode = 400;
      }
      
      res.status(statusCode).json({
        success: false,
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * 获取语音服务状态
   */
  async getServiceStatus(req, res) {
    try {
      const healthStatus = await ProviderFactory.getHealthStatus();
      const asrStatus = healthStatus.services.asr;
      
      res.json({
        available: asrStatus.status === 'healthy',
        provider: healthStatus.provider,
        configured: asrStatus.status === 'healthy',
        language: 'zh-CN',
        maxDuration: 60,
        minDuration: 1,
        supportedFormats: ['mp3', 'wav', 'm4a', 'webm', 'pcm'],
        status: asrStatus
      });
    } catch (error) {
      console.error('获取语音服务状态失败:', error);
      res.status(500).json({
        available: false,
        error: '服务状态检查失败'
      });
    }
  }
}

module.exports = new SpeechController();