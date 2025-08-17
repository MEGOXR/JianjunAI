/**
 * 环境配置文件
 * 通过修改 currentEnv 变量来切换环境
 */

// 当前环境: 'local' | 'dev' | 'prod'
const currentEnv = 'prod';

// 环境配置
const envConfig = {
  // 本地开发环境
  local: {
    wsBaseUrl: "ws://192.168.1.13:3000",
    baseUrl: "http://192.168.1.13:3000",
    name: "本地环境"
  },
  
  // 开发/测试环境
  dev: {
    wsBaseUrl: "wss://jianjunai-h6bxanc3b4e7ebcn.eastasia-01.azurewebsites.net",
    baseUrl: "https://jianjunai-h6bxanc3b4e7ebcn.eastasia-01.azurewebsites.net",
    name: "开发环境"
  },
  
  // 生产环境
  prod: {
    wsBaseUrl: "wss://mego-xr.com/api/",
    baseUrl: "https://mego-xr.com/api",
    name: "生产环境"
  }
};

// 获取当前环境配置
const getEnvConfig = () => {
  const config = envConfig[currentEnv];
  if (!config) {
    console.error(`未知的环境配置: ${currentEnv}`);
    return envConfig.local; // 默认返回本地环境
  }
  
  console.log(`当前环境: ${config.name}`);
  console.log(`API地址: ${config.baseUrl}`);
  console.log(`WebSocket地址: ${config.wsBaseUrl}`);
  
  return config;
};

module.exports = {
  currentEnv,
  getEnvConfig,
  ...getEnvConfig()
};