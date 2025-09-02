module.exports = {
  apps: [{
    name: 'jianjunai',
    script: 'src/index.js',
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    },
    // 从.env.volcengine文件加载环境变量
    env_file: '.env.volcengine',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};