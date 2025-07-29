const WebSocket = require('ws');

console.log('WebSocket客户端测试工具');
console.log('========================');

// 测试配置
const tests = [
    {
        name: '本地连接测试',
        url: 'ws://localhost:8080',
        headers: {
            'User-Id': 'test-user-123',
            'Wx-Nickname': encodeURIComponent('测试用户')
        }
    },
    {
        name: '生产环境测试(WSS)',
        url: 'wss://mego-xr.com/api',
        headers: {
            'User-Id': 'test-user-123',
            'Wx-Nickname': encodeURIComponent('测试用户')
        }
    },
    {
        name: '生产环境测试(WS)',
        url: 'ws://mego-xr.com/api',
        headers: {
            'User-Id': 'test-user-123',
            'Wx-Nickname': encodeURIComponent('测试用户')
        }
    }
];

function testWebSocket(config) {
    return new Promise((resolve) => {
        console.log(`\n测试: ${config.name}`);
        console.log(`URL: ${config.url}`);
        console.log(`Headers:`, config.headers);
        
        const startTime = Date.now();
        let ws;
        
        try {
            ws = new WebSocket(config.url, {
                headers: config.headers,
                rejectUnauthorized: false // 忽略SSL证书验证（仅用于测试）
            });
            
            ws.on('open', () => {
                const connectTime = Date.now() - startTime;
                console.log(`✓ 连接成功！耗时: ${connectTime}ms`);
                
                // 发送测试消息
                const testMsg = JSON.stringify({ prompt: '你好' });
                console.log(`发送消息: ${testMsg}`);
                ws.send(testMsg);
            });
            
            ws.on('message', (data) => {
                console.log(`✓ 收到消息: ${data.toString().substring(0, 100)}...`);
                ws.close();
                resolve(true);
            });
            
            ws.on('error', (error) => {
                console.log(`✗ 错误: ${error.message}`);
                console.log(`  错误代码: ${error.code}`);
                console.log(`  错误类型: ${error.type}`);
                if (error.address) {
                    console.log(`  地址: ${error.address}:${error.port}`);
                }
                resolve(false);
            });
            
            ws.on('close', (code, reason) => {
                console.log(`连接关闭 - 代码: ${code}, 原因: ${reason}`);
                resolve(true);
            });
            
            // 设置超时
            setTimeout(() => {
                if (ws.readyState === WebSocket.CONNECTING) {
                    console.log('✗ 连接超时（10秒）');
                    ws.close();
                    resolve(false);
                }
            }, 10000);
            
        } catch (e) {
            console.log(`✗ 创建WebSocket失败: ${e.message}`);
            resolve(false);
        }
    });
}

// 运行测试
async function runTests() {
    console.log(`开始测试时间: ${new Date().toISOString()}`);
    
    for (const test of tests) {
        await testWebSocket(test);
    }
    
    console.log('\n测试完成！');
}

runTests();