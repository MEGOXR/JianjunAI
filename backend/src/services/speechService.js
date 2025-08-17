const fs = require('fs').promises;
const path = require('path');

// 环境变量读取辅助函数（处理 Azure App Service 的 APPSETTING_ 前缀）
function getEnvVar(name) {
  return process.env[name] || process.env[`APPSETTING_${name}`] || null;
}

// 动态导入 Azure Speech SDK（如果配置了密钥）
let sdk = null;
if (getEnvVar('AZURE_SPEECH_KEY')) {
  try {
    sdk = require('microsoft-cognitiveservices-speech-sdk');
    console.log('Azure Speech SDK 加载成功');
  } catch (error) {
    console.warn('Azure Speech SDK 加载失败:', error.message);
  }
}

class SpeechService {
  constructor() {
    // Azure Speech Service 配置
    this.speechKey = getEnvVar('AZURE_SPEECH_KEY');
    this.speechRegion = getEnvVar('AZURE_SPEECH_REGION') || 'koreacentral';
    this.speechEndpoint = getEnvVar('AZURE_SPEECH_ENDPOINT');
    this.language = getEnvVar('AZURE_SPEECH_LANGUAGE') || 'zh-CN';
    
    // 流式识别会话管理
    this.streamingSessions = new Map(); // sessionId -> { recognizer, pushStream, ws }
    
    if (!this.speechKey) {
      console.warn('警告: AZURE_SPEECH_KEY 未配置');
    } else if (sdk) {
      console.log(`Azure Speech Service 已配置: 区域=${this.speechRegion}, 语言=${this.language}`);
    }
  }

  /**
   * 使用 PushAudioInputStream 处理音频文件
   * 支持 MP3 格式通过推送流的方式
   * @param {string} audioFilePath - 音频文件路径
   * @returns {Promise<{success: boolean, text: string, confidence: number, duration: number}>}
   */
  async speechToText(audioFilePath) {
    try {
      // 检查文件是否存在
      await fs.access(audioFilePath);
      
      // 获取文件信息
      const stats = await fs.stat(audioFilePath);
      const duration = await this.getAudioDuration(audioFilePath);
      
      // 使用 Azure Speech Service 进行识别
      if (!this.speechKey) {
        throw new Error('Azure Speech Service 未配置');
      }
      
      if (!sdk) {
        throw new Error('Azure Speech SDK 未加载');
      }
      
      return await this.azureSpeechToText(audioFilePath, duration);
    } catch (error) {
      console.error('语音识别错误:', error);
      throw error;
    } finally {
      // 清理临时文件
      try {
        await fs.unlink(audioFilePath);
        console.log(`[STT] 已清理临时文件: ${audioFilePath}`);
      } catch (err) {
        console.error('清理临时文件失败:', err);
      }
    }
  }

  /**
   * 计算识别置信度
   * @private
   */
  calculateConfidence(result) {
    // Azure 不直接提供置信度分数，我们基于一些因素估算
    let confidence = 0.7; // 基础置信度
    
    // 根据识别文本长度调整
    if (result.text && result.text.length > 10) confidence += 0.1;
    if (result.text && result.text.length > 20) confidence += 0.1;
    
    // 检查是否包含标点符号（通常表示更完整的识别）
    if (result.text && /[，。！？]/.test(result.text)) confidence += 0.05;
    
    return Math.min(confidence, 0.95);
  }

  /**
   * 验证语音时长
   * @param {string} audioFilePath - 音频文件路径
   * @returns {Promise<number>} 音频时长（秒）
   */
  async getAudioDuration(audioFilePath) {
    // 简单实现：基于文件大小估算
    // MP3 文件约 128kbps 码率
    const stats = await fs.stat(audioFilePath);
    const fileSizeInBytes = stats.size;
    const bitRate = 128000 / 8; // 128kbps 转换为 bytes per second
    const duration = fileSizeInBytes / bitRate;
    
    // 返回合理范围内的时长（1-60秒）
    return Math.max(1, Math.min(60, Math.round(duration)));
  }

