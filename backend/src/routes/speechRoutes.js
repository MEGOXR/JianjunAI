const express = require('express');
const router = express.Router();
const speechController = require('../controllers/speechController');
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

module.exports = router;