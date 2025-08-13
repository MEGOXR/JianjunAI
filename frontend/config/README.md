# 前端环境配置说明

## 切换环境

编辑 `env.js` 文件中的 `currentEnv` 变量：

```javascript
// 本地开发
const currentEnv = 'local';

// 开发/测试环境
const currentEnv = 'dev';

// 生产环境
const currentEnv = 'prod';
```

## 环境说明

### local - 本地环境
- 用于本地开发调试
- 后端地址：`http://localhost:3000`
- WebSocket：`ws://localhost:3000`

### dev - 开发环境
- Azure测试环境
- 后端地址：`https://jianjunai-h6bxanc3b4e7ebcn.eastasia-01.azurewebsites.net`
- WebSocket：`wss://jianjunai-h6bxanc3b4e7ebcn.eastasia-01.azurewebsites.net`

### prod - 生产环境
- 正式生产环境
- 后端地址：`https://mego-xr.com/api`
- WebSocket：`wss://mego-xr.com/api/`

## 使用方法

1. 根据需要修改 `env.js` 中的 `currentEnv`
2. 重新编译小程序
3. 控制台会显示当前使用的环境配置

## 注意事项

- 本地开发时记得启动后端服务
- 切换环境后需要重新编译小程序
- 生产环境发布前请确认 `currentEnv = 'prod'`