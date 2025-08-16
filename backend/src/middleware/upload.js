const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;

// 确保临时目录存在
const tempDir = path.join(__dirname, '../../temp');
fs.mkdir(tempDir, { recursive: true }).catch(console.error);

// 配置 multer 存储
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    // 根据格式参数或 MIME 类型确定扩展名
    let ext = '.mp3';
    if (req.body && req.body.format === 'pcm') {
      ext = '.pcm';
    } else if (file.mimetype === 'audio/wav') {
      ext = '.wav';
    } else if (file.mimetype === 'audio/pcm' || file.mimetype === 'application/octet-stream') {
      ext = '.pcm';
    }
    const uniqueName = `${uuidv4()}-${Date.now()}${ext}`;
    cb(null, uniqueName);
  }
});

// 文件过滤器
const fileFilter = (req, file, cb) => {
  // 只接受音频文件
  const allowedMimeTypes = [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-m4a',
    'audio/webm',
    'audio/pcm',
    'application/octet-stream'  // PCM 文件可能被识别为二进制流
  ];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('只支持音频文件格式'), false);
  }
};

// 创建 multer 实例
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 限制 10MB
    files: 1
  }
});

module.exports = upload;