  /**
   * 使用 Azure Speech Service 进行语音识别
   * 使用 PushAudioInputStream 支持各种音频格式
   * @param {string} audioFilePath - 音频文件路径
   * @param {number} duration - 音频时长
   * @returns {Promise<Object>} 识别结果
   */
  async azureSpeechToText(audioFilePath, duration) {
    if (!sdk) {
      throw new Error('Azure Speech SDK 未加载');
    }

    return new Promise(async (resolve, reject) => {
      try {
        // 配置语音识别
        console.log(`[STT] 配置信息: Region=${this.speechRegion}, Language=${this.language}`);
        const speechConfig = sdk.SpeechConfig.fromSubscription(
          this.speechKey,
          this.speechRegion
        );
        speechConfig.speechRecognitionLanguage = this.language;
        
        // 设置识别参数以提高准确性
        speechConfig.setProperty(
          sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
          "30000"  // 增加初始静默超时到30秒
        );
        speechConfig.setProperty(
          sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
          "5000"   // 增加结束静默超时到5秒
        );
        
        // 读取音频文件数据
        const audioData = await fs.readFile(audioFilePath);
        console.log(`[STT] 音频文件信息: 大小=${audioData.length}字节, 估算时长=${duration}秒`);
        
        // 创建 PushAudioInputStream 用于处理各种格式
        let audioFormat;
        
        // 判断文件格式并设置相应的音频格式
        if (audioFilePath.toLowerCase().endsWith('.wav')) {
          // WAV 格式：默认 PCM 16kHz
          audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
        } else if (audioFilePath.toLowerCase().endsWith('.pcm')) {
          // PCM 格式：原始音频数据，16kHz, 16-bit, 单声道
          audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
          console.log('[STT] 使用 PCM 格式: 16kHz, 16-bit, 单声道');
        } else {
          // MP3 或其他格式：使用默认格式
          audioFormat = sdk.AudioStreamFormat.getDefaultInputFormat();
        }
        
        const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
        
        // 将音频数据推送到流中
        pushStream.write(audioData);
        pushStream.close();
        
        // 创建音频配置
        const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
        
        // 创建识别器
        const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
        
        console.log('[STT] 开始 Azure 语音识别...');
        const startTime = Date.now();
        
        // 执行识别
        recognizer.recognizeOnceAsync(
          (result) => {
            const processingTime = Date.now() - startTime;
            console.log(`[STT] Azure 识别完成，耗时: ${processingTime}ms`);
            
            if (result.reason === sdk.ResultReason.RecognizedSpeech) {
              // 识别成功
              const confidence = this.calculateConfidence(result);
              console.log(`[STT] 识别成功: "${result.text}", 置信度: ${confidence}`);
              
              resolve({
                success: true,
                text: result.text,
                confidence: confidence,
                duration: duration,
                language: this.language,
                isSimulated: false
              });
            } else if (result.reason === sdk.ResultReason.NoMatch) {
              // 无法识别
              console.log('[STT] 无法识别语音内容');
              console.log('[STT] NoMatch详细信息:', result.properties ? result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult) : 'N/A');
              resolve({
                success: false,
                text: '',
                confidence: 0,
                duration: duration,
                error: '无法识别语音内容，请说话清晰一些或尝试更长的录音',
                isSimulated: false
              });
            } else {
              // 其他错误
              console.error('[STT] 识别失败，原因:', result.reason);
              console.error('[STT] 错误详情:', result.errorDetails || 'N/A');
              reject(new Error(`语音识别失败: ${result.reason} - ${result.errorDetails}`));
            }
            
            recognizer.close();
          },
          (error) => {
            console.error('[STT] Azure 识别错误:', error);
            recognizer.close();
            reject(error);
          }
        );
      } catch (error) {
        console.error('[STT] Azure Speech Service 错误:', error);
        reject(error);
      }
    });
  }

  // ==================== 流式语音识别方法 ====================

  /**
   * 开始流式语音识别
   * @param {WebSocket} ws - WebSocket连接
   * @param {string} sessionId - 会话ID
   * @param {Object} config - 识别配置
   */
  async startStreamingRecognition(ws, sessionId, config) {
    if (!this.speechKey || !sdk) {
      throw new Error('Azure Speech Service 未配置或SDK未加载');
    }

    try {
      console.log(`🎤 [${sessionId}] 初始化流式语音识别`);

      // 配置语音识别
      const speechConfig = sdk.SpeechConfig.fromSubscription(
        this.speechKey,
        this.speechRegion
      );
      speechConfig.speechRecognitionLanguage = config.language || this.language;

      // 设置识别参数
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
        "60000"  // 初始静默超时60秒
      );
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
        "2000"   // 结束静默超时2秒
      );

      // 启用实时识别结果
      speechConfig.setProperty(
        sdk.PropertyId.Speech_RequestWordLevelTimestamps,
        "true"
      );

      // 创建音频格式
      const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(
        config.sampleRate || 16000,
        16,
        config.channels || 1
      );

      // 创建推送流
      const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

      // 创建语音识别器
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      // 存储会话信息
      this.streamingSessions.set(sessionId, {
        recognizer,
        pushStream,
        ws,
        config,
        lastPartialText: '', // 存储最后的部分识别结果
        hasFinalResult: false, // 标记是否已发送最终结果
        finalResultTimeout: null, // 等待最终结果的超时器
        isUserEnded: false, // 标记是否为用户主动结束
        allRecognizedTexts: [] // 存储所有识别到的文本片段
      });

      // 监听实时识别结果（部分结果）
      recognizer.recognizing = (s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizingSpeech) {
          const partialText = e.result.text;
          console.log(`🔄 [${sessionId}] 实时识别: ${partialText}`);
          
          // 更新最后的部分识别结果
          const session = this.streamingSessions.get(sessionId);
          if (session) {
            session.lastPartialText = partialText;
          }
          
          // 发送实时结果到前端
          this.sendSpeechResult(ws, sessionId, 'partial', partialText);
        }
      };

      // 监听最终识别结果
      recognizer.recognized = (s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
          const finalText = e.result.text;
          console.log(`✅ [${sessionId}] 最终识别片段: ${finalText}`);
          
          // 将识别到的文本片段存储起来，但不立即发送，也不停止识别
          const session = this.streamingSessions.get(sessionId);
          if (session && finalText.trim()) {
            session.allRecognizedTexts.push(finalText.trim());
            console.log(`📝 [${sessionId}] 存储识别片段，当前总数: ${session.allRecognizedTexts.length}`);
            console.log(`🔄 [${sessionId}] 继续等待用户完成语音...`);
          }
        } else if (e.result.reason === sdk.ResultReason.NoMatch) {
          console.log(`❌ [${sessionId}] 无法识别语音片段`);
        }
      };

      // 监听识别错误
      recognizer.canceled = (s, e) => {
        console.error(`❌ [${sessionId}] 识别取消: ${e.reason}, 错误: ${e.errorDetails}`);
        
        const session = this.streamingSessions.get(sessionId);
        if (!session) return;
        
        if (e.reason === sdk.CancellationReason.Error) {
          this.sendSpeechResult(ws, sessionId, 'error', '', e.errorDetails || '识别服务错误');
          this.cleanupSession(sessionId);
        } else if (session.isUserEnded) {
          // 用户主动结束导致的取消，处理最终结果
          console.log(`🛑 [${sessionId}] 用户主动结束导致的取消，处理最终结果`);
          this.handleUserEndedSession(sessionId);
        } else {
          // 其他原因导致的取消
          this.cleanupSession(sessionId);
        }
      };

      // 监听会话开始
      recognizer.sessionStarted = (s, e) => {
        console.log(`🟢 [${sessionId}] 识别会话开始`);
      };

      // 监听会话结束
      recognizer.sessionStopped = (s, e) => {
        console.log(`🔴 [${sessionId}] 识别会话结束`);
        
        const session = this.streamingSessions.get(sessionId);
        if (session && session.isUserEnded) {
          // 用户主动结束，处理最终结果
          this.handleUserEndedSession(sessionId);
        } else {
          // 其他情况直接清理
          this.cleanupSession(sessionId);
        }
      };

      // 开始连续识别
      recognizer.startContinuousRecognitionAsync(
        (result) => {
          console.log(`✅ [${sessionId}] 连续识别启动成功`);
        },
        (error) => {
          console.error(`❌ [${sessionId}] 连续识别启动失败:`, error);
          this.sendSpeechResult(ws, sessionId, 'error', '', '启动识别失败');
          this.cleanupSession(sessionId);
        }
      );

      console.log(`✅ [${sessionId}] 流式语音识别已启动`);

    } catch (error) {
      console.error(`❌ [${sessionId}] 启动流式识别失败:`, error);
      this.sendSpeechResult(ws, sessionId, 'error', '', error.message);
      this.cleanupSession(sessionId);
      throw error;
    }
  }

  /**
   * 处理音频帧数据
   * @param {string} sessionId - 会话ID
   * @param {Buffer} audioBuffer - 音频数据
   */
  async processAudioFrame(sessionId, audioBuffer) {
    const session = this.streamingSessions.get(sessionId);
    if (!session) {
      console.warn(`⚠️ [${sessionId}] 会话不存在，忽略音频帧`);
      return;
    }

    try {
      // 将音频数据推送到流中
      session.pushStream.write(audioBuffer);
      // console.log(`🔊 [${sessionId}] 处理音频帧: ${audioBuffer.length} 字节`);
    } catch (error) {
      console.error(`❌ [${sessionId}] 处理音频帧失败:`, error);
    }
  }

  /**
   * 结束流式语音识别
   * @param {string} sessionId - 会话ID
   */
  async endStreamingRecognition(sessionId) {
    const session = this.streamingSessions.get(sessionId);
    if (!session) {
      console.warn(`⚠️ [${sessionId}] 会话不存在，无法结束`);
      return;
    }

    try {
      console.log(`🛑 [${sessionId}] 用户主动结束流式语音识别`);

      // 标记为用户主动结束
      session.isUserEnded = true;

      // 关闭音频流，这会触发 canceled 或 sessionStopped 事件
      session.pushStream.close();
      
      // 停止连续识别
      session.recognizer.stopContinuousRecognitionAsync(
        () => {
          console.log(`✅ [${sessionId}] 连续识别停止请求已发送`);
        },
        (error) => {
          console.error(`❌ [${sessionId}] 停止连续识别失败:`, error);
          this.cleanupSession(sessionId);
        }
      );

    } catch (error) {
      console.error(`❌ [${sessionId}] 结束识别失败:`, error);
      this.cleanupSession(sessionId);
    }
  }

  /**
   * 发送识别结果到前端
   * @private
   */
  sendSpeechResult(ws, sessionId, resultType, text, error = null) {
    if (ws.readyState !== ws.OPEN) {
      console.warn(`⚠️ [${sessionId}] WebSocket连接已关闭，无法发送结果`);
      return;
    }

    const result = {
      type: 'speech_result',
      sessionId,
      resultType,
      text: text || '',
      timestamp: Date.now()
    };

    if (error) {
      result.error = error;
    }

    try {
      ws.send(JSON.stringify(result));
    } catch (sendError) {
      console.error(`❌ [${sessionId}] 发送识别结果失败:`, sendError);
    }
  }

  /**
   * 处理用户主动结束的会话
   * @private
   */
  handleUserEndedSession(sessionId) {
    const session = this.streamingSessions.get(sessionId);
    if (!session) {
      console.warn(`⚠️ [${sessionId}] 处理用户结束时会话不存在`);
      return;
    }

    if (!session.hasFinalResult) {
      // 构建最终结果：优先使用已识别的片段，否则使用最后的部分结果
      let finalText = '';
      
      if (session.allRecognizedTexts.length > 0) {
        finalText = session.allRecognizedTexts.join(' ');
        console.log(`📝 [${sessionId}] 使用已识别的片段作为最终结果: ${finalText}`);
      } else if (session.lastPartialText && session.lastPartialText.trim()) {
        finalText = session.lastPartialText.trim();
        console.log(`📝 [${sessionId}] 使用最后的部分结果作为最终结果: ${finalText}`);
      }
      
      if (finalText) {
        this.sendSpeechResult(session.ws, sessionId, 'final', finalText);
      } else {
        console.log(`⚠️ [${sessionId}] 没有识别到任何内容`);
      }
    }

    // 清理会话
    this.cleanupSession(sessionId);
  }

  /**
   * 清理识别会话
   * @private
   */
  cleanupSession(sessionId) {
    const session = this.streamingSessions.get(sessionId);
    if (session) {
      try {
        // 清除等待超时
        if (session.finalResultTimeout) {
          clearTimeout(session.finalResultTimeout);
          session.finalResultTimeout = null;
        }
        
        // 关闭识别器
        if (session.recognizer) {
          session.recognizer.close();
        }
        
        // 关闭推送流
        if (session.pushStream) {
          session.pushStream.close();
        }
      } catch (error) {
        console.error(`❌ [${sessionId}] 清理会话失败:`, error);
      }

      // 从Map中移除
      this.streamingSessions.delete(sessionId);
      console.log(`🧹 [${sessionId}] 会话已清理`);
    }
  }
}

module.exports = new SpeechService();