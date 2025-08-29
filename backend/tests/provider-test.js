/**
 * Provider功能测试
 * 验证Provider工厂和配置服务是否正常工作
 */
require('dotenv').config();
const ConfigService = require('../src/services/ConfigService');
const ProviderFactory = require('../src/services/ProviderFactory');

async function testProviders() {
  console.log('🧪 开始Provider功能测试...\n');
  
  // 测试Azure Provider
  console.log('=== 测试 Azure Provider ===');
  process.env.PROVIDER_TYPE = 'azure';
  
  try {
    const azureLLM = ProviderFactory.getLLMProvider();
    console.log('✓ Azure LLM Provider创建成功');
    console.log('Provider名称:', azureLLM.getName());
    console.log('配置验证:', await azureLLM.validateConfig());
    
    // 健康检查（可能会失败，但不影响测试）
    try {
      const health = await azureLLM.healthCheck();
      console.log('健康状态:', health.status);
    } catch (error) {
      console.log('健康检查跳过（预期行为）:', error.message);
    }
  } catch (error) {
    console.error('✗ Azure Provider测试失败:', error.message);
  }
  
  console.log();
  
  // 测试Volcengine Provider
  console.log('=== 测试 Volcengine Provider ===');
  process.env.PROVIDER_TYPE = 'volcengine';
  
  try {
    // 清理之前的实例
    ProviderFactory.cleanup();
    
    const volcengineLLM = ProviderFactory.getLLMProvider();
    console.log('✓ Volcengine LLM Provider创建成功');
    console.log('Provider名称:', volcengineLLM.getName());
    console.log('配置验证:', await volcengineLLM.validateConfig());
    console.log('模型信息:', volcengineLLM.getModelInfo());
    
    // 健康检查
    try {
      const health = await volcengineLLM.healthCheck();
      console.log('健康状态:', health.status);
      if (health.status === 'healthy') {
        console.log('✓ 火山引擎连接正常！');
      }
    } catch (error) {
      console.log('健康检查失败:', error.message);
    }
  } catch (error) {
    console.error('✗ Volcengine Provider测试失败:', error.message);
  }
  
  console.log();
  
  // 测试Provider工厂信息
  console.log('=== Provider工厂信息 ===');
  const info = ProviderFactory.getInstanceInfo();
  console.log('当前Provider:', info.currentProvider);
  console.log('Provider模式:', info.providerModeEnabled ? '启用' : '禁用');
  console.log('活跃实例:', info.activeInstances);
  console.log('实例数量:', info.instanceCount);
  
  console.log('\n🎉 Provider功能测试完成！');
}

// 运行测试
testProviders().catch(console.error);