/**
 * 每日总结定时任务
 * 建议在 00:30 (Asia/Shanghai) 运行，确保当天数据完整
 *
 * 改进：
 * - 并发限制：使用 p-limit 防止大量用户时任务堆积
 * - 活跃窗口检测：跳过最近 10 分钟活跃的用户
 */

const cron = require('node-cron');
const dailySummaryService = require('../services/dailySummaryService');
const supabaseService = require('../services/supabaseService');

// 并发限制配置
const CONCURRENCY_LIMIT = 5; // 同时处理 5 个用户
const ACTIVE_THRESHOLD = 10 * 60 * 1000; // 10 分钟内活跃的用户跳过

/**
 * 简单的并发限制器（无需额外依赖）
 */
function createLimiter(concurrency) {
  let running = 0;
  const queue = [];

  const run = async (fn) => {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        running++;
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          running--;
          if (queue.length > 0) {
            const next = queue.shift();
            next();
          }
        }
      };

      if (running < concurrency) {
        execute();
      } else {
        queue.push(execute);
      }
    });
  };

  return run;
}

/**
 * 执行每日总结任务
 */
async function runDailySummaryJob() {
  console.log('[DailySummaryJob] 开始执行每日总结任务');

  if (!supabaseService.isAvailable()) {
    console.warn('[DailySummaryJob] Supabase 不可用，跳过任务');
    return;
  }

  // 计算昨天的日期
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];

  console.log(`[DailySummaryJob] 处理日期: ${dateStr}`);

  try {
    // 获取所有有会话的用户
    const users = await supabaseService.getUsersWithSessionsOnDate(dateStr);

    if (users.length === 0) {
      console.log('[DailySummaryJob] 昨天没有用户会话，任务完成');
      return;
    }

    console.log(`[DailySummaryJob] 找到 ${users.length} 个用户需要生成每日总结`);

    // 创建并发限制器
    const limit = createLimiter(CONCURRENCY_LIMIT);
    const now = Date.now();

    // 统计
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // 并发处理用户
    const tasks = users.map(user => {
      return limit(async () => {
        try {
          // 活跃窗口检测：跳过最近活跃的用户
          const lastActive = await supabaseService.getUserLastActiveTime(user.id);
          if (lastActive && (now - lastActive.getTime()) < ACTIVE_THRESHOLD) {
            console.log(`[DailySummaryJob] 用户 ${user.id} 最近活跃，跳过`);
            skipped++;
            return;
          }

          // 生成每日总结
          await dailySummaryService.generateDailySummary(user.id, dateStr);
          processed++;
          console.log(`[DailySummaryJob] 用户 ${user.id} 每日总结已生成 (${processed}/${users.length})`);
        } catch (err) {
          failed++;
          console.error(`[DailySummaryJob] 用户 ${user.id} 生成失败:`, err.message);
        }
      });
    });

    // 等待所有任务完成
    await Promise.all(tasks);

    console.log(`[DailySummaryJob] 每日总结任务完成:`);
    console.log(`  - 成功: ${processed}`);
    console.log(`  - 跳过 (活跃中): ${skipped}`);
    console.log(`  - 失败: ${failed}`);
    console.log(`  - 总计: ${users.length}`);

  } catch (error) {
    console.error('[DailySummaryJob] 任务执行失败:', error);
  }
}

/**
 * 启动定时任务
 */
function startDailySummaryJob() {
  // 每天 00:30 执行（按 Asia/Shanghai 时区）
  // node-cron 不支持时区，所以这里用 UTC 时间
  // UTC 00:30 + 8 = Asia/Shanghai 08:30 (不对)
  // 我们需要 Asia/Shanghai 00:30 = UTC 16:30 (前一天)

  // 简单方案：在服务器时间 00:30 执行，假设服务器在东八区
  // 或者使用 node-schedule 支持时区

  // 这里使用 cron 格式：30 0 * * * (每天 00:30)
  const task = cron.schedule('30 0 * * *', runDailySummaryJob, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  console.log('[DailySummaryJob] 定时任务已启动，每天 00:30 (Asia/Shanghai) 执行');
  console.log(`[DailySummaryJob] 配置: 并发限制=${CONCURRENCY_LIMIT}, 活跃阈值=${ACTIVE_THRESHOLD / 60000}分钟`);

  return task;
}

/**
 * 手动触发任务（用于测试）
 */
async function triggerManually() {
  console.log('[DailySummaryJob] 手动触发任务...');
  await runDailySummaryJob();
}

module.exports = {
  startDailySummaryJob,
  runDailySummaryJob,
  triggerManually
};
