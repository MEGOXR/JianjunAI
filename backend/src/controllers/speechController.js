const speechService = require('../services/speechService');
const userDataService = require('../services/userDataService');

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

      // 获取音频时长
      const duration = await speechService.getAudioDuration(req.file.path);
      
      // 验证音频时长（1-60秒）
      if (duration < 1) {
        // 清理文件
        try {
          const fs = require('fs').promises;
          await fs.unlink(req.file.path);
        } catch (err) {
          console.error('清理文件失败:', err);
        }
        
        return res.status(400).json({
          success: false,
          error: '录音时间太短，请至少录制1秒'
        });
      }
      
      if (duration > 60) {
        // 清理文件
        try {
          const fs = require('fs').promises;
          await fs.unlink(req.file.path);
        } catch (err) {
          console.error('清理文件失败:', err);
        }
        
        return res.status(400).json({
          success: false,
          error: '录音时间太长，请不要超过60秒'
        });
      }

      // 执行语音识别
      const startTime = Date.now();
      const result = await speechService.speechToText(req.file.path);
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
        duration: duration,
        language: result.language,
        error: result.error,
        isSimulated: result.isSimulated // 开发阶段标记
      });

    } catch (error) {
      console.error('[STT] 语音识别错误:', error);
      
      // 尝试清理文件
      if (req.file && req.file.path) {
        try {
          const fs = require('fs').promises;
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
    const isConfigured = !!process.env.AZURE_SPEECH_KEY;
    
    res.json({
      available: true, // 始终可用（使用模拟或真实服务）
      configured: isConfigured,
      language: process.env.AZURE_SPEECH_LANGUAGE || 'zh-CN',
      region: process.env.AZURE_SPEECH_REGION || 'eastasia',
      maxDuration: 60,
      minDuration: 1,
      supportedFormats: ['mp3', 'wav', 'm4a', 'webm'],
      isSimulated: !isConfigured // 标记是否使用模拟服务
    });
  }
}

module.exports = new SpeechController();