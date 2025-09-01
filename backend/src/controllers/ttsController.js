/**
 * TTS（文本转语音）控制器
 * 处理语音合成相关的请求
 */
const ProviderFactory = require('../services/ProviderFactory');
const ConfigService = require('../services/ConfigService');
const fs = require('fs');
const path = require('path');

/**
 * TTS流式接口
 * 将文本转换为语音流
 */
exports.textToSpeechStream = async (req, res) => {
  try {
    const { text, voice, userId } = req.body;
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: '文本内容不能为空' });
    }

    const ttsProvider = ProviderFactory.getTTSProvider();
    await ttsProvider.initialize();

    // 获取当前Provider的配置（包含默认音色）
    const providerType = ConfigService.getProviderType();
    const providerConfig = ConfigService.getProviderConfig(providerType);
    const defaultVoice = providerConfig.ttsVoice;

    // 动态设置响应头（根据Provider支持的格式）
    const supportedFormats = ttsProvider.getSupportedFormats();
    const audioFormat = supportedFormats.includes('mp3') ? 'mp3' : 'wav';
    const contentType = audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Audio-Format', audioFormat); // 告知前端音频格式
    res.setHeader('X-TTS-Provider', providerType); // 告知前端使用的Provider
    
    console.log(`TTS合成开始 - Provider: ${providerType}, 音色: ${voice || defaultVoice}, 文本长度: ${text.length}`);
    
    // 收集所有音频块用于保存调试文件
    const audioChunks = [];
    
    // 使用真正的流式TTS - 直接转发火山引擎的音频块
    console.log(`TTS: 开始流式合成，文本长度: ${text.length}`);
    
    // 使用修改后的streamTextToSpeechReal方法
    await ttsProvider.streamTextToSpeechReal(text, {
      voiceType: voice || defaultVoice,
      userId: userId || 'web_user',
      encoding: audioFormat,
      onChunk: (chunk, chunkIndex) => {
        // 立即将每个音频块发送给前端
        res.write(chunk.audioBuffer);
        audioChunks.push(chunk.audioBuffer);
        console.log(`TTS: 发送音频块 ${chunkIndex + 1}，大小: ${chunk.audioBuffer.length} bytes`);
      }
    });
    
    // 保存调试音频文件
    try {
      const debugDir = path.join(__dirname, '../../tts-debug');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const debugFileName = `tts_${timestamp}_${userId || 'unknown'}.${audioFormat}`;
      const debugFilePath = path.join(debugDir, debugFileName);
      
      const fullAudioBuffer = Buffer.concat(audioChunks);
      fs.writeFileSync(debugFilePath, fullAudioBuffer);
      console.log(`TTS调试音频已保存: ${debugFilePath} (${fullAudioBuffer.length} bytes)`);
    } catch (saveError) {
      console.error('保存TTS调试音频失败:', saveError);
    }
    
    res.end();
    console.log(`TTS合成完成 - Provider: ${providerType}`);
    
  } catch (error) {
    console.error('TTS流式合成错误:', error);
    res.status(500).json({ 
      error: 'TTS服务异常',
      details: error.message,
      provider: ConfigService.getProviderType()
    });
  }
};

/**
 * 获取当前Provider支持的音色列表
 */
exports.getSupportedVoices = async (req, res) => {
  try {
    const ttsProvider = ProviderFactory.getTTSProvider();
    const voices = ttsProvider.getSupportedVoices();
    const providerType = ConfigService.getProviderType();
    const providerConfig = ConfigService.getProviderConfig(providerType);
    
    res.json({
      provider: providerType,
      voices: voices,
      defaultVoice: providerConfig.ttsVoice,
      currentVoice: providerConfig.ttsVoice
    });
    
    console.log(`返回音色列表 - Provider: ${providerType}, 音色数量: ${voices.length}`);
    
  } catch (error) {
    console.error('获取音色列表失败:', error);
    res.status(500).json({ 
      error: '获取音色列表失败',
      details: error.message
    });
  }
};

/**
 * 测试TTS服务健康状态
 */
exports.healthCheck = async (req, res) => {
  try {
    const ttsProvider = ProviderFactory.getTTSProvider();
    await ttsProvider.initialize();
    const healthStatus = await ttsProvider.healthCheck();
    
    res.json({
      ...healthStatus,
      provider: ConfigService.getProviderType(),
      config: {
        voice: ConfigService.getProviderConfig(ConfigService.getProviderType()).ttsVoice
      }
    });
    
  } catch (error) {
    console.error('TTS健康检查失败:', error);
    res.status(500).json({ 
      status: 'unhealthy',
      error: error.message,
      provider: ConfigService.getProviderType()
    });
  }
};

/**
 * 简单的TTS接口（非流式）
 * 返回完整的音频文件
 */
exports.textToSpeech = async (req, res) => {
  try {
    const { text, voice, userId } = req.body;
    
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: '文本内容不能为空' });
    }

    const ttsProvider = ProviderFactory.getTTSProvider();
    await ttsProvider.initialize();

    // 获取当前Provider的配置
    const providerType = ConfigService.getProviderType();
    const providerConfig = ConfigService.getProviderConfig(providerType);
    const defaultVoice = providerConfig.ttsVoice;
    
    console.log(`TTS合成开始 - Provider: ${providerType}, 音色: ${voice || defaultVoice}`);
    
    // 执行TTS合成
    const result = await ttsProvider.textToSpeech(text, {
      voiceType: voice || defaultVoice,
      userId: userId || 'web_user'
    });
    
    // 设置响应头
    const contentType = result.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', result.audioBuffer.length);
    res.setHeader('X-Audio-Format', result.format);
    res.setHeader('X-TTS-Provider', providerType);
    
    // 发送音频数据
    res.send(result.audioBuffer);
    
    console.log(`TTS合成完成 - 音频大小: ${result.audioBuffer.length} bytes`);
    
  } catch (error) {
    console.error('TTS合成错误:', error);
    res.status(500).json({ 
      error: 'TTS服务异常',
      details: error.message,
      provider: ConfigService.getProviderType()
    });
  }
};