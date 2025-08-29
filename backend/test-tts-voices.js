/**
 * 测试TTS服务并尝试获取音色列表
 */
require('dotenv').config();
const ProviderFactory = require('./src/services/ProviderFactory');
const https = require('https');

async function testTTSAndVoices() {
  console.log('🎤 测试TTS服务并获取音色列表...\n');
  
  try {
    // 1. 测试TTS基本功能
    console.log('🔧 创建TTS Provider...');
    const ttsProvider = ProviderFactory.getTTSProvider();
    
    await ttsProvider.initialize();
    console.log('✅ TTS Provider初始化成功\n');
    
    // 2. 测试配置验证
    console.log('🔍 验证TTS配置...');
    const isConfigValid = await ttsProvider.validateConfig();
    console.log(`配置验证结果: ${isConfigValid ? '✅ 有效' : '❌ 无效'}`);
    
    // 3. 测试TTS健康检查
    console.log('🏥 执行TTS健康检查...');
    try {
      const healthResult = await ttsProvider.healthCheck();
      console.log('📊 TTS健康检查结果:', healthResult);
      
      if (healthResult.status === 'healthy') {
        console.log('🎉 TTS服务连接成功！');
      } else {
        console.log('⚠️  TTS服务存在问题:', healthResult.error);
      }
    } catch (error) {
      console.error('❌ TTS健康检查失败:', error.message);
    }
    
    // 3. 尝试获取音色列表（通过API调用）
    console.log('🎭 尝试获取可用音色列表...');
    await getVoiceList();
    
    // 4. 显示当前支持的音色列表
    console.log('📋 当前代码中配置的音色:');
    const voices = ttsProvider.getSupportedVoices();
    voices.forEach((voice, index) => {
      const mark = voice.recommended ? '⭐' : '  ';
      console.log(`${mark} ${index + 1}. ${voice.name} (${voice.id})`);
      console.log(`     ${voice.description}`);
    });
    
  } catch (error) {
    console.error('\n❌ 测试过程中发生错误:', error);
  }
  
  process.exit(0);
}

async function getVoiceList() {
  // 尝试调用音色列表API
  const voiceListEndpoint = 'https://openspeech.bytedance.com/api/v1/tts/voice_list';
  
  return new Promise((resolve) => {
    const requestOptions = {
      method: 'GET',
      headers: {
        'X-Api-App-Key': process.env.VOLCENGINE_SPEECH_APP_ID,
        'X-Api-Access-Key': process.env.VOLCENGINE_SPEECH_ACCESS_TOKEN
      }
    };
    
    const req = https.request(voiceListEndpoint, requestOptions, (res) => {
      const chunks = [];
      
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            console.log('✅ 成功获取音色列表:');
            
            if (data.voices && Array.isArray(data.voices)) {
              data.voices.forEach((voice, index) => {
                console.log(`${index + 1}. ${voice.voice_name || voice.name} (${voice.voice_id || voice.id})`);
                if (voice.language) console.log(`   语言: ${voice.language}`);
                if (voice.gender) console.log(`   性别: ${voice.gender}`);
                if (voice.description) console.log(`   描述: ${voice.description}`);
                console.log();
              });
            } else {
              console.log('📊 API返回数据结构:', JSON.stringify(data, null, 2));
            }
          } else {
            const errorData = Buffer.concat(chunks).toString();
            console.log(`⚠️  音色列表API返回 ${res.statusCode}:`, errorData);
          }
        } catch (error) {
          console.error('❌ 解析音色列表响应失败:', error.message);
        }
        resolve();
      });
    });
    
    req.on('error', (error) => {
      console.error('❌ 音色列表API请求失败:', error.message);
      resolve();
    });
    
    req.setTimeout(10000, () => {
      console.error('⏰ 音色列表API请求超时');
      req.destroy();
      resolve();
    });
    
    req.end();
  });
}

testTTSAndVoices();