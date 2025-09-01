const express = require('express');
const router = express.Router();
const speechController = require('../controllers/speechController');
const ttsController = require('../controllers/ttsController'); // 添加TTS控制器
const upload = require('../middleware/upload');
const AuthMiddleware = require('../middleware/auth');

// 语音转文字接口
router.post(
  '/speech-to-text',
  AuthMiddleware.authenticateToken, // JWT 验证
  upload.single('audio'), // 处理单个音频文件上传
  speechController.speechToText.bind(speechController)
);

// 获取语音服务状态
router.get(
  '/speech/status',
  AuthMiddleware.authenticateToken,
  speechController.getServiceStatus.bind(speechController)
);

// ==================== TTS路由 ====================

// TTS流式接口
router.post(
  '/speech/tts/stream',
  AuthMiddleware.authenticateToken,
  ttsController.textToSpeechStream
);

// TTS简单接口
router.post(
  '/speech/tts',
  AuthMiddleware.authenticateToken,
  ttsController.textToSpeech
);

// 获取支持的音色列表
router.get(
  '/speech/tts/voices',
  AuthMiddleware.authenticateToken,
  ttsController.getSupportedVoices
);

// TTS健康检查
router.get(
  '/speech/tts/health',
  AuthMiddleware.authenticateToken,
  ttsController.healthCheck
);

module.exports = router;