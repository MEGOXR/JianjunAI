/**
 * 数据迁移脚本：从 JSON 文件迁移到 Supabase
 *
 * 使用方法：
 * 1. 确保 .env 中配置了 Supabase 凭据
 * 2. 在 Supabase 中执行数据库 schema（见 docs/supabase-schema.sql）
 * 3. 运行: node scripts/migrateToSupabase.js
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// 配置
const DATA_FILE = path.join(__dirname, '../data/users.json');
const DRY_RUN = process.argv.includes('--dry-run');

// 初始化 Supabase 客户端
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('错误: 缺少 Supabase 配置');
  console.error('请在 .env 中设置 SUPABASE_URL 和 SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 统计
const stats = {
  users: 0,
  sessions: 0,
  messages: 0,
  errors: []
};

async function loadJsonData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('用户数据文件不存在，无需迁移');
      return {};
    }
    throw error;
  }
}

async function migrateUser(wechatOpenId, userData) {
  console.log(`  迁移用户: ${wechatOpenId}`);

  if (DRY_RUN) {
    console.log(`    [DRY RUN] 将创建用户: ${wechatOpenId}`);
    return null;
  }

  try {
    // 1. 创建用户
    const { data: user, error: userError } = await supabase
      .from('users')
      .upsert({
        wechat_open_id: wechatOpenId,
        nickname: userData.userInfo?.nickname || null,
        extracted_name: userData.userInfo?.extractedName || null,
        created_at: userData.createdAt || new Date().toISOString(),
        last_visit: userData.lastVisit || new Date().toISOString(),
        total_sessions: 1,
        total_messages: (userData.chatHistory || []).length,
        metadata: {}
      }, {
        onConflict: 'wechat_open_id'
      })
      .select()
      .single();

    if (userError) {
      throw new Error(`创建用户失败: ${userError.message}`);
    }

    stats.users++;
    console.log(`    ✓ 用户创建成功: ${user.id}`);

    // 2. 创建会话
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .insert({
        user_id: user.id,
        started_at: userData.createdAt || new Date().toISOString(),
        message_count: (userData.chatHistory || []).length,
        is_active: false
      })
      .select()
      .single();

    if (sessionError) {
      throw new Error(`创建会话失败: ${sessionError.message}`);
    }

    stats.sessions++;
    console.log(`    ✓ 会话创建成功: ${session.id}`);

    // 3. 迁移聊天历史
    const chatHistory = userData.chatHistory || [];
    if (chatHistory.length > 0) {
      const messages = chatHistory
        .filter(msg => msg.role !== 'system') // 跳过系统消息
        .map((msg, index) => ({
          session_id: session.id,
          user_id: user.id,
          role: msg.role,
          content: msg.content,
          created_at: new Date(Date.now() - (chatHistory.length - index) * 1000).toISOString(),
          metadata: {}
        }));

      if (messages.length > 0) {
        const { error: msgError } = await supabase
          .from('chat_messages')
          .insert(messages);

        if (msgError) {
          throw new Error(`创建消息失败: ${msgError.message}`);
        }

        stats.messages += messages.length;
        console.log(`    ✓ 迁移 ${messages.length} 条消息`);
      }
    }

    return user;
  } catch (error) {
    stats.errors.push({
      userId: wechatOpenId,
      error: error.message
    });
    console.error(`    ✗ 错误: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('JianjunAI 数据迁移工具');
  console.log('从 JSON 文件迁移到 Supabase');
  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN 模式 - 不会实际写入数据\n');
  }

  console.log(`数据文件: ${DATA_FILE}`);
  console.log(`Supabase URL: ${supabaseUrl}`);
  console.log('');

  // 加载现有数据
  console.log('加载现有用户数据...');
  const usersData = await loadJsonData();
  const userIds = Object.keys(usersData);

  console.log(`找到 ${userIds.length} 个用户\n`);

  if (userIds.length === 0) {
    console.log('没有用户需要迁移');
    return;
  }

  // 迁移每个用户
  console.log('开始迁移...\n');
  for (const userId of userIds) {
    await migrateUser(userId, usersData[userId]);
  }

  // 输出统计
  console.log('\n' + '='.repeat(60));
  console.log('迁移完成\n');
  console.log(`用户: ${stats.users}`);
  console.log(`会话: ${stats.sessions}`);
  console.log(`消息: ${stats.messages}`);

  if (stats.errors.length > 0) {
    console.log(`\n错误 (${stats.errors.length}):`);
    stats.errors.forEach(e => {
      console.log(`  - ${e.userId}: ${e.error}`);
    });
  }

  console.log('='.repeat(60));
}

main().catch(error => {
  console.error('迁移失败:', error);
  process.exit(1);
});
