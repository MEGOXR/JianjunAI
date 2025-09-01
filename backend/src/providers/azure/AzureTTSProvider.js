/**
 * Azure TTS Provider实现
 * 使用Microsoft Cognitive Services Speech SDK
 */
const TTSProvider = require('../base/TTSProvider');

class AzureTTSProvider extends TTSProvider {
  constructor(config) {
    super(config);
    this.config = {
      speechKey: config.speechKey,
      speechRegion: config.speechRegion || 'koreacentral',
      speechEndpoint: config.speechEndpoint,
      language: config.language || 'zh-CN',
      // Azure默认配置
      defaultVoice: config.ttsVoice || 'zh-CN-XiaoxiaoNeural', // 从配置读取音色
      defaultFormat: 'audio-16khz-128kbitrate-mono-mp3',
      defaultSpeed: '0%',
      defaultPitch: '0%'
    };
    this.sdk = null;
  }

  async initialize() {
    if (!this.config.speechKey) {
      throw new Error('Azure Speech Key未配置');
    }

    try {
      // 动态加载Azure Speech SDK
      this.sdk = require('microsoft-cognitiveservices-speech-sdk');
      console.log('Azure TTS Provider初始化成功');
      console.log('- 区域:', this.config.speechRegion);
      console.log('- 语言:', this.config.language);
      console.log('- 默认音色:', this.config.defaultVoice);
    } catch (error) {
      throw new Error(`Azure Speech SDK加载失败: ${error.message}`);
    }
  }

  async textToSpeech(text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error('文本内容不能为空');
    }

    console.log(`开始Azure TTS合成，文本长度: ${text.length}`);

    return new Promise((resolve, reject) => {
      try {
        // 创建语音配置
        const speechConfig = this.sdk.SpeechConfig.fromSubscription(
          this.config.speechKey,
          this.config.speechRegion
        );

        // 设置输出格式
        speechConfig.speechSynthesisOutputFormat = 
          this.sdk.SpeechSynthesisOutputFormat.Audio16Khz128KBitRateMonoMp3;

        // 创建语音合成器
        const synthesizer = new this.sdk.SpeechSynthesizer(speechConfig);

        // 构建SSML
        const ssml = this.buildSSML(text, options);

        // 执行语音合成
        synthesizer.speakSsmlAsync(
          ssml,
          result => {
            if (result.reason === this.sdk.ResultReason.SynthesizingAudioCompleted) {
              const audioBuffer = Buffer.from(result.audioData);
              resolve({
                audioBuffer,
                format: 'mp3',
                sampleRate: 16000,
                duration: this.estimateAudioDuration(text, options)
              });
            } else if (result.reason === this.sdk.ResultReason.Canceled) {
              const cancellation = this.sdk.CancellationDetails.fromResult(result);
              reject(new Error(`TTS取消: ${cancellation.reason} - ${cancellation.errorDetails}`));
            } else {
              reject(new Error(`TTS合成失败: ${result.reason}`));
            }
            synthesizer.close();
          },
          error => {
            console.error('Azure TTS错误:', error);
            synthesizer.close();
            reject(error);
          }
        );

      } catch (error) {
        reject(error);
      }
    });
  }

  async streamTextToSpeech(text, options = {}) {
    // Azure Speech SDK不直接支持流式合成，但可以通过分段处理实现
    const maxChunkLength = 200; // 单次TTS文本限制
    const chunks = this.splitText(text, maxChunkLength);
    const audioChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = await this.textToSpeech(chunk, options);
      
      audioChunks.push(result.audioBuffer);
      
      // 流式返回
      if (options.onChunk) {
        options.onChunk({
          index: i,
          total: chunks.length,
          audioBuffer: result.audioBuffer,
          text: chunk,
          isLast: i === chunks.length - 1
        });
      }
    }

    // 合并所有音频片段
    const combinedBuffer = Buffer.concat(audioChunks);
    return {
      audioBuffer: combinedBuffer,
      format: 'mp3',
      sampleRate: 16000,
      chunks: audioChunks.length
    };
  }

  getSupportedVoices() {
    return [
      {
        id: 'zh-CN-XiaoxiaoNeural',
        name: '晓晓-温柔',
        gender: 'female',
        language: 'zh-CN',
        description: '温柔清澈女声，适合医疗咨询',
        provider: 'azure'
      },
      {
        id: 'zh-CN-YunxiNeural',
        name: '云希-温暖',
        gender: 'male',
        language: 'zh-CN',
        description: '温暖磁性男声，专业权威',
        provider: 'azure'
      },
      {
        id: 'zh-CN-YunyangNeural',
        name: '云扬-专业',
        gender: 'male',
        language: 'zh-CN',
        description: '专业男声，清晰标准',
        provider: 'azure'
      },
      {
        id: 'zh-CN-XiaohanNeural',
        name: '晓涵-亲和',
        gender: 'female',
        language: 'zh-CN',
        description: '亲和女声，友好温暖',
        provider: 'azure'
      }
    ];
  }

  getSupportedFormats() {
    return ['mp3', 'wav', 'pcm'];
  }

  async validateConfig() {
    return !!(this.config.speechKey && this.config.speechRegion);
  }

  async healthCheck() {
    try {
      if (!this.sdk) {
        await this.initialize();
      }

      // 简单的健康检查：合成短文本
      const result = await this.textToSpeech('测试', { 
        voiceType: this.config.defaultVoice 
      });

      return {
        status: 'healthy',
        provider: 'Azure TTS',
        region: this.config.speechRegion,
        audioSize: result.audioBuffer.length
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: 'Azure TTS',
        error: error.message
      };
    }
  }

  // 构建SSML
  buildSSML(text, options = {}) {
    const voice = options.voiceType || this.config.defaultVoice;
    const speed = options.speed ? `${(options.speed - 1) * 100}%` : this.config.defaultSpeed;
    const pitch = options.pitch ? `${(options.pitch - 1) * 50}%` : this.config.defaultPitch;
    const volume = options.volume ? `${options.volume * 100}%` : '100%';

    return `
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${this.config.language}">
        <voice name="${voice}">
          <prosody rate="${speed}" pitch="${pitch}" volume="${volume}">
            ${this.escapeXml(text)}
          </prosody>
        </voice>
      </speak>
    `.trim();
  }

  // 文本分段处理
  splitText(text, maxLength) {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks = [];
    let current = '';
    const sentences = text.split(/[。！？；\n]/);

    for (const sentence of sentences) {
      if ((current + sentence).length <= maxLength) {
        current += sentence + '。';
      } else {
        if (current) chunks.push(current.trim());
        current = sentence + '。';
      }
    }

    if (current) chunks.push(current.trim());
    return chunks.filter(chunk => chunk.length > 0);
  }

  // XML转义
  escapeXml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  getName() {
    return 'Azure TTS Provider';
  }
}

module.exports = AzureTTSProvider;