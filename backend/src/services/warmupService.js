/**
 * 预热服务 - 在用户连接时立即开始所有前置工作
 * 这样等用户真正发问时，所有数据都已准备就绪
 */

const userDataService = require('./userDataService');
const greetingService = require('./greetingService');

class WarmupService {
  constructor() {
    this.warmupCache = new Map(); // 缓存预热任务
    this.warmupTimeout = 30 * 1000; // 30秒超时
  }

  /**
   * 开始用户预热流程
   * 在WebSocket连接建立时立即调用
   */
  async startUserWarmup(userId, ws) {
    console.log(`🔥 开始用户 ${userId} 的预热流程`);
    
    // 如果已经在预热中，直接返回现有的Promise
    if (this.warmupCache.has(userId)) {
      console.log(`用户 ${userId} 预热任务已存在，复用中...`);
      return this.warmupCache.get(userId);
    }

    // 创建预热任务
    const warmupTask = this.performWarmup(userId, ws);
    this.warmupCache.set(userId, warmupTask);
    
    // 设置清理定时器
    setTimeout(() => {
      this.warmupCache.delete(userId);
    }, this.warmupTimeout);
    
    return warmupTask;
  }

  /**
   * 执行预热工作
   */
  async performWarmup(userId, ws) {
    const startTime = Date.now();
    const results = {
      userData: null,
      greeting: null,
      suggestions: null,
      errors: []
    };

    try {
      console.log(`📊 [${userId}] 步骤1: 加载用户数据`);
      // 步骤1: 加载用户数据
      results.userData = await userDataService.getUserData(userId);
      console.log(`✅ [${userId}] 用户数据加载完成: ${Date.now() - startTime}ms`);

      // 步骤2: 并行执行问候语生成和建议生成
      const parallelTasks = [];
      
      // 2a: 生成智能问候语
      if (greetingService.shouldSendGreeting(results.userData)) {
        console.log(`🤖 [${userId}] 步骤2a: 生成AI问候语`);
        parallelTasks.push(
          greetingService.generateGreeting(results.userData)
            .then(greeting => {
              results.greeting = greeting;
              console.log(`✅ [${userId}] AI问候语生成完成: ${Date.now() - startTime}ms`);
              return greeting;
            })
            .catch(error => {
              console.error(`❌ [${userId}] 问候语生成失败:`, error);
              results.errors.push({ type: 'greeting', error: error.message });
              return null;
            })
        );
      } else {
        console.log(`⏭️ [${userId}] 跳过问候语生成（24小时内已访问）`);
      }

      // 2b: 预生成建议问题（如果需要）
      console.log(`💡 [${userId}] 步骤2b: 预生成建议问题`);
      const suggestionService = require('./suggestionService');
      parallelTasks.push(
        suggestionService.generateSuggestions('', results.userData?.chatHistory || [])
          .then(suggestions => {
            results.suggestions = suggestions;
            console.log(`✅ [${userId}] 建议问题生成完成: ${Date.now() - startTime}ms`);
            return suggestions;
          })
          .catch(error => {
            console.error(`❌ [${userId}] 建议问题生成失败:`, error);
            results.errors.push({ type: 'suggestions', error: error.message });
            // 使用备用建议问题
            return suggestionService.getFallbackSuggestions();
          })
      );

      // 等待所有并行任务完成
      await Promise.allSettled(parallelTasks);

      console.log(`🎉 [${userId}] 预热完成，总耗时: ${Date.now() - startTime}ms`);
      
      // 步骤3: 发送预热完成的内容
      this.sendWarmupResults(userId, ws, results);
      
      return results;

    } catch (error) {
      console.error(`💥 [${userId}] 预热失败:`, error);
      results.errors.push({ type: 'general', error: error.message });
      return results;
    }
  }

  /**
   * 发送预热结果给客户端
   */
  sendWarmupResults(userId, ws, results) {
    if (ws.readyState !== ws.OPEN) {
      console.log(`⚠️ [${userId}] WebSocket已断开，跳过发送预热结果`);
      return;
    }

    try {
      // 发送问候语
      if (results.greeting) {
        ws.send(JSON.stringify({
          type: 'greeting',
          data: results.greeting,
          userId: userId
        }));
        console.log(`📤 [${userId}] 问候语已发送`);
      }

      // 发送建议问题
      if (results.suggestions && results.suggestions.length > 0) {
        ws.send(JSON.stringify({
          type: 'suggestions',
          suggestions: results.suggestions
        }));
        console.log(`📤 [${userId}] 建议问题已发送 (${results.suggestions.length}个)`);
      }

      // 发送预热完成通知
      ws.send(JSON.stringify({
        type: 'warmup_complete',
        userId: userId,
        hasGreeting: !!results.greeting,
        hasSuggestions: !!(results.suggestions && results.suggestions.length > 0),
        errors: results.errors
      }));

    } catch (sendError) {
      console.error(`❌ [${userId}] 发送预热结果失败:`, sendError);
    }
  }

  /**
   * 获取预热结果（如果已完成）
   */
  async getWarmupResults(userId) {
    const warmupTask = this.warmupCache.get(userId);
    if (warmupTask) {
      try {
        return await warmupTask;
      } catch (error) {
        console.error(`获取用户 ${userId} 预热结果失败:`, error);
        return null;
      }
    }
    return null;
  }

  /**
   * 清理过期的预热缓存
   */
  cleanup() {
    // 预热缓存会自动过期，这里可以添加额外的清理逻辑
    console.log('预热服务清理完成');
  }
}

module.exports = new WarmupService();